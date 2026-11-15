// Parsers for the sources of NetBird peers that need no root: the OpenSSH drop-in NetBird writes
// (/etc/ssh/ssh_config.d/99-netbird.conf, peers with NetBird SSH), the management API (optional
// token) and `ss` output (peers connected to this machine). Pure: no pi imports, unit-tested.

export interface Peer {
	/** Short DNS label, e.g. "sergeys-macbook-pro". */
	name: string;
	fqdn?: string;
	ips: string[];
	sshEnabled?: boolean;
	connected?: boolean;
	os?: string;
	lastSeen?: string;
	hostname?: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const isIp = (t: string) => IPV4.test(t) || (t.includes(":") && /^[0-9a-f:]+$/i.test(t));

export function ipv4ToInt(ip: string): number | undefined {
	if (!IPV4.test(ip)) return undefined;
	const p = ip.split(".").map(Number);
	if (p.some((n) => n > 255)) return undefined;
	return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** NetBird uses the CGNAT range 100.64.0.0/10 for peer addresses. */
export function inNetbirdRange(ip: string): boolean {
	const n = ipv4ToInt(ip);
	if (n === undefined) return false;
	return n >>> 22 === ipv4ToInt("100.64.0.0")! >>> 22;
}

/**
 * Peers from the `Match host "a,b,c"` lines of NetBird's OpenSSH drop-in. Each peer is listed as
 * IPv4, IPv6, FQDN, short name; only peers with NetBird SSH enabled appear there.
 */
export function parseNetbirdSshConfig(text: string): Peer[] {
	const peers = new Map<string, Peer>();
	for (const line of text.split("\n")) {
		const m = /^\s*Match\s+host\s+"([^"]+)"/i.exec(line);
		if (!m) continue;
		let ips: string[] = [];
		let fqdn: string | undefined;
		for (const raw of m[1].split(",")) {
			const t = raw.trim();
			if (!t) continue;
			if (isIp(t)) {
				if (fqdn) fqdn = undefined; // a name group without short name: start over
				ips.push(t);
			} else if (t.includes(".")) {
				fqdn = t;
			} else {
				const p: Peer = peers.get(t) ?? { name: t, ips: [], sshEnabled: true };
				if (fqdn && fqdn.split(".")[0] === t) p.fqdn = fqdn;
				for (const ip of ips) if (!p.ips.includes(ip)) p.ips.push(ip);
				peers.set(t, p);
				ips = [];
				fqdn = undefined;
			}
		}
	}
	return [...peers.values()];
}

/** Peers from GET /api/peers of the NetBird management API. */
export function parseApiPeers(json: unknown): Peer[] {
	if (!Array.isArray(json)) return [];
	const out: Peer[] = [];
	for (const p of json) {
		if (!p || typeof p !== "object") continue;
		const o = p as Record<string, unknown>;
		const dns = typeof o.dns_label === "string" ? o.dns_label : typeof o.name === "string" ? o.name : "";
		if (!dns) continue;
		const name = dns.split(".")[0].toLowerCase();
		const ips = [o.ip, o.ipv6].filter((x): x is string => typeof x === "string" && !!x);
		out.push({
			name,
			fqdn: dns.includes(".") ? dns : undefined,
			ips,
			sshEnabled: typeof o.ssh_enabled === "boolean" ? o.ssh_enabled : undefined,
			connected: typeof o.connected === "boolean" ? o.connected : undefined,
			os: typeof o.os === "string" ? o.os : undefined,
			lastSeen: typeof o.last_seen === "string" ? o.last_seen : undefined,
			hostname: typeof o.hostname === "string" ? o.hostname : undefined,
		});
	}
	return out;
}

/** Merge peer lists; later lists fill in fields earlier ones lack (API data wins for status fields). */
export function mergePeers(...lists: Peer[][]): Peer[] {
	const byName = new Map<string, Peer>();
	for (const list of lists) {
		for (const p of list) {
			const cur = byName.get(p.name);
			if (!cur) {
				byName.set(p.name, { ...p, ips: [...p.ips] });
				continue;
			}
			for (const ip of p.ips) if (!cur.ips.includes(ip)) cur.ips.push(ip);
			cur.fqdn ??= p.fqdn;
			if (p.sshEnabled !== undefined) cur.sshEnabled = p.sshEnabled || cur.sshEnabled === true;
			if (p.connected !== undefined) cur.connected = p.connected;
			cur.os = p.os ?? cur.os;
			cur.lastSeen = p.lastSeen ?? cur.lastSeen;
			cur.hostname = p.hostname ?? cur.hostname;
		}
	}
	return [...byName.values()];
}

function splitHostPort(s: string): { host: string; port: number } | undefined {
	const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(s.trim());
	if (!m) return undefined;
	return { host: m[1].replace(/^::ffff:/, ""), port: Number(m[2]) };
}

/** Local TCP ports in LISTEN state, from `ss -tlnH`. */
export function parseListeningPorts(ssOutput: string): Set<number> {
	const ports = new Set<number>();
	for (const line of ssOutput.split("\n")) {
		const cols = line.trim().split(/\s+/);
		// State Recv-Q Send-Q Local Peer [Process]  (with or without the State column)
		const local = cols.find((c) => /:\d+$/.test(c));
		const hp = local ? splitHostPort(local) : undefined;
		if (hp) ports.add(hp.port);
	}
	return ports;
}

/**
 * Inbound NetBird connections: established sockets whose local side is one of our NetBird
 * addresses on a listening port, and whose peer is in the NetBird range. Returns peer IP -> count.
 */
export function inboundPeers(ssEstablished: string, listening: Set<number>, localIps: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of ssEstablished.split("\n")) {
		const addrs = line
			.trim()
			.split(/\s+/)
			.map(splitHostPort)
			.filter((x): x is { host: string; port: number } => !!x);
		if (addrs.length < 2) continue;
		const [local, peer] = addrs.slice(-2);
		if (!localIps.includes(local.host) || !listening.has(local.port)) continue;
		if (!inNetbirdRange(peer.host)) continue;
		out.set(peer.host, (out.get(peer.host) ?? 0) + 1);
	}
	return out;
}

/** `getent hosts <ip>` / `getent hosts <name>` output: "100.71.171.69   sergeys-macbook-pro.netbird.cloud [aliases]". */
export function parseGetentHosts(out: string): { ip: string; names: string[] }[] {
	const res: { ip: string; names: string[] }[] = [];
	for (const line of out.split("\n")) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 2 || !isIp(cols[0])) continue;
		res.push({ ip: cols[0], names: cols.slice(1).map((n) => n.toLowerCase().replace(/\.$/, "")) });
	}
	return res;
}

/**
 * Addresses of an interface from `ip -o addr show <iface>` (one line per address:
 * `4: wt0    inet 100.71.73.147/16 scope global wt0\ ...`). Without `iface` every line counts.
 */
export function parseIpAddr(out: string, iface?: string): string[] {
	const ips: string[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*\d+:\s+([^\s:@]+)(?:@\S+)?:?\s+inet6?\s+([0-9a-fA-F.:]+)(?:\/\d+)?/.exec(line);
		if (!m || (iface && m[1] !== iface)) continue;
		if (!ips.includes(m[2])) ips.push(m[2]);
	}
	return ips;
}
