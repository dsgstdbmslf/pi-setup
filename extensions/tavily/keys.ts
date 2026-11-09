// Shared API key store with failover. No pi imports, so tests run without node_modules.
//
// Keys:  ~/.pi/agent/api-keys.json   { "<service>": ["key", { "key": "...", "label": "...", "disabled": true }] }
// State: ~/.pi/agent/api-keys-state/<service>/<fingerprint>.json   one small file per marked key (exhausted or
//        invalid), never the key. One file per key means no read-modify-write, so no lock is needed.

import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeMessage } from "./client.ts";
import { checkPrivateDir, ensurePrivateDir } from "./output.ts";

export const KEYS_FILE = "api-keys.json";
export const STATE_DIR = "api-keys-state";

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

const ID_RE = /^[0-9a-f]{12}$/;
/** Mark files only; temp files start with a dot and never match. */
const MARK_FILE_RE = /^[0-9a-f]{12}\.json$/;

function isMark(m: any): m is Mark {
	return (
		!!m &&
		(m.status === "exhausted" || m.status === "invalid" || m.status === "rate_limited") &&
		(m.until === null || typeof m.until === "number") &&
		typeof m.reason === "string"
	);
}

/**
 * Rate-limit marks in memory, shared by every KeyPool with the same state dir and service.
 * Pi loads each extension with its own module cache, so a module-level Map would not be
 * shared between web-search, web-fetch and web-research; globalThis is.
 */
const COOLING = Symbol.for("pi-setup.tavily.cooling");

function sharedCooling(stateDir: string, service: string): Map<string, Mark> {
	const registry: Map<string, Map<string, Mark>> = ((globalThis as any)[COOLING] ??= new Map());
	const id = `${stateDir}\0${service}`;
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
	/** The state directory could not be trusted (symlink, foreign owner); persistent marks are ignored. */
	stateWarning?: string;
}

/** Keys of one service in file order, minus the ones marked unusable. */
export class KeyPool {
	/** Rate limits are short-lived, so they stay in memory (shared across extensions). */
	private cooling: Map<string, Mark>;

	readonly service: string;
	readonly keysFile: string;
	readonly stateDir: string;
	private now: () => number;

	constructor(service: string, keysFile: string, stateDir: string, now: () => number = Date.now) {
		// The service becomes a path segment.
		if (!/^[a-z0-9_-]+$/i.test(service)) throw new Error(`invalid service name: ${service}`);
		this.service = service;
		this.keysFile = keysFile;
		this.stateDir = stateDir;
		this.now = now;
		this.cooling = sharedCooling(stateDir, service);
	}

	private get serviceDir(): string {
		return join(this.stateDir, this.service);
	}

	/** ids come from fingerprint(), but clear() takes external input, so check before building a path. */
	private markPath(id: string): string {
		if (!ID_RE.test(id)) throw new Error(`invalid key id: ${id}`);
		return join(this.serviceDir, `${id}.json`);
	}

	/**
	 * Validate stateDir, then serviceDir. They live in ~/.pi/agent, but a pre-existing loose directory
	 * or a symlink would move marks outside it (or expose them). Returns false when a directory is
	 * missing and create is off; throws when one cannot be trusted.
	 */
	private async dirs(create: boolean): Promise<boolean> {
		for (const dir of [this.stateDir, this.serviceDir]) {
			if (create) await ensurePrivateDir(dir);
			else if (!(await checkPrivateDir(dir))) return false;
		}
		return true;
	}

	/** Persistent marks by key id. Missing, unreadable or malformed files simply mean "not marked". */
	private async readMarks(): Promise<{ marks: Record<string, Mark>; warning?: string }> {
		const marks: Record<string, Mark> = {};
		try {
			if (!(await this.dirs(false))) return { marks };
		} catch (err) {
			// Keep failover working; the caller reports it.
			return { marks, warning: `${err instanceof Error ? err.message : String(err)}; saved key marks are ignored` };
		}
		const names = await readdir(this.serviceDir).catch(() => [] as string[]);
		for (const name of names) {
			if (!MARK_FILE_RE.test(name)) continue;
			try {
				const file = join(this.serviceDir, name);
				if (!(await lstat(file)).isFile()) continue; // a symlinked mark file is not read
				const mark = JSON.parse(await readFile(file, "utf8"));
				if (isMark(mark)) marks[name.slice(0, -5)] = mark;
			} catch {
				// corrupt or removed meanwhile
			}
		}
		return { marks };
	}

	/** Write to a temp file and rename: readers see the old or the new mark, never a partial one. */
	private async writeMark(id: string, mark: Mark): Promise<void> {
		const file = this.markPath(id);
		await this.dirs(true);
		const tmp = join(this.serviceDir, `.${id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
		try {
			await writeFile(tmp, `${JSON.stringify(mark)}\n`, { mode: 0o600, flag: "wx" });
			await rename(tmp, file);
		} catch (err) {
			await rm(tmp, { force: true });
			throw err;
		}
	}

	async snapshot(): Promise<PoolSnapshot> {
		const { entries, missing, insecure, malformed } = await loadKeys(this.keysFile, this.service);
		const { marks, warning: stateWarning } = await this.readMarks();
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
		return { available, skipped, missing, insecure, malformed, ...(stateWarning && { stateWarning }) };
	}

	async mark(entry: KeyEntry, mark: Mark): Promise<void> {
		const t = this.now();
		if (mark.status === "rate_limited") {
			for (const [id, m] of this.cooling) if (m.until !== null && m.until <= t) this.cooling.delete(id);
			this.cooling.set(entry.id, mark);
			return;
		}
		// One file per key: no read-modify-write, so concurrent marks of different keys cannot interfere
		// and two marks of the same key are last-writer-wins. Expired files are not deleted automatically
		// (read, see expired, rm could remove a fresh mark written in between); snapshot() ignores them
		// and the next mark of the key overwrites them.
		await this.writeMark(entry.id, mark);
	}

	/** Clear marks for the given key ids, or all marks of this service. */
	async clear(ids?: string[]): Promise<void> {
		if (ids) ids.forEach((id) => this.cooling.delete(id));
		else this.cooling.clear();
		// A validation error propagates: never delete through a symlink.
		if (!(await this.dirs(false))) return;
		const files = ids
			? ids.filter((id) => ID_RE.test(id)).map((id) => this.markPath(id))
			: (await readdir(this.serviceDir).catch(() => [] as string[])).filter((n) => MARK_FILE_RE.test(n)).map((n) => join(this.serviceDir, n));
		for (const file of files) await rm(file, { force: true });
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
		// run() is expected to redact already; this guards what is thrown and what lands on disk (fail closed).
		const message = safeMessage(res.message, entry.key);
		const status = verdictFor(res.status);
		if (!status) throw new ApiError(message, res.status);
		const until =
			status === "exhausted" ? nextMonthUtc(now()) : status === "rate_limited" ? now() + (res.retryAfter ?? 60) * 1000 : null;
		const what = `${pool.service} key "${entry.label}" ${status.replace("_", "-")} (${res.status})`;
		try {
			await pool.mark(entry, { status, until, reason: `${res.status}: ${message}`.slice(0, 200) });
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
	if (!res.ok) throw new ApiError(`${safeMessage(res.message, null)} (keyless mode: ${why})`, res.status);
	note(`${pool.service}: ${why}, used keyless mode`);
	return { value: res.value, key: null, via: "keyless", notes };
}
