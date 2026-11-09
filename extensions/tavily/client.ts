// Tavily REST client shared by the web-* extensions: HTTP calls and small text helpers.
// No pi imports, so tests run without node_modules.

import type { Attempt } from "./keys.ts";

export const API = "https://api.tavily.com";

export interface CallOptions {
	method?: "GET" | "POST";
	body?: unknown;
	signal?: AbortSignal;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
}

function errorText(data: unknown, fallback: string): string {
	const detail = (data as { detail?: unknown } | null)?.detail;
	const error = (detail as { error?: unknown } | null)?.error ?? detail;
	return typeof error === "string" && error ? error : fallback;
}

/** One HTTP call with one key (or keyless when key is null). Network errors and aborts throw. */
export async function call<T = any>(path: string, key: string | null, opts: CallOptions): Promise<Attempt<T>> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (key) headers.authorization = `Bearer ${key}`;
	else headers["x-tavily-access-mode"] = "keyless";
	const timeout = AbortSignal.timeout(opts.timeoutMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	let resp: Response;
	try {
		resp = await (opts.fetchImpl ?? fetch)(`${API}${path}`, {
			method: opts.method ?? "POST",
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal,
		});
	} catch (err) {
		if (timeout.aborted && !opts.signal?.aborted) throw new Error(`Tavily ${path}: timed out after ${opts.timeoutMs / 1000}s`);
		throw err;
	}
	const text = await resp.text();
	let data: unknown;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = undefined;
	}
	if (resp.ok) {
		if (data === undefined) return { ok: false, status: resp.status, message: `Tavily ${path}: invalid JSON response` };
		return { ok: true, value: data as T };
	}
	const retry = Number(resp.headers.get("retry-after"));
	return {
		ok: false,
		status: resp.status,
		message: `Tavily ${path} ${resp.status}: ${errorText(data, text.slice(0, 200) || resp.statusText)}`,
		retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
	};
}

/** Drop undefined, empty strings and empty arrays so the request stays minimal. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
		out[k] = v;
	}
	return out as Partial<T>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Snippets and titles sometimes carry HTML; reduce them to one line of plain text. */
export function plain(text: unknown): string {
	return String(text ?? "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e] ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Credits spent by a request, when the body asked for include_usage. */
export function credits(data: any): number | undefined {
	const c = data?.usage?.credits;
	return typeof c === "number" ? c : undefined;
}
