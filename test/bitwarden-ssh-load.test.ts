// Load the extension entry and drive it end to end with a fake pi, a fake `bw` and a temp HOME.
// Needs pi's packages to resolve (the entry imports pi-coding-agent and pi-tui at runtime), otherwise
// skipped. Never touches the real ~/.ssh, ~/.pi or the real vault.

import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "bitwarden-ssh.ts");

function resolves(spec: string): boolean {
	try {
		import.meta.resolve(spec);
		return true;
	} catch {
		return false;
	}
}

const available = resolves("@earendil-works/pi-coding-agent") && resolves("@earendil-works/pi-tui") && resolves("typebox");
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

// A fake bw CLI backed by a JSON file. Session "SESS" after unlock with password "pw".
const FAKE_BW = (db: string) => `#!${process.execPath}
const fs = require("node:fs");
const db = ${JSON.stringify(db)};
const data = JSON.parse(fs.readFileSync(db, "utf8"));
const a = process.argv.slice(2);
const ok = process.env.BW_SESSION === "SESS";
const out = (s) => process.stdout.write(typeof s === "string" ? s : JSON.stringify(s));
const die = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
const save = () => fs.writeFileSync(db, JSON.stringify(data));
const stdin = () => Buffer.from(fs.readFileSync(0, "utf8"), "base64").toString("utf8");
switch (a[0]) {
	case "status": out({ status: ok ? "unlocked" : "locked", userEmail: "t@example.com", serverUrl: null, lastSync: "2026-01-01T00:00:00Z" }); break;
	case "unlock": if (process.env.BW_PASSWORD === "pw") out("SESS"); else die("Invalid master password."); break;
	case "sync": if (!ok) die("Vault is locked."); out("Syncing complete."); break;
	case "lock": out("Your vault is locked."); break;
	case "list": {
		if (!ok) die("Vault is locked.");
		const i = a.indexOf("--search");
		out(data.items.filter((x) => i < 0 || x.name.includes(a[i + 1])));
		break;
	}
	case "get":
		if (a[1] === "template") out({ type: 1, name: "", notes: null, login: {}, favorite: false });
		else { if (!ok) die("Vault is locked."); out(data.items.find((x) => x.id === a[2]) ?? die("Not found.")); }
		break;
	case "edit": {
		if (!ok) die("Vault is locked.");
		const item = JSON.parse(stdin());
		data.items = data.items.map((x) => (x.id === a[2] ? item : x));
		save(); out(item); break;
	}
	case "create": {
		if (!ok) die("Vault is locked.");
		const item = { ...JSON.parse(stdin()), id: "new-" + data.items.length };
		data.items.push(item); save(); out(item); break;
	}
	default: die("unknown " + a.join(" "));
}
`;

test("extension end to end with a fake pi and a fake bw", { skip: (!available && "pi packages not installed") || (!has("ssh-agent") && "no OpenSSH") }, async () => {
	const dir = mkdtempSync("/tmp/pi-bw-e2e-");
	const home = join(dir, "home");
	const binDir = join(dir, "fakebin");
	mkdirSync(home, { recursive: true });
	mkdirSync(binDir);
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "testkey", "-f", join(dir, "k")]);
	const priv = readFileSync(join(dir, "k"), "utf8");
	const pub = readFileSync(join(dir, "k.pub"), "utf8").trim();
	const db = join(dir, "db.json");
	const note = "Host web\n    HostName 127.0.0.1\n    IdentityFile ~/.ssh/testkey\n    UseKeychain yes\n";
	writeFileSync(
		db,
		JSON.stringify({
			items: [
				{ id: "key-1", type: 5, name: "testkey", sshKey: { privateKey: priv, publicKey: pub, keyFingerprint: "SHA256:ignored" } },
				{ id: "note-1", type: 2, name: "ssh-config", notes: note, secureNote: { type: 0 } },
			],
		}),
	);
	writeFileSync(join(binDir, "bw"), FAKE_BW(db), { mode: 0o755 });

	const saved = { ...process.env };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	process.env.PATH = `${binDir}:${process.env.PATH}`;
	delete process.env.BW_SESSION;

	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const pi: any = {
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerTool: (t: any) => tools.set(t.name, t),
		on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
		getSettings: () => ({ bitwardenSsh: { keyTtl: "1h" } }),
	};
	const notes: string[] = [];
	const confirms: string[] = [];
	const status: string[] = [];
	let secretsAsked = 0;
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		cwd: dir,
		ui: {
			notify: (m: string) => notes.push(m),
			setStatus: (_k: string, t: string) => status.push(t),
			confirm: async (title: string, body: string) => {
				confirms.push(`${title}\n${body}`);
				return true;
			},
			select: async (_t: string, opts: string[]) => opts[0],
			input: async () => "",
			editor: async (_t: string, text: string) => text.replace("HostName 127.0.0.1", "HostName 127.0.0.2"),
			custom: async () => {
				secretsAsked++;
				return "pw"; // the masked master password dialog
			},
		},
	};
	const fire = async (e: string, ev: any) => {
		let last: any;
		for (const h of handlers.get(e) ?? []) last = await h(ev, ctx);
		return last;
	};
	const tool = async (name: string, params: any) => {
		const r = await tools.get(name).execute("id", params, undefined, undefined, ctx);
		return { text: r.content[0].text as string, isError: !!r.isError };
	};
	const cmd = async (name: string, args: string) => {
		notes.length = 0;
		await commands.get(name).handler(args, ctx);
		return notes.join("\n");
	};
	const agentDir = join(home, ".pi", "agent", "bitwarden-ssh");
	const sock = join(agentDir, "run", "ssh-agent.sock");
	try {
		const mod: any = await import("../extensions/bitwarden-ssh.ts");
		mod.default(pi);
		await fire("session_start", { reason: "startup" });
		assert.equal(process.env.SSH_AUTH_SOCK, sock);
		assert.ok(process.env.SSH_ASKPASS?.endsWith("/run/askpass"));
		assert.ok(process.env.PI_BW_ASKPASS_SOCK?.includes(`askpass-${process.pid}.sock`));
		assert.equal(process.env.BW_SESSION, undefined);

		assert.match(await cmd("bw", "status"), /vault: locked \(t@example.com\)/);
		// Agent asks to load a key: confirm, unlock dialog, ssh-add.
		let r = await tool("ssh_keys", { action: "load", name: "testkey" });
		assert.equal(r.isError, false, r.text);
		assert.match(r.text, /Loaded into ssh-agent \(TTL 1h\): testkey/);
		assert.equal(secretsAsked, 1);
		assert.match(confirms.pop()!, /The agent asks to load SSH key\(s\) testkey/);
		r = await tool("ssh_keys", { action: "status" });
		assert.match(r.text, /vault: unlocked/);
		assert.match(r.text, /● testkey SHA256:/);
		r = await tool("ssh_keys", { action: "list" });
		assert.match(r.text, /● testkey/);
		assert.doesNotMatch(JSON.stringify(r), /PRIVATE KEY|SESS/);

		// Pull the config from the note: auto-maps the key, writes generated config and Include.
		const pulled = await cmd("ssh", "config pull");
		assert.match(pulled, /Pulled "ssh-config"/);
		assert.match(pulled, /1 IdentityFile\(s\) mapped/);
		assert.match(pulled, /Disabled \(unusable here\): UseKeychain yes/);
		const gen = readFileSync(join(home, ".ssh", "pi-bitwarden", "config"), "utf8");
		assert.match(gen, /IdentityFile ".*\/keys\/testkey-key-1\.pub"\n {4}IdentitiesOnly yes/);
		assert.equal(readFileSync(join(home, ".ssh", "pi-bitwarden", "keys", "testkey-key-1.pub"), "utf8"), `${pub}\n`);
		assert.match(readFileSync(join(home, ".ssh", "config"), "utf8"), /^# Added by pi bitwarden-ssh\nInclude .*pi-bitwarden\/config\n/);

		// Agent edits hosts.
		r = await tool("ssh_config", { action: "list" });
		assert.match(r.text, /web {2}— HostName 127\.0\.0\.1 · key testkey ●/);
		r = await tool("ssh_config", { action: "add", host: "db", options: { HostName: "10.0.0.9", User: "admin" } });
		assert.equal(r.isError, false, r.text);
		r = await tool("ssh_config", { action: "add", host: "db", options: {} });
		assert.equal(r.isError, true);
		r = await tool("ssh_config", { action: "update", host: "web", options: { User: "root", UseKeychain: null } });
		assert.equal(r.isError, false, r.text);
		assert.match(confirms.pop()!, /\+ {5}User root/);
		r = await tool("ssh_config", { action: "update", host: "web", options: { Bogus: "x" } });
		assert.equal(r.isError, true);
		assert.match(r.text, /Invalid SSH config/);
		r = await tool("ssh_config", { action: "get", host: "web" });
		assert.match(r.text, /IdentityFile ~\/\.ssh\/testkey/);
		assert.match(r.text, /User root/);
		r = await tool("ssh_config", { action: "remove", host: "db" });
		assert.equal(r.isError, false, r.text);
		assert.doesNotMatch(readFileSync(join(agentDir, "config"), "utf8"), /Host db/);

		// Push back to the note.
		r = await tool("ssh_config", { action: "push" });
		assert.match(r.text, /Updated Bitwarden note "ssh-config"/);
		const stored = JSON.parse(readFileSync(db, "utf8")).items.find((i: any) => i.id === "note-1").notes;
		assert.equal(stored, readFileSync(join(agentDir, "config"), "utf8"));
		assert.match(await cmd("ssh", "config edit"), /Generated/);
		assert.match(readFileSync(join(agentDir, "config"), "utf8"), /127\.0\.0\.2/);
		assert.match(await cmd("ssh", "config show"), /local changes since last pull\/push: yes/);
		assert.match(await cmd("ssh", "hosts"), /web/);

		// user_bash interception of interactive bw commands.
		const ub = await fire("user_bash", { command: "bw status", excludeFromContext: false, cwd: dir });
		assert.match(ub.result.output, /vault: unlocked/);

		// Completions.
		assert.ok(commands.get("ssh").getArgumentCompletions("config p").some((i: any) => i.value === "config pull"));
		assert.ok(commands.get("ssh").getArgumentCompletions("test ").some((i: any) => i.value === "test web"));

		// Lock: forgets the session and empties the agent.
		assert.match(await cmd("bw", "lock"), /locked; ssh-agent keys removed/);
		r = await tool("ssh_keys", { action: "list" });
		assert.match(r.text, /cached; vault locked/);
		assert.match(r.text, /○ testkey/);
		assert.ok(status.some((s) => s.startsWith("🔐 unlocked · 1 key")));
		assert.ok(status.some((s) => s.startsWith("🔒 locked")));

		// Nothing secret was written to disk or shown.
		for (const f of [join(agentDir, "state.json"), join(home, ".ssh", "pi-bitwarden", "config")]) {
			const t = readFileSync(f, "utf8");
			assert.doesNotMatch(t, /PRIVATE KEY|SESS/);
		}
		assert.doesNotMatch([...notes, ...confirms].join("\n"), /PRIVATE KEY|SESS\b/);

		await fire("session_shutdown", { reason: "quit" });
		assert.equal(existsSync(process.env.PI_BW_ASKPASS_SOCK!), false);
	} finally {
		spawnSync("pkill", ["-f", sock]);
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A fresh extension instance with a fake pi in a temp HOME (fake bw with an empty, locked vault). */
async function setup(dir: string, mode: "tui" | "rpc") {
	const home = join(dir, "home");
	const binDir = join(dir, "fakebin");
	mkdirSync(home, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	const db = join(dir, "db.json");
	writeFileSync(db, JSON.stringify({ items: [] }));
	writeFileSync(join(binDir, "bw"), FAKE_BW(db), { mode: 0o755 });
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	process.env.PATH = `${binDir}:${process.env.PATH}`;
	delete process.env.BW_SESSION;
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const pi: any = {
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerTool: (t: any) => tools.set(t.name, t),
		on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
		getSettings: () => ({}),
	};
	const log = { notes: [] as string[], confirms: [] as string[], inputs: [] as string[], customs: [] as any[] };
	const ctx: any = {
		hasUI: true,
		mode,
		cwd: dir,
		ui: {
			notify: (m: string) => log.notes.push(m),
			setStatus: () => {},
			confirm: async (title: string, body: string) => {
				log.confirms.push(`${title}\n${body}`);
				return false;
			},
			select: async () => undefined,
			input: async (title: string) => {
				log.inputs.push(title);
				return "typed-in-plain-input";
			},
			editor: async () => undefined,
			// Like pi: the factory gets done(); the promise only resolves through done().
			custom: (factory: any) =>
				new Promise((resolve) => {
					const component = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t }, { matches: () => false }, resolve);
					log.customs.push(component);
				}),
		},
	};
	const mod: any = await import(EXTENSION);
	mod.default(pi);
	const fire = async (e: string, ev: any) => {
		for (const h of handlers.get(e) ?? []) await h(ev, ctx);
	};
	return { commands, tools, fire, ctx, log, sock: join(home, ".pi", "agent", "bitwarden-ssh", "run", "ssh-agent.sock") };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const G = () => (globalThis as any)[Symbol.for("pi.bitwarden-ssh")];

test("dialogs: dispose settles a secret dialog, the queued one runs; session end cancels and clears askpass", { skip: (!available && "pi packages not installed") || (!has("ssh-agent") && "no OpenSSH") }, async () => {
	const dir = mkdtempSync("/tmp/pi-bw-dlg-");
	const saved = { ...process.env };
	let sock = "";
	try {
		const x = await setup(dir, "tui");
		sock = x.sock;
		await x.fire("session_start", { reason: "startup" });
		const notified = (n: number) => x.log.notes.length >= n;
		const unlock = () => x.commands.get("bw").handler("unlock", x.ctx);
		const first = unlock();
		for (let i = 0; i < 100 && x.log.customs.length < 1; i++) await tick();
		assert.equal(x.log.customs.length, 1, "first master password dialog open");
		const second = unlock();
		await tick(100);
		assert.equal(x.log.customs.length, 1, "second dialog waits for the UI lock");
		// pi disposes dialogs on /reload without calling done(): the promise must still settle.
		x.log.customs[0].dispose();
		await first;
		assert.ok(x.log.notes.some((n) => /still locked/.test(n)));
		for (let i = 0; i < 100 && x.log.customs.length < 2; i++) await tick();
		assert.equal(x.log.customs.length, 2, "queued dialog runs after the disposed one");

		// Askpass dialogs say the requester is unverified and always warn.
		const handler = G().handler;
		assert.ok(handler);
		const ac = new AbortController();
		const confirmed = handler({ prompt: "Allow use of key?", kind: "confirm", requester: { cmdline: "/usr/bin/ssh host", program: "ssh", fromThisPi: false } }, ac.signal);
		// Session shutdown (reload) cancels the open secret dialog and the queued askpass dialog.
		await x.fire("session_shutdown", { reason: "reload" });
		await Promise.race([Promise.all([second, confirmed]), tick(2000).then(() => assert.fail("dialogs not cancelled by session_shutdown"))]);
		assert.equal(await confirmed, undefined);
		assert.equal(G().handler, undefined, "askpass handler cleared on every shutdown");
		// The askpass server stays (process-wide) but answers "not ok" right away without a session.
		const net = await import("node:net");
		const c = net.createConnection(process.env.PI_BW_ASKPASS_SOCK!);
		let reply = "";
		c.on("data", (d) => (reply += d));
		await new Promise((r) => c.on("connect", r));
		c.write('{"prompt":"Password:","ppid":1}\n');
		await Promise.race([new Promise((r) => c.on("close", r)), tick(2000)]);
		assert.equal(reply.trim(), '{"ok":false}');

		// A new session installs a fresh handler; its confirm text marks the requester unverified.
		await x.fire("session_start", { reason: "reload" });
		const h2 = G().handler;
		assert.ok(h2 && h2 !== handler);
		await h2({ prompt: "Allow use of key?", kind: "confirm", requester: { cmdline: "/usr/bin/ssh host", program: "ssh", fromThisPi: false } }, new AbortController().signal);
		const body = x.log.confirms.pop()!;
		assert.match(body, /Requested by \(unverified\): \/usr\/bin\/ssh host/);
		assert.match(body, /not started from this pi session/);
		assert.match(body, /the program that asked will receive what you type/);
		await h2({ prompt: "Allow?", kind: "confirm", requester: { cmdline: "/usr/bin/ssh host", program: "ssh", fromThisPi: true } }, new AbortController().signal);
		const body2 = x.log.confirms.pop()!;
		assert.match(body2, /the program that asked will receive what you type/, "warning even for a plausible ssh");
		assert.doesNotMatch(body2, /not started from this pi session/);
		await x.fire("session_shutdown", { reason: "quit" });
		void notified;
	} finally {
		if (sock) spawnSync("pkill", ["-f", sock]);
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("RPC mode: secret input fails closed (no unmasked input)", { skip: (!available && "pi packages not installed") || (!has("ssh-agent") && "no OpenSSH") }, async () => {
	const dir = mkdtempSync("/tmp/pi-bw-rpc-");
	const saved = { ...process.env };
	let sock = "";
	try {
		const x = await setup(dir, "rpc");
		sock = x.sock;
		await x.fire("session_start", { reason: "startup" });
		await x.commands.get("bw").handler("unlock", x.ctx);
		assert.match(x.log.notes.join("\n"), /secret input needs the interactive TUI/);
		await x.commands.get("bw").handler("login", x.ctx);
		assert.match(x.log.notes.join("\n"), /secret input needs the interactive TUI/);
		x.ctx.ui.confirm = async () => true;
		const r = await x.tools.get("ssh_keys").execute("id", { action: "load", name: "k" }, undefined, undefined, x.ctx);
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /secret input needs the interactive TUI/);
		const ans = await G().handler({ prompt: "Password:", kind: "secret", requester: { cmdline: "sudo -A ls", program: "sudo" } }, new AbortController().signal);
		assert.equal(ans, undefined);
		assert.match(x.log.notes.join("\n"), /askpass prompt "Password:" cancelled: secret input needs the interactive TUI/);
		// Visible prompts still use the normal input.
		const user = await G().handler({ prompt: "Username for 'https://x': ", kind: "visible", requester: { cmdline: "git", program: "git" } }, new AbortController().signal);
		assert.equal(user, "typed-in-plain-input");
		assert.equal(x.log.inputs.length, 1, "no secret went through ctx.ui.input");
		assert.equal(x.log.customs.length, 0);
		await x.fire("session_shutdown", { reason: "quit" });
	} finally {
		if (sock) spawnSync("pkill", ["-f", sock]);
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two pi processes editing the source config: no lost update", { skip: !available && "pi packages not installed" }, async () => {
	// Replays the review race: A waits at its confirmation, B confirms and writes, then A confirms.
	const dir = mkdtempSync("/tmp/pi-bw-writers-");
	mkdirSync(join(dir, "home"), { recursive: true });
	mkdirSync(join(dir, "agent", "bitwarden-ssh"), { recursive: true });
	const source = join(dir, "agent", "bitwarden-ssh", "config");
	writeFileSync(source, "Host a\n HostName a.invalid\nHost b\n HostName b.invalid\n");
	const child = join(dir, "writer.mjs");
	writeFileSync(
		child,
		`import { existsSync, writeFileSync } from "node:fs";
const d = process.env.WRITER_DIR;
process.env.HOME = d + "/home";
process.env.PI_CODING_AGENT_DIR = d + "/agent";
const extension = (await import(${JSON.stringify(EXTENSION)})).default;
const tools = {};
extension({ registerTool: (t) => (tools[t.name] = t), registerCommand() {}, on() {} });
const role = process.env.WRITER_ROLE;
const ctx = { hasUI: true, mode: "tui", ui: { notify() {}, setStatus() {}, select: async () => undefined, confirm: async () => {
	if (role === "A") { writeFileSync(d + "/A-confirm", ""); while (!existsSync(d + "/A-release")) await new Promise((r) => setTimeout(r, 10)); }
	return true;
} } };
const params = role === "A" ? { action: "update", host: "a", options: { User: "alice" } } : { action: "update", host: "b", options: { Port: "2222" } };
const r = await tools.ssh_config.execute("id", params, undefined, undefined, ctx);
writeFileSync(d + "/" + role + ".json", JSON.stringify({ isError: !!r.isError, text: r.content[0].text }));
`,
	);
	const launch = (role: string) => {
		const c = fork(child, [], { env: { ...process.env, WRITER_DIR: dir, WRITER_ROLE: role }, execArgv: ["--no-warnings"], stdio: "inherit" });
		return new Promise<number | null>((r) => c.on("exit", r));
	};
	try {
		const a = launch("A");
		for (let i = 0; i < 500 && !existsSync(join(dir, "A-confirm")); i++) await tick();
		assert.equal(await launch("B"), 0);
		writeFileSync(join(dir, "A-release"), "");
		assert.equal(await a, 0);
		const ra = JSON.parse(readFileSync(join(dir, "A.json"), "utf8"));
		const rb = JSON.parse(readFileSync(join(dir, "B.json"), "utf8"));
		assert.equal(rb.isError, false, rb.text);
		assert.equal(ra.isError, true, "A's stale edit is rejected");
		assert.match(ra.text, /changed in another pi session; retry/);
		const final = readFileSync(source, "utf8");
		assert.match(final, /Port 2222/, "B's confirmed edit survives");
		assert.doesNotMatch(final, /User alice/);
		// The advisory lock file stays (deleting it would break mutual exclusion).
		assert.equal(existsSync(join(dir, "agent", "bitwarden-ssh", "config.lock")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("N3: pull and edit validate the exact final config; a cached mapping of a deleted key cannot hide errors", { skip: (!available && "pi packages not installed") || (!has("ssh") && "no OpenSSH") }, async () => {
	// Review N3: the preview substituted any cached mapping, so `IdentityFile ~/.ssh/known extra` and an
	// unterminated quote passed the check; after the key cache refresh (key deleted) the malformed line
	// itself was installed into the globally included config.
	const dir = mkdtempSync("/tmp/pi-bw-n3-");
	const saved = { ...process.env };
	const bwShared = () => ((globalThis as any)[Symbol.for("pi.bitwarden-ssh.bw")] ??= {});
	try {
		const { commands, ctx, log } = await setup(dir, "tui");
		const home = join(dir, "home");
		const db = join(dir, "db.json");
		const dataDir = join(home, ".pi", "agent", "bitwarden-ssh");
		const source = join(dataDir, "config");
		const state = join(dataDir, "state.json");
		const generated = join(home, ".ssh", "pi-bitwarden", "config");
		const userConfig = join(home, ".ssh", "config");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(dirname(generated), { recursive: true });
		const OLD = "Host original\n User original\n";
		const { createHash } = await import("node:crypto");
		const reset = (note: string) => {
			// The vault has only the note now: the key "known" was deleted, but state.json still maps it.
			writeFileSync(db, JSON.stringify({ items: [{ id: "note-1", type: 2, name: "ssh-config", notes: note, secureNote: { type: 0 } }] }));
			writeFileSync(source, OLD);
			writeFileSync(generated, OLD);
			writeFileSync(userConfig, `Include ${generated}\n`);
			writeFileSync(
				state,
				JSON.stringify({
					version: 1,
					identityMap: { "~/.ssh/known": { itemId: "old-key", name: "known" } },
					keys: [{ id: "old-key", name: "known", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOld", fingerprint: "" }],
					syncedHash: createHash("sha256").update(OLD).digest("hex"),
				}),
			);
			log.notes.length = 0;
		};
		bwShared().session = "SESS";
		const sshG = () => spawnSync("ssh", ["-G", "-F", generated, "target"], { encoding: "utf8", input: "" });
		for (const [name, note, why] of [
			["extra argument", "Host target\n IdentityFile ~/.ssh/known unexpected-extra\n", /line 2: IdentityFile takes exactly 1 argument \(got 2\)/],
			["unterminated quote", 'Host target\n IdentityFile "~/.ssh/known\n', /line 2: unterminated quote/],
			["unknown directive", "Host target\n BogusOption yes\n", /ssh: line 2: Bad configuration option: bogusoption/],
		] as const) {
			reset(note);
			await commands.get("ssh").handler("config pull", ctx);
			const out = log.notes.join("\n");
			assert.match(out, /is not a valid SSH config; kept the local config/, `${name}: ${out}`);
			assert.match(out, why, name);
			assert.doesNotMatch(out, /Pulled/);
			assert.equal(readFileSync(source, "utf8"), OLD, `${name}: source kept`);
			assert.equal(readFileSync(generated, "utf8"), OLD, `${name}: generated kept`);
			assert.equal(JSON.parse(readFileSync(state, "utf8")).note, undefined, `${name}: state not marked as pulled`);
			assert.equal(sshG().status, 0);
		}
		// /ssh config edit with the same malformed line: refused, nothing written.
		reset("Host target\n HostName t.invalid\n");
		ctx.ui.editor = async () => "Host original\n IdentityFile ~/.ssh/known unexpected-extra\n";
		await commands.get("ssh").handler("config edit", ctx);
		assert.match(log.notes.join("\n"), /Invalid SSH config: line 2: IdentityFile takes exactly 1 argument/);
		assert.equal(readFileSync(source, "utf8"), OLD);
		assert.equal(readFileSync(generated, "utf8"), OLD);
		// A valid pull still succeeds; the unmapped identity stays as written.
		reset("Host target\n HostName t.invalid\n IdentityFile ~/.ssh/known\n");
		await commands.get("ssh").handler("config pull", ctx);
		assert.match(log.notes.join("\n"), /Pulled "ssh-config"/);
		assert.equal(readFileSync(source, "utf8"), "Host target\n HostName t.invalid\n IdentityFile ~/.ssh/known\n");
		const r = sshG();
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^hostname t\.invalid$/m);
		assert.match(readFileSync(generated, "utf8"), /IdentityFile ~\/\.ssh\/known\n/);
		assert.equal(JSON.parse(readFileSync(state, "utf8")).note.id, "note-1");
	} finally {
		const sh = bwShared();
		sh.session = undefined;
		if (sh.lockTimer) clearTimeout(sh.lockTimer);
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R1/R2: pull is refused when ssh -G cannot validate (timeout, ssh missing) or a path cannot be prepared; nothing changes", { skip: (!available && "pi packages not installed") || (!has("ssh") && "no OpenSSH"), timeout: 90_000 }, async () => {
	// Review R1: a validator timeout or spawn failure counted as "valid" and the unchecked config was installed.
	// Review R2: with ~/.ssh/pi-bitwarden/keys a regular file, source and state (note id, syncedHash) were
	// replaced before the generated output failed.
	const dir = mkdtempSync("/tmp/pi-bw-r1r2-");
	const saved = { ...process.env };
	const bwShared = () => ((globalThis as any)[Symbol.for("pi.bitwarden-ssh.bw")] ??= {});
	try {
		const { commands, ctx, log } = await setup(dir, "tui");
		ctx.ui.confirm = async () => true;
		const home = join(dir, "home");
		const db = join(dir, "db.json");
		const dataDir = join(home, ".pi", "agent", "bitwarden-ssh");
		const source = join(dataDir, "config");
		const state = join(dataDir, "state.json");
		const sshDir = join(home, ".ssh", "pi-bitwarden");
		const generated = join(sshDir, "config");
		const keysDir = join(sshDir, "keys");
		const userConfig = join(home, ".ssh", "config");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(keysDir, { recursive: true });
		const OLD = "Host original\n User original\n";
		const STATE = JSON.stringify({ version: 1, identityMap: {}, keys: [], syncedHash: "old-hash" });
		const reset = (note: string) => {
			writeFileSync(db, JSON.stringify({ items: [{ id: "note-1", type: 2, name: "ssh-config", notes: note, secureNote: { type: 0 } }] }));
			writeFileSync(source, OLD);
			writeFileSync(generated, OLD);
			writeFileSync(join(keysDir, "old-0ld00000.pub"), "ssh-ed25519 AAAA old\n");
			writeFileSync(userConfig, `Include ${generated}\n`);
			writeFileSync(state, STATE);
			log.notes.length = 0;
		};
		const unchanged = (what: string) => {
			assert.equal(readFileSync(source, "utf8"), OLD, `${what}: source kept`);
			assert.equal(readFileSync(generated, "utf8"), OLD, `${what}: generated kept`);
			// (The key cache refresh may rewrite state.json; the sync metadata must stay old.)
			const st = JSON.parse(readFileSync(state, "utf8"));
			assert.deepEqual([st.syncedHash, st.note], ["old-hash", undefined], `${what}: state not marked as pulled`);
			assert.equal(readFileSync(userConfig, "utf8"), `Include ${generated}\n`, what);
			assert.doesNotMatch(log.notes.join("\n"), /Pulled/, what);
		};
		bwShared().session = "SESS";
		const basePath = process.env.PATH!;

		// R1a: ssh -G hangs past the 10 s validation timeout.
		const slow = join(dir, "slowssh");
		mkdirSync(slow);
		writeFileSync(join(slow, "ssh"), "#!/bin/sh\nsleep 30\nexit 0\n", { mode: 0o755 });
		process.env.PATH = `${slow}:${basePath}`;
		reset("Host target\n BogusOption yes\n");
		await commands.get("ssh").handler("config pull", ctx);
		assert.match(log.notes.join("\n"), /Could not validate the SSH config \(ssh -G timed out after 10s\); nothing was changed/);
		unchanged("timeout");
		// /ssh config edit too.
		reset("Host target\n HostName t.invalid\n");
		ctx.ui.editor = async () => "Host original\n User changed\n";
		await commands.get("ssh").handler("config edit", ctx);
		assert.match(log.notes.join("\n"), /Could not validate the SSH config \(ssh -G timed out after 10s\)/);
		unchanged("edit with timeout");

		// R1b: no ssh on PATH at all (only what the lock helper needs).
		const tools = join(dir, "tools");
		mkdirSync(tools);
		for (const t of ["flock", "perl", "cat", "sh", "sleep"]) {
			const w = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
			if (w.startsWith("/")) symlinkSync(w, join(tools, t));
		}
		process.env.PATH = `${join(dir, "fakebin")}:${tools}`;
		reset("Host target\n HostName t.invalid\n");
		await commands.get("ssh").handler("config pull", ctx);
		assert.match(log.notes.join("\n"), /Could not validate the SSH config \(ssh -G command not found\); nothing was changed/);
		unchanged("ssh missing");

		// R2: keys path is a regular file -> refused before anything is written.
		process.env.PATH = basePath;
		reset("Host target\n HostName new.invalid\n");
		rmSync(keysDir, { recursive: true });
		writeFileSync(keysDir, "blocked-directory");
		await commands.get("ssh").handler("config pull", ctx);
		assert.match(log.notes.join("\n"), /keys is not a directory|EEXIST/);
		assert.equal(readFileSync(source, "utf8"), OLD);
		assert.equal(readFileSync(keysDir, "utf8"), "blocked-directory");
		unchanged("keys path is a file");

		// Fixed paths: the same pull succeeds; the obsolete .pub file is removed only now.
		rmSync(keysDir);
		mkdirSync(keysDir);
		reset("Host target\n HostName new.invalid\n");
		await commands.get("ssh").handler("config pull", ctx);
		assert.match(log.notes.join("\n"), /Pulled "ssh-config"/);
		assert.equal(readFileSync(source, "utf8"), "Host target\n HostName new.invalid\n");
		assert.equal(JSON.parse(readFileSync(state, "utf8")).note.id, "note-1");
		assert.equal(existsSync(join(keysDir, "old-0ld00000.pub")), false);
	} finally {
		const sh = bwShared();
		sh.session = undefined;
		if (sh.lockTimer) clearTimeout(sh.lockTimer);
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("F1: after a vault key rename and a refused pull, the host still loads its key (last published mapping)", { skip: (!available && "pi packages not installed") || (!has("ssh-agent") && "no OpenSSH") }, async () => {
	// Review 4 F1: reverse lookup recomputed .pub names from the refreshed key cache (new name), so the old
	// .pub path still named by the live generated config no longer mapped to the vault item.
	const dir = mkdtempSync("/tmp/pi-bw-f1-");
	const saved = { ...process.env };
	const bwShared = () => ((globalThis as any)[Symbol.for("pi.bitwarden-ssh.bw")] ??= {});
	let sock: string | undefined;
	let fire: ((e: string, ev: any) => Promise<void>) | undefined;
	try {
		const s = await setup(dir, "tui");
		sock = s.sock;
		fire = s.fire;
		const { commands, tools, ctx, log } = s;
		ctx.ui.confirm = async () => true;
		const home = join(dir, "home");
		const db = join(dir, "db.json");
		const dataDir = join(home, ".pi", "agent", "bitwarden-ssh");
		const state = join(dataDir, "state.json");
		const generated = join(home, ".ssh", "pi-bitwarden", "config");
		const userConfig = join(home, ".ssh", "config");
		mkdirSync(dataDir, { recursive: true });
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "f1", "-f", join(dir, "k")]);
		const key = (name: string) => ({ id: "aaaaaaaa-f1", type: 5, name, sshKey: { privateKey: readFileSync(join(dir, "k"), "utf8"), publicKey: readFileSync(join(dir, "k.pub"), "utf8").trim(), keyFingerprint: "" } });
		const vault = (name: string, note: string) => writeFileSync(db, JSON.stringify({ items: [key(name), { id: "note-1", type: 2, name: "ssh-config", notes: note, secureNote: { type: 0 } }] }));
		writeFileSync(state, JSON.stringify({ version: 1, identityMap: { "~/.ssh/key": { itemId: "aaaaaaaa-f1", name: "OldName" } }, keys: [] }));
		// `ssh -G target` must read the temp config (ssh takes ~ from the passwd entry, not $HOME).
		const wrap = join(dir, "sshwrap");
		mkdirSync(wrap);
		const realSsh = spawnSync("sh", ["-c", "command -v ssh"], { encoding: "utf8" }).stdout.trim();
		writeFileSync(join(wrap, "ssh"), `#!/bin/sh\nif [ "$1" = -G ] && [ "$2" != -F ]; then shift; exec '${realSsh}' -F '${userConfig}' -G "$@"; fi\nexec '${realSsh}' "$@"\n`, { mode: 0o755 });
		process.env.PATH = `${wrap}:${process.env.PATH}`;
		bwShared().session = "SESS";
		await fire("session_start", { reason: "startup" });

		vault("OldName", "Host target\n HostName target.invalid\n IdentityFile ~/.ssh/key\n");
		await commands.get("ssh").handler("config pull", ctx);
		assert.match(log.notes.join("\n"), /Pulled "ssh-config"/);
		const before = readFileSync(generated, "utf8");
		const oldPub = join(home, ".ssh", "pi-bitwarden", "keys", "oldname-aaaaaaaa.pub");
		assert.match(before, new RegExp(`IdentityFile "${oldPub}"`));
		assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).published, { "oldname-aaaaaaaa.pub": "aaaaaaaa-f1" });
		const load = async () => (await tools.get("ssh_keys").execute("id", { action: "load", host: "target" }, undefined, undefined, ctx)).content[0].text as string;
		assert.match(await load(), /Loaded into ssh-agent.*: OldName/);

		// Rename in the vault, pull an invalid note: refused, the key cache now says NewName.
		vault("NewName", "Host target\n BogusOption yes\n");
		log.notes.length = 0;
		await commands.get("ssh").handler("config pull", ctx);
		assert.match(log.notes.join("\n"), /not a valid SSH config; kept the local config/);
		assert.equal(readFileSync(generated, "utf8"), before);
		assert.ok(existsSync(oldPub));
		const st = JSON.parse(readFileSync(state, "utf8"));
		assert.equal(st.keys[0].name, "NewName");
		assert.deepEqual(st.published, { "oldname-aaaaaaaa.pub": "aaaaaaaa-f1" }, "published mapping only changes with a generation");
		assert.match(await load(), /Loaded into ssh-agent.*: NewName/);
	} finally {
		await fire?.("session_shutdown", { reason: "quit" });
		const sh = bwShared();
		sh.session = undefined;
		if (sh.lockTimer) clearTimeout(sh.lockTimer);
		if (sock) spawnSync("pkill", ["-f", sock]);
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});
