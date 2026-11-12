// The shared ssh-agent: one per user at a fixed socket, reused by every pi process and surviving pi
// restarts. Keys are added with a lifetime (ssh-add -t). Private keys travel to ssh-add only via stdin.

import { lstatSync, unlinkSync } from "node:fs";
import { failure, run } from "./exec.ts";
import { type LockOptions, withFileLock } from "./lock.ts";

export interface LoadedKey {
	fingerprint: string;
	comment: string;
	type: string;
	bits?: number;
}

function envFor(sock: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...process.env, SSH_AUTH_SOCK: sock, ...extra };
}

/** 0 = agent has keys, 1 = agent has no keys, 2 = cannot connect, null = ssh-add missing. */
export async function probe(sock: string): Promise<number | null> {
	const r = await run("ssh-add", ["-l"], { env: envFor(sock), timeoutMs: 10_000 });
	if (r.error) return null;
	return r.code;
}

export interface EnsureResult {
	sock: string;
	started: boolean;
	/** Pid of a newly started agent (parsed from ssh-agent's output; informational). */
	pid?: number;
}

/**
 * Reuse a live agent at `sock` or start one there (`ssh-agent -a sock`, it daemonizes itself). Startup is
 * serialized across pi processes with the advisory lock on `<sock>.lock`: the probe is repeated under the lock, and
 * the socket is only unlinked when that probe still cannot connect, so a concurrent pi that just started the
 * agent (and maybe loaded keys) never loses its socket.
 */
export async function ensureAgent(sock: string, lockOpts: LockOptions = {}): Promise<EnsureResult> {
	const first = await probe(sock);
	if (first === null) throw new Error("ssh-add not found (install OpenSSH client)");
	if (first === 0 || first === 1) return { sock, started: false };
	return withFileLock(
		`${sock}.lock`,
		async () => {
			const again = await probe(sock);
			if (again === null) throw new Error("ssh-add not found (install OpenSSH client)");
			if (again === 0 || again === 1) return { sock, started: false };
			if (again !== 2) throw new Error(`ssh-add -l exit ${again} for ${sock}`);
			// Stale socket from a dead agent: remove it (only if it really is a socket).
			try {
				const st = lstatSync(sock);
				if (st.isSocket()) unlinkSync(sock);
				else throw new Error(`${sock} exists and is not a socket`);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			const r = await run("ssh-agent", ["-a", sock, "-s"], { timeoutMs: 15_000 });
			const third = await probe(sock);
			if (third === 0 || third === 1) {
				const pid = Number(/SSH_AGENT_PID=(\d+)/.exec(r.stdout)?.[1]);
				return { sock, started: r.code === 0, pid: Number.isFinite(pid) ? pid : undefined };
			}
			throw new Error(failure(r, "ssh-agent"));
		},
		lockOpts,
	);
}

/** Parse `ssh-add -l -E sha256` output. */
export function parseList(stdout: string): LoadedKey[] {
	const out: LoadedKey[] = [];
	for (const line of stdout.split("\n")) {
		const m = /^(\d+)\s+(\S+)\s+(.*?)\s*\(([^()]+)\)\s*$/.exec(line.trim());
		if (m) out.push({ bits: Number(m[1]), fingerprint: m[2], comment: m[3], type: m[4] });
	}
	return out;
}

export async function listLoaded(sock: string): Promise<LoadedKey[]> {
	const r = await run("ssh-add", ["-l", "-E", "sha256"], { env: envFor(sock), timeoutMs: 10_000 });
	if (r.code === 1) return [];
	if (r.code !== 0) throw new Error(failure(r, "ssh-add -l"));
	return parseList(r.stdout);
}

/**
 * Add a private key from stdin. A passphrase-protected key makes ssh-add ask through SSH_ASKPASS (our
 * bridge), forced by SSH_ASKPASS_REQUIRE=force (prefer needs DISPLAY).
 */
export async function addKey(sock: string, privateKey: string, ttl: string): Promise<void> {
	const args = ttl ? ["-t", ttl, "-"] : ["-"];
	const input = privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`;
	const r = await run("ssh-add", args, {
		env: envFor(sock, { SSH_ASKPASS_REQUIRE: "force" }),
		input,
		timeoutMs: 300_000, // a passphrase dialog may be open
	});
	if (r.code !== 0) throw new Error(failure(r, "ssh-add"));
}

export async function removeKey(sock: string, publicKey: string): Promise<void> {
	const input = publicKey.endsWith("\n") ? publicKey : `${publicKey}\n`;
	const r = await run("ssh-add", ["-d", "-"], { env: envFor(sock), input, timeoutMs: 10_000 });
	if (r.code !== 0) throw new Error(failure(r, "ssh-add -d"));
}

export async function clearKeys(sock: string): Promise<void> {
	const r = await run("ssh-add", ["-D"], { env: envFor(sock), timeoutMs: 10_000 });
	if (r.code !== 0) throw new Error(failure(r, "ssh-add -D"));
}
