import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPrompt, defaultProcInfo, describeRequester, descendsFrom, parseCmdline, procfsInfo, psInfo } from "../extensions/bitwarden-ssh/askpass.ts";
import { parseList } from "../extensions/bitwarden-ssh/agent.ts";
import { fingerprintOf } from "../extensions/bitwarden-ssh/keyutil.ts";
import { CM_SOCKET_NAME, MAX_SOCKET_PATH, resolvePaths } from "../extensions/bitwarden-ssh/paths.ts";
import { DEFAULTS, parseSettings } from "../extensions/bitwarden-ssh/settings.ts";
import {
	addHost,
	ConfigSyntaxError,
	configErrors,
	generateConfig,
	getHostBlockText,
	hostNames,
	identityPaths,
	invalidLines,
	listHosts,
	matchKeyName,
	parseConfig,
	removeHost,
	serializeConfig,
	setHostOptions,
	tokenize,
} from "../extensions/bitwarden-ssh/sshconfig.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { footerText, formatDuration, hostsInCommand, lineDiff, mentionsNetworkCommand } from "../extensions/bitwarden-ssh/ui-text.ts";

const SAMPLE = `# global
AddKeysToAgent yes
ServerAliveInterval=30

Host web web.example.com
    HostName 10.0.0.5
    User deploy
    IdentityFile ~/.ssh/web_key
    # comment inside

Host "quoted host" db
  HostName = db.internal
  IdentityFile "~/.ssh/my db key"
  LocalForward 5432 localhost:5432

Match host *.corp exec "true"
    User corp

Host *
    UseKeychain yes
    IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
    Include ~/.ssh/pi-bitwarden/config
`;

test("parse/serialize round trip is lossless", () => {
	for (const t of [SAMPLE, SAMPLE.replace(/\n/g, "\r\n"), "", "Host a", "\n\n# only comments\n", "Host x\n  User y\n  Port 22"]) {
		assert.equal(serializeConfig(parseConfig(t)), t);
	}
});

test("blocks, patterns and options", () => {
	const blocks = parseConfig(SAMPLE);
	assert.deepEqual(
		blocks.map((b) => b.kind),
		["preamble", "host", "host", "match", "host"],
	);
	const hosts = listHosts(blocks);
	assert.deepEqual(hosts[1].patterns, ["quoted host", "db"]);
	assert.deepEqual(hosts[1].options.hostname, ["db.internal"]);
	assert.deepEqual(hosts[1].options.identityfile, ["~/.ssh/my db key"]);
	assert.deepEqual(hosts[1].options.localforward, ["5432 localhost:5432"]);
	assert.equal(hosts[2].wildcard, true);
	assert.equal(hosts[0].wildcard, false);
	assert.deepEqual(hostNames(blocks), ["web", "web.example.com", "quoted host", "db"]);
	assert.deepEqual(identityPaths(blocks), ["~/.ssh/web_key", "~/.ssh/my db key"]);
	assert.match(getHostBlockText(blocks, "db")!, /^Host "quoted host" db\n {2}HostName = db.internal/);
	assert.equal(getHostBlockText(blocks, "nope"), undefined);
	assert.equal(parseConfig("Host a\r\n  User b\r\n")[1].lines[1].key, "user");
});

test("setHostOptions replaces in place, removes, appends with block indentation", () => {
	const blocks = parseConfig(SAMPLE);
	assert.equal(setHostOptions(blocks, "web", { user: "root", Port: "2222", IdentityFile: null }), true);
	const t = getHostBlockText(blocks, "web")!;
	assert.equal(t, "Host web web.example.com\n    HostName 10.0.0.5\n    User root\n    Port 2222\n    # comment inside\n\n");
	assert.equal(setHostOptions(blocks, "db", { ProxyJump: "bastion", LocalForward: ["1 a:1", "2 b:2"] }), true);
	const d = getHostBlockText(blocks, "db")!;
	assert.match(d, / {2}LocalForward 1 a:1\n {2}LocalForward 2 b:2\n {2}ProxyJump bastion\n\n$/);
	assert.equal(setHostOptions(blocks, "missing", { User: "x" }), false);
	assert.throws(() => setHostOptions(blocks, "web", { User: "a\nHost evil" }), /single-line/);
	assert.throws(() => setHostOptions(blocks, "web", { Host: "x" }), /cannot be set/);
	// Unrelated text is untouched.
	assert.ok(serializeConfig(blocks).startsWith("# global\nAddKeysToAgent yes\nServerAliveInterval=30\n\n"));
});

test("setHostOptions on a last line without newline and CRLF files", () => {
	const b = parseConfig("Host a\n  User x");
	setHostOptions(b, "a", { Port: "1" });
	assert.equal(serializeConfig(b), "Host a\n  User x\n  Port 1\n");
	const c = parseConfig("Host a\r\n\tUser x\r\n");
	setHostOptions(c, "a", { User: "y", HostName: "h" });
	assert.equal(serializeConfig(c), "Host a\r\n\tUser y\r\n\tHostName h\r\n");
});

test("addHost goes before Host * or at the end; rejects duplicates", () => {
	const blocks = parseConfig(SAMPLE);
	addHost(blocks, ["new1"], { HostName: "1.2.3.4", IdentityFile: "~/.ssh/with space" });
	const t = serializeConfig(blocks);
	assert.ok(t.indexOf("Host new1") < t.indexOf("Host *"));
	assert.ok(t.indexOf("Host new1") > t.indexOf("Match host"));
	assert.match(t, /Host new1\n {4}HostName 1\.2\.3\.4\n {4}IdentityFile "~\/\.ssh\/with space"\n\nHost \*/);
	assert.throws(() => addHost(blocks, ["db"], {}), /already exists/);
	assert.throws(() => addHost(blocks, ["bad pattern\n"], {}), /invalid host pattern/);
	const end = parseConfig("Host a\n  User b");
	addHost(end, ["c"], { User: "d" });
	assert.equal(serializeConfig(end), "Host a\n  User b\n\nHost c\n    User d\n\n");
	const empty = parseConfig("");
	addHost(empty, ["x"], {});
	assert.equal(serializeConfig(empty), "Host x\n\n");
});

test("removeHost: pattern from a multi-pattern header, or the whole block", () => {
	const blocks = parseConfig(SAMPLE);
	assert.equal(removeHost(blocks, "web.example.com"), true);
	assert.match(serializeConfig(blocks), /^Host web\n {4}HostName 10\.0\.0\.5/m);
	assert.equal(removeHost(blocks, "web"), true);
	assert.doesNotMatch(serializeConfig(blocks), /10\.0\.0\.5/);
	assert.equal(removeHost(blocks, "db"), true);
	assert.match(serializeConfig(blocks), /^Host "quoted host"\n/m);
	assert.equal(removeHost(blocks, "nope"), false);
});

test("generateConfig maps identities, disables macOS-only lines, appends ControlMaster", () => {
	const r = generateConfig(SAMPLE, {
		mapIdentity: (p) => (p === "~/.ssh/web_key" ? "/home/u/.ssh/pi-bitwarden/keys/web_key.pub" : undefined),
		pathExists: () => false,
		controlPersist: "10m",
		cmDir: "/home/u/.ssh/pi-bitwarden/cm",
		header: "generated\nsecond line",
	});
	assert.ok(r.text.startsWith("# generated\n# second line\n\n# global\n"));
	assert.match(r.text, /IdentityFile "\/home\/u\/\.ssh\/pi-bitwarden\/keys\/web_key\.pub"\n {4}IdentitiesOnly yes\n/);
	assert.equal(r.text.match(/IdentitiesOnly/g)?.length, 1);
	assert.deepEqual(r.mapped, ["~/.ssh/web_key"]);
	assert.deepEqual(r.unmatched, ["~/.ssh/my db key"]);
	assert.equal(r.disabled.length, 3);
	assert.match(r.text, /# \[pi-bw disabled\] UseKeychain yes/);
	assert.match(r.text, /# \[pi-bw disabled\] IdentityAgent/);
	assert.match(r.text, /# \[pi-bw disabled\] Include ~\/\.ssh\/pi-bitwarden\/config/);
	assert.ok(r.text.endsWith('Host *\n    ControlMaster auto\n    ControlPath "/home/u/.ssh/pi-bitwarden/cm/%C"\n    ControlPersist 10m\n'));
	// Parsing the result still works and keeps the specific hosts first.
	const hosts = listHosts(parseConfig(r.text));
	assert.deepEqual(hosts[hosts.length - 1].patterns, ["*"]);
});

test("generateConfig: existing IdentitiesOnly, existing paths, ControlMaster skipped", () => {
	const src = "Host a\n  IdentitiesOnly no\n  IdentityFile ~/.ssh/k1\n  IdentityFile ~/.ssh/k2\n  IdentityFile /exists\n  ControlMaster no";
	const r = generateConfig(src, {
		mapIdentity: (p) => (p.startsWith("~/") ? `/k/${p.slice(7)}.pub` : undefined),
		pathExists: (p) => p === "/exists",
		controlPersist: "10m",
		cmDir: "/cm",
		header: "h",
	});
	assert.equal(r.text.match(/IdentitiesOnly/g)?.length, 1);
	assert.deepEqual(r.unmatched, []);
	assert.doesNotMatch(r.text, /ControlPersist/);
	assert.match(r.text, /IdentityFile "\/k\/k2\.pub"\n/);
	const off = generateConfig("Host a\n", { mapIdentity: () => undefined, pathExists: () => false, controlPersist: false, cmDir: "/cm", header: "h" });
	assert.doesNotMatch(off.text, /ControlMaster/);
	const two = generateConfig("Host a\n  IdentityFile ~/.ssh/x\n  IdentityFile ~/.ssh/y\n", {
		mapIdentity: (p) => `/k/${p.slice(7)}.pub`,
		pathExists: () => false,
		controlPersist: false,
		cmDir: "/cm",
		header: "h",
	});
	assert.equal(two.text.match(/IdentitiesOnly yes/g)?.length, 1);
});

test("invalidLines", () => {
	assert.deepEqual(invalidLines("Host a\n  User b\n# c\n\n  ???\n"), [5]);
});

test("N3: configErrors reports unterminated quotes and IdentityFile arity; the generator refuses them", () => {
	assert.equal(tokenize('"~/.ssh/known').unterminated, true);
	assert.equal(tokenize("'a b").unterminated, true);
	assert.equal(tokenize('"a b" c # "x').unterminated, undefined);
	const text = 'Host a\n  IdentityFile ~/.ssh/known unexpected-extra\n  IdentityFile "~/.ssh/known\n  IdentityFile\n  User "x\n  IdentityFile "/p q" # ok\n  ???\n';
	assert.deepEqual(configErrors(text), [
		"line 2: IdentityFile takes exactly 1 argument (got 2)",
		"line 3: unterminated quote",
		"line 4: IdentityFile takes exactly 1 argument (got 0)",
		"line 5: unterminated quote",
		'line 7: not "Keyword value"',
	]);
	assert.deepEqual(configErrors("Host a\n  IdentityFile ~/.ssh/k # c\n  IdentityFile 'a b'\n"), []);
	// Even with a mapping that would replace the line, the malformed source is refused (no masking).
	const opts = { mapIdentity: () => "/k.pub", pathExists: () => true, controlPersist: false as const, cmDir: "/cm", header: "h" };
	for (const bad of ["Host a\n IdentityFile ~/.ssh/known unexpected-extra\n", 'Host a\n IdentityFile "~/.ssh/known\n'])
		assert.throws(() => generateConfig(bad, opts), (e: unknown) => e instanceof ConfigSyntaxError && /line 2/.test((e as Error).message));
});

test("generateConfig: sourceLines maps generated line numbers back to the source", () => {
	const src = "Host a\n  IdentityFile ~/.ssh/k\n  Bogus x\n";
	const r = generateConfig(src, { mapIdentity: () => "/k.pub", pathExists: () => true, controlPersist: "10m", cmDir: "/cm", header: "one\ntwo" });
	const lines = r.text.split("\n");
	const at = (re: RegExp) => lines.findIndex((l) => re.test(l)) + 1;
	assert.equal(r.sourceLines[at(/^Host a$/)], 1);
	assert.equal(r.sourceLines[at(/IdentityFile "\/k\.pub"/)], 2);
	assert.equal(r.sourceLines[at(/IdentitiesOnly yes/)], 2);
	assert.equal(r.sourceLines[at(/Bogus x/)], 3);
	assert.equal(r.sourceLines[at(/^# one$/)], 0);
	assert.equal(r.sourceLines[at(/ControlMaster auto/)] ?? 0, 0);
});

test("matchKeyName", () => {
	const keys = [{ name: "web_key" }, { name: "My DB Key" }, { name: "dup" }, { name: "dup.pub" }, { name: "github.pem" }];
	assert.equal(matchKeyName("~/.ssh/web_key", keys)?.name, "web_key");
	assert.equal(matchKeyName("~/.ssh/web_key.pub", keys)?.name, "web_key");
	assert.equal(matchKeyName("~/.ssh/my_db_key", keys)?.name, "My DB Key");
	assert.equal(matchKeyName("~/.ssh/my-db-key", keys)?.name, "My DB Key");
	assert.equal(matchKeyName("~/.ssh/GitHub", keys)?.name, "github.pem");
	assert.equal(matchKeyName("~/.ssh/dup", keys), undefined);
	assert.equal(matchKeyName("~/.ssh/none", keys), undefined);
});

test("settings defaults and validation", () => {
	assert.deepEqual(parseSettings(undefined), { settings: DEFAULTS, warnings: [] });
	const ok = parseSettings({ keyTtl: "30m", autoLockMinutes: 0, configNote: "my-ssh", controlPersist: false });
	assert.deepEqual(ok.settings, { keyTtl: "30m", autoLockMinutes: 0, configNote: "my-ssh", controlPersist: false });
	assert.equal(parseSettings({ keyTtl: "0" }).settings.keyTtl, "");
	assert.equal(parseSettings({ keyTtl: 3600 }).settings.keyTtl, "3600");
	const bad = parseSettings({ keyTtl: "8 hours", autoLockMinutes: -1, configNote: "", controlPersist: "forever" });
	assert.deepEqual(bad.settings, DEFAULTS);
	assert.equal(bad.warnings.length, 4);
	assert.equal(parseSettings("x").warnings.length, 1);
});

test("paths: layout and long runDir fallback", () => {
	const p = resolvePaths({ agentDir: "/home/u/.pi/agent", home: "/home/u", uid: 1000 });
	assert.equal(p.stateFile, "/home/u/.pi/agent/bitwarden-ssh/state.json");
	assert.equal(p.sourceFile, "/home/u/.pi/agent/bitwarden-ssh/config");
	assert.equal(p.runDir, "/home/u/.pi/agent/bitwarden-ssh/run");
	assert.equal(p.agentSock, "/home/u/.pi/agent/bitwarden-ssh/run/ssh-agent.sock");
	assert.equal(p.generatedFile, "/home/u/.ssh/pi-bitwarden/config");
	assert.equal(p.keysDir, "/home/u/.ssh/pi-bitwarden/keys");
	assert.equal(p.cmDir, "/home/u/.ssh/pi-bitwarden/cm");
	assert.equal(p.userConfig, "/home/u/.ssh/config");
	const long = resolvePaths({ agentDir: `/home/u/${"x".repeat(80)}`, home: "/home/u", uid: 1000 });
	assert.equal(long.runDir, "/tmp/pi-bw-1000");
	assert.equal(long.agentSock, "/tmp/pi-bw-1000/ssh-agent.sock");
	assert.equal(long.stateFile, `/home/u/${"x".repeat(80)}/bitwarden-ssh/state.json`);
	// Socket paths fit macOS (104 bytes incl. NUL) as well as Linux (108).
	assert.ok(MAX_SOCKET_PATH <= 103);
	// ControlPath: cm/<40 hex %C> plus ssh's temporary ".<16 chars>" suffix must fit too.
	const mac = resolvePaths({ agentDir: "/Users/someone/.pi/agent", home: "/Users/someone", uid: 501 });
	assert.equal(mac.cmDir, "/Users/someone/.ssh/pi-bitwarden/cm");
	assert.ok(Buffer.byteLength(mac.cmDir) + CM_SOCKET_NAME <= MAX_SOCKET_PATH);
	const longHome = `/Users/${"n".repeat(40)}`;
	const lh = resolvePaths({ agentDir: `${longHome}/.pi/agent`, home: longHome, uid: 501 });
	assert.equal(lh.cmDir, "/tmp/pi-bw-501/cm");
	assert.equal(lh.generatedFile, `${longHome}/.ssh/pi-bitwarden/config`);
});

test("classifyPrompt and requester parsing", () => {
	assert.equal(classifyPrompt("Allow use of key?", true), "confirm");
	assert.equal(classifyPrompt("Are you sure you want to continue connecting (yes/no/[fingerprint])? ", false), "yesno");
	assert.equal(classifyPrompt("Username for 'https://github.com': ", false), "visible");
	assert.equal(classifyPrompt("Password for 'https://u@github.com': ", false), "secret");
	assert.equal(classifyPrompt("Enter passphrase for key '(stdin)': ", false), "secret");
	assert.equal(classifyPrompt("[sudo] password for orca: ", false), "secret");
	const r = parseCmdline("/usr/bin/ssh\0-T\0host\0");
	// No "known"/trusted flag: the claimed requester is only a hint and never suppresses the warning.
	assert.deepEqual(r, { cmdline: "/usr/bin/ssh -T host", program: "ssh" });
	assert.equal(parseCmdline(`x\0${"a".repeat(300)}`).cmdline.length, 200);
});

test("requester parent chain from /proc (hint only)", async () => {
	const proc = mkdtempSync(join(tmpdir(), "pi-bw-proc-"));
	try {
		const fake = (pid: number, ppid: number, comm: string, cmdline: string) => {
			mkdirSync(join(proc, String(pid)));
			writeFileSync(join(proc, String(pid), "stat"), `${pid} (${comm}) S ${ppid} 1 1 0 -1`);
			writeFileSync(join(proc, String(pid), "cmdline"), cmdline);
		};
		fake(100, 1, "pi", "pi\0");
		fake(200, 100, "ba sh)", "bash\0");
		fake(300, 200, "ssh", "/usr/bin/ssh\0host\0");
		fake(400, 1, "ssh", "/usr/bin/ssh\0forged\0"); // claims to be ssh, not below pi
		const info = procfsInfo(proc);
		assert.equal(await descendsFrom(300, 100, info), true);
		assert.equal(await descendsFrom(400, 100, info), false);
		assert.equal(await descendsFrom(999, 100, info), undefined);
		assert.deepEqual(await describeRequester(300, info, 100), { cmdline: "/usr/bin/ssh host", program: "ssh", fromThisPi: true });
		assert.deepEqual(await describeRequester(400, info, 100), { cmdline: "/usr/bin/ssh forged", program: "ssh", fromThisPi: false });
		assert.deepEqual(await describeRequester(999, info, 100), { cmdline: "(pid 999)", program: "" });
	} finally {
		rmSync(proc, { recursive: true, force: true });
	}
});

test("requester parent chain via ps (macOS path, injected ps)", async () => {
	const table: Record<number, { ppid: number; command: string }> = {
		100: { ppid: 1, command: "pi" },
		200: { ppid: 100, command: "/bin/zsh -l" },
		300: { ppid: 200, command: "/usr/bin/ssh -T host" },
		400: { ppid: 1, command: "/usr/bin/ssh forged" },
	};
	const calls: string[][] = [];
	const info = psInfo(async (args) => {
		calls.push(args);
		const [ww, o, field, p, pid] = args;
		assert.equal(ww, "-ww", "BSD ps must not truncate the command");
		assert.equal(o, "-o");
		assert.equal(p, "-p");
		const row = table[Number(pid)];
		if (!row) return { code: 1, stdout: "" };
		return { code: 0, stdout: field === "ppid=" ? `  ${row.ppid}\n` : `${row.command}\n` };
	});
	assert.equal(await descendsFrom(300, 100, info), true);
	assert.equal(await descendsFrom(400, 100, info), false);
	assert.equal(await descendsFrom(999, 100, info), undefined);
	assert.deepEqual(calls[0], ["-ww", "-o", "ppid=", "-p", "300"]);
	assert.deepEqual(await describeRequester(300, info, 100), { cmdline: "/usr/bin/ssh -T host", program: "ssh", fromThisPi: true });
	assert.deepEqual(await describeRequester(400, info, 100), { cmdline: "/usr/bin/ssh forged", program: "ssh", fromThisPi: false });
	assert.deepEqual(await describeRequester(999, info, 100), { cmdline: "(pid 999)", program: "" });
	assert.ok(calls.some((c) => c.join(" ") === "-ww -o command= -p 300"));
	// The real ps (here) gives the same answer as /proc for this process.
	const real = psInfo();
	assert.equal(await real.ppid(process.pid), process.ppid);
	assert.equal(await descendsFrom(process.pid, process.ppid, real), true);
	assert.match((await describeRequester(process.pid, real, process.ppid)).program, /node/);
	if (process.platform === "linux") assert.equal(await procfsInfo().ppid(process.pid), process.ppid);
	// darwin -> ps (works here too).
	assert.equal(await defaultProcInfo("darwin").ppid(process.pid), process.ppid);
});

test("tokenize like OpenSSH: comments, both quote kinds, fragments, escapes", () => {
	assert.deepEqual(tokenize("target # comment"), { args: ["target"], comment: "# comment" });
	assert.deepEqual(tokenize("a#b c"), { args: ["a#b", "c"] });
	assert.deepEqual(tokenize(`"~/.ssh/my key" # this key`), { args: ["~/.ssh/my key"], comment: "# this key" });
	assert.deepEqual(tokenize(`'~/.ssh/foo'`), { args: ["~/.ssh/foo"] });
	assert.deepEqual(tokenize(`a"b c"d 'e "f'`), { args: ["ab cd", `e "f`] });
	assert.deepEqual(tokenize(`"#not comment" x`), { args: ["#not comment", "x"] });
	assert.deepEqual(tokenize(String.raw`a\ b \"c`), { args: ["a b", `"c`] });
	assert.equal(tokenize(`"open`).unterminated, true);
});

test("comments and single quotes in directives: patterns, identities, removeHost", () => {
	const text = "Host target other # comment\n IdentityFile ~/.ssh/foo # this key\nHost q\n IdentityFile '~/.ssh/bar'\n IdentityFile \"~/.ssh/baz\" # c\n";
	const blocks = parseConfig(text);
	assert.equal(serializeConfig(blocks), text);
	assert.deepEqual(hostNames(blocks), ["target", "other", "q"]);
	assert.deepEqual(identityPaths(blocks), ["~/.ssh/foo", "~/.ssh/bar", "~/.ssh/baz"]);
	assert.deepEqual(listHosts(blocks)[0].options.identityfile, ["~/.ssh/foo"]);
	const gen = generateConfig(text, { mapIdentity: (p) => `/k/${p.split("/").pop()}.pub`, pathExists: () => false, controlPersist: false, cmDir: "/cm", header: "t" });
	assert.deepEqual(gen.mapped, ["~/.ssh/foo", "~/.ssh/bar", "~/.ssh/baz"]);
	assert.deepEqual(gen.unmatched, []);
	// Removing one pattern keeps the comment; removing the last removes the block.
	assert.equal(removeHost(blocks, "other"), true);
	assert.match(serializeConfig(blocks), /^Host target # comment\n/);
	const one = parseConfig("Host target # comment\n User bob\nHost x\n");
	assert.equal(removeHost(one, "target"), true);
	assert.equal(serializeConfig(one), "Host x\n");
});

test("ssh-add -l parsing and fingerprints", () => {
	const list = parseList("256 SHA256:abc/DEF+1 (stdin) (ED25519)\n3072 SHA256:xyz me@host (RSA)\n");
	assert.deepEqual(list, [
		{ bits: 256, fingerprint: "SHA256:abc/DEF+1", comment: "(stdin)", type: "ED25519" },
		{ bits: 3072, fingerprint: "SHA256:xyz", comment: "me@host", type: "RSA" },
	]);
	assert.equal(fingerprintOf("garbage"), undefined);
	assert.match(fingerprintOf("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7L0x7+aT7m2hJpD5n0Q3oP8nYhGJ4iX4o1Yq2bq4Xz c")!, /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("ui text helpers", () => {
	assert.equal(formatDuration(29.6 * 60_000), "30m");
	assert.equal(formatDuration(65 * 60_000), "1h 5m");
	assert.equal(footerText({ kind: "unlocked", loaded: 2 }), "🔐 unlocked · 2 keys");
	assert.equal(footerText({ kind: "locked", loaded: 1 }), "🔒 locked · 1 key");
	assert.equal(footerText({ kind: "unauthenticated" }), "bw: logged out");
	assert.equal(footerText({ kind: "missing" }), "bw: not installed");
	assert.equal(mentionsNetworkCommand("cd x && ssh web uptime"), true);
	assert.equal(mentionsNetworkCommand("echo sshfoo"), false);
	assert.deepEqual(hostsInCommand("ssh deploy@web uptime; scp f db:/tmp", ["web", "db", "other"]), ["web", "db"]);
	assert.deepEqual(hostsInCommand("git clone ssh://git@web:22/repo.git", ["web"]), ["web"]);
	assert.deepEqual(hostsInCommand("echo web", ["web"]), []);
	assert.equal(lineDiff("a\nb\nc\n", "a\nB\nc\n"), "  a\n- b\n+ B\n  c");
	assert.equal(lineDiff("a\n", "a\n"), "(no changes)");
});
