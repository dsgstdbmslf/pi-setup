// ssh.ts against a fake `ssh` (sshBin): the fake records its arguments and runs the remote script locally with /bin/sh.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { access, assertConnected, checkPort, classifyError, describeError, detectUser, exec, idle, isDirectory, probe, readFile, resolveVariant, SshError, sshArgs, stat, stripSshNoise, type Target, writeFile, writeScript } from "../extensions/netbird-devices/ssh.ts";

interface Fake {
	dir: string;
	target: Target;
	args: () => string[][];
	cleanup: () => void;
}

/** `body` replaces the default behaviour; $SCRIPT is the remote script, $USER_AT the destination. */
function fakeSsh(body?: string): Fake {
	const dir = mkdtempSync(join(tmpdir(), "nbd-ssh-"));
	const log = join(dir, "args.log");
	const bin = join(dir, "ssh");
	writeFileSync(
		bin,
		`#!/bin/sh
printf 'ARGS %s\\n' "$(printf %s "$*" | tr '\\n' ' ')" >> '${log}'
for a; do SCRIPT="$a"; done
USER_AT=""; prev=""; for a; do [ "$prev" = "--" ] && USER_AT="$a"; prev="$a"; done
${body ?? 'exec /bin/sh -c "$SCRIPT"'}
`,
	);
	chmodSync(bin, 0o755);
	const target: Target = { user: "sergey", host: "100.71.171.69", hostKeyAlias: "sergeys-macbook-pro.netbird.cloud", sshBin: bin, paths: { knownHosts: join(dir, "kh", "known_hosts"), cmDir: join(dir, "cm") } };
	return {
		dir,
		target,
		args: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.slice(5).split(" ")) : []),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("sshArgs: options, alias, destination", () => {
	const t: Target = { user: "sergey", host: "100.71.171.69", port: 2200, hostKeyAlias: "mac.netbird.cloud", paths: { knownHosts: "/d/known_hosts", cmDir: "/d/cm" } };
	const a = sshArgs(t);
	const opt = (k: string) => a[a.indexOf(a.find((x) => x.startsWith(`${k}=`))!)];
	assert.deepEqual(a.slice(0, 5), ["-F", "/dev/null", "-p", "2200", "-T"]);
	assert.equal(opt("BatchMode"), "BatchMode=yes");
	assert.equal(opt("ControlMaster"), "ControlMaster=auto");
	assert.equal(opt("ControlPath"), "ControlPath=/d/cm/%C");
	assert.equal(opt("ControlPersist"), "ControlPersist=10m");
	assert.equal(opt("StrictHostKeyChecking"), "StrictHostKeyChecking=accept-new");
	assert.equal(opt("UserKnownHostsFile"), "UserKnownHostsFile=/d/known_hosts");
	assert.equal(opt("HostKeyAlias"), "HostKeyAlias=mac.netbird.cloud");
	assert.equal(opt("ConnectTimeout"), "ConnectTimeout=8");
	assert.equal(opt("ForwardAgent"), "ForwardAgent=no");
	assert.deepEqual(a.slice(-2), ["--", "sergey@100.71.171.69"]);
	assert.equal(sshArgs({ ...t, port: undefined, hostKeyAlias: undefined }).includes("HostKeyAlias=100.71.171.69"), true);
	assert.equal(sshArgs({ ...t, port: undefined })[3], "22");
	// option injection and odd characters are refused
	for (const bad of [{ user: "-oProxyCommand=x" }, { user: "a b" }, { host: "-oProxyCommand=x" }, { host: "a;b" }, { hostKeyAlias: "-x" }]) assert.throws(() => sshArgs({ ...t, ...bad }));
});

test("exec: stdout, stderr, exit code, args; the script is one argument", async () => {
	const f = fakeSsh();
	try {
		const r = await exec(f.target, "echo out; echo err >&2; exit 3");
		assert.equal(r.code, 3);
		assert.equal(r.stdout.toString(), "out\n");
		assert.equal(r.stderr, "err\n");
		const [args] = f.args();
		assert.ok(args.includes("sergey@100.71.171.69"));
		assert.ok(args.includes("ControlMaster=auto"));
		assert.ok(statSync(f.target.paths.cmDir).isDirectory());
		assert.equal(statSync(f.target.paths.cmDir).mode & 0o777, 0o700);
		// shell metacharacters in the script are not interpreted on this side
		const m = await exec(f.target, "printf %s '$(echo pwned); `x` | y'");
		assert.equal(m.stdout.toString(), "$(echo pwned); `x` | y");
	} finally {
		f.cleanup();
	}
});

test("exec: stdin, binary output, onData, truncation", async () => {
	const f = fakeSsh();
	try {
		const r = await exec(f.target, "cat", { stdin: Buffer.from([0, 1, 2, 255, 254]) });
		assert.deepEqual([...r.stdout], [0, 1, 2, 255, 254]);
		assert.equal((await exec(f.target, "cat", { stdin: "текст" })).stdout.toString(), "текст");
		const chunks: string[] = [];
		await exec(f.target, "echo a; echo b >&2", { onData: (c, s) => chunks.push(`${s}:${c.toString().trim()}`) });
		assert.deepEqual(chunks.sort(), ["stderr:b", "stdout:a"]);
		// no stdin option: the remote command sees EOF (not a hang)
		assert.equal((await exec(f.target, "cat; echo done")).stdout.toString(), "done\n");
		const big = await exec(f.target, "head -c 100000 /dev/zero", { maxBytes: 1000 });
		assert.equal(big.truncated, true);
		assert.ok(big.stdout.length <= 1000);
	} finally {
		f.cleanup();
	}
});

test("exec: timeout, abort, missing ssh", async () => {
	const f = fakeSsh();
	try {
		const t0 = Date.now();
		const r = await exec(f.target, "sleep 30", { timeoutMs: 300 });
		assert.equal(r.timedOut, true);
		assert.ok(Date.now() - t0 < 5000);
		assert.equal(classifyError(r), "timeout");
		const ac = new AbortController();
		const p = exec(f.target, "sleep 30", { signal: ac.signal });
		setTimeout(() => ac.abort(), 100);
		const a = await p;
		assert.equal(a.aborted, true);
		assert.throws(() => assertConnected(a), /aborted/);
		const pre = new AbortController();
		pre.abort();
		assert.equal((await exec(f.target, "sleep 30", { signal: pre.signal })).aborted, true);
		const nope = await exec({ ...f.target, sshBin: join(f.dir, "missing") }, "true");
		assert.match(nope.spawnError!, /ENOENT/);
		assert.throws(() => assertConnected(nope), /cannot run ssh/);
		const bad = await exec({ ...f.target, user: "-bad" }, "true");
		assert.match(bad.spawnError!, /invalid user/);
	} finally {
		f.cleanup();
	}
});

test("classifyError: connection failures only (exit 255)", () => {
	const c = (stderr: string, code: number | null = 255) => classifyError({ code, stderr });
	assert.equal(c("sergey@host: Permission denied (publickey)."), "auth");
	assert.equal(c("User authentication failed"), "auth");
	assert.equal(c("Too many authentication failures"), "auth");
	assert.equal(c("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."), "hostkey-changed");
	assert.equal(c("Host key verification failed."), "hostkey-changed");
	assert.equal(c("SSH-2.0-NetBird-JWT-Required\nPermission denied"), "jwt-required");
	assert.equal(c("ssh: connect to host 1.2.3.4 port 22: Connection timed out"), "timeout");
	assert.equal(c("Connection timed out during banner exchange"), "timeout");
	assert.equal(c("ssh: connect to host 1.2.3.4 port 22: Connection refused"), "unreachable");
	assert.equal(c("ssh: connect to host x port 22: No route to host"), "unreachable");
	assert.equal(c("ssh: Could not resolve hostname x"), "unreachable");
	assert.equal(c("kex_exchange_identification: Connection closed by remote host"), "unreachable");
	assert.equal(c("something odd"), undefined);
	// the remote command's own failures are not connection errors
	assert.equal(c("cat: x: Permission denied", 1), undefined);
	assert.equal(c("Permission denied", 0), undefined);
	assert.equal(classifyError({ code: null, stderr: "", timedOut: true }), "timeout");
	for (const k of ["auth", "hostkey-changed", "jwt-required", "timeout", "unreachable"] as const) assert.match(describeError(k, "mac", "sergey"), /^mac:/);
	assert.match(describeError("hostkey-changed", "mac"), /\/nb forget mac/);
	assert.match(describeError("jwt-required", "mac"), /JWT/);
	assert.equal(stripSshNoise("Warning: Permanently added '100.1.1.1' (ED25519) to the list of known hosts.\nreal\n"), "real\n");
});

test("assertConnected maps the fake's failures to SshError kinds", async () => {
	const f = fakeSsh(`echo 'sergey@h: Permission denied (publickey).' >&2; exit 255`);
	try {
		await assert.rejects(probe(f.target), (e: any) => e instanceof SshError && e.kind === "auth" && /\/nb user/.test(e.message));
		await assert.rejects(readFile(f.target, "/x"), (e: any) => e.kind === "auth");
	} finally {
		f.cleanup();
	}
});

test("probe, readFile, access, stat, isDirectory, resolveVariant (local sh)", async () => {
	const f = fakeSsh();
	const work = mkdtempSync(join(tmpdir(), "nbd-w-"));
	try {
		const info = await probe(f.target);
		assert.equal(info.os, process.platform === "darwin" ? "Darwin" : "Linux");
		const file = join(work, "a.txt");
		writeFileSync(file, "héllo\0bin");
		assert.equal((await readFile(f.target, file)).toString("utf8"), "héllo\0bin");
		await assert.rejects(readFile(f.target, join(work, "missing")), (e: any) => e instanceof SshError && e.code === "ENOENT");
		await assert.rejects(readFile(f.target, work), (e: any) => e.code === "EISDIR");
		await access(f.target, file, "rw");
		await assert.rejects(access(f.target, join(work, "missing")), (e: any) => e.code === "ENOENT");
		assert.equal(await stat(f.target, file), "file");
		assert.equal(await stat(f.target, work), "dir");
		assert.equal(await stat(f.target, join(work, "missing")), "none");
		assert.equal(await isDirectory(f.target, work), true);
		assert.equal(await isDirectory(f.target, file), false);
		// hostile path names stay data
		const odd = join(work, "it's $(x) `y`.txt");
		writeFileSync(odd, "ok");
		assert.equal((await readFile(f.target, odd)).toString(), "ok");
		// resolveVariant
		const nnbsp = join(work, "Shot 3.04 PM.png".replace(" PM", "\u202FPM"));
		writeFileSync(nnbsp, "i");
		assert.equal(await resolveVariant(f.target, join(work, "Shot 3.04 PM.png")), nnbsp);
		assert.equal(await resolveVariant(f.target, join(work, "none.png")), undefined);
	} finally {
		f.cleanup();
		rmSync(work, { recursive: true, force: true });
	}
});

test("writeFile: creates parents, replaces atomically, keeps mode, follows symlinks", async () => {
	const f = fakeSsh();
	const work = mkdtempSync(join(tmpdir(), "nbd-w-"));
	try {
		const nested = join(work, "a", "b", "new file's.txt");
		await writeFile(f.target, nested, "one\n");
		assert.equal(readFileSync(nested, "utf8"), "one\n");
		await writeFile(f.target, nested, Buffer.from([0, 255, 1]));
		assert.deepEqual([...readFileSync(nested)], [0, 255, 1]);
		// existing file keeps its mode, no temp files are left behind
		const script = join(work, "run.sh");
		writeFileSync(script, "x", { mode: 0o755 });
		chmodSync(script, 0o755);
		await writeFile(f.target, script, "#!/bin/sh\necho hi\n");
		assert.equal(statSync(script).mode & 0o777, 0o755);
		assert.equal(readFileSync(script, "utf8"), "#!/bin/sh\necho hi\n");
		const names = (await import("node:fs")).readdirSync(work);
		assert.deepEqual(names.sort(), ["a", "run.sh"]);
		// symlink: the target is written, the link stays
		const real = join(work, "real.txt");
		writeFileSync(real, "old");
		const link = join(work, "link.txt");
		symlinkSync(real, link);
		await writeFile(f.target, link, "via link");
		assert.equal(readFileSync(real, "utf8"), "via link");
		assert.equal((await import("node:fs")).lstatSync(link).isSymbolicLink(), true);
		// failure: path under a file
		await assert.rejects(writeFile(f.target, join(real, "x"), "z"), SshError);
		assert.ok(writeScript("/a/b").includes("mv -f"));
		assert.ok(writeScript("/a'b").includes(`'/a'\\''b'`));
	} finally {
		f.cleanup();
		rmSync(work, { recursive: true, force: true });
	}
});

test("idle: parses the probe output", async () => {
	const f = fakeSsh(`echo 17`);
	try {
		assert.equal(await idle(f.target), 17);
	} finally {
		f.cleanup();
	}
	const g = fakeSsh(`true`);
	try {
		assert.equal(await idle(g.target), undefined);
	} finally {
		g.cleanup();
	}
});

test("checkPort: open and closed", async () => {
	const srv = createServer((s) => s.destroy());
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	try {
		assert.equal(await checkPort("127.0.0.1", port, 1000), true);
	} finally {
		await new Promise((r) => srv.close(r));
	}
	assert.equal(await checkPort("127.0.0.1", port, 500), false);
});

const probeOut = (user: string, consoleUser: string) => `printf 'nb_os=Darwin\\nnb_user=${user}\\nnb_home=/Users/${user}\\nnb_console=${consoleUser}\\n'`;

test("detectUser: tries candidates in order, auth failures move on", async () => {
	const f = fakeSsh(`case "$USER_AT" in
bob@*|sergeys@*) echo 'Permission denied' >&2; exit 255;;
sergey@*) ${probeOut("sergey", "sergey")};;
esac`);
	const { user: _u, ...base } = f.target;
	try {
		const r = await detectUser(base, ["bob", "sergeys", "sergey", "other"], "mac");
		assert.equal(r.user, "sergey");
		assert.deepEqual(r.tried, ["bob", "sergeys", "sergey"]);
		assert.equal(r.switchedToConsole, false);
		assert.equal(r.probe.home, "/Users/sergey");
		await assert.rejects(detectUser(base, ["bob"], "mac"), (e: any) => e.kind === "auth" && /tried: bob/.test(e.message) && /\/nb user mac/.test(e.message));
		await assert.rejects(detectUser(base, [], "mac"), /nobody/);
	} finally {
		f.cleanup();
	}
});

test("detectUser: switches to the console user when that login works", async () => {
	const f = fakeSsh(`case "$USER_AT" in
orca@*) ${probeOut("orca", "sergey")};;
sergey@*) ${probeOut("sergey", "sergey")};;
esac`);
	const { user: _u, ...base } = f.target;
	try {
		const r = await detectUser(base, ["orca"]);
		assert.equal(r.user, "sergey");
		assert.equal(r.switchedToConsole, true);
	} finally {
		f.cleanup();
	}
	// console user refuses the login: stay on the working account
	const g = fakeSsh(`case "$USER_AT" in
orca@*) ${probeOut("orca", "sergey")};;
*) echo 'Permission denied' >&2; exit 255;;
esac`);
	const { user: _v, ...base2 } = g.target;
	try {
		const r = await detectUser(base2, ["orca"]);
		assert.equal(r.user, "orca");
		assert.equal(r.switchedToConsole, false);
	} finally {
		g.cleanup();
	}
	// console user root is never used
	const h = fakeSsh(`${probeOut("orca", "root")}`);
	const { user: _w, ...base3 } = h.target;
	try {
		assert.equal((await detectUser(base3, ["orca"])).user, "orca");
	} finally {
		h.cleanup();
	}
});

test("detectUser: other connection errors abort at once", async () => {
	const f = fakeSsh(`echo 'ssh: connect to host x port 22: Connection refused' >&2; exit 255`);
	const { user: _u, ...base } = f.target;
	try {
		await assert.rejects(detectUser(base, ["a", "b"]), (e: any) => e.kind === "unreachable");
		assert.equal(f.args().length, 1);
	} finally {
		f.cleanup();
	}
});
