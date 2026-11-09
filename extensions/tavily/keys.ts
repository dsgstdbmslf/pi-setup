// Shared API key store with failover. No pi imports, so tests run without node_modules.
//
// Keys:  ~/.pi/agent/api-keys.json   { "<service>": ["key", { "key": "...", "label": "...", "disabled": true }] }
// State: ~/.pi/agent/api-keys-state.json   which keys are exhausted or invalid, by fingerprint (never the key).

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const KEYS_FILE = "api-keys.json";
export const STATE_FILE = "api-keys-state.json";

export interface KeyEntry {
	key: string;
	label: string;
	/** Fingerprint used in the state file and UI instead of the key itself. */
	id: string;
}

export type MarkStatus = "exhausted" | "invalid" | "rate_limited";

export interface Mark {
	status: MarkStatus;
	/** Epoch ms when the mark expires; null = until the key changes or is reset. */
	until: number | null;
	reason: string;
}

type State = Record<string, Record<string, Mark>>;

export class KeyFileError extends Error {}

export function fingerprint(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function mask(key: string): string {
	return key.length > 12 ? `${key.slice(0, 5)}…${key.slice(-4)}` : "…";
}

/** First day of the next month (UTC): when monthly credits are expected to reset. */
export function nextMonthUtc(now: number): number {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export interface LoadedKeys {
	entries: KeyEntry[];
	/** The key file does not exist. */
	missing: boolean;
	/** The key file is readable by group or others. */
	insecure: boolean;
	/** Labels (never keys) of entries skipped because they are not valid header values. */
	malformed: string[];
}

/** Visible ASCII only: anything else (newline, space, non-ASCII) makes fetch reject the Authorization header. */
const SAFE_KEY = /^[\x21-\x7e]+$/;

export async function loadKeys(file: string, service: string): Promise<LoadedKeys> {
	let text: string;
	let insecure = false;
	try {
		text = await readFile(file, "utf8");
		insecure = process.platform !== "win32" && ((await stat(file)).mode & 0o077) !== 0;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], missing: true, insecure, malformed: [] };
		throw new KeyFileError(`Cannot read ${file}: ${(err as Error).message}`);
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (err) {
		// The parser message can quote file content, so keep only the position.
		const where = /position \d+/.exec((err as Error).message)?.[0];
		throw new KeyFileError(`${file} is not valid JSON${where ? ` (${where})` : ""}`);
	}
	const list = (data as Record<string, unknown> | null)?.[service];
	if (list === undefined) return { entries: [], missing: false, insecure, malformed: [] };
	if (!Array.isArray(list)) throw new KeyFileError(`${file}: "${service}" must be an array of keys`);
	const entries: KeyEntry[] = [];
	const malformed: string[] = [];
	const seen = new Set<string>();
	list.forEach((item, i) => {
		const obj = typeof item === "string" ? { key: item } : (item as { key?: unknown; label?: unknown; disabled?: unknown });
		if (!obj || typeof obj.key !== "string" || obj.disabled === true) return;
		const key = obj.key.trim();
		if (!key) return;
		const label = typeof obj.label === "string" && obj.label.trim() ? obj.label.trim() : `#${i + 1}`;
		// Skip instead of throwing so one bad key does not disable the others.
		if (!SAFE_KEY.test(key)) return void malformed.push(label);
		if (seen.has(key)) return;
		seen.add(key);
		entries.push({ key, label, id: fingerprint(key) });
	});
	return { entries, missing: false, insecure, malformed };
}

async function readState(file: string): Promise<State> {
	try {
		const data = JSON.parse(await readFile(file, "utf8"));
		return data && typeof data === "object" ? data : {};
	} catch {
		return {}; // missing or corrupt state only means "nothing marked"
	}
}

async function writeState(file: string, state: State): Promise<void> {
	// Unique name: concurrent writers must never share a tmp file. Exclusive create, private mode.
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(tmp, file);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

/**
 * Per state file promise chains. On globalThis for the same reason as COOLING: every extension
 * has its own module cache, but their pools write the same file.
 */
const STATE_LOCKS = Symbol.for("pi-setup.tavily.stateLocks");

const LOCK_STALE_MS = 10_000;
const LOCK_GIVE_UP_MS = 3_000;
const LOCK_RETRY_MS = 30;

/** Create `lock` exclusively (the lock is the file's existence); wait for other holders, break stale ones. */
async function acquireFileLock(lock: string): Promise<() => Promise<void>> {
	const deadline = Date.now() + LOCK_GIVE_UP_MS;
	for (;;) {
		try {
			const handle = await open(lock, "wx", 0o600);
			return async () => {
				await handle.close().catch(() => {});
				await rm(lock, { force: true });
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		// A crashed holder leaves its lock behind; an old mtime means nobody is working on it.
		const st = await stat(lock).catch(() => null);
		if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) await rm(lock, { force: true });
		else if (Date.now() > deadline) throw new Error(`api-keys state is locked: ${lock}`);
		else await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
	}
}

/** Run fn exclusively for this state file: serialized in-process, then across pi processes via a lock file. */
function withStateLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
	const locks: Map<string, Promise<unknown>> = ((globalThis as any)[STATE_LOCKS] ??= new Map());
	const prev = locks.get(file) ?? Promise.resolve();
	const run = prev
		.catch(() => {}) // one failed holder must not poison the chain
		.then(async () => {
			await mkdir(dirname(file), { recursive: true });
			const release = await acquireFileLock(`${file}.lock`);
			try {
				return await fn();
			} finally {
				await release();
			}
		});
	locks.set(file, run);
	const cleanup = () => {
		if (locks.get(file) === run) locks.delete(file); // idle: do not grow the map
	};
	run.then(cleanup, cleanup);
	return run;
}

/** Drop persistent marks of one service whose expiry has passed. */
function dropExpired(marks: Record<string, Mark>, t: number): void {
	for (const [id, m] of Object.entries(marks)) if (m.until !== null && m.until <= t) delete marks[id];
}

/**
 * Rate-limit marks in memory, shared by every KeyPool with the same state file and service.
 * Pi loads each extension with its own module cache, so a module-level Map would not be
 * shared between web-search, web-fetch and web-research; globalThis is.
 */
const COOLING = Symbol.for("pi-setup.tavily.cooling");

function sharedCooling(stateFile: string, service: string): Map<string, Mark> {
	const registry: Map<string, Map<string, Mark>> = ((globalThis as any)[COOLING] ??= new Map());
	const id = `${stateFile}\0${service}`;
	let map = registry.get(id);
	if (!map) registry.set(id, (map = new Map()));
	return map;
}

export interface PoolSnapshot {
	available: KeyEntry[];
	skipped: { entry: KeyEntry; mark: Mark }[];
	missing: boolean;
	insecure: boolean;
	malformed: string[];
}

/** Keys of one service in file order, minus the ones marked unusable. */
export class KeyPool {
	/** Rate limits are short-lived, so they stay in memory (shared across extensions). */
	private cooling: Map<string, Mark>;

	readonly service: string;
	readonly keysFile: string;
	readonly stateFile: string;
	private now: () => number;

	constructor(service: string, keysFile: string, stateFile: string, now: () => number = Date.now) {
		this.service = service;
		this.keysFile = keysFile;
		this.stateFile = stateFile;
		this.now = now;
		this.cooling = sharedCooling(stateFile, service);
	}

	async snapshot(): Promise<PoolSnapshot> {
		const { entries, missing, insecure, malformed } = await loadKeys(this.keysFile, this.service);
		const marks = (await readState(this.stateFile))[this.service] ?? {};
		const t = this.now();
		// Forget expired marks and keys that are gone. Every pool of a bucket reads the same key file.
		// The bucket Map itself stays in the registry: live pools hold it and share it across extensions.
		const present = new Set(entries.map((e) => e.id));
		for (const [id, m] of this.cooling) if (!present.has(id) || (m.until !== null && m.until <= t)) this.cooling.delete(id);
		const available: KeyEntry[] = [];
		const skipped: PoolSnapshot["skipped"] = [];
		for (const entry of entries) {
			const mark = [marks[entry.id], this.cooling.get(entry.id)].find((m) => m && (m.until === null || m.until > t));
			if (mark) skipped.push({ entry, mark });
			else available.push(entry);
		}
		return { available, skipped, missing, insecure, malformed };
	}

	async mark(entry: KeyEntry, mark: Mark): Promise<void> {
		const t = this.now();
		if (mark.status === "rate_limited") {
			for (const [id, m] of this.cooling) if (m.until !== null && m.until <= t) this.cooling.delete(id);
			this.cooling.set(entry.id, mark);
			return;
		}
		// Read, modify and write under the lock so no other pool or pi process drops this mark.
		await withStateLock(this.stateFile, async () => {
			const state = await readState(this.stateFile);
			const marks = (state[this.service] ??= {});
			dropExpired(marks, t);
			marks[entry.id] = mark;
			await writeState(this.stateFile, state);
		});
	}

	/** Clear marks for the given key ids, or all marks of this service. */
	async clear(ids?: string[]): Promise<void> {
		if (ids) ids.forEach((id) => this.cooling.delete(id));
		else this.cooling.clear();
		await withStateLock(this.stateFile, async () => {
			const state = await readState(this.stateFile);
			const marks = state[this.service];
			if (!marks) return;
			for (const id of ids ?? Object.keys(marks)) delete marks[id];
			dropExpired(marks, this.now());
			if (Object.keys(marks).length === 0) delete state[this.service];
			await writeState(this.stateFile, state);
		});
	}
}

// ---------- failover ----------

export type Attempt<T> =
	| { ok: true; value: T }
	| { ok: false; status: number; message: string; retryAfter?: number };

/** How a failed HTTP status affects the key. null: the request itself failed; do not switch keys. */
export function verdictFor(status: number): MarkStatus | null {
	if (status === 401) return "invalid";
	if (status === 432 || status === 433) return "exhausted";
	if (status === 429) return "rate_limited";
	return null;
}

export class ApiError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export interface RotationResult<T> {
	value: T;
	/** The key that succeeded; null in keyless mode. Never put it in tool output. */
	key: string | null;
	via: string;
	/** Human-readable notes about switched keys and fallbacks. */
	notes: string[];
}

export interface RotationOptions {
	/** Fall back to a request without a key when no key works. */
	keyless: boolean;
	/** Called for every key switch, e.g. to notify the user. */
	onNote?: (note: string) => void;
	now?: () => number;
}

/**
 * Try the available keys in order. Exhausted (432/433), invalid (401) and rate-limited (429)
 * keys are marked and the next key is tried; any other failure is returned as is.
 */
export async function withRotation<T>(
	pool: KeyPool,
	run: (key: string | null) => Promise<Attempt<T>>,
	opts: RotationOptions,
): Promise<RotationResult<T>> {
	const now = opts.now ?? Date.now;
	const notes: string[] = [];
	const note = (text: string) => {
		notes.push(text);
		opts.onNote?.(text);
	};
	const snap = await pool.snapshot();
	for (const entry of snap.available) {
		const res = await run(entry.key);
		if (res.ok) return { value: res.value, key: entry.key, via: entry.label, notes };
		const status = verdictFor(res.status);
		if (!status) throw new ApiError(res.message, res.status);
		const until =
			status === "exhausted" ? nextMonthUtc(now()) : status === "rate_limited" ? now() + (res.retryAfter ?? 60) * 1000 : null;
		const what = `${pool.service} key "${entry.label}" ${status.replace("_", "-")} (${res.status})`;
		try {
			await pool.mark(entry, { status, until, reason: `${res.status}: ${res.message}`.slice(0, 200) });
			note(what);
		} catch (err) {
			// A failed state write must not stop the failover; the mark is only lost for later calls.
			note(`${what}; could not save the mark: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const total = snap.available.length + snap.skipped.length;
	const why = snap.missing ? "no key file" : total === 0 ? "no keys configured" : "no usable keys";
	if (!opts.keyless) {
		throw new ApiError(
			`${pool.service}: ${why}. Add keys to ${pool.keysFile} or check them with /search-keys.`,
		);
	}
	const res = await run(null);
	if (!res.ok) throw new ApiError(`${res.message} (keyless mode: ${why})`, res.status);
	note(`${pool.service}: ${why}, used keyless mode`);
	return { value: res.value, key: null, via: "keyless", notes };
}
