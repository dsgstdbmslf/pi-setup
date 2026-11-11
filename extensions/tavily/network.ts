// How Tavily connects: the `tavily.proxy` setting and a one-line description of the route.
// No pi imports, so tests run without node_modules.

import { API } from "./client.ts";

export interface ProxySetting {
	/** true: follow pi's proxy (global dispatcher); false: connect directly. */
	proxy: boolean;
	/** Set when the value was not a boolean and the default was used. */
	invalid?: string;
}

/** `tavily.proxy` from pi's effective settings. Anything but a boolean falls back to true. */
export function parseProxySetting(settings: unknown): ProxySetting {
	const tavily = (settings as { tavily?: unknown } | null | undefined)?.tavily;
	if (tavily === undefined || tavily === null) return { proxy: true };
	if (typeof tavily !== "object" || Array.isArray(tavily)) return { proxy: true, invalid: 'tavily must be an object like { "proxy": false }' };
	const value = (tavily as { proxy?: unknown }).proxy;
	if (value === undefined) return { proxy: true };
	if (typeof value === "boolean") return { proxy: value };
	return { proxy: true, invalid: "tavily.proxy must be true or false" };
}

type Env = Record<string, string | undefined>;

const pick = (env: Env, ...names: string[]) => names.map((n) => env[n]?.trim()).find(Boolean);

/** Does NO_PROXY exclude this host? Same rules as undici: `*`, exact host or domain suffix, optional port. */
export function noProxyMatches(noProxy: string | undefined, host: string, port: number): boolean {
	for (const raw of (noProxy ?? "").split(/[\s,]+/)) {
		if (!raw) continue;
		if (raw === "*") return true;
		const m = /^(.*?)(?::(\d+))?$/.exec(raw.toLowerCase());
		const entry = (m?.[1] ?? "").replace(/^\*?\./, "");
		if (m?.[2] && Number(m[2]) !== port) continue;
		if (entry && (host === entry || host.endsWith(`.${entry}`))) return true;
	}
	return false;
}

/** Host and port of a proxy URL for display: no scheme, no userinfo, no path. */
function proxyHost(url: string): string {
	try {
		return new URL(url.includes("://") ? url : `http://${url}`).host || "proxy";
	} catch {
		return "proxy";
	}
}

/** One line for /search-keys: how requests to Tavily connect. Never shows proxy credentials. */
export function describeNetwork(proxy: boolean, env: Env, bypassed = !proxy): string {
	if (bypassed) return "direct (tavily.proxy = false)";
	const url = pick(env, "HTTPS_PROXY", "https_proxy");
	if (!url) return "direct (no proxy configured)";
	const { hostname, port } = new URL(API);
	if (noProxyMatches(pick(env, "NO_PROXY", "no_proxy"), hostname, Number(port) || 443)) return "direct (NO_PROXY)";
	const failed = proxy ? "" : "; tavily.proxy = false could not be applied";
	return `via proxy ${proxyHost(url)} (pi httpProxy/HTTPS_PROXY${failed})`;
}
