// Cross-process lock: a kernel advisory lock (flock(2)) on a lock file, held by a small child process for as
// long as it lives. The child prints "locked" once it holds the lock and then blocks reading its stdin;
// release = end its stdin (kill as fallback). The child also watches its stdin while it is still WAITING:
// if pi dies (even by SIGKILL), the pipe closes and the child exits at once, waiting or holding, and the
// kernel drops any lock it held. A live holder is never broken (a stopped or slow pi keeps its lock;
// waiters time out), and lock files are never renamed or deleted, so there is no staleness logic and no
// recovery race. Used for the shared ssh-agent startup and for source config / state writes shared by pi processes.
//
// Backends (chosen once per process, by availability): Linux `flock` (util-linux), macOS `/usr/bin/lockf`
// (BSD; -k keeps the file), else `perl` (Fcntl flock). All three take flock(2) locks.
//
// Parent-death watch while waiting:
// - flock/lockf: run inside a `/bin/sh` wrapper (its own process group, as the child is spawned detached).
//   The wrapper starts `cat` on a copy of the pipe in the background, then execs the locker; when `cat`
//   sees EOF it kills the whole process group (`kill -s KILL 0`): the waiting or holding locker, its
//   holding shell, and itself. Only POSIX sh features, so the same on Linux and macOS.
// - perl: the acquisition loop tries LOCK_NB and, between attempts, waits up to 50 ms for stdin with
//   select(); EOF there exits before the lock is taken.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname } from "node:path";

export type LockBackend = "flock" | "lockf" | "perl";

export interface LockOptions {
	/** Give up waiting after this long (default 30 s). The holder is never broken. */
	timeoutMs?: number;
	/** Force a backend (tests); default: detected once per process. */
	backend?: LockBackend;
}

export class LockTimeoutError extends Error {}

/** Marker the lock child prints once it holds the lock. */
export const LOCKED_MARKER = "locked";
const HOLD_SH = `echo ${LOCKED_MARKER}; exec cat >/dev/null`;
/**
 * `/bin/sh -c WATCH_SH sh <locker...>`: fd 3 = the stdin pipe from pi (a background job's own stdin is
 * /dev/null in a non-interactive sh); on its EOF kill the process group. The locker gets the pipe as stdin.
 */
export const WATCH_SH = 'exec 3<&0; { cat >/dev/null; kill -s KILL 0; } <&3 & exec 3<&- "$@"';
export const MACOS_LOCKF = "/usr/bin/lockf";
// Non-blocking attempts until the deadline, waiting up to 50 ms on stdin between them (EOF: pi is gone,
// exit without the lock); then hold until stdin ends.
const PERL_SCRIPT =
	'use strict; use Fcntl qw(:flock); my ($p, $t) = @ARGV; open(my $f, ">>", $p) or die "open $p: $!\\n"; ' +
	"my $end = time + $t; my $b; until (flock($f, LOCK_EX | LOCK_NB)) { if (time >= $end) { print STDERR \"timeout\\n\"; exit 75 } " +
	"my $r = ''; vec($r, fileno(STDIN), 1) = 1; if (select($r, undef, undef, 0.05) > 0) { exit 0 unless sysread(STDIN, $b, 4096) } } " +
	`$| = 1; print "${LOCKED_MARKER}\\n"; 1 while sysread(STDIN, $b, 4096);`;

export interface LockCommand {
	cmd: string;
	args: string[];
}

/** The command that takes and holds the lock on `path`, waiting at most `timeoutSec` (backstop timeout). */
export function lockCommand(backend: LockBackend, path: string, timeoutSec: number): LockCommand {
	const t = String(Math.max(1, Math.ceil(timeoutSec)));
	switch (backend) {
		case "flock":
			return { cmd: "/bin/sh", args: ["-c", WATCH_SH, "sh", "flock", "-x", "-w", t, "-E", "75", path, "/bin/sh", "-c", HOLD_SH] };
		case "lockf":
			// BSD lockf exits 75 on timeout. -k: keep the lock file (deleting it would break mutual exclusion), -s: silent, -t: timeout.
			return { cmd: "/bin/sh", args: ["-c", WATCH_SH, "sh", MACOS_LOCKF, "-k", "-s", "-t", t, path, "/bin/sh", "-c", HOLD_SH] };
		case "perl":
			return { cmd: "perl", args: ["-e", PERL_SCRIPT, path, t] };
	}
}

export const NO_BACKEND = "Cross-process locking needs flock (Linux, util-linux), lockf (macOS) or perl; none was found on PATH";

/** Preferred backend for a platform among the available ones; throws when none exists. */
export function chooseBackend(platform: NodeJS.Platform, available: (b: LockBackend) => boolean): LockBackend {
	const order: LockBackend[] = platform === "linux" ? ["flock", "perl"] : platform === "darwin" ? ["lockf", "perl"] : ["perl"];
	for (const b of order) if (available(b)) return b;
	throw new Error(NO_BACKEND);
}

function minimalEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH || "/usr/bin:/bin" };
	if (process.env.HOME) env.HOME = process.env.HOME;
	if (process.env.LANG) env.LANG = process.env.LANG;
	return env;
}

/** Real availability probe. util-linux flock only: busybox flock has no -w. */
export function backendAvailable(b: LockBackend): boolean {
	const opts = { env: minimalEnv(), encoding: "utf8" as const, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
	switch (b) {
		case "flock": {
			const r = spawnSync("flock", ["--version"], opts);
			return r.status === 0 && /util-linux/.test(`${r.stdout}${r.stderr}`);
		}
		case "lockf":
			try {
				accessSync(MACOS_LOCKF, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		case "perl":
			return spawnSync("perl", ["-MFcntl=:flock", "-e", "1"], opts).status === 0;
	}
}

// Process-wide state, shared by every module generation (pi reloads extensions without a module cache):
// the detected backend, the lock children (waiting or holding, killed when the process exits) and the
// one exit hook.
interface LockGlobal {
	backend?: LockBackend;
	children: Set<ChildProcess>;
	exitHook: boolean;
}
const G: LockGlobal = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi.bitwarden-ssh.lock")] ??= {
	children: new Set<ChildProcess>(),
	exitHook: false,
}) as LockGlobal;

/** The backend of this process (probed once per process, cached). */
export function lockBackend(): LockBackend {
	G.backend ??= chooseBackend(process.platform, backendAvailable);
	return G.backend;
}

function killGroup(child: ChildProcess): void {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, "SIGKILL"); // detached: the child leads its own process group (sh, cat)
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
}
function track(child: ChildProcess): void {
	G.children.add(child);
	if (!G.exitHook) {
		G.exitHook = true;
		const children = G.children;
		process.on("exit", () => {
			for (const c of children) {
				if (!c.pid) continue;
				try {
					process.kill(-c.pid, "SIGKILL");
				} catch {}
			}
		});
	}
}

/** Create the lock file (mode 600, never deleted). Refuses a symlink. */
function prepareLockFile(path: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Error(`${path} is not a regular file`);
		if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
	} finally {
		closeSync(fd);
	}
}

interface Held {
	release(): Promise<void>;
}

function acquire(path: string, timeoutMs: number, backend: LockBackend): Promise<Held> {
	prepareLockFile(path);
	const { cmd, args } = lockCommand(backend, path, timeoutMs / 1000 + 2);
	const name = basename(path);
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			// Own process group (terminal signals such as Ctrl+C do not reach it), minimal env, pipes only.
			child = spawn(cmd, args, { env: minimalEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
		} catch (err) {
			reject(new Error(`lock helper ${cmd}: ${err instanceof Error ? err.message : String(err)}`));
			return;
		}
		track(child);
		let out = "";
		let err = "";
		let state: "waiting" | "held" | "done" = "waiting";
		const closed = new Promise<void>((res) => child.once("close", () => res()));
		closed.then(() => G.children.delete(child));
		const stop = () => {
			try {
				child.stdin?.end();
			} catch {}
			killGroup(child);
		};
		const fail = (e: Error) => {
			if (state !== "waiting") return;
			state = "done";
			clearTimeout(timer);
			stop();
			reject(e);
		};
		const timer = setTimeout(() => fail(new LockTimeoutError(`another pi session holds ${name}; try again`)), timeoutMs);
		child.stdin?.on("error", () => {});
		child.stderr?.on("data", (d: Buffer) => {
			if (err.length < 4096) err += d.toString("utf8");
		});
		child.stdout?.on("data", (d: Buffer) => {
			if (state !== "waiting") return;
			out += d.toString("utf8");
			if (!out.split("\n").slice(0, -1).includes(LOCKED_MARKER)) return;
			state = "held";
			clearTimeout(timer);
			let releasing: Promise<void> | undefined;
			resolve({
				release: () => {
					releasing ??= (async () => {
						state = "done";
						try {
							child.stdin?.end();
						} catch {}
						// Normally the child exits at once on EOF; kill the group if it does not.
						const t = setTimeout(() => killGroup(child), 1000);
						await closed;
						clearTimeout(t);
					})();
					return releasing;
				},
			});
		});
		child.on("error", (e: NodeJS.ErrnoException) =>
			fail(new Error(e.code === "ENOENT" ? `lock helper ${cmd} not found. ${NO_BACKEND}` : `lock helper ${cmd}: ${e.message}`)),
		);
		child.on("exit", (code, signal) => {
			const line = err.split("\n").map((l) => l.trim()).filter(Boolean).pop();
			fail(
				code === 75 // EX_TEMPFAIL: flock -E 75, BSD lockf and our perl script on timeout
					? new LockTimeoutError(`another pi session holds ${name}; try again`)
					: new Error(`lock helper ${backend} exited (${signal ?? code})${line ? `: ${line.slice(0, 200)}` : ""}`),
			);
		});
	});
}

/** Run fn while holding the advisory lock on `path`. The lock is released when fn settles (also on throw). */
export async function withFileLock<T>(path: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
	const held = await acquire(path, opts.timeoutMs ?? 30_000, opts.backend ?? lockBackend());
	try {
		return await fn();
	} finally {
		await held.release();
	}
}
