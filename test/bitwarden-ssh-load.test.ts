// Load the extension entry and drive it end to end with a fake pi, a fake `bw` and a temp HOME.
// Needs pi's packages to resolve (the entry imports pi-coding-agent and pi-tui at runtime), otherwise
// skipped. Never touches the real ~/.ssh, ~/.pi or the real vault.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

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
		assert.match(gen, /IdentityFile ".*\/keys\/testkey\.pub"\n {4}IdentitiesOnly yes/);
		assert.equal(readFileSync(join(home, ".ssh", "pi-bitwarden", "keys", "testkey.pub"), "utf8"), `${pub}\n`);
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
