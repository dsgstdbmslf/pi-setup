// Cross-process lock: an exclusive lock file created with O_EXCL ("wx"). The holder refreshes its mtime
// while it holds the lock; a lock whose holder pid is gone or whose mtime is older than staleMs is broken.
// Used for the shared ssh-agent startup and for source config / state writes shared by pi processes.

import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface LockOptions {
	/** A lock file not refreshed for this long counts as stale (default 10 s). */
	staleMs?: number;
	/** Give up waiting after this long (default 30 s). */
	timeoutMs?: number;
	/** Poll interval while waiting (default 50 ms). */
	pollMs?: number;
}

export class LockTimeoutError extends Error {}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function tryCreate(path: string, token: string): boolean {
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeSync(fd, `${process.pid} ${token}\n`);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
}

/** Remove a stale lock. Rename first, so two waiters cannot both break it and delete a fresh lock. */
function breakIfStale(path: string, staleMs: number): void {
	let st: ReturnType<typeof statSync>;
	let pid: number;
	try {
		st = statSync(path);
		pid = Number(readFileSync(path, "utf8").split(" ")[0]);
	} catch {
		return; // gone already: retry the create
	}
	const age = Date.now() - st.mtimeMs;
	// A just-created file may not have its pid yet: only a fresh-enough mtime protects it then.
	const dead = Number.isInteger(pid) && pid > 0 && pid !== process.pid && !pidAlive(pid);
	if (!dead && age < staleMs) return;
	const aside = `${path}.stale-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(path, aside);
	} catch {
		return;
	}
	try {
		const st2 = statSync(aside);
		// Someone replaced the lock between our stat and the rename: we moved a live lock. Put it back
		// unless the path is taken again (then the live holder lost it; it re-checks nothing, accept that).
		if (st2.ino !== st.ino) {
			try {
				renameSync(aside, path);
			} catch {}
			return;
		}
		unlinkSync(aside);
	} catch {}
}

/** Run fn while holding the lock file `path`. */
export async function withFileLock<T>(path: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
	const staleMs = opts.staleMs ?? 10_000;
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const pollMs = opts.pollMs ?? 50;
	const start = Date.now();
	const token = randomBytes(8).toString("hex");
	while (!tryCreate(path, token)) {
		breakIfStale(path, staleMs);
		if (Date.now() - start > timeoutMs) throw new LockTimeoutError(`timed out waiting for the lock ${path} (another pi session holds it)`);
		await new Promise((r) => setTimeout(r, pollMs));
	}
	const beat = setInterval(
		() => {
			try {
				const now = new Date();
				utimesSync(path, now, now);
			} catch {}
		},
		Math.max(200, Math.floor(staleMs / 3)),
	);
	beat.unref?.();
	try {
		return await fn();
	} finally {
		clearInterval(beat);
		try {
			if (readFileSync(path, "utf8").trim() === `${process.pid} ${token}`) unlinkSync(path);
		} catch {}
	}
}
