// Detects agent bash commands that reach NetBird devices directly (ssh, scp, rsync, curl...), so they
// can be redirected to the device tools. A guard rail against habits, not a sandbox. Pure, unit-tested.

import { inNetbirdRange } from "./discovery.ts";

const NET_VERBS = /(^|[\s;&|()`'"/])(ssh|scp|sftp|rsync|mosh|sshfs|telnet|nc|ncat|netcat|socat|curl|wget|git|netbird|autossh|ssh-copy-id)(?=$|[\s;&|()`'"])/;

export function mentionsNetVerb(command: string): boolean {
	return NET_VERBS.test(command);
}

export interface GuardTargets {
	/** Lower-case names, FQDNs, IPs and aliases of known devices. */
	names: Set<string>;
	/** NetBird DNS domain(s), e.g. "netbird.cloud". */
	domains: string[];
	/** Our own NetBird addresses and names (allowed: connecting to ourselves is not a device). */
	self: Set<string>;
}

/** Loopback is always "this machine", never a device. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/** The first device-like target in a network command, or undefined. */
export function deviceTargetInCommand(command: string, t: GuardTargets): string | undefined {
	if (!mentionsNetVerb(command)) return undefined;
	for (let tok of command.split(/[\s;&|()`'"=,]+/)) {
		if (!tok) continue;
		tok = tok.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // ssh://, http://
		const at = tok.lastIndexOf("@");
		if (at >= 0) tok = tok.slice(at + 1);
		tok = tok.replace(/^\[/, "");
		// host:path, host:port, [v6]:port, host/path
		let host = tok;
		if (/^[0-9a-f:]+\]/i.test(host)) host = host.replace(/\].*$/, "");
		else host = host.replace(/[:/].*$/, "");
		host = host.toLowerCase().replace(/\.$/, "");
		if (!host || t.self.has(host) || LOOPBACK.has(host)) continue;
		if (t.names.has(host)) return host;
		if (inNetbirdRange(host)) return host;
		if (t.domains.some((d) => host.endsWith(`.${d}`))) return host;
	}
	return undefined;
}
