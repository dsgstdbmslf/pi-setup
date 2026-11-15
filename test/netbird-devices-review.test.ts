import "./isolated-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isolateTestEnv } from "./isolated-env.ts";
import { fakeSsh } from "./netbird-devices-fake-ssh.ts";
import { isReadOnlyCommand, protectedInCommand, protectedMatch, resolveRemotePath } from "../extensions/netbird-devices/policy.ts";
import { DEFAULT_PROTECTED } from "../extensions/netbird-devices/settings.ts";
import { SessionPolicy } from "../extensions/netbird-devices/session-policy.ts";
import { canonicalPath, exec, sshArgs } from "../extensions/netbird-devices/ssh.ts";
import { askpassScript, rootNativeWrapper, rootStdinWrapper } from "../extensions/netbird-devices/remote.ts";
import { runRoot } from "../extensions/netbird-devices/root.ts";
import { createEditOps, remoteTimeoutSeconds, type Conn } from "../extensions/netbird-devices/remote-ops.ts";

const write = { kind: "write" as const, path: "/h/file", diff: "+x", isNew: true };

test("review: approvals and classifier cache are scoped to device and login", async () => {
	const p = new SessionPolicy();
	const base = { device: "mac", baseMode: "ask" as const, action: write };
	assert.equal((await p.authorize({ ...base, ask: async () => "always" })).ok, true);
	assert.equal((await p.authorize(base)).ok, true);
	assert.equal((await p.authorize({ ...base, device: "linux" })).ok, false);
	assert.equal((await p.authorize({ ...base, scope: "another user" })).ok, false);
	let calls = 0;
	const classify = async () => ({ decision: ++calls === 1 ? "allow" as const : "deny" as const, reason: "different device" });
	const auto = { ...base, baseMode: "auto" as const, scope: "sergey", classify };
	assert.equal((await p.authorize(auto)).ok, true);
	assert.equal((await p.authorize({ ...auto, device: "linux" })).ok, false);
	assert.equal((await p.authorize({ ...auto, scope: "alice" })).ok, false);
	assert.equal((await p.authorize({ ...auto, cacheSalt: "new user intent" })).ok, false);
	assert.equal(calls, 4);
});

test("review: an incomplete classifier preview cannot authorize hidden changes", async () => {
	for (const action of [
		{ kind: "bash" as const, command: "echo " + "x".repeat(3000) + "; touch hidden", root: false },
		{ ...write, diff: "+safe\n… (200 more lines)" },
		{ ...write, diff: "(2000 lines -> 2001 lines)" },
		{ ...write, diff: "+" + "x".repeat(3000) },
	]) {
		const r = await new SessionPolicy().authorize({ device: "mac", baseMode: "auto", action, classify: async () => assert.fail("must ask instead of classifying") });
		assert.equal(r.ok, false);
		assert.match((r as any).message, /exceeds the classifier preview/);
	}
	for (const invalid of [0, -1, Infinity, NaN, 2_147_484]) assert.throws(() => remoteTimeoutSeconds(invalid), /Invalid timeout/);
	assert.equal(remoteTimeoutSeconds(0.25), 0.25);
});

test("review: read-only allowlist refuses shell/utility execution and write bypasses", () => {
	for (const c of [
		"/tmp/cat file", "./ls", "PATH=/tmp ls", "LD_PRELOAD=/tmp/x.so cat x", "printf -v PATH /tmp; ls",
		"echo x >/dev/null.out", "echo x 2>/dev/null/../out", "echo 2>&10", "cat $'secret'", "cat ${X}", "cat ~/.s*/id_rsa", "cat ~other/.ssh/id_rsa", "l\\s",
		"sed -n '1e touch /tmp/pwned' file", "sed 'w /tmp/pwned' file", "awk 'BEGIN {printf \"x\" > \"out\"}'", "find -delete", "find . -exec touch x +",
		"git diff --ext-diff", "git diff --no-index --output out a b", "npm view x --logfile=/tmp/out", "brew info x",
		"file -C -m magic", "file --compile", "journalctl --setup-keys", "journalctl --update-catalog", "sysctl -f settings", "dmesg -n 1",
		"plutil -lint file -replace key -string value", "scutil --get HostName --set HostName pwned", "networksetup -getinfo Wi-Fi -setcomputername x",
	]) assert.equal(isReadOnlyCommand(c), false, c);
	for (const c of ["ls -la ~/proj", "/bin/cat file", "/usr/bin/head -n 2 file", "echo ok 2>&1", "ls 2>/dev/null", "file --mime-type x", "sysctl -n kern.ostype"]) assert.equal(isReadOnlyCommand(c), true, c);
});

test("review: protected paths fold case, normalization, dot segments, newline and quoted spaces", () => {
	const home = "/Users/s";
	for (const p of ["/Users/s/.SSH/id_rsa", "/Users/s/.ssh/../.ssh/id_rsa", "/Users/s/.ssh/key\nname", "/Users/s/Library/KEYCHAINS/login.keychain-db"])
		assert.ok(protectedMatch(p, home, DEFAULT_PROTECTED), p);
	assert.equal(protectedMatch("/Users/s/SÉCRET/key".normalize("NFD"), home, ["~/sécret/**"]), "~/sécret/**");
	assert.ok(protectedInCommand('cat "~/Library/Application Support/Google/Chrome/Default/Login Data"', home, DEFAULT_PROTECTED));
	for (const c of ["cat ~/.s*/id_rsa", "cat $SECRET", "cat ~other/.ssh/id_rsa", "rg token .", "grep -r token ."]) assert.ok(protectedInCommand(c, home, DEFAULT_PROTECTED), c);
	assert.equal(resolveRemotePath("~other/.ssh/id_rsa", home), "/Users/s/~other/.ssh/id_rsa", "file tools never shell-expand ~user");
});

test("review: canonical paths detect file/parent symlinks, new parents, hostile names and loops", async () => {
	const f = fakeSsh();
	try {
		const home = join(f.dir, "home");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		writeFileSync(join(home, ".ssh", "key"), "private");
		symlinkSync(".ssh/key", join(home, "innocent"));
		symlinkSync(".ssh", join(home, "innocent-dir"));
		assert.equal(await canonicalPath(f.target, join(home, "innocent")), join(home, ".ssh/key"));
		const resolved = await canonicalPath(f.target, join(home, "innocent-dir/new/deep/key"));
		assert.ok(protectedMatch(resolved, home, DEFAULT_PROTECTED));
		for (const name of ["it's $(touch marker)", "line\nbreak"]) {
			writeFileSync(join(home, name), "x");
			assert.equal(await canonicalPath(f.target, join(home, name)), join(home, name));
		}
		symlinkSync("loop", join(home, "loop"));
		await assert.rejects(canonicalPath(f.target, join(home, "loop")), /resolve remote path safely/);
		let read = false;
		const ops = createEditOps({ target: f.target } as Conn, undefined, async () => { read = true; throw new Error("protected read refused"); });
		await assert.rejects(ops.access(join(home, "innocent")), /protected read refused/);
		assert.equal(read, true);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("review: SSH owns its parent directories/known_hosts and namespaces ControlMaster by runtime", async () => {
	const f = fakeSsh();
	try {
		await exec(f.target, "true");
		assert.equal(statSync(f.target.paths.knownHosts).mode & 0o777, 0o600);
		const option = (id: string) => sshArgs({ ...f.target, controlId: id }).find((x) => x.startsWith("ControlPath="));
		assert.notEqual(option("session-one"), option("session-two"));
		assert.equal(option("session-one"), option("session-one"));
		const real = join(f.dir, "real"); mkdirSync(real);
		const alias = join(f.dir, "alias"); symlinkSync(real, alias);
		const refused = await exec({ ...f.target, paths: { ...f.target.paths, cmDir: join(alias, "cm") } }, "true");
		assert.match(refused.spawnError!, /not a directory/);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("review: pre-aborted ssh starts nothing", async () => {
	const f = fakeSsh();
	try {
		const ctl = new AbortController(); ctl.abort();
		assert.equal((await exec(f.target, "touch marker", { signal: ctl.signal })).aborted, true);
		assert.deepEqual(f.calls(), []);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("review: password wrappers cannot invoke a sudo or askpass utility from a writable login PATH", () => {
	const dir = mkdtempSync(join(tmpdir(), "nbd-root-path-"));
	try {
		writeFileSync(join(dir, "sudo"), '#!/bin/sh\necho HIJACKED\ncat\n', { mode: 0o755 });
		const trusted = join(dir, "trusted-sudo");
		writeFileSync(trusted, '#!/bin/sh\nIFS= read -r pw\n[ "$pw" = SECRET ] || exit 1\nwhile [ "$1" != -- ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
		const wrapper = rootStdinWrapper("cat", { path: `${dir}:/usr/bin:/bin` });
		assert.match(wrapper, /exec \/usr\/bin\/sudo -S/);
		const r = spawnSync("/bin/sh", ["-c", wrapper.replaceAll("/usr/bin/sudo", trusted)], { encoding: "utf8", input: "SECRET\n" });
		assert.equal(r.status, 0); assert.equal(r.stdout, "");
		assert.match(rootNativeWrapper("true", { os: "Linux", title: "t", text: "t" }), /\/usr\/bin\/sudo -k -A/);
		for (const os of ["Linux", "Darwin"]) assert.match(askpassScript(os), /^#!\/bin\/sh\nexport PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin\n/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review: native askpass private mode, cleanup and reserved agent exit codes", () => {
	const dir = mkdtempSync(join(tmpdir(), "nbd-native-review-"));
	try {
		// No sudo or GUI is ever used: this fake inspects the generated helper then
		// behaves like NOPASSWD (does not read stdin or invoke askpass).
		writeFileSync(join(dir, "sudo"), '#!/bin/sh\nprintf "%s\\n" "$SUDO_ASKPASS" > "$CAPTURE"\n(stat -c %a "$SUDO_ASKPASS" 2>/dev/null || stat -f%Lp "$SUDO_ASKPASS") >> "$CAPTURE"\nwhile [ "$1" != -- ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
		for (const code of [196, 197]) {
			const capture = join(dir, "capture");
			const script = rootNativeWrapper(`cat; exit ${code}`, { os: "Linux", title: "t'$(false)", text: "test" }).replaceAll("/usr/bin/sudo", join(dir, "sudo"));
			const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", input: "SECRET-PASSWORD\n", env: { PATH: `${dir}:/usr/bin:/bin`, CAPTURE: capture, TMPDIR: dir } });
			assert.equal(r.status, 1, "reserved command exit cannot cause fallback/re-execution");
			assert.equal(r.stdout, "");
			const [helper, mode] = readFileSync(capture, "utf8").trim().split("\n");
			assert.equal(mode, "700");
			assert.throws(() => statSync(helper), /ENOENT/, "helper removed on completion");
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review: native helper cancellation/unavailable statuses and private cleanup without GUI", () => {
	const dir = mkdtempSync(join(tmpdir(), "nbd-native-status-"));
	try {
		writeFileSync(join(dir, "sudo"), '#!/bin/sh\nprintf "%s" "$SUDO_ASKPASS" > "$CAPTURE"\n"$SUDO_ASKPASS" Password: >/dev/null\nexit 1\n', { mode: 0o755 });
		for (const [stderr, code] of [["cancel", 197], ["cannot open display", 196]] as const) {
			writeFileSync(join(dir, "zenity"), `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n`, { mode: 0o755 });
			const capture = join(dir, "capture");
			const script = rootNativeWrapper("touch SHOULD-NOT-RUN", { os: "Linux", title: "test", text: "test" })
				.replaceAll("/usr/bin/sudo", join(dir, "sudo"))
				.replaceAll("export PATH=/usr/bin:/bin:/usr/sbin:/sbin", `export PATH='${dir}:/usr/bin:/bin'`);
			const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, DISPLAY: ":test-only", CAPTURE: capture, TMPDIR: dir } });
			assert.equal(r.status, code, r.stderr);
			assert.equal(r.stdout, "");
			assert.throws(() => statSync(readFileSync(capture, "utf8")), /ENOENT/);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review: root drops password buffer on failure/timeout/abort and never asks on pre-abort", async () => {
	const conn = { device: "mac", user: "s", target: {}, probe: { os: "Linux" } } as Conn;
	for (const result of [{ timedOut: true }, { aborted: true }, { spawnError: "failed" }, {}]) {
		let stdin: Buffer | undefined;
		const output: string[] = [];
		const r = { command: "cat", pref: "pi" as const, userIsAtDevice: false, from: "vm", timeoutMs: 1, askPassword: async () => "UNIQUE-SECRET", onData: (b: Buffer) => output.push(b.toString()), run: async (_t: any, script: string, o: any) => {
			stdin = o.stdin;
			assert.equal(stdin!.toString(), "UNIQUE-SECRET\n");
			assert.ok(!script.includes("UNIQUE-SECRET"));
			return { code: 1, stdout: Buffer.alloc(0), stderr: "sudo failed", ...result };
		} };
		try { const value = await runRoot(conn, r); assert.ok(!JSON.stringify(value).includes("UNIQUE-SECRET")); }
		catch (e) { assert.ok(!String(e).includes("UNIQUE-SECRET")); }
		assert.ok(stdin?.every((b) => b === 0));
		assert.deepEqual(output, []);
	}
	const ctl = new AbortController(); ctl.abort();
	await assert.rejects(runRoot(conn, { command: "true", pref: "pi", userIsAtDevice: false, from: "vm", timeoutMs: 1, signal: ctl.signal, askPassword: async () => assert.fail("must not ask"), onData() {} }), /aborted/);
});

test("review: test environment cannot reach inherited askpass or agent, including PATH sudo shim", () => {
	const dir = mkdtempSync(join(tmpdir(), "nbd-env-review-"));
	try {
		writeFileSync(join(dir, "sudo"), '#!/bin/sh\n# pi bitwarden-ssh: sudo asks through the pi askpass dialog\nexit 9\n');
		const env = { PATH: `${dir}:/usr/bin:/bin`, SSH_ASKPASS: "/real-session/askpass", SSH_ASKPASS_REQUIRE: "force", PI_BW_ASKPASS_SOCK: "/real-session/socket", SUDO_ASKPASS: "secret", GIT_ASKPASS: "secret", SSH_AUTH_SOCK: "/real-session/agent", DISPLAY: ":0", BW_SESSION: "secret", BASH_ENV: "secret" };
		isolateTestEnv(env);
		assert.deepEqual(env, { PATH: "/usr/bin:/bin", SSH_ASKPASS_REQUIRE: "never" });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
