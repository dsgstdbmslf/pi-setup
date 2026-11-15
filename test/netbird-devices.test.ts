import "./isolated-env.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifierPromptCheck } from "./netbird-devices-helpers.ts";
import { buildClassifierPrompt, CLASSIFIER_SYSTEM, parseClassifierAnswer } from "../extensions/netbird-devices/classifier.ts";
import { inboundPeers, inNetbirdRange, mergePeers, parseApiPeers, parseGetentHosts, parseIpAddr, parseListeningPorts, parseNetbirdSshConfig } from "../extensions/netbird-devices/discovery.ts";
import { buildDevices, deviceNames, findDevice, userCandidates, userFromPeerName } from "../extensions/netbird-devices/devices.ts";
import { deviceTargetInCommand, mentionsNetVerb } from "../extensions/netbird-devices/guard.ts";
import { appendJournal, clock, formatEntry, formatLog, type JournalEntry, readJournal, rotatedName, shouldRotate } from "../extensions/netbird-devices/journal.ts";
import { resolvePaths } from "../extensions/netbird-devices/paths.ts";
import { type Action, approvalKey, dangerReason, decide, expandHome, globToRegExp, isReadOnlyCommand, normalizePosix, protectedInCommand, protectedMatch, resolveRemotePath, rmRecursiveOfRoot, splitCommands, splitSudo, words } from "../extensions/netbird-devices/policy.ts";
import { ACTIVE_SEC, AWAY_SEC, fmtIdle, IDLE_PROBE, parseIdle, resolveHere } from "../extensions/netbird-devices/presence.ts";
import { agentScript, askpassScript, bashWrapper, cdStep, parseProbe, pathVariants, pathVariantsScript, PROBE_SCRIPT, rootDialogText, rootNativeWrapper, rootStdinWrapper, shq } from "../extensions/netbird-devices/remote.ts";
import { DEFAULT_PROTECTED, DEFAULTS, parseSettings } from "../extensions/netbird-devices/settings.ts";
import { emptyState, loadState, saveState } from "../extensions/netbird-devices/state.ts";
import { actionSummary, confirmBody, confirmOptions, confirmTitle, displayPath, footerText, formatBytes, formatDeviceTable, lineDiff, truncate } from "../extensions/netbird-devices/ui-text.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "nbd-"));
const sh = (script: string, opts: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
	spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", input: opts.input ?? "", env: opts.env ?? process.env });

// --- settings ----------------------------------------------------------------------------------

test("settings: defaults and validation", () => {
	assert.deepEqual(parseSettings(undefined).settings, DEFAULTS);
	const { settings, warnings } = parseSettings({
		defaultMode: "auto",
		classifierModel: "openai-codex/gpt-6.1-terra",
		apiUrl: "https://nb.example/",
		localName: " cloudcli ",
		protected: ["~/secret/**"],
		devices: { mac: { peer: "sergeys-macbook-pro", aliases: ["МАК"], mode: "full", rootPrompt: "native", port: 2222 }, "bad name": {}, x: 5 },
	});
	assert.equal(settings.defaultMode, "auto");
	assert.equal(settings.apiUrl, "https://nb.example");
	assert.equal(settings.localName, "cloudcli");
	assert.equal(settings.devices.mac.port, 2222);
	assert.equal(settings.devices.mac.rootPrompt, "native");
	assert.equal(warnings.length, 2);
	assert.equal(parseSettings({ defaultMode: "yolo" }).warnings.length, 1);
	assert.equal(parseSettings("x").settings.defaultMode, "ask");
});

// --- discovery ---------------------------------------------------------------------------------

const NB_CONF = `Host *
Match host "100.71.171.69,fd00::1,sergeys-macbook-pro.netbird.cloud,sergeys-macbook-pro"
    UserKnownHostsFile /dev/null
Match host "100.71.201.21,personal-project-nl.netbird.cloud,personal-project-nl"
`;

test("discovery: 99-netbird.conf, API, merge, range", () => {
	const peers = parseNetbirdSshConfig(NB_CONF);
	assert.equal(peers.length, 2);
	assert.deepEqual(peers[0], { name: "sergeys-macbook-pro", fqdn: "sergeys-macbook-pro.netbird.cloud", ips: ["100.71.171.69", "fd00::1"], sshEnabled: true });
	const api = parseApiPeers([{ dns_label: "Sergeys-MacBook-Pro.netbird.cloud", ip: "100.71.171.69", connected: true, os: "macOS 27", ssh_enabled: false }, { nope: 1 }]);
	assert.equal(api[0].name, "sergeys-macbook-pro");
	const merged = mergePeers(peers, api);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].connected, true);
	assert.equal(merged[0].os, "macOS 27");
	assert.equal(merged[0].sshEnabled, true);
	assert.ok(inNetbirdRange("100.71.1.1") && !inNetbirdRange("100.128.0.1") && !inNetbirdRange("10.0.0.1"));
});

test("discovery: ss parsing", () => {
	const listen = "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:6768 0.0.0.0:*\nLISTEN 0 5 [::]:8080 [::]:*";
	assert.deepEqual([...parseListeningPorts(listen)].sort((a, b) => a - b), [22, 6768, 8080]);
	const est = "ESTAB 0 0 100.71.73.147:6768 100.71.171.69:50000\nESTAB 0 0 100.71.73.147:9999 100.71.171.69:50001\nESTAB 0 0 127.0.0.1:6768 100.71.171.69:5";
	const m = inboundPeers(est, new Set([6768]), ["100.71.73.147"]);
	assert.deepEqual([...m], [["100.71.171.69", 1]]);
});

test("discovery: parseGetentHosts and parseIpAddr (change 10)", () => {
	assert.deepEqual(parseGetentHosts("100.71.171.69   sergeys-macbook-pro.netbird.cloud\n\nfd00::1 Host.Netbird.Cloud. alias\njunk line\n"), [
		{ ip: "100.71.171.69", names: ["sergeys-macbook-pro.netbird.cloud"] },
		{ ip: "fd00::1", names: ["host.netbird.cloud", "alias"] },
	]);
	assert.deepEqual(parseGetentHosts(""), []);
	const out = "4: wt0    inet 100.71.73.147/16 scope global wt0\\       valid_lft forever preferred_lft forever\n2: eth0    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0\\       valid_lft forever\n4: wt0    inet6 fd00::7/64 scope global";
	assert.deepEqual(parseIpAddr(out, "wt0"), ["100.71.73.147", "fd00::7"]);
	assert.deepEqual(parseIpAddr(out, "eth0"), ["10.0.0.5"]);
	assert.deepEqual(parseIpAddr(out), ["100.71.73.147", "10.0.0.5", "fd00::7"]);
	assert.deepEqual(parseIpAddr("", "wt0"), []);
});

// --- policy: paths -----------------------------------------------------------------------------

test("policy: paths and protected globs", () => {
	assert.equal(expandHome("~/x", "/h/"), "/h/x");
	assert.equal(normalizePosix("/a/b/../c//./d"), "/a/c/d");
	assert.equal(resolveRemotePath("@docs/../x", "/Users/s"), "/Users/s/x");
	assert.equal(resolveRemotePath("~", "/Users/s"), "/Users/s");
	assert.ok(globToRegExp("**/.env.*").test("/a/b/.env.local"));
	assert.equal(protectedMatch("/Users/s/.ssh/id_rsa", "/Users/s", DEFAULT_PROTECTED), "~/.ssh/**");
	assert.equal(protectedMatch("/Users/s/.ssh", "/Users/s", DEFAULT_PROTECTED), "~/.ssh/**");
	assert.equal(protectedMatch("/Users/s/proj/.env", "/Users/s", DEFAULT_PROTECTED), "**/.env");
	assert.equal(protectedMatch("/Users/s/proj/app.ts", "/Users/s", DEFAULT_PROTECTED), undefined);
});

// --- policy: read-only commands (change 3) -----------------------------------------------------

const RO = (c: string) => isReadOnlyCommand(c);

test("policy: plain read-only commands still pass", () => {
	for (const c of [
		"ls -la ~/proj", "cat a.txt | head -n 5", "grep foo file | wc -l",
		"sort a.txt | uniq -c", "uniq a.txt", "date", "date +%s", "date -u +%FT%T", "hostname", "hostname -f", "mount", "mount -l", "mount -t nfs",
		"xxd file.bin | head", "xxd -l 16 file.bin", "base64 file.txt", "base64 -d file.b64", "tree -L 2", "rg -n foo", "codesign -dv /Applications/X.app", "codesign --verify --deep /Applications/X.app",
		"command -v brew", "ifconfig", "ifconfig -a", "ifconfig en0", "scutil --get ComputerName", "networksetup -listallhardwareports",
		"echo hi 2>&1", "ls /nonexistent 2>/dev/null",
	]) assert.ok(RO(c), `should be read-only: ${c}`);
});

test("policy: commands that write or execute are not read-only", () => {
	for (const c of [
		"sort -o out.txt in.txt", "sort -ro out in", "sort --output=out in", "sort --compress-program=sh in", "uniq in out", "xxd -r hex.txt out.bin", "xxd -r -p a b", "xxd in out", "base64 -o out in", "base64 -i in -o out",
		"codesign -s - /tmp/x", "codesign --sign ID app", "codesign --force --sign - app", "codesign --remove-signature app", "tree -o out.txt", "tree -L 2 -o out", "rg --pre ./evil.sh foo", "rg --pre=./evil foo",
		"git branch newbranch", "git branch -d old", "git branch -D old", "git branch -m a b", "git branch -a foo", "git remote add x url", "git remote remove x", "git remote set-url x u", "git remote rename a b",
		"git tag v1", "git tag -d v1", "git tag -a v1 -m x", "git diff --output=out.patch", "git log --output out", "git show --output=x",
		"date -s 2020-01-01", "date --set=2020-01-01", "date 123123592020", "hostname newname", "mount /dev/disk2 /mnt", "mount -t ext4 /dev/sda1 /mnt",
		"env", "printenv", "printenv SECRET", "env FOO=1 ls", "command rm -rf x", "ifconfig en0 down", "dmesg -c", "scutil --set HostName x", "networksetup -setdnsservers Wi-Fi 1.1.1.1",
		"awk 'BEGIN{print \"x\" | \"sh\"}'", "sudo ls", "ls > out", "cat $(whoami)", "ls &", "rm file", "git push",
	]) assert.ok(!RO(c), `should NOT be read-only: ${c}`);
});

test("policy: splitCommands / words / splitSudo", () => {
	assert.deepEqual(splitCommands("a && b; c | d"), ["a", "b", "c", "d"]);
	assert.equal(splitCommands("a &"), undefined);
	assert.equal(splitCommands("echo 'x"), undefined);
	assert.deepEqual(words(`git commit -m "a b" 'c d' e\\ f`), ["git", "commit", "-m", "a b", "c d", "e f"]);
	assert.equal(splitSudo("sudo systemctl restart nginx"), "systemctl restart nginx");
	assert.equal(splitSudo("sudo -u bob ls"), undefined);
	assert.equal(splitSudo("echo sudo"), undefined);
});

// --- policy: danger (changes 4, 5) -------------------------------------------------------------

test("policy: dangerous rm variants (change 4)", () => {
	for (const c of [
		"rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf ~/", "rm -rf ~/*", "rm -rf ~/.*", "rm -rf $HOME", "rm -rf $HOME/", "rm -rf $HOME/*", 'rm -rf "$HOME"/*', 'rm -rf "${HOME}"/*', "rm -rf ${HOME}/*",
		"rm -fr ~/*", "rm -r -f ~/*", "rm -Rf $HOME/*", "rm --recursive --force ~/", "rm -rf -- ~/*", "rm ~/* -rf", "rm -rf ~//", "sudo rm -rf /", "ls; rm -rf ~/* &", "sh -c 'rm -rf ~/*'", "/bin/rm -rf /", "cd x && rm -rf ~",
	]) {
		assert.ok(rmRecursiveOfRoot(c), `rm danger: ${c}`);
		assert.equal(dangerReason(c), "recursive delete of / or home", c);
	}
	for (const c of ["rm -rf ./build", "rm -rf ~/proj/build", "rm -f ~/x", "rm ~/*", "rm -rf /tmp/x", "echo rm", "ls ~/*", "rm -r mydir/"]) assert.equal(dangerReason(c), undefined, c);
	assert.ok(dangerReason("mkfs.ext4 /dev/sda1") && dangerReason("diskutil eraseDisk APFS X disk2") && dangerReason("sudo reboot"));
});

test("policy: dangerous commands are always asked and never cached (change 5)", () => {
	for (const mode of ["ro", "ask", "auto", "full"] as const) {
		for (const approved of [false, true]) {
			const d = decide({ mode, action: { kind: "bash", command: "rm -rf ~/*", root: false }, approved });
			assert.equal(d.verdict, "ask", `${mode} approved=${approved}`);
			assert.equal(d.danger, true);
		}
	}
	const root = decide({ mode: "full", action: { kind: "bash", command: "rm -rf /", root: true }, approved: true });
	assert.equal(root.verdict, "ask");
	assert.equal(root.danger, true);
	// non-dangerous: approval still works
	assert.equal(decide({ mode: "ask", action: { kind: "bash", command: "make", root: false }, approved: true }).verdict, "allow");
	assert.equal(decide({ mode: "ask", action: { kind: "bash", command: "make", root: false } }).danger, undefined);
});

test("policy: decide matrix", () => {
	const bash = (command: string, root = false): Action => ({ kind: "bash", command, root });
	const write: Action = { kind: "write", path: "/h/a.txt", diff: "+x", isNew: true };
	assert.equal(decide({ mode: "ro", action: write }).verdict, "deny");
	assert.equal(decide({ mode: "ask", action: write }).verdict, "ask");
	assert.equal(decide({ mode: "auto", action: write }).verdict, "classify");
	assert.equal(decide({ mode: "full", action: write }).verdict, "allow");
	assert.equal(decide({ mode: "full", action: write, protectedHit: "~/.ssh/**" }).verdict, "ask");
	assert.equal(decide({ mode: "ask", action: { kind: "read", path: "/x" } }).verdict, "allow");
	assert.equal(decide({ mode: "ask", action: { kind: "read", path: "/x" }, protectedHit: "g" }).verdict, "ask");
	assert.equal(decide({ mode: "ro", action: bash("ls") }).verdict, "allow");
	assert.equal(decide({ mode: "ro", action: bash("make") }).verdict, "ask");
	assert.equal(decide({ mode: "auto", action: bash("make") }).verdict, "classify");
	assert.equal(decide({ mode: "full", action: bash("make") }).verdict, "allow");
	assert.equal(decide({ mode: "ro", action: bash("ls", true) }).verdict, "deny");
	assert.equal(decide({ mode: "ask", action: bash("ls", true) }).verdict, "ask");
	assert.equal(decide({ mode: "auto", action: bash("ls", true) }).verdict, "classify");
	assert.equal(approvalKey(bash(" ls ", true)), "bash:root:ls");
	assert.equal(approvalKey(write), "write:/h/a.txt");
});

// --- policy: protected paths in bash (change 2) ------------------------------------------------

const HOME = "/Users/s";
const PIC = (c: string, cwd?: string) => protectedInCommand(c, HOME, DEFAULT_PROTECTED, cwd);

test("policy: protectedInCommand finds protected paths in command words (change 2)", () => {
	assert.equal(PIC("cat ~/.ssh/id_rsa"), "~/.ssh/**");
	assert.equal(PIC("grep -r . ~/.aws"), "~/.aws/**");
	assert.equal(PIC("cat $HOME/.ssh/id_rsa"), "~/.ssh/**");
	assert.equal(PIC('cat "${HOME}/.ssh/id_rsa"'), "~/.ssh/**");
	assert.equal(PIC("cat /Users/s/.netrc"), "~/.netrc");
	assert.equal(PIC("ls ~/.ssh/"), "~/.ssh/**");
	assert.equal(PIC("cat .env", "/Users/s/proj"), "**/.env");
	assert.equal(PIC("cat ../.ssh/config", "/Users/s/proj"), "~/.ssh/**");
	assert.equal(PIC("cd ~/.ssh && cat id_rsa"), "~/.ssh/**");
	assert.equal(PIC("echo x >~/.netrc"), "~/.netrc");
	assert.equal(PIC("echo x 2>>~/.ssh/log"), "~/.ssh/**");
	assert.equal(PIC("tail --file=~/.aws/credentials"), "~/.aws/**");
	assert.equal(PIC("cat /etc/shadow"), "/etc/shadow");
	assert.equal(PIC("ls ~/proj; cat ~/proj/a.txt"), undefined);
	assert.equal(PIC("ls -la"), undefined);
	assert.equal(PIC("ls", "/Users/s/proj"), undefined);
});

test("policy: read-only command touching a protected path is asked with a warning (change 2)", () => {
	const cmd = "cat ~/.ssh/id_rsa";
	const hit = PIC(cmd);
	assert.ok(RO(cmd));
	for (const mode of ["ro", "ask", "auto", "full"] as const) {
		const d = decide({ mode, action: { kind: "bash", command: cmd, root: false }, protectedHit: hit });
		assert.equal(d.verdict, "ask", mode);
		assert.ok(d.warning);
	}
	assert.equal(decide({ mode: "ask", action: { kind: "bash", command: cmd, root: false }, protectedHit: hit, approved: true }).verdict, "allow");
	assert.equal(decide({ mode: "ask", action: { kind: "bash", command: "ls", root: false } }).verdict, "allow");
	assert.equal(decide({ mode: "full", action: { kind: "bash", command: "cat /etc/shadow", root: true }, protectedHit: "/etc/shadow" }).verdict, "ask");
});

// --- guard (change 6) --------------------------------------------------------------------------

test("guard: network verbs and device targets", () => {
	const t = { names: new Set(["mac", "sergeys-macbook-pro", "100.71.171.69"]), domains: ["netbird.cloud"], self: new Set(["cloudcli", "100.71.73.147"]) };
	assert.equal(deviceTargetInCommand("ssh mac", t), "mac");
	assert.equal(deviceTargetInCommand("ssh sergey@sergeys-macbook-pro.netbird.cloud ls", t), "sergeys-macbook-pro.netbird.cloud");
	assert.equal(deviceTargetInCommand("scp a.txt mac:/tmp/", t), "mac");
	assert.equal(deviceTargetInCommand("curl http://100.71.200.1:8080/x", t), "100.71.200.1");
	assert.equal(deviceTargetInCommand("ssh cloudcli", t), undefined);
	assert.equal(deviceTargetInCommand("ls mac", t), undefined);
	assert.ok(mentionsNetVerb("echo hi; git push"));
});

test("guard: absolute and prefixed verbs, loopback (change 6)", () => {
	const t = { names: new Set(["mac"]), domains: ["netbird.cloud"], self: new Set<string>() };
	assert.equal(deviceTargetInCommand("/usr/bin/ssh mac", t), "mac");
	assert.equal(deviceTargetInCommand("command ssh mac", t), "mac");
	assert.equal(deviceTargetInCommand("exec ssh mac", t), "mac");
	assert.equal(deviceTargetInCommand("env FOO=1 /usr/local/bin/rsync -a x mac:y", t), "mac");
	assert.equal(deviceTargetInCommand("(/usr/bin/ssh mac)", t), "mac");
	assert.equal(deviceTargetInCommand("ssh localhost", t), undefined);
	assert.equal(deviceTargetInCommand("curl http://127.0.0.1:6768/x", t), undefined);
	assert.equal(deviceTargetInCommand("ssh -p 22 user@127.0.0.1", t), undefined);
	assert.equal(deviceTargetInCommand("ssh ::1", t), undefined);
	assert.ok(!mentionsNetVerb("cat /home/x/ssh/config"));
});

// --- presence (change 7) -----------------------------------------------------------------------

test("presence: resolveHere", () => {
	assert.equal(resolveHere([], "mac").kind, "found");
	assert.equal(resolveHere([]).kind, "none");
	assert.deepEqual(resolveHere([{ device: "mac", connected: true }]), { kind: "found", device: "mac", why: "the only device connected to this machine" });
	const two = [{ device: "mac", connected: true, idleSec: 3 }, { device: "pc", connected: true, idleSec: AWAY_SEC + 1 }];
	assert.equal((resolveHere(two) as any).device, "mac");
	assert.equal(resolveHere([{ device: "mac", connected: true }, { device: "pc", connected: true }]).kind, "ambiguous");
	const now = 1_000_000;
	const r = resolveHere([{ device: "mac", connected: true }, { device: "pc", connected: true }], undefined, { device: "pc", at: now - 60_000 }, now);
	assert.equal((r as any).device, "pc");
	assert.equal(fmtIdle(3), "3s");
	assert.equal(fmtIdle(ACTIVE_SEC), "2m");
	assert.equal(parseIdle("junk\n 42 \n"), 42);
	assert.equal(parseIdle(""), undefined);
});

test("presence: IDLE_PROBE uses the realtime IdleSinceHint against date +%s and resets L_* (change 7)", { skip: process.platform === "darwin" }, () => {
	assert.ok(IDLE_PROBE.includes("IdleSinceHint") && !IDLE_PROBE.includes("Monotonic") && !IDLE_PROBE.includes("/proc/uptime") && IDLE_PROBE.includes("date +%s"));
	const dir = tmp();
	try {
		const now = Math.floor(Date.now() / 1000);
		// session 1 is a tty (no Type match), session 2 is an active x11 session idle for 90 s; the first one must not leak values.
		writeFileSync(
			join(dir, "loginctl"),
			`#!/bin/sh
case "$1" in
list-sessions) printf '1 1000 u seat0\\n2 1000 u seat0\\n' ;;
show-session) if [ "$2" = 1 ]; then printf 'Type=tty\\nActive=yes\\nIdleHint=yes\\nIdleSinceHint=1\\n'; else printf 'Type=x11\\nActive=yes\\nIdleHint=yes\\nIdleSinceHint=%s\\n' "$(( (${now} - 90) * 1000000 ))"; fi ;;
esac
`,
		);
		chmodSync(join(dir, "loginctl"), 0o755);
		const r = sh(IDLE_PROBE, { env: { PATH: `${dir}:/usr/bin:/bin` } });
		const n = parseIdle(r.stdout);
		assert.ok(n !== undefined && n >= 89 && n <= 95, `idle=${n} stderr=${r.stderr}`);
		// IdleHint=no -> 0
		writeFileSync(join(dir, "loginctl"), `#!/bin/sh\ncase "$1" in list-sessions) echo '2 1000 u seat0';; show-session) printf 'Type=wayland\\nActive=yes\\nIdleHint=no\\nIdleSinceHint=0\\n';; esac\n`);
		assert.equal(parseIdle(sh(IDLE_PROBE, { env: { PATH: `${dir}:/usr/bin:/bin` } }).stdout), 0);
		// A non-GUI session after a GUI one must not reuse the previous Type/Active.
		writeFileSync(join(dir, "loginctl"), `#!/bin/sh\ncase "$1" in list-sessions) printf '1 1000 u seat0\\n2 1000 u seat0\\n';; show-session) if [ "$2" = 1 ]; then printf 'Type=tty\\nActive=yes\\n'; else printf 'IdleHint=yes\\n'; fi;; esac\n`);
		assert.equal(parseIdle(sh(IDLE_PROBE, { env: { PATH: `${dir}:/usr/bin:/bin` } }).stdout), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- classifier --------------------------------------------------------------------------------

test("classifier: prompt and answer", () => {
	const p = buildClassifierPrompt({ device: "mac", os: "macOS", user: "s", action: { kind: "bash", command: "brew install jq", root: false }, userMessages: ["install jq", "thanks"] });
	assert.match(p, /Device: mac \(macOS\), user s/);
	assert.match(p, /<msg 1>\ninstall jq/);
	assert.match(p, /brew install jq/);
	assert.ok(CLASSIFIER_SYSTEM.includes("JSON"));
	assert.deepEqual(parseClassifierAnswer('ok {"decision":"allow","reason":"asked\\nfor it"}'), { decision: "allow", reason: "asked for it" });
	assert.equal(parseClassifierAnswer('{"decision":"yes"}'), undefined);
	assert.equal(parseClassifierAnswer("nope"), undefined);
	assert.ok(classifierPromptCheck(buildClassifierPrompt({ device: "d", action: { kind: "write", path: "/x", diff: "d".repeat(5000), isNew: false }, userMessages: [] })) > 0);
});

// --- remote scripts ----------------------------------------------------------------------------

test("remote: shq round trip and probe parsing", () => {
	for (const s of ["a b", "it's", "$HOME `x`", "", "a\nb"]) assert.equal(sh(`printf %s ${shq(s)}`).stdout, s);
	const p = parseProbe("nb_os=Darwin\nnb_arch=arm64\nnb_user=sergey\nnb_home=/Users/sergey\nnb_shell=/bin/zsh\nnb_osver=macOS 27.0\nnb_console=sergey\nnb_path=/opt/homebrew/bin:/usr/bin\nnb_sudo=1\n");
	assert.deepEqual(p, { os: "Darwin", arch: "arm64", user: "sergey", home: "/Users/sergey", shell: "/bin/zsh", osver: "macOS 27.0", console: "sergey", path: "/opt/homebrew/bin:/usr/bin", sudo: true });
	assert.equal(parseProbe("nb_os=Linux\n"), undefined);
	assert.equal(parseProbe("nb_user=a\nnb_home=/h\nnb_console=loginwindow\n")!.console, undefined);
	const local = sh(PROBE_SCRIPT);
	assert.equal(parseProbe(local.stdout)?.os, process.platform === "darwin" ? "Darwin" : "Linux");
});

test("remote: bashWrapper runs the command with empty stdin (change 1)", () => {
	const script = bashWrapper("cat", {});
	assert.ok(script.includes("exec </dev/null"));
	// What the wrapper reads from stdin (a password) never reaches the command.
	const r = sh(script, { input: "SECRET-PASSWORD\n" });
	assert.equal(r.stdout, "");
	assert.equal(r.status, 0);
	assert.equal(sh(bashWrapper("echo hi; read x; echo got=$x", {}), { input: "pw\n" }).stdout, "hi\ngot=\n");
	assert.ok(agentScript("ls").startsWith("exec </dev/null; "));
	// heredocs in the agent command still work
	assert.equal(sh(bashWrapper("cat <<EOF\nline\nEOF", {})).stdout, "line\n");
});

test("remote: root wrappers redirect the command's stdin (change 1)", () => {
	for (const w of [rootStdinWrapper("cat", {}), rootNativeWrapper("cat", { os: "Linux", title: "t", text: "x" })]) {
		assert.ok(w.includes("exec </dev/null; cat"), w);
	}
	// Simulate sudo with NOPASSWD: it does not read the password and passes stdin on to the command.
	const dir = tmp();
	try {
		writeFileSync(join(dir, "sudo"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done\nexec "$@"\n`);
		chmodSync(join(dir, "sudo"), 0o755);
		const r = sh(rootStdinWrapper("cat", {}).replaceAll("/usr/bin/sudo", join(dir, "sudo")), { input: "SECRET-PASSWORD\n", env: { PATH: `${dir}:/usr/bin:/bin` } });
		assert.equal(r.stdout, "", `password leaked: ${r.stdout}`);
		assert.equal(r.status, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("remote: missing cwd is an error, not home (change 8)", () => {
	const dir = tmp();
	try {
		const nodir = join(dir, "does not exist");
		for (const w of [bashWrapper("pwd", { cwd: nodir }), rootStdinWrapper("pwd", { cwd: nodir }), rootNativeWrapper("pwd", { os: "Linux", cwd: nodir, title: "t", text: "x" })]) {
			const r = sh(w, { env: { ...process.env, PATH: process.env.PATH } });
			assert.equal(r.status, 2, w);
			assert.equal(r.stderr.trim(), `pi-nb: no such directory: ${nodir}`);
			assert.equal(r.stdout, "");
		}
		assert.equal(sh(bashWrapper("pwd", { cwd: dir })).stdout.trim(), dir);
		assert.equal(sh(bashWrapper("pwd", {}), { env: { ...process.env, HOME: dir } }).stdout.trim(), dir);
		// hostile directory names are quoted
		assert.equal(cdStep(`/x'; echo pwned; '`).includes("pwned"), true);
		const evil = sh(bashWrapper("true", { cwd: `/x'; echo pwned; '` }));
		assert.equal(evil.stdout, "");
		assert.equal(evil.status, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("remote: path variants include NFC, NFD and U+202F (change 9)", () => {
	const nfc = "/Users/s/Desktop/Скриншот é 3.04.05 PM.png";
	const nfd = nfc.normalize("NFD");
	assert.notEqual(nfc, nfd);
	for (const base of [nfc, nfd]) {
		const v = pathVariants(base);
		assert.ok(v.includes(nfc), "NFC form");
		assert.ok(v.includes(nfd), "NFD form");
		assert.ok(v.includes(nfc.replace(" PM.", "\u202FPM.")), "NFC + U+202F");
		assert.ok(v.includes(nfd.replace(" PM.", "\u202FPM.")), "NFD + U+202F");
	}
	assert.ok(pathVariants("/a/it's.png").includes("/a/it\u2019s.png"));
	// The script finds a real file whose name is in another normalization / with U+202F.
	const dir = tmp();
	try {
		const real = join(dir, "Screenshot é 3.04.05\u202FPM.png".normalize("NFD"));
		writeFileSync(real, "x");
		const asked = join(dir, "Screenshot é 3.04.05 PM.png".normalize("NFC"));
		const r = sh(pathVariantsScript(asked));
		assert.equal(r.status, 0);
		assert.equal(r.stdout, real);
		assert.equal(sh(pathVariantsScript(join(dir, "nope.png"))).status, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("remote: root native wrapper structure", () => {
	const w = rootNativeWrapper("ls", { os: "Darwin", cwd: "/x", path: "/bin", title: "T", text: "X" });
	assert.ok(w.includes("sudo -k -A") && w.includes("osascript") && w.includes("exit 196") && w.includes("exit 197"));
	assert.ok(askpassScript("Linux").includes("zenity") && askpassScript("Darwin").includes("System Events"));
	assert.equal(sh(`sh -n <<'X'\n${w}\nX`).status, 0);
	assert.match(rootDialogText("x".repeat(400), "cloudcli"), /cloudcli.*…/s);
});

// --- devices (change 11) -----------------------------------------------------------------------

const PEERS = parseNetbirdSshConfig(`Match host "100.71.171.69,sergeys-macbook-pro.netbird.cloud,sergeys-macbook-pro"
Match host "100.71.201.21,personal-project-nl.netbird.cloud,personal-project-nl"
Match host "100.71.73.147,cloudcli.netbird.cloud,cloudcli"
Match host "100.71.5.5,iphone-1037955.netbird.cloud,iphone-1037955"
`);

test("devices: buildDevices, auto aliases, local peer excluded (change 11)", () => {
	const { settings } = parseSettings({ devices: { nl: { peer: "personal-project-nl", aliases: ["НЛ", "Server"] } } });
	const hints = { "sergeys-macbook-pro": "macOS 27.0" };
	const ds = buildDevices(settings, PEERS, ["CloudCLI", "100.71.73.147", "old-man.vpspay.net"], hints);
	assert.deepEqual(ds.map((d) => d.name), ["nl", "sergeys-macbook-pro", "iphone-1037955"]);
	const mac = ds.find((d) => d.name === "sergeys-macbook-pro")!;
	assert.deepEqual(mac.aliases, ["mac"]);
	assert.equal(mac.configured, false);
	assert.equal(mac.fqdn, "sergeys-macbook-pro.netbird.cloud");
	const nl = ds[0];
	assert.deepEqual(nl.aliases, ["нл", "server"]);
	assert.equal(nl.peer, "personal-project-nl");
	assert.deepEqual(nl.ips, ["100.71.201.21"]);
	assert.equal(nl.configured, true);
	assert.deepEqual(ds[2].aliases, []);
});

test("devices: mac/linux aliases only when unambiguous; configured names win", () => {
	const { settings } = parseSettings({ devices: { mac: { peer: "sergeys-macbook-pro" } } });
	const ds = buildDevices(settings, PEERS, ["cloudcli"]);
	assert.equal(ds[0].name, "mac");
	assert.deepEqual(ds[0].aliases, []); // "mac" is already the name
	assert.equal(ds.filter((d) => d.peer === "sergeys-macbook-pro").length, 1);
	// two Macs -> no auto alias
	const peers = [...PEERS, { name: "work-macbook-air", ips: ["100.71.9.9"], sshEnabled: true }];
	const two = buildDevices(parseSettings({}).settings, peers, [], { "sergeys-macbook-pro": "macOS", "work-macbook-air": "macOS" });
	assert.ok(two.every((d) => !d.aliases.includes("mac")));
	// one Linux box via hint
	const lin = buildDevices(parseSettings({}).settings, PEERS, [], { "personal-project-nl": "Ubuntu 24.04" });
	assert.deepEqual(lin.find((d) => d.name === "personal-project-nl")!.aliases, ["linux"]);
	// alias collision: first claim wins, device name beats alias
	const col = buildDevices(parseSettings({ devices: { a: { peer: "x", aliases: ["b", "Dup"] }, b: { peer: "y", aliases: ["dup"] } } }).settings, []);
	assert.deepEqual(col.map((d) => d.aliases), [["dup"], []]);
	// configured device without matching peer: IP / FQDN peer
	const un = buildDevices(parseSettings({ devices: { box: { peer: "100.64.0.9" }, fq: { peer: "x.netbird.cloud" } } }).settings, []);
	assert.deepEqual(un[0].ips, ["100.64.0.9"]);
	assert.equal(un[1].fqdn, "x.netbird.cloud");
});

test("devices: findDevice and deviceNames", () => {
	const { settings } = parseSettings({ devices: { nl: { peer: "personal-project-nl", aliases: ["НЛ"] } } });
	const ds = buildDevices(settings, PEERS, ["cloudcli"], { "sergeys-macbook-pro": "macOS" });
	assert.equal(findDevice(ds, "NL")?.name, "nl");
	assert.equal(findDevice(ds, "нл")?.name, "nl");
	assert.equal(findDevice(ds, "mac")?.name, "sergeys-macbook-pro");
	assert.equal(findDevice(ds, "Sergeys-MacBook-Pro.netbird.cloud.")?.name, "sergeys-macbook-pro");
	assert.equal(findDevice(ds, "100.71.171.69")?.name, "sergeys-macbook-pro");
	assert.equal(findDevice(ds, "personal-project-nl")?.name, "nl");
	assert.equal(findDevice(ds, "nope"), undefined);
	assert.equal(findDevice(ds, "  "), undefined);
	const names = deviceNames(ds);
	assert.ok(names.has("mac") && names.has("100.71.201.21") && names.has("нл") && !names.has("cloudcli"));
	const t = { names, domains: ["netbird.cloud"], self: new Set(["cloudcli"]) };
	assert.equal(deviceTargetInCommand("ssh mac", t), "mac");
});

test("devices: userFromPeerName and userCandidates", () => {
	assert.deepEqual(userFromPeerName("sergeys-macbook-pro"), ["sergey", "sergeys"]);
	assert.deepEqual(userFromPeerName("sergey-pc"), ["sergey"]);
	assert.deepEqual(userFromPeerName("macbook-pro"), []);
	assert.deepEqual(userFromPeerName("iphone-1037955"), []);
	assert.deepEqual(userFromPeerName("personal-project-nl"), []);
	assert.deepEqual(userFromPeerName("laptop"), []);
	assert.deepEqual(userCandidates("sergeys-macbook-pro", "bob", "alice", "orca"), ["bob", "alice", "sergey", "sergeys", "orca"]);
	assert.deepEqual(userCandidates("sergeys-macbook-pro", undefined, "sergey", "orca"), ["sergey", "sergeys", "orca"]);
	assert.deepEqual(userCandidates("x", "root", "root", "root"), []);
	assert.deepEqual(userCandidates("x", " ", undefined, "bad user"), []);
});

// --- state -------------------------------------------------------------------------------------

test("state: round trip, permissions, corrupt files", () => {
	const dir = tmp();
	try {
		const f = join(dir, "state.json");
		assert.deepEqual(loadState(f), { state: emptyState() });
		const s = emptyState();
		s.devices.mac = { user: "sergey", userSource: "asked", probe: { os: "Darwin", user: "sergey", home: "/Users/sergey", sudo: true, console: "sergey", at: 5 } };
		s.classifierModel = "anthropic/claude-haiku-5-5";
		s.hereChoice = { device: "mac", at: 7 };
		saveState(f, s);
		assert.equal(statSync(f).mode & 0o777, 0o600);
		assert.deepEqual(loadState(f).state, s);
		saveState(f, s); // overwrite
		writeFileSync(f, JSON.stringify({ devices: { a: { user: 5, userSource: "x", probe: { os: "x" } }, b: null }, hereChoice: { device: 1 } }));
		const l = loadState(f);
		assert.deepEqual(l.state.devices, { a: {} });
		assert.equal(l.state.hereChoice, undefined);
		writeFileSync(f, "{nope");
		assert.match(loadState(f).warning!, /not valid JSON/);
		assert.deepEqual(loadState(f).state, emptyState());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("paths: layout and ControlPath fallback", () => {
	const p = resolvePaths({ agentDir: "/home/u/.pi/agent", uid: 1000 });
	assert.equal(p.stateFile, "/home/u/.pi/agent/netbird-devices/state.json");
	assert.equal(p.cmDir, "/home/u/.pi/agent/netbird-devices/cm");
	assert.equal(p.journalFile, "/home/u/.pi/agent/netbird-devices/log.jsonl");
	const deep = resolvePaths({ agentDir: `/very/${"long/".repeat(20)}agent`, uid: 7 });
	assert.equal(deep.cmDir, "/tmp/pi-nb-7/cm");
	assert.ok(Buffer.byteLength(`${p.cmDir}/`) + 40 + 17 <= 100);
});

// --- journal -----------------------------------------------------------------------------------

const E = (over: Partial<JournalEntry> = {}): JournalEntry => ({ ts: new Date(2026, 10, 15, 13, 42, 5).getTime(), session: "s1", device: "mac", user: "sergey", tool: "read", summary: "~/Desktop/a.png", decision: "auto", ok: true, ms: 40, ...over });

test("journal: formatting", () => {
	assert.equal(clock(E().ts), "13:42:05");
	assert.equal(formatEntry(E({ detail: "1.2 MB" })), "13:42:05  mac  read  ~/Desktop/a.png  ✓ 1.2 MB");
	assert.equal(formatEntry(E({ tool: "bash", summary: "brew list | head", detail: "exit 0", ms: 400 })), "13:42:05  mac  bash  brew list | head  ✓ exit 0 · 0.4s");
	assert.equal(formatEntry(E({ tool: "edit", decision: "asked→allowed", detail: "+3 −1" })), "13:42:05  mac  edit  ~/Desktop/a.png  ✓ +3 −1 спросил → разрешено");
	assert.equal(formatEntry(E({ device: "nl", tool: "sudo", summary: "systemctl restart nginx", ok: false, decision: "denied", ms: 0 })), "13:42:05  nl  sudo  systemctl restart nginx  ✗ отклонено");
	assert.equal(formatEntry(E({ decision: "classifier:allow", summary: "a\nb\tc" })), "13:42:05  mac  read  a b c  ✓ classifier:allow");
	assert.equal(formatEntry(E({ summary: "x".repeat(500) })).length, "13:42:05  mac  read  ".length + 200 + "  ✓".length);
});

test("journal: formatLog filters, limits and aligns", () => {
	const es = [E({ device: "mac" }), E({ device: "nl", tool: "sudo", summary: "ls" }), E({ device: "mac", tool: "edit", summary: "b" })];
	const all = formatLog(es, { n: 10 }).split("\n");
	assert.equal(all.length, 3);
	assert.ok(all[1].startsWith("13:42:05  nl   sudo  ls"));
	assert.ok(all[0].startsWith("13:42:05  mac  read  "));
	assert.equal(formatLog(es, { device: "MAC", n: 10 }).split("\n").length, 2);
	assert.equal(formatLog(es, { n: 1 }).split("\n").length, 1);
	assert.ok(formatLog(es, { n: 1 }).includes("edit"));
	assert.equal(formatLog([], { n: 5 }), "(no entries)");
	assert.equal(formatLog(es, { device: "zz", n: 5 }), "(no entries)");
});

test("journal: append, rotate, read", () => {
	const dir = tmp();
	try {
		const f = join(dir, "sub", "log.jsonl");
		assert.deepEqual(readJournal(f, 5), []);
		appendJournal(f, E({ summary: "a".repeat(300) }));
		appendJournal(f, E({ tool: "write", summary: "b" }));
		assert.equal(statSync(f).mode & 0o777, 0o600);
		writeFileSync(f, `${readFileSync(f, "utf8")}garbage\n{"ts":"x"}\n`);
		const r = readJournal(f, 10);
		assert.equal(r.length, 2);
		assert.equal(r[0].summary.length, 200);
		assert.equal(readJournal(f, 1)[0].tool, "write");
		assert.ok(!shouldRotate(2 * 1024 * 1024) && shouldRotate(2 * 1024 * 1024 + 1));
		assert.equal(rotatedName(f), join(dir, "sub", "log.1.jsonl"));
		writeFileSync(f, "x".repeat(2 * 1024 * 1024 + 10));
		appendJournal(f, E({ summary: "fresh" }));
		assert.ok(existsSync(rotatedName(f)));
		assert.equal(readJournal(f, 5).length, 1);
		assert.equal(readJournal(f, 5)[0].summary, "fresh");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- ui-text -----------------------------------------------------------------------------------

test("ui-text: footer, paths, sizes", () => {
	assert.equal(footerText({ kind: "local", name: "cloudcli" }), "⌂ cloudcli");
	assert.equal(footerText({ kind: "remote", device: "mac", mode: "auto" }), "→ mac · auto");
	assert.equal(footerText({ kind: "remote", device: "mac", mode: "ask", waiting: "confirm" }), "→ mac · ask · ⏸ ждёт тебя");
	assert.equal(footerText({ kind: "remote", device: "mac", mode: "auto", waiting: "root" }), "→ mac · auto · 🔑 пароль root");
	assert.equal(displayPath("mac", "/Users/s/x/y", "/Users/s"), "mac:~/x/y");
	assert.equal(displayPath("mac", "/Users/s", "/Users/s/"), "mac:~");
	assert.equal(displayPath("mac", "/Users/sergey/x", "/Users/s"), "mac:/Users/sergey/x");
	assert.equal(displayPath("mac", "/etc/hosts", "/Users/s"), "mac:/etc/hosts");
	assert.equal(formatBytes(500), "500 B");
	assert.equal(formatBytes(1234567), "1.2 MB");
	assert.equal(truncate("abcdef", 3), "abc\n… (3 more characters)");
	assert.equal(lineDiff("a\nb\n", "a\nc\n"), "  a\n- b\n+ c");
	assert.equal(lineDiff("a", "a"), "(no changes)");
});

test("ui-text: device table", () => {
	const t = formatDeviceTable(
		[
			{ name: "cloudcli", local: true },
			{ name: "mac", peer: "sergeys-macbook-pro", os: "macOS 27.0 arm64", user: "sergey", online: true, ssh: true, mode: "auto" },
			{ name: "nl", peer: "personal-project-nl", online: false },
			{ name: "x", peer: "xx", online: undefined, ssh: true },
		],
		{ device: "mac", why: "input 3s ago" },
	).split("\n");
	assert.equal(t[0], "here: mac (input 3s ago)");
	assert.equal(t[1], "cloudcli — this VM (local)");
	assert.equal(t[2], "mac  sergeys-macbook-pro  macOS 27.0 arm64  sergey  ● online   ssh  mode auto");
	assert.equal(t[3], "nl   personal-project-nl  ?                         ○ offline");
	assert.equal(t[4], "x    xx                   ?                         ? unknown  ssh");
	assert.equal(formatDeviceTable([{ name: "c", local: true }]).split("\n")[0], "here: unknown");
	assert.match(formatDeviceTable([{ name: "c", local: true }]), /no other NetBird devices/);
});

test("ui-text: confirm dialogs, dangerous commands get no 'always'/'full' (change 5)", () => {
	const bash: Action = { kind: "bash", command: "make install", root: false };
	const d = decide({ mode: "ask", action: bash });
	assert.equal(confirmTitle(bash, "mac", d), "Pi wants to run on mac");
	assert.match(confirmBody(bash, "mac", d), /^\$ \[mac\] make install\n\nWhy asked: mode ask$/);
	assert.deepEqual(confirmOptions(bash, "mac", d).map((o) => o.id), ["once", "always", "full", "deny"]);
	assert.match(confirmOptions(bash, "mac", d)[1].label, /команду/);
	assert.match(confirmOptions(bash, "mac", d)[2].label, /mac в full/);
	const bad: Action = { kind: "bash", command: "rm -rf ~/*", root: false };
	const dd = decide({ mode: "full", action: bad });
	assert.deepEqual(confirmOptions(bad, "mac", dd).map((o) => o.id), ["once", "deny"]);
	assert.ok(confirmTitle(bad, "mac", dd).startsWith("⚠ "));
	assert.match(confirmBody(bad, "mac", dd), /⚠ dangerous: recursive delete/);
	const w: Action = { kind: "write", path: "/Users/s/a.ts", diff: "- a\n+ b", isNew: false };
	assert.equal(confirmTitle(w, "mac", decide({ mode: "ask", action: w }), "/Users/s"), "Pi wants to edit mac:~/a.ts");
	assert.match(confirmOptions(w, "mac", decide({ mode: "ask", action: w }))[1].label, /путь/);
	assert.equal(actionSummary({ kind: "read", path: "/etc/hosts" }, "mac"), "read mac:/etc/hosts");
	assert.match(confirmBody(w, "mac", decide({ mode: "ask", action: w })), /^- a\n\+ b/);
});
