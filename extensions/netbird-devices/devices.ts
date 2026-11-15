// Devices = settings + NetBird peers: names, aliases, lookup, login-user candidates. Pure, unit-tested.

import type { Peer } from "./discovery.ts";
import type { DeviceSettings, Settings } from "./settings.ts";

export interface Device {
	/** Name used in tool calls (the settings key, or the peer name). */
	name: string;
	/** NetBird peer name as configured/discovered (short label, FQDN or IP). */
	peer: string;
	fqdn?: string;
	ips: string[];
	sshEnabled: boolean;
	/** From the API, when available. */
	connected?: boolean;
	os?: string;
	/** Lower-case aliases: configured plus automatic `mac`/`linux`. */
	aliases: string[];
	settings: DeviceSettings;
	/** Present in settings.json (as opposed to discovered). */
	configured: boolean;
}

export type OsKind = "mac" | "linux" | "other";

export function osKind(os?: string, name?: string): OsKind {
	if (os && /mac|darwin/i.test(os)) return "mac";
	if (os && /linux|ubuntu|debian|fedora|arch|centos|rhel|suse|nixos|mint/i.test(os)) return "linux";
	if (!os && name && /macbook|imac|mac-?mini|mac-?studio|mac-?pro/i.test(name)) return "mac";
	return "other";
}

const isIpLike = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (s.includes(":") && /^[0-9a-f:]+$/i.test(s));

function matchPeer(peers: readonly Peer[], ref: string): Peer | undefined {
	const r = ref.toLowerCase();
	return peers.find((p) => p.name.toLowerCase() === r || p.fqdn?.toLowerCase() === r || p.ips.some((ip) => ip.toLowerCase() === r) || p.hostname?.toLowerCase() === r);
}

const DEFAULT_DEVICE_SETTINGS = (): DeviceSettings => ({ aliases: [], protected: [], rootPrompt: "auto", port: 22 });

/**
 * @param localNames names/IPs of this machine (hostname, NetBird name, `localName`, own wt0 addresses): their peers are not devices.
 * @param osHints device name -> OS string learned by probing (peers from `99-netbird.conf` carry no OS).
 */
export function buildDevices(settings: Settings, peers: readonly Peer[], localNames: readonly string[] = [], osHints: Record<string, string> = {}): Device[] {
	const local = new Set(localNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
	const isLocal = (p: Peer) => [p.name, p.fqdn, p.hostname, ...p.ips].some((x) => x && local.has(x.toLowerCase()));
	const used = new Set<Peer>();
	const out: Device[] = [];

	for (const [name, ds] of Object.entries(settings.devices)) {
		const peerRef = ds.peer ?? name;
		const peer = matchPeer(peers, peerRef);
		if (peer) used.add(peer);
		const ref = peerRef.toLowerCase();
		out.push({
			name,
			peer: peer?.name ?? peerRef,
			fqdn: peer?.fqdn ?? (!isIpLike(ref) && ref.includes(".") ? ref : undefined),
			ips: peer ? [...peer.ips] : isIpLike(ref) ? [ref] : [],
			sshEnabled: peer?.sshEnabled ?? true,
			connected: peer?.connected,
			os: peer?.os ?? osHints[name],
			aliases: [],
			settings: ds,
			configured: true,
		});
	}
	for (const peer of peers) {
		if (used.has(peer) || isLocal(peer)) continue;
		if (Object.keys(settings.devices).some((k) => k.toLowerCase() === peer.name.toLowerCase())) continue;
		out.push({
			name: peer.name,
			peer: peer.name,
			fqdn: peer.fqdn,
			ips: [...peer.ips],
			sshEnabled: peer.sshEnabled === true,
			connected: peer.connected,
			os: peer.os ?? osHints[peer.name],
			aliases: [],
			settings: DEFAULT_DEVICE_SETTINGS(),
			configured: false,
		});
	}

	// Aliases: configured ones first (lower-case, first claim wins), then automatic mac/linux.
	const claimed = new Set(out.map((d) => d.name.toLowerCase()));
	for (const d of out) {
		for (const a of d.settings.aliases) {
			const al = a.toLowerCase();
			if (claimed.has(al)) continue; // a device name or an earlier alias
			d.aliases.push(al);
			claimed.add(al);
		}
	}
	for (const kind of ["mac", "linux"] as const) {
		if (claimed.has(kind)) continue;
		const of = out.filter((d) => osKind(d.os, d.peer) === kind);
		if (of.length === 1) {
			of[0].aliases.push(kind);
			claimed.add(kind);
		}
	}
	return out;
}

/** Look a device up by name, alias, peer name, FQDN, short FQDN label or IP (case-insensitive). */
export function findDevice(devices: readonly Device[], query: string): Device | undefined {
	const q = query.trim().toLowerCase().replace(/\.$/, "");
	if (!q) return undefined;
	const keys = (d: Device) => [d.name, ...d.aliases, d.peer, d.fqdn, ...d.ips].filter((x): x is string => !!x).map((x) => x.toLowerCase());
	return devices.find((d) => d.name.toLowerCase() === q) ?? devices.find((d) => d.aliases.includes(q)) ?? devices.find((d) => keys(d).includes(q));
}

/** Everything that counts as "this device" for the ssh guard: names, FQDNs, IPs, aliases. */
export function deviceNames(devices: readonly Device[]): Set<string> {
	const s = new Set<string>();
	for (const d of devices) for (const k of [d.name, ...d.aliases, d.peer, d.fqdn, ...d.ips]) if (k) s.add(k.toLowerCase());
	return s;
}

// --- login user ---------------------------------------------------------------------------------

const GENERIC = new Set(["macbook", "imac", "mac", "mini", "iphone", "ipad", "ubuntu", "debian", "fedora", "arch", "linux", "desktop", "laptop", "pc", "server", "host", "vm", "node", "workstation", "notebook", "personal", "work", "home"]);
const DEVICE_WORDS = new Set(["macbook", "imac", "mac", "mini", "pro", "air", "studio", "pc", "laptop", "desktop", "computer", "workstation", "notebook", "linux", "ubuntu", "book"]);

/** `sergeys-macbook-pro` -> ["sergey", "sergeys"]; `sergey-pc` -> ["sergey"]; `macbook-pro`, `iphone-123` -> []. */
export function userFromPeerName(peerName: string): string[] {
	const segs = peerName.toLowerCase().split(/[-_.]/).filter(Boolean);
	if (segs.length < 2) return [];
	const first = segs[0];
	if (!/^[a-z][a-z0-9]{1,31}$/.test(first) || GENERIC.has(first)) return [];
	if (!segs.slice(1).some((s) => DEVICE_WORDS.has(s))) return [];
	return first.length > 3 && first.endsWith("s") ? [first.slice(0, -1), first] : [first];
}

/** Login users to try, in order: settings, cache, name of the peer, user of this VM. `root` never. */
export function userCandidates(peerName: string, configured?: string, cached?: string, vmUser?: string): string[] {
	const out: string[] = [];
	for (const u of [configured, cached, ...userFromPeerName(peerName), vmUser]) {
		const t = u?.trim();
		if (!t || t === "root" || !/^[\w][\w.@-]*$/.test(t) || out.includes(t)) continue;
		out.push(t);
	}
	return out;
}
