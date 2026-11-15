// Hub: discovery from injected sources, online/inbound, logins (user detection, state cache, ask),
// "where is the user". ssh is a fake that runs scripts locally.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hub, type HubDeps } from "../extensions/netbird-devices/hub.ts";
import { resolvePaths } from "../extensions/netbird-devices/paths.ts";
import { type Settings, parseSettings } from "../extensions/netbird-devices/settings.ts";
import { SshError } from "../extensions/netbird-devices/ssh.ts";
import { type FakeSsh, fakeSsh } from "./netbird-devices-fake-ssh.ts";

const CONF = `Host *
Match host "100.71.171.69,sergeys-macbook-pro.netbird.cloud,sergeys-macbook-pro"
Match host "100.71.201.21,personal-project-nl.netbird.cloud,personal-project-nl"
Match host "100.71.9.9,ana-linux-pc.netbird.cloud,ana-linux-pc"
`;

const RUNS: Record<string, string> = {
	"ip -o addr show wt0": "4: wt0    inet 100.71.73.147/16 scope global wt0\\       valid_lft forever\n",
	"getent hosts 100.71.73.147": "100.71.73.147   cloudcli.netbird.cloud\n",
	"ss -tlnH": "LISTEN 0 128 100.71.73.147:6768 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:631 0.0.0.0:*\n",
	"ss -tnH state established": "0 0 100.71.73.147:6768 100.71.171.69:50000\n0 0 100.71.73.147:6768 100.71.171.69:50001\n",
};

interface Fx {
	dir: string;
	hub: Hub;
	fake: FakeSsh;
	settings: { value: Settings };
	mk: (over?: Partial<HubDeps>) => Hub;
	cleanup: () => void;
}

function fixture(opts: { users?: string[]; runs?: Record<string, string>; settings?: unknown; online?: string[] } = {}): Fx {
	const dir = mkdtempSync(join(tmpdir(), "nbd-hub-"));
	writeFileSync(join(dir, "99-netbird.conf"), CONF);
	const fake = fakeSsh({ dir: join(dir, "fake"), users: opts.users ?? ["sergey"] });
	const settings = { value: parseSettings(opts.settings).settings };
	const runs = { ...RUNS, ...opts.runs };
	const paths = resolvePaths({ agentDir: join(dir, "agent"), uid: 1000 });
	let t = 1_000_000;
	const mk = (over: Partial<HubDeps> = {}) =>
		new Hub({
			paths,
			settings: () => settings.value,
			vmUser: "orca",
			sshBin: fake.bin,
			hostname: "old-man.vpspay.net",
			confFile: join(dir, "99-netbird.conf"),
			run: async (cmd, args) => runs[`${cmd} ${args.join(" ")}`] ?? "",
			checkPort: async (ip) => (opts.online ?? ["100.71.171.69"]).includes(ip),
			now: () => (t += 1),
			...over,
		});
	return { dir, hub: mk(), fake, settings, mk, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const dev = (hub: Hub, name: string) => {
	const d = hub.devices().find((x) => x.name === name || x.aliases.includes(name));
	assert.ok(d, `device ${name}`);
	return d;
};

test("hub: discovery names this machine, devices, aliases, inbound, domains", async () => {
	const f = fixture();
	try {
		await f.hub.refresh();
		assert.equal(f.hub.netbirdName, "cloudcli");
		assert.equal(f.hub.localLabel(), "cloudcli");
		assert.deepEqual(f.hub.selfIps, ["100.71.73.147"]);
		const names = f.hub.localNames();
		assert.ok(names.has("cloudcli") && names.has("old-man.vpspay.net") && names.has("old-man") && names.has("100.71.73.147"));
		const devices = f.hub.devices();
		assert.deepEqual(devices.map((d) => d.name), ["sergeys-macbook-pro", "personal-project-nl", "ana-linux-pc"]);
		assert.deepEqual(dev(f.hub, "sergeys-macbook-pro").aliases, ["mac"]);
		assert.deepEqual([...f.hub.inboundDevices(devices)], ["sergeys-macbook-pro"]);
		assert.ok(f.hub.domains().includes("netbird.cloud"));
		assert.equal(f.hub.modeOf(devices[0]), "ask");
	} finally {
		f.cleanup();
	}
});

test("hub: devices() works before refresh (reads the drop-in), settings give names, mode, protected globs", () => {
	const f = fixture({ settings: { defaultMode: "ro", protected: ["~/p/**"], devices: { mac: { peer: "sergeys-macbook-pro", mode: "full", aliases: ["Мак"], protected: ["~/q/**"] } } } });
	try {
		const devices = f.hub.devices();
		const mac = devices.find((d) => d.name === "mac")!;
		assert.equal(mac.peer, "sergeys-macbook-pro");
		assert.deepEqual(mac.ips, ["100.71.171.69"]);
		assert.deepEqual(mac.aliases, ["мак"]);
		assert.equal(f.hub.modeOf(mac), "full");
		assert.equal(f.hub.modeOf(devices.find((d) => d.name === "ana-linux-pc")!), "ro");
		const g = f.hub.protectedGlobs(mac);
		assert.ok(g.includes("~/.ssh/**") && g.includes("~/p/**") && g.includes("~/q/**"));
	} finally {
		f.cleanup();
	}
});

test("hub: an inbound peer that NetBird SSH does not list is named by getent and is not usable", async () => {
	const f = fixture({
		runs: {
			"ss -tnH state established": "0 0 100.71.73.147:6768 100.71.5.5:4000\n",
			"getent hosts 100.71.5.5": "100.71.5.5   work-pc.netbird.cloud\n",
		},
	});
	try {
		await f.hub.refresh();
		const d = f.hub.devices().find((x) => x.name === "work-pc")!;
		assert.ok(d);
		assert.equal(d.sshEnabled, false);
		assert.deepEqual([...f.hub.inboundDevices(f.hub.devices())], ["work-pc"]);
	} finally {
		f.cleanup();
	}
});

test("hub: online = SSH port answers (only for devices with NetBird SSH) or API connected", async () => {
	const f = fixture({ online: ["100.71.171.69"] });
	try {
		const devices = f.hub.devices();
		const online = await f.hub.online(devices);
		assert.equal(online.get("sergeys-macbook-pro"), true);
		assert.equal(online.get("personal-project-nl"), false);
	} finally {
		f.cleanup();
	}
});

test("hub: the API token adds status; a failing API becomes a warning, never the token", async () => {
	const f = fixture({ online: [] });
	try {
		const ok = f.mk({
			apiToken: async () => "nbp_secret",
			fetchPeers: async (url, token) => {
				assert.equal(url, "https://api.netbird.io");
				assert.equal(token, "nbp_secret");
				return [{ dns_label: "sergeys-macbook-pro.netbird.cloud", ip: "100.71.171.69", connected: true, os: "macOS 27", ssh_enabled: true }];
			},
		});
		await ok.refresh();
		const d = ok.devices().find((x) => x.name === "sergeys-macbook-pro")!;
		assert.equal(d.connected, true);
		assert.equal((await ok.online(ok.devices())).get(d.name), true);
		const bad = f.mk({ apiToken: async () => "nbp_secret", fetchPeers: async () => Promise.reject(new Error("HTTP 401")) });
		await bad.refresh();
		assert.deepEqual(bad.warnings, ["NetBird API: HTTP 401"]);
		assert.ok(bad.devices().length >= 3, "conf peers still there");
	} finally {
		f.cleanup();
	}
});

test("hub.connect: detects the user from the peer name, saves state, then needs no ssh; parallel calls share one login", async () => {
	const f = fixture({ users: ["sergey"] });
	try {
		const d = dev(f.hub, "mac");
		const [a, b] = await Promise.all([f.hub.connect(d), f.hub.connect(d)]);
		assert.equal(a.user, "sergey");
		assert.equal(a.home, process.env.HOME);
		assert.equal(a, b);
		assert.equal(a.target.user, "sergey");
		assert.equal(a.target.host, "100.71.171.69");
		assert.equal(a.target.hostKeyAlias, "sergeys-macbook-pro.netbird.cloud");
		assert.equal(f.fake.calls().length, 1, "one probe");
		await f.hub.connect(d);
		assert.equal(f.fake.calls().length, 1, "cached in memory");
		const st = JSON.parse(readFileSync(join(f.dir, "agent", "netbird-devices", "state.json"), "utf8"));
		assert.equal(st.devices["sergeys-macbook-pro"].user, "sergey");
		assert.equal(st.devices["sergeys-macbook-pro"].userSource, "detected");
		// another process: state cache, no ssh at all
		const again = f.mk();
		const c = await again.connect(dev(again, "sergeys-macbook-pro"));
		assert.equal(c.user, "sergey");
		assert.equal(f.fake.calls().length, 1);
		// os hint from the probe makes the alias survive without the name heuristic
		assert.ok(again.state.devices["sergeys-macbook-pro"].probe?.os);
	} finally {
		f.cleanup();
	}
});

test("hub.connect: a login from settings is the only one tried; its failure is an auth error", async () => {
	const f = fixture({ users: ["sergey"], settings: { devices: { mac: { peer: "sergeys-macbook-pro", user: "ana" } } } });
	try {
		await assert.rejects(f.hub.connect(dev(f.hub, "mac")), (e: SshError) => e.kind === "auth" && /ana/.test(e.message));
		assert.equal(f.fake.calls().length, 1);
		f.settings.value = parseSettings({ devices: { mac: { peer: "sergeys-macbook-pro", user: "sergey" } } }).settings;
		const c = await f.hub.connect(dev(f.hub, "mac"));
		assert.equal(c.user, "sergey");
		assert.equal(f.hub.state.devices["mac"].userSource, "settings");
	} finally {
		f.cleanup();
	}
});

test("hub.connect: nothing detected -> asks once and remembers; no answer or no ask -> error; root is refused", async () => {
	const f = fixture({ users: ["bob"] });
	try {
		const d = dev(f.hub, "mac");
		await assert.rejects(f.hub.connect(d), (e: SshError) => e.kind === "auth");
		await assert.rejects(f.hub.connect(d, { ask: async () => undefined }), (e: SshError) => e.kind === "auth");
		await assert.rejects(f.hub.connect(d, { ask: async () => "root" }), /not a usable login user/);
		let asked = 0;
		const c = await f.hub.connect(d, {
			ask: async (dd, why) => {
				asked++;
				assert.match(why, /login/);
				return " bob ";
			},
		});
		assert.equal(c.user, "bob");
		assert.equal(asked, 1);
		assert.equal(f.hub.state.devices["sergeys-macbook-pro"].userSource, "asked");
		// remembered: a new hub uses it without asking or probing again
		const calls = f.fake.calls().length;
		const again = f.mk();
		assert.equal((await again.connect(dev(again, "sergeys-macbook-pro"))).user, "bob");
		assert.equal(f.fake.calls().length, calls);
	} finally {
		f.cleanup();
	}
});

test("hub.setUser / forget", async () => {
	const f = fixture({ users: ["sergey", "bob"] });
	try {
		const d = dev(f.hub, "mac");
		assert.equal((await f.hub.connect(d)).user, "sergey");
		f.hub.setUser(d, "bob");
		assert.equal((await f.hub.connect(d)).user, "bob");
		f.hub.setUser(d, undefined);
		assert.equal(f.hub.state.devices[d.name].user, undefined);
		assert.equal((await f.hub.connect(d)).user, "sergey");
		const before = f.fake.calls().length;
		await f.hub.forget(d);
		const exits = f.fake.calls().slice(before).filter((a) => a.includes("-O") && a.includes("exit"));
		assert.ok(exits.some((a) => a.includes("sergey@100.71.171.69")), "the master of the login user is closed even without a live connection object");
		assert.equal(f.hub.state.devices[d.name], undefined);
		assert.equal(f.mk().state.devices[d.name], undefined);
	} finally {
		f.cleanup();
	}
});

test("hub.closeAll: waits for an in-flight probe, closes attempted users and rejects further connections", async () => {
	const f = fixture({ users: ["sergey"] });
	try {
		const d = dev(f.hub, "mac");
		const login = f.hub.connect(d);
		await f.hub.closeAll();
		await login;
		const exits = f.fake.calls().filter((a) => a.includes("-O") && a.includes("exit"));
		assert.ok(exits.some((a) => a.includes("sergey@100.71.171.69")));
		assert.ok(exits.some((a) => a.includes("orca@100.71.171.69")), "attempted login tracked too");
		await assert.rejects(f.hub.connect(d), /session is closed/);
	} finally { f.cleanup(); }
});

test("hub.resolveHere: pinned, single inbound device, none, ambiguous, recent choice", async () => {
	const f = fixture({ online: ["100.71.171.69", "100.71.9.9"], users: ["sergey", "ana"] });
	try {
		assert.deepEqual(await f.hub.resolveHere("mac"), { kind: "found", device: "mac", why: "pinned with /nb here" });
		const one = await f.hub.resolveHere();
		assert.equal(one.kind, "found");
		assert.equal((one as any).device, "sergeys-macbook-pro");
		assert.match((one as any).why, /only device connected/);
		// nobody connected, nobody known active: none
		const quiet = fixture({ online: ["100.71.171.69"], runs: { "ss -tnH state established": "" } });
		try {
			const r = await quiet.hub.resolveHere();
			assert.equal(r.kind, "none");
		} finally {
			quiet.cleanup();
		}
		// two connected, input idle unknown: ambiguous, then the choice is remembered for 30 minutes
		const two = fixture({
			online: ["100.71.171.69", "100.71.9.9"],
			runs: { "ss -tnH state established": "0 0 100.71.73.147:6768 100.71.171.69:50000\n0 0 100.71.73.147:6768 100.71.9.9:50001\n" },
		});
		try {
			const r = await two.hub.resolveHere();
			assert.equal(r.kind, "ambiguous");
			assert.deepEqual((r as any).candidates.map((c: any) => c.device).sort(), ["ana-linux-pc", "sergeys-macbook-pro"]);
			two.hub.rememberHere("ana-linux-pc");
			const again = await two.hub.resolveHere();
			assert.equal(again.kind, "found");
			assert.equal((again as any).device, "ana-linux-pc");
			assert.equal(two.mk().state.hereChoice?.device, "ana-linux-pc");
		} finally {
			two.cleanup();
		}
	} finally {
		f.cleanup();
	}
});
