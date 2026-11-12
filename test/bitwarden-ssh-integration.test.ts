// Integration tests in temp dirs: config-store, state, the shared ssh-agent (skipped without OpenSSH),
// the askpass bridge and the bw wrapper against a fake `bw`. Never touches ~/.ssh or the real vault.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addKey, clearKeys, ensureAgent, listLoaded, removeKey } from "../extensions/bitwarden-ssh/agent.ts";
import { clientScript, setupAskpassEnv, startAskpassServer, writeClientScript } from "../extensions/bitwarden-ssh/askpass.ts";
import { Bitwarden, BwError, shared } from "../extensions/bitwarden-ssh/bw.ts";
import { ensureInclude, keyForPubPath, readSource, regenerate, writeSource } from "../extensions/bitwarden-ssh/config-store.ts";
import { fingerprintOf } from "../extensions/bitwarden-ssh/keyutil.ts";
import { ensureDir, resolvePaths } from "../extensions/bitwarden-ssh/paths.ts";
import { emptyState, loadState, saveState } from "../extensions/bitwarden-ssh/state.ts";

const root = mkdtempSync(join(tmpdir(), "pi-bw-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const mode = (p: string) => statSync(p).mode & 0o777;
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

function tempPaths(name: string) {
	const home = join(root, name, "home");
	mkdirSync(home, { recursive: true });
	return resolvePaths({ agentDir: join(home, ".pi", "agent"), home, uid: process.getuid!() });
}

test("state round trip, mode 600, bad JSON tolerated", () => {
	const p = tempPaths("state");
	ensureDir(p.dataDir);
	assert.equal(mode(p.dataDir), 0o700);
	const s = emptyState();
	s.identityMap["~/.ssh/a"] = { itemId: "i1", name: "a" };
	s.keys.push({ id: "i1", name: "a", fingerprint: "SHA256:x", publicKey: "ssh-ed25519 AAAA a" });
	s.syncedHash = "h";
	saveState(p.stateFile, s);
	assert.equal(mode(p.stateFile), 0o600);
	assert.deepEqual(loadState(p.stateFile).state, s);
	writeFileSync(p.stateFile, "{nope");
	const bad = loadState(p.stateFile);
	assert.deepEqual(bad.state, emptyState());
	assert.match(bad.warning!, /not valid JSON/);
	assert.deepEqual(loadState(join(p.dataDir, "missing.json")).state, emptyState());
});

test("ensureDir forces 0700", () => {
	const d = join(root, "loose");
	mkdirSync(d, { mode: 0o755 });
	chmodSync(d, 0o755);
	ensureDir(d);
	assert.equal(mode(d), 0o700);
});

test("regenerate writes pub files, generated config and dirs with safe modes", () => {
	const p = tempPaths("regen");
	writeSource(p, "Host web\n  IdentityFile ~/.ssh/web\n  IdentityFile ~/.ssh/other\n");
	assert.equal(mode(p.sourceFile), 0o600);
	const s = emptyState();
	s.keys = [
		{ id: "11111111-a", name: "web", fingerprint: "", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7L web" },
		{ id: "22222222-b", name: "stale", fingerprint: "", publicKey: "ssh-ed25519 AAAA stale" },
	];
	s.identityMap["~/.ssh/web"] = { itemId: "11111111-a", name: "web" };
	writeFileSync(join((ensureDir(p.sshDir), ensureDir(p.keysDir), p.keysDir), "old.pub"), "x");
	const r = regenerate(p, s, { controlPersist: "10m" })!;
	assert.deepEqual(r.mapped, ["~/.ssh/web"]);
	assert.deepEqual(r.unmatched, ["~/.ssh/other"]);
	const pub = join(p.keysDir, "web.pub");
	assert.equal(readFileSync(pub, "utf8"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7L web\n");
	assert.equal(existsSync(join(p.keysDir, "old.pub")), false);
	const gen = readFileSync(p.generatedFile, "utf8");
	assert.match(gen, new RegExp(`IdentityFile "${pub}"`));
	assert.match(gen, /ControlPath ".*\/cm\/%C"/);
	assert.equal(mode(p.generatedFile), 0o600);
	for (const d of [p.sshDir, p.keysDir, p.cmDir]) assert.equal(mode(d), 0o700);
	assert.equal(keyForPubPath(p, s, pub)?.id, "11111111-a");
	assert.equal(readSource(p), "Host web\n  IdentityFile ~/.ssh/web\n  IdentityFile ~/.ssh/other\n");
	if (has("ssh")) {
		const g = spawnSync("ssh", ["-G", "-F", p.generatedFile, "web"], { encoding: "utf8", input: "" });
		assert.equal(g.status, 0, g.stderr);
		assert.match(g.stdout, new RegExp(`identityfile ${pub}`));
		assert.match(g.stdout, /identitiesonly yes/);
		assert.match(g.stdout, /controlmaster auto/);
	}
});

test("ensureInclude: create, prepend once, keep mode, follow symlink", () => {
	const p = tempPaths("include");
	assert.equal(ensureInclude(p.userConfig, p.generatedFile), "created");
	assert.equal(readFileSync(p.userConfig, "utf8"), `# Added by pi bitwarden-ssh\nInclude ${p.generatedFile}\n`);
	assert.equal(mode(p.userConfig), 0o600);
	assert.equal(mode(join(p.home, ".ssh")), 0o700);
	assert.equal(ensureInclude(p.userConfig, p.generatedFile), "present");

	const q = tempPaths("include2");
	mkdirSync(join(q.home, ".ssh"), { recursive: true });
	const real = join(q.home, "dotfiles-ssh-config");
	writeFileSync(real, "Host mine\n  User me\n", { mode: 0o644 });
	chmodSync(real, 0o644);
	symlinkSync(real, q.userConfig);
	assert.equal(ensureInclude(q.userConfig, q.generatedFile), "added");
	assert.equal(readFileSync(real, "utf8"), `# Added by pi bitwarden-ssh\nInclude ${q.generatedFile}\n\nHost mine\n  User me\n`);
	assert.equal(mode(real), 0o644);
	assert.ok(statSync(q.userConfig, { throwIfNoEntry: true }) && existsSync(q.userConfig));
	assert.equal(ensureInclude(q.userConfig, q.generatedFile), "present");
	// A ~-form Include counts too.
	const t = tempPaths("include3");
	mkdirSync(join(t.home, ".ssh"), { recursive: true });
	writeFileSync(t.userConfig, "Include ~/.ssh/pi-bitwarden/config\n");
	assert.equal(ensureInclude(t.userConfig, t.generatedFile), "present");
});

test("shared ssh-agent: start, add, list, remove, clear", { skip: !has("ssh-agent") || !has("ssh-keygen") }, async () => {
	const dir = mkdtempSync("/tmp/pi-bw-agent-");
	const sock = join(dir, "agent.sock");
	let pid: number | undefined;
	try {
		const first = await ensureAgent(sock);
		assert.equal(first.started, true);
		pid = first.pid;
		const again = await ensureAgent(sock);
		assert.equal(again.started, false);
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", join(dir, "k")]);
		const priv = readFileSync(join(dir, "k"), "utf8");
		const pub = readFileSync(join(dir, "k.pub"), "utf8");
		const fp = fingerprintOf(pub)!;
		assert.equal(fp, execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", join(dir, "k.pub")], { encoding: "utf8" }).split(" ")[1]);
		assert.deepEqual(await listLoaded(sock), []);
		await addKey(sock, priv.trimEnd(), "1h");
		const loaded = await listLoaded(sock);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].fingerprint, fp);
		await removeKey(sock, pub);
		assert.deepEqual(await listLoaded(sock), []);
		await addKey(sock, priv, "");
		await clearKeys(sock);
		assert.deepEqual(await listLoaded(sock), []);
		// A stale socket file (dead agent) is replaced.
		if (pid) process.kill(pid);
		pid = undefined;
		await new Promise((r) => setTimeout(r, 200));
		const restarted = await ensureAgent(sock);
		assert.equal(restarted.started, true);
		pid = restarted.pid;
	} finally {
		if (pid) {
			try {
				process.kill(pid);
			} catch {}
		} else spawnSync("pkill", ["-f", sock]);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("askpass bridge: answer, cancel, confirm, missing socket", async () => {
	const dir = mkdtempSync("/tmp/pi-bw-ask-");
	const sockPath = join(dir, "askpass-1.sock");
	const script = join(dir, "askpass");
	writeClientScript(script);
	assert.equal(mode(script), 0o700);
	assert.ok(readFileSync(script, "utf8").startsWith(`#!${process.execPath}\n`));
	let seen: any;
	let answer: string | boolean | undefined = "s3cret value";
	const server = await startAskpassServer(sockPath, () => async (req) => {
		seen = req;
		return answer;
	});
	try {
		assert.equal(mode(sockPath), 0o600);
		// Async spawn: the server runs in this process, spawnSync would block it.
		const runClient = (prompt: string, env: Record<string, string> = {}) =>
			new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
				const c = spawn(script, [prompt], { env: { ...process.env, PI_BW_ASKPASS_SOCK: sockPath, ...env }, stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				c.stdout.on("data", (d) => (stdout += d));
				c.stderr.on("data", (d) => (stderr += d));
				c.on("close", (status) => resolve({ status, stdout, stderr }));
			});
		let r = await runClient("Enter passphrase for key '(stdin)': ");
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "s3cret value\n");
		assert.equal(seen.kind, "secret");
		assert.equal(seen.requester.known, false); // spawned by node, not by ssh
		answer = undefined;
		r = await runClient("Password: ");
		assert.equal(r.status, 1);
		assert.equal(r.stdout, "");
		answer = true;
		r = await runClient("Allow?", { SSH_ASKPASS_PROMPT: "confirm" });
		assert.equal(r.status, 0);
		assert.equal(seen.kind, "confirm");
		answer = false;
		r = await runClient("Allow?", { SSH_ASKPASS_PROMPT: "confirm" });
		assert.equal(r.status, 1);
		r = await runClient("x", { PI_BW_ASKPASS_SOCK: join(dir, "missing.sock") });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /cannot reach pi/);
	} finally {
		server.close();
	}
	assert.equal(existsSync(sockPath), false);
	assert.match(clientScript("/x/node"), /^#!\/x\/node\n/);
	rmSync(dir, { recursive: true, force: true });
});

test("askpass: dialog is cancelled when the client goes away", async () => {
	const dir = mkdtempSync("/tmp/pi-bw-ask-");
	const sockPath = join(dir, "a.sock");
	let aborted: Promise<void> | undefined;
	const server = await startAskpassServer(sockPath, () => (_req, signal) => {
		aborted = new Promise((res) => signal.addEventListener("abort", () => res()));
		return new Promise(() => {});
	});
	try {
		const net = await import("node:net");
		const c = net.createConnection(sockPath);
		await new Promise((r) => c.on("connect", r));
		c.write('{"prompt":"p","ppid":1}\n');
		await new Promise((r) => setTimeout(r, 100));
		c.destroy();
		await Promise.race([aborted, new Promise((_, rej) => setTimeout(() => rej(new Error("not aborted")), 2000))]);
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("setupAskpassEnv sets variables and a sudo shim", () => {
	const dir = mkdtempSync(join(root, "env-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const fakeSudoDir = join(dir, "sys");
	mkdirSync(fakeSudoDir);
	writeFileSync(join(fakeSudoDir, "sudo"), "#!/bin/sh\necho real-sudo \"$@\"\n", { mode: 0o755 });
	const env: NodeJS.ProcessEnv = { PATH: `${fakeSudoDir}:/usr/bin:/bin` };
	const r = setupAskpassEnv(env, { scriptPath: "/s/askpass", sockPath: "/s/a.sock", binDir: bin });
	assert.equal(env.SSH_ASKPASS, "/s/askpass");
	assert.equal(env.SUDO_ASKPASS, "/s/askpass");
	assert.equal(env.GIT_ASKPASS, "/s/askpass");
	assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
	assert.equal(env.PI_BW_ASKPASS_SOCK, "/s/a.sock");
	assert.equal(r.sudoShim, join(bin, "sudo"));
	assert.equal(env.PATH, `${bin}:${fakeSudoDir}:/usr/bin:/bin`);
	const out = spawnSync("sudo", ["whoami"], { encoding: "utf8", env: env as any });
	assert.equal(out.stdout, "real-sudo -A whoami\n");
	// Idempotent: a second call does not stack binDir.
	setupAskpassEnv(env, { scriptPath: "/s/askpass", sockPath: "/s/a.sock", binDir: bin });
	assert.equal(env.PATH, `${bin}:${fakeSudoDir}:/usr/bin:/bin`);
});

test("bw wrapper against a fake bw: env scrubbing, session, errors", async () => {
	const dir = mkdtempSync(join(root, "fakebw-"));
	const log = join(dir, "log");
	const fake = join(dir, "bw");
	// The fake records which variables it got (names and whether the session matches), never values.
	writeFileSync(
		fake,
		`#!/bin/sh
echo "$1 nonint=$BW_NOINTERACTION session=\${BW_SESSION:+set} pw=\${BW_PASSWORD:+set} cs=\${BW_CLIENTSECRET:+set}" >> "${log}"
case "$1" in
  unlock) if [ "$BW_PASSWORD" = "right" ]; then printf 'SESSIONKEY'; else echo "Invalid master password." >&2; exit 1; fi ;;
  status) if [ "$BW_SESSION" = "SESSIONKEY" ]; then echo '{"status":"unlocked","userEmail":"a@b"}'; else echo '{"status":"locked","userEmail":"a@b"}'; fi ;;
  list) if [ "$BW_SESSION" = "SESSIONKEY" ]; then cat "${dir}/items.json"; else echo "Vault is locked." >&2; exit 1; fi ;;
  login) echo "Two-step login code is required." >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(dir, "items.json"),
		JSON.stringify([
			{ id: "k1", type: 5, name: "web", sshKey: { privateKey: "PRIV", publicKey: "ssh-ed25519 AAAA web", keyFingerprint: "SHA256:x" } },
			{ id: "n1", type: 2, name: "ssh-config", notes: "Host a\n" },
			{ id: "l1", type: 1, name: "login" },
		]),
	);
	const saved = { pw: process.env.BW_PASSWORD, sess: process.env.BW_SESSION };
	process.env.BW_PASSWORD = "inherited";
	delete process.env.BW_SESSION;
	const bw = new Bitwarden({ bin: fake, autoLockMinutes: () => 0 });
	bw.forget();
	try {
		assert.equal((await bw.status()).status, "locked");
		await assert.rejects(bw.unlock("wrong"), (e: any) => e instanceof BwError && e.message === "Invalid master password");
		await bw.unlock("right");
		assert.equal(bw.unlocked, true);
		assert.equal(process.env.BW_SESSION, undefined, "session must not leak into process.env");
		assert.equal((await bw.status()).status, "unlocked");
		const keys = await bw.listSshKeys();
		assert.deepEqual(
			keys.map((k) => k.name),
			["web"],
		);
		assert.equal((await bw.findNote("ssh-config"))?.notes, "Host a\n");
		await assert.rejects(bw.loginPassword("a@b", "pw"), (e: any) => e.kind === "needs2fa");
		// Session invalidated elsewhere: "Vault is locked." -> forgotten.
		shared().session = "OTHER";
		await assert.rejects(bw.listSshKeys(), (e: any) => e.kind === "locked");
		assert.equal(bw.unlocked, false);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		for (const l of lines) {
			assert.match(l, /nonint=true/);
			assert.doesNotMatch(l, /cs=set/);
		}
		assert.ok(lines.some((l) => l.startsWith("status") && /pw= /.test(l)), "inherited BW_PASSWORD is scrubbed");
		assert.ok(lines.some((l) => l.startsWith("unlock") && /pw=set/.test(l)));
		assert.ok(!readFileSync(log, "utf8").includes("SESSIONKEY"));
	} finally {
		bw.forget();
		if (saved.pw === undefined) delete process.env.BW_PASSWORD;
		else process.env.BW_PASSWORD = saved.pw;
		if (saved.sess !== undefined) process.env.BW_SESSION = saved.sess;
	}
	const missing = new Bitwarden({ bin: join(dir, "nope") });
	await assert.rejects(missing.status(), (e: any) => e.kind === "missing");
});
