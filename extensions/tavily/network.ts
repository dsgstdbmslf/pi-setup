// How Tavily connects: the `tavily.proxy` setting, the route pi's proxy settings give it, and the
// direct (proxy-free) agent. The undici loader is injected by tool.ts.
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

interface NoProxyEntry {
	hostname: string;
	port: number;
	wildcard: boolean;
}

/** NO_PROXY entries parsed like undici 8's EnvHttpProxyAgent (ports, `*`, `*.` and leading-dot forms, trailing dots). */
function parseNoProxy(value: string): NoProxyEntry[] {
	const out: NoProxyEntry[] = [];
	for (const entry of value.split(/[,\s]/)) {
		if (!entry) continue;
		let hostname: string;
		let port = 0;
		const v6 = entry.match(/^\[(.+)\]:(\d+)$/);
		if (v6) {
			hostname = v6[1];
			port = Number.parseInt(v6[2], 10);
		} else {
			const bare = entry.replace(/^\[(.+)\]$/, "$1");
			const parsed = (bare.match(/:/g) || []).length === 1 && bare.match(/^(.+):(\d+)$/);
			hostname = parsed ? parsed[1] : bare;
			port = parsed ? Number.parseInt(parsed[2], 10) : 0;
		}
		out.push({ hostname: hostname.replace(/^\*?\./, "").replace(/^(.+)\.$/, "$1").toLowerCase(), port, wildcard: entry.charCodeAt(0) === 42 });
	}
	return out;
}

/** Does NO_PROXY exclude this host and port? Mirrors undici's `#shouldProxy` (inverted). */
export function noProxyMatches(noProxy: string | undefined, host: string, port: number): boolean {
	let hostname = host.toLowerCase();
	if (hostname.length > 1 && hostname.endsWith(".")) hostname = hostname.slice(0, -1);
	for (const entry of parseNoProxy(noProxy ?? "")) {
		if (entry.hostname === "*") {
			if (entry.port && entry.port !== port) continue;
			return true;
		}
		if (entry.port && entry.port !== port) continue;
		if (!entry.wildcard && hostname === entry.hostname) return true;
		if (hostname.slice(-(entry.hostname.length + 1)) === `.${entry.hostname}`) return true;
	}
	return false;
}

/**
 * The proxy URL pi's global dispatcher (undici EnvHttpProxyAgent 8) uses for an https request to
 * `host`, or null for a direct connection. Lowercase variables win even when empty, https falls
 * back to the http proxy, NO_PROXY is read live. Proxy variables are read when pi starts; this
 * assumes they did not change since.
 */
export function proxyFor(env: Env, host: string, port: number): string | null {
	const chosen = (env.https_proxy ?? env.HTTPS_PROXY) || (env.http_proxy ?? env.HTTP_PROXY);
	if (!chosen) return null;
	return noProxyMatches(env.no_proxy ?? env.NO_PROXY ?? "", host, port) ? null : chosen;
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
	const { hostname, port } = new URL(API);
	const url = proxyFor(env, hostname, Number(port) || 443);
	if (url) return `via proxy ${proxyHost(url)} (pi httpProxy/HTTPS_PROXY${proxy ? "" : "; tavily.proxy = false could not be applied"})`;
	return "direct (no proxy for api.tavily.com)";
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** pi's `httpIdleTimeoutMs`: a number of ms, `"disabled"` (0) or a numeric string; anything else is the default. */
export function idleTimeoutMs(settings: unknown): number {
	let value = (settings as { httpIdleTimeoutMs?: unknown } | null | undefined)?.httpIdleTimeoutMs;
	if (typeof value === "string") value = value.trim().toLowerCase() === "disabled" ? 0 : value.trim() === "" ? undefined : Number(value);
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_IDLE_TIMEOUT_MS;
}

const noop = () => {};

/** Options of a direct Agent, matching what pi gives its global dispatcher (minus the proxy). */
export function directAgentOptions(timeoutMs: number, undici: any): Record<string, unknown> {
	// Undici can emit an internal "error" on a client that is terminating a body; pi swallows it, so do we.
	const guard = (d: any) => (typeof d?.on === "function" ? d.on("error", noop) : d);
	const clientFactory = (origin: any, options: any) => guard(new undici.Client(origin, options));
	return {
		allowH2: false,
		bodyTimeout: timeoutMs,
		headersTimeout: timeoutMs,
		connect: { autoSelectFamilyAttemptTimeout: 2000 },
		clientFactory,
		factory: (origin: any, options: any) =>
			options.connections === 1 ? clientFactory(origin, options) : guard(new undici.Pool(origin, { ...options, factory: clientFactory })),
	};
}

/** Process-wide network state: the extensions are loaded as separate modules but share one agent and one set of warnings. */
export interface NetworkState {
	agent?: { timeoutMs: number; dispatcher: any } | null;
	/** Warnings already shown in a UI. */
	notified: Set<string>;
}
const STATE = Symbol.for("pi-setup.tavily.network");
export function networkState(): NetworkState {
	const g = globalThis as { [STATE]?: NetworkState };
	return (g[STATE] ??= { notified: new Set() });
}

export interface Network {
	/** Pass to `call()`; set only to bypass the proxy. */
	dispatcher?: unknown;
	description: string;
	/** Non-fatal problems, shown on every result and status. */
	warnings: string[];
	/** The request must not be sent: `tavily.proxy = false` cannot be honoured. */
	error?: string;
}

/**
 * Settings + environment -> how to connect. `loadUndici` returns pi's undici module or throws.
 * With `tavily.proxy = false` and no undici the request fails rather than going through the
 * proxy: the user asked for it not to.
 */
export function resolveNetwork(settings: unknown, env: Env, loadUndici: () => any, state = networkState()): Network {
	const { proxy, invalid } = parseProxySetting(settings);
	const warnings = invalid ? [`${invalid}; using the default (true, follow pi's proxy)`] : [];
	if (proxy) return { description: describeNetwork(true, env), warnings };
	const timeoutMs = idleTimeoutMs(settings);
	if (state.agent === undefined || (state.agent && state.agent.timeoutMs !== timeoutMs)) {
		const old = state.agent?.dispatcher;
		try {
			const undici = loadUndici();
			const dispatcher = new undici.Agent(directAgentOptions(timeoutMs, undici));
			if (typeof dispatcher?.on === "function") dispatcher.on("error", noop);
			state.agent = { timeoutMs, dispatcher };
		} catch {
			state.agent = null;
		}
		if (old) void Promise.resolve(old.close?.()).catch(noop);
	}
	if (state.agent) return { dispatcher: state.agent.dispatcher, description: describeNetwork(false, env), warnings };
	const error = "tavily.proxy = false cannot be applied (undici is not available from pi), so Tavily is not contacted; set tavily.proxy to true to follow pi's proxy";
	return { description: "unavailable (tavily.proxy = false, undici not found)", warnings, error };
}
