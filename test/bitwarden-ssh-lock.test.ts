// Cross-process lock (lock.ts): real processes with every backend available here (flock, perl; lockf only
// on macOS), plus command construction and backend choice per platform via injection.

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
	backendAvailable,
	chooseBackend,
	type LockBackend,
	LockTimeoutError,
	lockCommand,
	MACOS_LOCKF,
	NO_BACKEND,
	withFileLock,
} from "../extensions/bitwarden-ssh/lock.ts";

const root = mkdtempSync(join(tmpdir(), "pi-bw-lock-"));
after(() => rmSync(root, { recursive: true, force: true }));
const HOLDER = join(dirname(fileURLToPath(import.meta.url)), "bitwarden-ssh-lock-holder.ts");
const backends = (["flock", "lockf", "perl"] as LockBackend[]).filter(backendAvailable);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Holder {
	child: ChildProcess;
	lines: string[];
	next(prefix: string, ms?: number): Promise<string>;
	release(): void;
	exited: Promise<void>;
}

function holder(path: string, backend: LockBackend, timeoutMs = 30_000): Holder {
	const child = spawn(process.execPath, [HOLDER], {
		env: { ...process.env, LOCK_PATH: path, LOCK_BACKEND: backend, LOCK_TIMEOUT_MS: String(timeoutMs) },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const lines: string[] = [];
	let buf = "";
	const waiters: (() => void)[] = [];
	child.stdout!.on("data", (d: Buffer) => {
		buf += d.toString("utf8");
		const parts = buf.split("\n");
		buf = parts.pop()!;
		lines.push(...parts);
		for (const w of waiters.splice(0)) w();
	});
	const exited = new Promise<void>((r) => child.once("exit", () => r()));
	const next = async (prefix: string, ms = 20_000) => {
		const t0 = Date.now();
		for (;;) {
			const hit = lines.find((l) => l.startsWith(prefix));
			if (hit) return hit;
			if (Date.now() - t0 > ms) throw new Error(`no "${prefix}" line from holder within ${ms} ms (got ${JSON.stringify(lines)})`);
			await Promise.race([new Promise<void>((r) => waiters.push(r)), sleep(50)]);
		}
	};
	return { child, lines, next, exited, release: () => child.stdin!.write("release\n") };
}

/** Processes whose argv mentions `needle` (lock children left behind). */
function procsWith(needle: string): string[] {
	const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
	return r.stdout.split("\n").filter((l) => l.includes(needle) && !l.includes(" ps "));
}

test("lockCommand: flock (Linux), lockf (macOS) and perl command lines", () => {
	assert.deepEqual(lockCommand("flock", "/d/x.lock", 32), {
		cmd: "flock",
		args: ["-x", "-w", "32", "-E", "75", "/d/x.lock", "/bin/sh", "-c", "echo locked; exec cat >/dev/null"],
	});
	assert.deepEqual(lockCommand("lockf", "/d/x.lock", 31.2), {
		cmd: MACOS_LOCKF,
		args: ["-k", "-s", "-t", "32", "/d/x.lock", "/bin/sh", "-c", "echo locked; exec cat >/dev/null"],
	});
	const perl = lockCommand("perl", "/d/x.lock", 0.2);
	assert.equal(perl.cmd, "perl");
	assert.equal(perl.args[0], "-e");
	assert.match(perl.args[1], /flock\(\$f, LOCK_EX \| LOCK_NB\)/);
	assert.match(perl.args[1], /1 while <STDIN>/);
	assert.deepEqual(perl.args.slice(2), ["/d/x.lock", "1"]);
	// The perl script must at least compile here.
	if (backendAvailable("perl")) assert.equal(spawnSync("perl", ["-c", "-e", perl.args[1]], { encoding: "utf8" }).status, 0);
	// lockf never gets a flag that deletes the file; nothing gets an unlink step.
	assert.ok(!lockCommand("lockf", "/x", 1).args.includes("-n"));
});

test("chooseBackend: per platform by availability, clear error when none", () => {
	const only = (...b: LockBackend[]) => (x: LockBackend) => b.includes(x);
	assert.equal(chooseBackend("linux", only("flock", "perl", "lockf")), "flock");
	assert.equal(chooseBackend("linux", only("perl", "lockf")), "perl");
	assert.equal(chooseBackend("darwin", only("flock", "lockf", "perl")), "lockf");
	assert.equal(chooseBackend("darwin", only("flock", "perl")), "perl");
	assert.equal(chooseBackend("freebsd", only("perl")), "perl");
	assert.throws(() => chooseBackend("linux", only()), (e: Error) => e.message === NO_BACKEND && /flock \(Linux.*lockf \(macOS\).*perl/.test(e.message));
	assert.throws(() => chooseBackend("darwin", only("flock")), /needs flock/);
});

test("a backend is available on this machine", () => {
	assert.ok(backends.length > 0, NO_BACKEND);
	if (process.platform === "linux") assert.ok(backends.includes("flock") || backends.includes("perl"));
	if (process.platform === "darwin") assert.ok(backends.includes("lockf"));
});

for (const backend of backends) {
	test(`${backend}: in-process serialization, throw releases, timeout message, file kept with mode 600`, async () => {
		const lock = join(mkdtempSync(join(root, `${backend}-a-`)), "x.lock");
		const order: string[] = [];
		const hold = (name: string, ms: number) =>
			withFileLock(
				lock,
				async () => {
					order.push(`${name}+`);
					await sleep(ms);
					order.push(`${name}-`);
				},
				{ backend },
			);
		await Promise.all([hold("a", 150), sleep(20).then(() => hold("b", 10))]);
		assert.deepEqual(order, ["a+", "a-", "b+", "b-"]);
		const ino = statSync(lock).ino;
		assert.equal(statSync(lock).mode & 0o777, 0o600);
		await assert.rejects(withFileLock(lock, () => Promise.reject(new Error("boom")), { backend }), /boom/);
		// Released after the throw: the next one gets it at once.
		const t0 = Date.now();
		assert.equal(await withFileLock(lock, () => 7, { backend, timeoutMs: 2000 }), 7);
		assert.ok(Date.now() - t0 < 1500);
		await withFileLock(
			lock,
			async () => {
				await assert.rejects(withFileLock(lock, () => 1, { backend, timeoutMs: 300 }), (e: Error) => e instanceof LockTimeoutError && e.message === "another pi session holds x.lock; try again");
			},
			{ backend },
		);
		assert.equal(statSync(lock).ino, ino, "lock file is never replaced");
		assert.deepEqual(procsWith(lock), [], "no lock children left");
	});

	test(`${backend}: mutual exclusion between processes; a timed-out waiter leaves no child behind`, async () => {
		const lock = join(mkdtempSync(join(root, `${backend}-b-`)), "x.lock");
		const a = holder(lock, backend);
		await a.next("acquired");
		const ino = statSync(lock).ino;
		const b = holder(lock, backend, 400);
		assert.match(await b.next("timeout:"), /another pi session holds x\.lock; try again/);
		await b.exited;
		const c = holder(lock, backend);
		await sleep(300);
		assert.equal(c.lines.length, 0, "C waits while A holds");
		a.release();
		await a.next("released");
		const acquiredC = Number((await c.next("acquired", 5000)).split(" ")[1]);
		assert.ok(acquiredC > 0);
		assert.equal(statSync(lock).ino, ino, "same lock file inode across holders");
		c.release();
		await Promise.all([a.exited, c.exited]);
		// B's lock child must not have survived to take the lock later.
		assert.deepEqual(procsWith(lock), []);
		assert.equal(await withFileLock(lock, () => "free", { backend, timeoutMs: 1000 }), "free");
		assert.equal(statSync(lock).ino, ino);
	});

	test(`${backend}: holder killed with SIGKILL -> waiter acquires promptly`, async () => {
		const lock = join(mkdtempSync(join(root, `${backend}-c-`)), "x.lock");
		const a = holder(lock, backend);
		await a.next("acquired");
		const b = holder(lock, backend, 10_000);
		await sleep(200);
		assert.equal(b.lines.length, 0);
		const t0 = Date.now();
		a.child.kill("SIGKILL");
		await b.next("acquired", 5000);
		assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
		b.release();
		await b.exited;
		assert.ok(existsSync(lock));
	});
}

test("N1: a SIGSTOPped holder keeps the lock for > 10 s; the waiter never overlaps", { timeout: 60_000 }, async () => {
	// Old lease lock: after 10 s without heartbeat B broke A's lock and both ran their critical sections.
	await Promise.all(
		backends.map(async (backend) => {
			const lock = join(mkdtempSync(join(root, `${backend}-n1-`)), "x.lock");
			const a = holder(lock, backend);
			await a.next("acquired");
			const ino = statSync(lock).ino;
			process.kill(a.child.pid!, "SIGSTOP");
			const waiter = holder(lock, backend, 60_000);
			const timedOut = holder(lock, backend, 10_500);
			try {
				assert.match(await timedOut.next("timeout:", 15_000), /another pi session holds/);
				assert.equal(waiter.lines.length, 0, `${backend}: waiter entered while A was stopped`);
			} finally {
				process.kill(a.child.pid!, "SIGCONT");
			}
			await sleep(300);
			assert.equal(waiter.lines.length, 0, `${backend}: waiter entered while A resumed in its critical section`);
			a.release();
			await a.next("released");
			await waiter.next("acquired", 5000);
			waiter.release();
			await Promise.all([a.exited, waiter.exited, timedOut.exited]);
			assert.equal(statSync(lock).ino, ino);
		}),
	);
});

test("N2: concurrent contenders never overlap and the lock file is never renamed or deleted", { timeout: 60_000 }, async () => {
	// Old protocol: stale-lock recovery renamed a fresh holder's file aside and restored it over a third holder.
	for (const backend of backends) {
		const dir = mkdtempSync(join(root, `${backend}-n2-`));
		const lock = join(dir, "x.lock");
		const results = new Set<number>();
		let first: number | undefined;
		let inside = 0;
		let maxInside = 0;
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				withFileLock(
					lock,
					async () => {
						inside++;
						maxInside = Math.max(maxInside, inside);
						first ??= statSync(lock).ino;
						assert.equal(statSync(lock).ino, first);
						await sleep(5);
						results.add(i);
						inside--;
					},
					{ backend },
				),
			),
		);
		assert.equal(maxInside, 1);
		assert.equal(results.size, 8);
		// Cross-process: 4 holders in a row, each sees the same inode, none overlaps (each waits for the previous).
		const hs = Array.from({ length: 4 }, () => holder(lock, backend));
		const order: Holder[] = [];
		while (order.length < hs.length) {
			await Promise.race(hs.filter((h) => !order.includes(h)).map((h) => h.next("acquired").then(() => h)));
			const live = hs.filter((h) => !order.includes(h) && h.lines.some((l) => l.startsWith("acquired")));
			assert.equal(live.length, 1, `${backend}: exactly one cross-process holder`);
			assert.equal(statSync(lock).ino, first);
			live[0].release();
			await live[0].next("released");
			order.push(live[0]);
		}
		await Promise.all(hs.map((h) => h.exited));
		assert.equal(statSync(lock).ino, first);
	}
});
