// The device hub: discovery (99-netbird.conf, optional API, getent, ss, wt0), online checks, "where is
// the user", and logins (user detection, probe cache in state.json). No pi imports; every outside
// dependency can be replaced for tests.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { buildDevices, type Device, userCandidates } from "./devices.ts";
import {
	inboundPeers,
	mergePeers,
	type Peer,
	parseApiPeers,
	parseGetentHosts,
	parseIpAddr,
	parseListeningPorts,
	parseNetbirdSshConfig,
} from "./discovery.ts";
import { type Paths, ensureDir } from "./paths.ts";
import { type Candidate, type HereResult, resolveHere } from "./presence.ts";
import type { Conn } from "./remote-ops.ts";
import { DEFAULT_PROTECTED, type Mode, type Settings } from "./settings.ts";
import { checkPort as realCheckPort, detectUser, idle, probe, SshError, stopMaster, type Target } from "./ssh.ts";
import { type DeviceState, type State, loadState, saveState } from "./state.ts";

export const NETBIRD_CONF = "/etc/ssh/ssh_config.d/99-netbird.conf";
/** Discovery results are reused this long (`/nb refresh` forces). */
export const DISCOVERY_TTL_MS = 60_000;
/** A probe (home, PATH, console user) is trusted this long; the login user is re-detected after it. */
export const PROBE_TTL_MS = 30 * 60_000;
/** Same for logins fixed by the user or settings: they cannot change by themselves. */
export const FIXED_PROBE_TTL_MS = 24 * 60 * 60_000;

export interface HubDeps {
	paths: Paths;
	settings: () => Settings;
	/** The account pi runs as; the last login candidate. */
	vmUser?: string;
	sshBin?: string;
	hostname?: string;
	confFile?: string;
	/** Run a command and return its stdout ("" on any failure). */
	run?: (cmd: string, args: string[]) => Promise<string>;
	/** NetBird API token (api-keys.json "netbird"), if any. */
	apiToken?: () => Promise<string | undefined>;
	fetchPeers?: (url: string, token: string) => Promise<unknown>;
	checkPort?: (ip: string, port: number, ms: number) => Promise<boolean>;
	now?: () => number;
}

export type AskUser = (device: Device, reason: string) => Promise<string | undefined>;

function defaultRun(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		try {
			execFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
		} catch {
			resolve("");
		}
	});
}

async function defaultFetchPeers(url: string, token: string): Promise<unknown> {
	const res = await fetch(`${url}/api/peers`, { headers: { Authorization: `Token ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

const ipv4First = (ips: readonly string[]) => [...ips].sort((a, b) => Number(b.includes(".")) - Number(a.includes(".")));

export class Hub {
	state: State;
	/** Problems worth showing in `/nb`: unreadable state, API errors. */
	warnings: string[] = [];
	netbirdName?: string;
	selfIps: string[] = [];
	private peers: Peer[] = [];
	private peersAt = 0;
	private inbound = new Map<string, number>();
	private conns = new Map<string, Conn & { at: number }>();
	private inflight = new Map<string, Promise<Conn>>();
	private refreshing?: Promise<void>;
	private sshBin?: string;
	private now: () => number;
	private d: HubDeps;

	constructor(d: HubDeps) {
		this.d = d;
		const loaded = loadState(d.paths.stateFile);
		this.state = loaded.state;
		if (loaded.warning) this.warnings.push(loaded.warning);
		this.sshBin = d.sshBin;
		this.now = d.now ?? Date.now;
	}

	private run = (cmd: string, args: string[]) => (this.d.run ?? defaultRun)(cmd, args);
	private get settings(): Settings {
		return this.d.settings();
	}

	// --- state -------------------------------------------------------------------------------------

	/** Read-modify-write, so other pi processes' changes are not lost. */
	updateState(fn: (s: State) => void): void {
		const s = loadState(this.d.paths.stateFile).state;
		fn(s);
		this.state = s;
		try {
			ensureDir(this.d.paths.dataDir);
			saveState(this.d.paths.stateFile, s);
		} catch (e) {
			this.warn(`cannot save ${this.d.paths.stateFile}: ${(e as Error).message}`);
		}
	}

	private warn(w: string): void {
		if (!this.warnings.includes(w)) this.warnings.push(w);
		if (this.warnings.length > 20) this.warnings.shift();
	}

	// --- discovery ---------------------------------------------------------------------------------

	private readConf(): Peer[] {
		try {
			return parseNetbirdSshConfig(readFileSync(this.d.confFile ?? NETBIRD_CONF, "utf8"));
		} catch {
			return [];
		}
	}

	/** Refresh peers, own addresses and inbound connections (cached for a minute). */
	refresh(force = false): Promise<void> {
		if (!force && this.peersAt && this.now() - this.peersAt < DISCOVERY_TTL_MS) return Promise.resolve();
		this.refreshing ??= this.doRefresh().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	private async apiPeers(): Promise<Peer[]> {
		try {
			const token = await this.d.apiToken?.();
			if (!token) return [];
			return parseApiPeers(await (this.d.fetchPeers ?? defaultFetchPeers)(this.settings.apiUrl, token));
		} catch (e) {
			this.warn(`NetBird API: ${(e as Error).message}`);
			return [];
		}
	}

	private async doRefresh(): Promise<void> {
		const [conf, api, addr, listen, established] = await Promise.all([
			Promise.resolve(this.readConf()),
			this.apiPeers(),
			this.run("ip", ["-o", "addr", "show", "wt0"]),
			this.run("ss", ["-tlnH"]),
			this.run("ss", ["-tnH", "state", "established"]),
		]);
		this.selfIps = parseIpAddr(addr, "wt0");
		if (this.selfIps.length) {
			const names = parseGetentHosts(await this.run("getent", ["hosts", this.selfIps[0]]))[0]?.names ?? [];
			if (names[0]) this.netbirdName = names[0].split(".")[0];
		}
		this.inbound = inboundPeers(established, parseListeningPorts(listen), this.selfIps);
		let merged = mergePeers(conf, api);
		// Devices connected to us that NetBird SSH does not list (a laptop without --allow-server-ssh): name them.
		const known = new Set(merged.flatMap((p) => p.ips));
		const extra: Peer[] = [];
		for (const ip of this.inbound.keys()) {
			if (known.has(ip) || this.selfIps.includes(ip)) continue;
			const e = parseGetentHosts(await this.run("getent", ["hosts", ip]))[0];
			const fqdn = e?.names[0];
			extra.push({ name: fqdn ? fqdn.split(".")[0] : ip, fqdn: fqdn?.includes(".") ? fqdn : undefined, ips: [ip], sshEnabled: false });
		}
		merged = mergePeers(merged, extra);
		this.peers = merged;
		this.peersAt = this.now();
	}

	/** Names and addresses of this machine (lower case). */
	localNames(): Set<string> {
		const s = this.settings;
		const host = this.d.hostname ?? osHostname();
		const out = [host, host.split(".")[0], s.localName, this.netbirdName, this.netbirdName && `${this.netbirdName}.netbird.cloud`, ...this.selfIps];
		return new Set(out.filter((x): x is string => !!x).map((x) => x.toLowerCase()));
	}

	/** Name for the footer: setting, NetBird name, hostname. */
	localLabel(): string {
		return this.settings.localName || this.netbirdName || (this.d.hostname ?? osHostname()).split(".")[0];
	}

	/** Devices from what is known now (reads the NetBird drop-in synchronously the first time). */
	devices(): Device[] {
		if (!this.peersAt && !this.peers.length) this.peers = this.readConf();
		const hints: Record<string, string> = {};
		for (const [name, ds] of Object.entries(this.state.devices)) if (ds.probe?.os) hints[name] = ds.probe.os;
		return buildDevices(this.settings, this.peers, [...this.localNames()], hints);
	}

	/** Names of NetBird domains seen (for the ssh guard). */
	domains(): string[] {
		const set = new Set<string>(["netbird.cloud"]);
		for (const p of this.peers) if (p.fqdn?.includes(".")) set.add(p.fqdn.slice(p.fqdn.indexOf(".") + 1).toLowerCase());
		return [...set];
	}

	modeOf(d: Device): Mode {
		return d.settings.mode ?? this.settings.defaultMode;
	}

	protectedGlobs(d: Device): string[] {
		return [...DEFAULT_PROTECTED, ...this.settings.protected, ...d.settings.protected];
	}

	/** Online = SSH port answers or the API says connected. Only devices with NetBird SSH are probed. */
	async online(devices: readonly Device[]): Promise<Map<string, boolean>> {
		const check = this.d.checkPort ?? realCheckPort;
		const res = new Map<string, boolean>();
		await Promise.all(
			devices.map(async (d) => {
				if (!d.sshEnabled) {
					if (d.connected !== undefined) res.set(d.name, d.connected);
					return;
				}
				const ip = ipv4First(d.ips)[0];
				const open = ip ? await check(ip, d.settings.port, 1500).catch(() => false) : false;
				res.set(d.name, open || d.connected === true);
			}),
		);
		return res;
	}

	/** Devices with an inbound NetBird connection to this machine. */
	inboundDevices(devices: readonly Device[]): Set<string> {
		const out = new Set<string>();
		for (const d of devices) if (d.ips.some((ip) => this.inbound.has(ip))) out.add(d.name);
		return out;
	}

	// --- login -------------------------------------------------------------------------------------

	private baseTarget(d: Device): Omit<Target, "user"> {
		const host = ipv4First(d.ips)[0] ?? d.fqdn ?? d.peer;
		return { host, port: d.settings.port, hostKeyAlias: d.fqdn ?? d.peer, paths: { knownHosts: this.d.paths.knownHosts, cmDir: this.d.paths.cmDir }, sshBin: this.sshBin };
	}

	private toConn(d: Device, user: string, info: NonNullable<DeviceState["probe"]>): Conn {
		return { device: d.name, target: { ...this.baseTarget(d), user }, user, home: info.home, probe: info };
	}

	private fixedUser(d: Device): { user: string; source: "settings" | "asked" } | undefined {
		if (d.settings.user) return { user: d.settings.user, source: "settings" };
		const ds = this.state.devices[d.name];
		return ds?.user && ds.userSource === "asked" ? { user: ds.user, source: "asked" } : undefined;
	}

	private save(d: Device, user: string, source: "settings" | "asked" | "detected", info: Awaited<ReturnType<typeof probe>>): Conn {
		const probeInfo = { ...info, at: this.now() };
		this.updateState((s) => {
			s.devices[d.name] = { ...(s.devices[d.name] ?? {}), user, userSource: source, probe: probeInfo };
		});
		const conn = { ...this.toConn(d, user, probeInfo), at: this.now() };
		this.conns.set(d.name, conn);
		return conn;
	}

	/**
	 * A logged-in connection to the device. The user comes from settings, from what was asked, or is
	 * detected (name of the peer, the user at the screen); `ask` is called once when nothing works.
	 * Concurrent calls share one login.
	 */
	connect(d: Device, opts: { ask?: AskUser } = {}): Promise<Conn> {
		let p = this.inflight.get(d.name);
		if (!p) {
			p = this.doConnect(d, opts.ask).finally(() => this.inflight.delete(d.name));
			this.inflight.set(d.name, p);
		}
		return p;
	}

	private async doConnect(d: Device, ask?: AskUser): Promise<Conn> {
		const fixed = this.fixedUser(d);
		const ttl = fixed ? FIXED_PROBE_TTL_MS : PROBE_TTL_MS;
		const mem = this.conns.get(d.name);
		if (mem && this.now() - mem.at < ttl && (!fixed || mem.user === fixed.user)) return mem;
		const ds = this.state.devices[d.name];
		if (ds?.probe && ds.user && this.now() - ds.probe.at < ttl && (!fixed || ds.user === fixed.user) && ds.probe.user === ds.user) {
			const c = { ...this.toConn(d, ds.user, ds.probe), at: ds.probe.at };
			this.conns.set(d.name, c);
			return c;
		}
		const base = this.baseTarget(d);
		if (fixed) return this.save(d, fixed.user, fixed.source, await probe({ ...base, user: fixed.user }));
		const candidates = userCandidates(d.peer, undefined, ds?.user, this.d.vmUser);
		try {
			const r = await detectUser(base, candidates, d.name);
			return this.save(d, r.user, "detected", r.probe);
		} catch (e) {
			if (!(e instanceof SshError) || e.kind !== "auth" || !ask) throw e;
			const user = (await ask(d, e.message))?.trim();
			if (!user) throw e;
			if (!/^[\w][\w.@-]*$/.test(user) || user === "root") throw new SshError(`${d.name}: "${user}" is not a usable login user`, { kind: "auth" });
			return this.save(d, user, "asked", await probe({ ...base, user }));
		}
	}

	/** `/nb user <device> <user|auto>`. */
	setUser(d: Device, user: string | undefined): void {
		this.conns.delete(d.name);
		this.updateState((s) => {
			const ds: DeviceState = { ...(s.devices[d.name] ?? {}) };
			delete ds.probe;
			if (user) {
				ds.user = user;
				ds.userSource = "asked";
			} else {
				delete ds.user;
				delete ds.userSource;
			}
			s.devices[d.name] = ds;
		});
	}

	/** `/nb forget <device>`: host key, cached login, open connection. */
	async forget(d: Device): Promise<void> {
		const conn = this.conns.get(d.name);
		this.conns.delete(d.name);
		// A master may be left by an earlier process or another login of this device: close every user it could have.
		const users = new Set([conn?.user, this.state.devices[d.name]?.user, ...userCandidates(d.peer, d.settings.user, undefined, this.d.vmUser)].filter((u): u is string => !!u));
		await Promise.all([...users].map((user) => stopMaster({ ...this.baseTarget(d), user })));
		this.updateState((s) => {
			delete s.devices[d.name];
		});
		await this.run("ssh-keygen", ["-R", d.fqdn ?? d.peer, "-f", this.d.paths.knownHosts]);
	}

	/** Close the connections we opened (session quit). */
	async closeAll(): Promise<void> {
		const conns = [...this.conns.values()];
		this.conns.clear();
		await Promise.all(conns.map((c) => stopMaster(c.target)));
	}

	// --- where is the user -------------------------------------------------------------------------

	/**
	 * Resolve "here" without asking the user: pinned device, inbound connections, input idle time,
	 * a recent choice. `ambiguous` and `none` are for the caller to turn into a question or an error.
	 */
	async resolveHere(pinned?: string, opts: { ask?: AskUser } = {}): Promise<HereResult> {
		if (pinned) return { kind: "found", device: pinned, why: "pinned with /nb here" };
		await this.refresh();
		const devices = this.devices().filter((d) => d.sshEnabled);
		const online = await this.online(devices);
		const inb = this.inboundDevices(devices);
		const cands: Candidate[] = devices.filter((d) => online.get(d.name)).map((d) => ({ device: d.name, connected: inb.has(d.name) }));
		const choice = this.state.hereChoice;
		let r = resolveHere(cands, undefined, choice, this.now());
		if (r.kind === "found") return r;
		// Not decided by connections alone: measure input idle time on the candidates.
		const connected = cands.filter((c) => c.connected);
		const pool = connected.length ? connected : cands;
		await Promise.all(
			pool.map(async (c) => {
				const dev = devices.find((d) => d.name === c.device)!;
				try {
					c.idleSec = await idle((await this.connect(dev, opts)).target);
				} catch {}
			}),
		);
		r = resolveHere(cands, undefined, choice, this.now());
		return r;
	}

	rememberHere(device: string): void {
		this.updateState((s) => {
			s.hereChoice = { device, at: this.now() };
		});
	}

	/** Inbound NetBird peer addresses (for `/nb`). */
	inboundIps(): string[] {
		return [...this.inbound.keys()];
	}
}
