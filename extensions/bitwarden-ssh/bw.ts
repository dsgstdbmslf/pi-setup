// Bitwarden CLI wrapper. The session key lives only in this process's memory (a globalThis singleton, so
// it survives /new, /resume, /fork and /reload) and only reaches bw children through their environment.
// It is never put into process.env, files, argv, tool results or notifications.

import { failure, type RunResult, run } from "./exec.ts";

export type BwStatus = "unauthenticated" | "locked" | "unlocked";

export interface StatusInfo {
	status: BwStatus;
	userEmail?: string;
	serverUrl?: string;
	lastSync?: string;
}

export type BwErrorKind = "missing" | "locked" | "unauthenticated" | "needs2fa" | "failed";

export class BwError extends Error {
	kind: BwErrorKind;
	constructor(kind: BwErrorKind, message: string) {
		super(message);
		this.kind = kind;
	}
}

export interface SshKeyItem {
	id: string;
	name: string;
	fingerprint: string;
	publicKey: string;
	/** Secret: keep only in local variables of the caller. */
	privateKey: string;
}

interface Shared {
	session?: string;
	lockTimer?: ReturnType<typeof setTimeout>;
	lockAt?: number;
	/** Called after an auto-lock (replaced on every session_start). */
	onAutoLock?: () => void;
	/** Called whenever the session is forgotten or set (footer refresh). */
	onChange?: () => void;
}

const KEY = Symbol.for("pi.bitwarden-ssh.bw");

export function shared(): Shared {
	const g = globalThis as any;
	return (g[KEY] ??= {});
}

export interface BwOptions {
	bin?: string;
	/** Idle minutes before the session is forgotten; 0 = never. */
	autoLockMinutes?: () => number;
	timeoutMs?: number;
}

const SCRUB = ["BW_PASSWORD", "BW_CLIENTSECRET", "BW_CLIENTID", "BW_SESSION"];

export class Bitwarden {
	bin: string;
	autoLockMinutes: () => number;
	timeoutMs: number;

	constructor(opts: BwOptions = {}) {
		this.bin = opts.bin ?? "bw";
		this.autoLockMinutes = opts.autoLockMinutes ?? (() => 30);
		this.timeoutMs = opts.timeoutMs ?? 120_000;
	}

	get unlocked(): boolean {
		return !!shared().session;
	}

	/** Environment for one bw child: no inherited secrets except a BW_SESSION the user exported themselves. */
	env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env };
		const inherited = env.BW_SESSION;
		for (const k of SCRUB) delete env[k];
		env.BW_NOINTERACTION = "true";
		const session = shared().session ?? inherited;
		if (session) env.BW_SESSION = session;
		return { ...env, ...extra };
	}

	forget(): void {
		const s = shared();
		const had = !!s.session;
		s.session = undefined;
		if (s.lockTimer) clearTimeout(s.lockTimer);
		s.lockTimer = undefined;
		s.lockAt = undefined;
		if (had) s.onChange?.();
	}

	private setSession(key: string): void {
		const s = shared();
		s.session = key;
		this.touch();
		s.onChange?.();
	}

	/** Reset the idle auto-lock timer (only while unlocked). */
	touch(): void {
		const s = shared();
		if (s.lockTimer) clearTimeout(s.lockTimer);
		s.lockTimer = undefined;
		s.lockAt = undefined;
		const min = this.autoLockMinutes();
		if (!s.session || !(min > 0)) return;
		s.lockAt = Date.now() + min * 60_000;
		s.lockTimer = setTimeout(() => {
			this.forget();
			s.onAutoLock?.();
		}, min * 60_000);
		s.lockTimer.unref?.();
	}

	/** Milliseconds until auto-lock, or undefined when locked or auto-lock is off. */
	lockRemaining(): number | undefined {
		const at = shared().lockAt;
		return at ? Math.max(0, at - Date.now()) : undefined;
	}

	/** Run bw; classifies errors and forgets an invalid session. */
	async call(args: string[], opts: { input?: string; extraEnv?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
		const r = await run(this.bin, args, {
			env: this.env(opts.extraEnv),
			input: opts.input,
			timeoutMs: opts.timeoutMs ?? this.timeoutMs,
		});
		if (r.error?.includes("command not found")) throw new BwError("missing", "bw (Bitwarden CLI) is not installed or not in PATH");
		if (r.code === 0 && !r.error) {
			if (this.unlocked) this.touch();
			return r;
		}
		const err = r.stderr;
		if (/vault is locked|invalid session|session key is invalid/i.test(err)) {
			this.forget();
			throw new BwError("locked", "Vault is locked (the session ended, e.g. after bw unlock in another process). Run /bw unlock.");
		}
		if (/not logged in|you are not logged in/i.test(err)) {
			this.forget();
			throw new BwError("unauthenticated", "Not logged in to Bitwarden. Run /bw login.");
		}
		throw new BwError("failed", failure(r, `bw ${args[0]}`));
	}

	async status(): Promise<StatusInfo> {
		const r = await this.call(["status"], { timeoutMs: 30_000 });
		let j: any;
		try {
			j = JSON.parse(r.stdout);
		} catch {
			throw new BwError("failed", "bw status: unexpected output");
		}
		const status: BwStatus = j.status === "unlocked" || j.status === "locked" ? j.status : "unauthenticated";
		// Our own session ended elsewhere (e.g. bw unlock in another pi): forget it.
		if (status !== "unlocked" && this.unlocked) this.forget();
		return {
			status,
			userEmail: typeof j.userEmail === "string" ? j.userEmail : undefined,
			serverUrl: typeof j.serverUrl === "string" ? j.serverUrl : undefined,
			lastSync: typeof j.lastSync === "string" ? j.lastSync : undefined,
		};
	}

	async loginApiKey(clientId: string, clientSecret: string): Promise<void> {
		await this.call(["login", "--apikey"], { extraEnv: { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret } });
	}

	/** Log in with email + master password; stores the session. Throws BwError("needs2fa") when a code is needed. */
	async loginPassword(email: string, password: string, twoFactor?: { method: 0 | 1 | 3; code: string }): Promise<void> {
		const args = ["login", email, "--passwordenv", "BW_PASSWORD", "--raw"];
		if (twoFactor) args.push("--method", String(twoFactor.method), "--code", twoFactor.code);
		let r: RunResult;
		try {
			r = await this.call(args, { extraEnv: { BW_PASSWORD: password } });
		} catch (err) {
			if (err instanceof BwError && err.kind === "failed" && !twoFactor && /two.?step|two.?factor|code is required|verification code|\b2fa\b/i.test(err.message))
				throw new BwError("needs2fa", "Two-step login code required");
			throw err;
		}
		const key = r.stdout.trim();
		if (!key) throw new BwError("failed", "bw login returned no session key");
		this.setSession(key);
	}

	async unlock(password: string): Promise<void> {
		let r: RunResult;
		try {
			r = await this.call(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { extraEnv: { BW_PASSWORD: password } });
		} catch (err) {
			if (err instanceof BwError && err.kind === "failed" && /decrypt|invalid master password|cryptography/i.test(err.message))
				throw new BwError("failed", "Invalid master password");
			throw err;
		}
		const key = r.stdout.trim();
		if (!key) throw new BwError("failed", "bw unlock returned no session key");
		this.setSession(key);
	}

	async lock(): Promise<void> {
		try {
			await this.call(["lock"], { timeoutMs: 30_000 });
		} finally {
			this.forget();
		}
	}

	async logout(): Promise<void> {
		try {
			await this.call(["logout"], { timeoutMs: 30_000 });
		} finally {
			this.forget();
		}
	}

	async setServer(url: string): Promise<void> {
		const st = await this.status();
		if (st.status !== "unauthenticated") throw new BwError("failed", "Log out first (/bw logout): the server can only change while logged out");
		if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new BwError("failed", "Server must be an http(s) URL");
		await this.call(["config", "server", url], { timeoutMs: 30_000 });
	}

	async sync(): Promise<void> {
		await this.call(["sync"]);
	}

	private requireUnlocked(): void {
		// A BW_SESSION the user exported before starting pi also counts (bw then reports the vault state).
		if (!this.unlocked && !process.env.BW_SESSION) throw new BwError("locked", "Vault is locked. Run /bw unlock.");
	}

	private async items(args: string[]): Promise<any[]> {
		this.requireUnlocked();
		const r = await this.call(["list", "items", ...args]);
		try {
			const j = JSON.parse(r.stdout);
			return Array.isArray(j) ? j : [];
		} catch {
			throw new BwError("failed", "bw list items: unexpected output");
		}
	}

	/** All SSH key items. The result holds private keys: never store, log or return it to the model. */
	async listSshKeys(): Promise<SshKeyItem[]> {
		const all = await this.items([]);
		return all
			.filter((i) => i && i.type === 5 && i.sshKey && typeof i.sshKey.privateKey === "string")
			.map((i) => ({
				id: String(i.id),
				name: String(i.name ?? ""),
				fingerprint: String(i.sshKey.keyFingerprint ?? ""),
				publicKey: String(i.sshKey.publicKey ?? ""),
				privateKey: String(i.sshKey.privateKey),
			}));
	}

	/** The secure note with exactly this name (case-sensitive), or undefined. Throws if several match. */
	async findNote(name: string): Promise<{ id: string; name: string; notes: string } | undefined> {
		const found = (await this.items(["--search", name])).filter((i) => i && i.type === 2 && i.name === name);
		if (found.length > 1) throw new BwError("failed", `Several secure notes are named "${name}"; rename or delete the extra ones`);
		const n = found[0];
		return n ? { id: String(n.id), name: String(n.name), notes: String(n.notes ?? "") } : undefined;
	}

	async getItem(id: string): Promise<any> {
		this.requireUnlocked();
		const r = await this.call(["get", "item", id]);
		try {
			return JSON.parse(r.stdout);
		} catch {
			throw new BwError("failed", "bw get item: unexpected output");
		}
	}

	/** Update the note's text (existingId) or create a new secure note. Returns the item id. */
	async saveNote(name: string, text: string, existingId?: string): Promise<string> {
		this.requireUnlocked();
		let item: any;
		if (existingId) {
			item = await this.getItem(existingId);
			if (item.type !== 2) throw new BwError("failed", `item ${existingId} is not a secure note`);
			item.notes = text;
		} else {
			const r = await this.call(["get", "template", "item"]);
			item = JSON.parse(r.stdout);
			Object.assign(item, { type: 2, name, notes: text, secureNote: { type: 0 }, login: null, card: null, identity: null, fields: [] });
		}
		const input = Buffer.from(JSON.stringify(item), "utf8").toString("base64");
		const r = existingId ? await this.call(["edit", "item", existingId], { input }) : await this.call(["create", "item"], { input });
		try {
			return String(JSON.parse(r.stdout).id ?? existingId ?? "");
		} catch {
			return existingId ?? "";
		}
	}
}
