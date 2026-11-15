// Root through password dialogs (root.ts) and the journal wiring. ssh is replaced by running the script
// locally with a fake `sudo` that accepts only the password "secret" from stdin.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournal, formatLog, readJournal } from "../extensions/netbird-devices/journal.ts";
import type { Conn } from "../extensions/netbird-devices/remote-ops.ts";
import { ASKPASS_STATUS_CANCEL, ASKPASS_STATUS_UNAVAILABLE } from "../extensions/netbird-devices/remote.ts";
import { chooseRootPath, RootCancelled, runRoot, testRoot } from "../extensions/netbird-devices/root.ts";
import type { ExecOptions, ExecResult, Target } from "../extensions/netbird-devices/ssh.ts";

const conn = { device: "mac", user: "sergey", home: "/tmp", target: {} as Target, probe: { os: "Darwin", user: "sergey", home: "/tmp", sudo: true} } as unknown as Conn;

/** Runs the script in a local sh; `sudo` is a fake that needs the password "secret" on stdin. */
function localRun(dir: string, calls: string[] = []) {
	writeFileSync(
		join(dir, "sudo"),
		`#!/bin/sh
case "$*" in *-A*) echo "native sudo" >&2; exit 9;; esac
IFS= read -r pw
[ "$pw" = secret ] || { echo "Sorry, try again." >&2; exit 1; }
while [ "$1" != "--" ]; do shift; done; shift
exec "$@"
`,
		{ mode: 0o755 },
	);
	chmodSync(join(dir, "sudo"), 0o755);
	return (_t: Target, script: string, o: ExecOptions): Promise<ExecResult> =>
		new Promise((resolve) => {
			calls.push(script);
			const p = spawn("/bin/sh", ["-c", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
			const out: Buffer[] = [];
			let err = "";
			p.stdout.on("data", (b) => {
				out.push(b);
				o.onData?.(b, "stdout");
			});
			p.stderr.on("data", (b) => {
				err += b;
				o.onData?.(b, "stderr");
			});
			p.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
			if (o.stdin !== undefined) p.stdin.end(o.stdin);
			else p.stdin.end();
		});
}

const nativeResult = (code: number): ((t: Target, s: string, o: ExecOptions) => Promise<ExecResult>) => async () => ({ code, stdout: Buffer.alloc(0), stderr: "" });

const base = { pref: "auto" as const, userIsAtDevice: false, from: "cloudcli", timeoutMs: 5000 };

test("chooseRootPath: auto = native only when the user is at the device", () => {
	assert.equal(chooseRootPath("auto", true), "native");
	assert.equal(chooseRootPath("auto", false), "pi");
	assert.equal(chooseRootPath("native", false), "native");
	assert.equal(chooseRootPath("pi", true), "pi");
});

test("root via pi: the password goes to sudo's stdin only, the command's stdin is empty, nothing echoes it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "nbd-root-"));
	try {
		const calls: string[] = [];
		const out: string[] = [];
		const waits: boolean[] = [];
		let asked = 0;
		const r = await runRoot(conn, {
			...base,
			command: "cat; echo done",
			askPassword: async () => (asked++, "secret"),
			onWaiting: (w) => waits.push(w),
			onData: (b) => out.push(b.toString()),
			run: localRun(dir, calls),
		});
		assert.equal(r.exitCode, 0);
		assert.equal(r.path, "pi");
		assert.equal(asked, 1);
		assert.deepEqual(waits, [true, false]);
		assert.equal(out.join(""), "done\n"); // `cat` read an empty stdin, not the password
		assert.ok(calls.every((c) => !c.includes("secret")));
		assert.match(calls[0], /sudo -S -k -p ''/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("root via pi: wrong password gives sudo's failure, an empty or missing password is a cancellation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "nbd-root-"));
	try {
		const errs: string[] = [];
		const r = await runRoot(conn, { ...base, command: "true", askPassword: async () => "nope", onData: (b, s) => s === "stderr" && errs.push(b.toString()), run: localRun(dir) });
		assert.equal(r.exitCode, 1);
		assert.match(errs.join(""), /Sorry/);
		await assert.rejects(runRoot(conn, { ...base, command: "true", askPassword: async () => undefined, onData() {}, run: localRun(dir) }), RootCancelled);
		await assert.rejects(runRoot(conn, { ...base, command: "true", askPassword: async () => "", onData() {}, run: localRun(dir) }), /no root password/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("root via pi: no TUI (askPassword throws) fails, the footer wait ends", async () => {
	const waits: boolean[] = [];
	await assert.rejects(
		runRoot(conn, { ...base, command: "true", askPassword: async () => { throw new Error("secret input needs the interactive TUI"); }, onWaiting: (w) => waits.push(w), onData() {}, run: nativeResult(0) }),
		/interactive TUI/,
	);
	assert.deepEqual(waits, [true, false]);
});

test("root native: 197 = cancelled by the user, 196 = window unavailable falls back to pi, native-only does not", async () => {
	await assert.rejects(runRoot(conn, { ...base, userIsAtDevice: true, command: "true", askPassword: async () => "x", onData() {}, run: nativeResult(ASKPASS_STATUS_CANCEL) }), (e: Error) => e instanceof RootCancelled && e.message === "cancelled by the user on mac");
	const dir = mkdtempSync(join(tmpdir(), "nbd-root-"));
	try {
		const calls: string[] = [];
		const local = localRun(dir, calls);
		let asked = 0;
		const run = (t: Target, s: string, o: ExecOptions) => (s.includes("SUDO_ASKPASS") ? nativeResult(ASKPASS_STATUS_UNAVAILABLE)() : local(t, s, o));
		const r = await runRoot(conn, { ...base, userIsAtDevice: true, command: "true", askPassword: async () => (asked++, "secret"), onData() {}, run });
		assert.equal(r.exitCode, 0);
		assert.equal(r.path, "native→pi");
		assert.equal(asked, 1);
		await assert.rejects(runRoot(conn, { ...base, pref: "native", command: "true", askPassword: async () => "x", onData() {}, run }), /not available/);
		// native success: exit code of the command is passed through, the pi dialog is not used
		const ok = await runRoot(conn, { ...base, userIsAtDevice: true, command: "true", askPassword: async () => assert.fail("no pi dialog"), onData() {}, run: nativeResult(0) });
		assert.deepEqual([ok.exitCode, ok.path], [0, "native"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("testRoot reports success, failure and cancellation", async () => {
	const o = { ...base, userIsAtDevice: true, askPassword: async () => "x" };
	assert.match(await testRoot(conn, { ...o, run: nativeResult(0) }), /root works on mac \(password dialog: native\)/);
	assert.match(await testRoot(conn, { ...o, run: nativeResult(1) }), /sudo failed on mac \(exit 1/);
	await assert.rejects(testRoot(conn, { ...o, run: nativeResult(ASKPASS_STATUS_CANCEL) }), /cancelled by the user on mac/);
});

test("journal: root and file entries round trip, no content fields, log format", () => {
	const dir = mkdtempSync(join(tmpdir(), "nbd-j-"));
	try {
		const f = join(dir, "log.jsonl");
		const e = { ts: Date.now(), session: "s", device: "mac", user: "sergey", tool: "sudo", summary: "systemctl restart nginx", decision: "asked→denied", ok: false, ms: 5 };
		appendJournal(f, e);
		appendJournal(f, { ...e, tool: "read", summary: "~/a.png", decision: "auto", ok: true, detail: "1.2 MB" });
		const list = readJournal(f, 20);
		assert.equal(list.length, 2);
		assert.match(formatLog(list, { n: 20 }), /mac {2}sudo {2}systemctl restart nginx {2}✗ спросил → отклонено/);
		assert.match(formatLog(list, { device: "nl", n: 20 }), /no entries/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
