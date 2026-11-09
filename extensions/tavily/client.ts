// Tavily REST client shared by the web-* extensions: HTTP calls and small text helpers.
// No pi imports, so tests run without node_modules.

import type { Attempt } from "./keys.ts";

export const API = "https://api.tavily.com";

/** Longest server- or network-derived text kept in an error message. */
export const MAX_ERROR_CHARS = 300;
/** Largest successful response body, counted after decompression. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Error bodies are only read for a short message, so they get a much smaller budget. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface CallOptions {
	method?: "GET" | "POST";
	body?: unknown;
	signal?: AbortSignal;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
	/** Cap for a successful response body in bytes. Default MAX_RESPONSE_BYTES. */
	maxBytes?: number;
}

function errorText(data: unknown, fallback: string): string {
	const detail = (data as { detail?: unknown } | null)?.detail;
	const error = (detail as { error?: unknown } | null)?.error ?? detail;
	return typeof error === "string" && error ? error : fallback;
}

/** Shortest piece of the key that counts as an echo of it (checked on letters and digits only). */
const KEY_WINDOW = 12;

/**
 * Server- or network-derived text that is safe to show or log, or null when it must be withheld.
 * Allowlist: plain printable ASCII, no markup/entity/escape characters, no long token-like run,
 * and no trace of the key or a bearer token, however it is split. The whole text is judged and
 * only then cut. Every check is linear; nothing here tries to repair or decode the text.
 */
export function serverText(raw: string, key: string | null, max = MAX_ERROR_CHARS): string | null {
	if (/[^\x20-\x7e\t\n\r]/.test(raw) || /[<>&\\]/.test(raw) || /[A-Za-z0-9_-]{20}/.test(raw)) return null;
	const compact = raw.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
	if (compact.includes("tvly") || compact.includes("bearer")) return null;
	const own = key ? key.replace(/[^A-Za-z0-9]/g, "").toLowerCase() : "";
	if (own.length >= 8) {
		const size = Math.min(KEY_WINDOW, own.length);
		for (let i = 0; i + size <= own.length; i++) if (compact.includes(own.slice(i, i + size))) return null;
	}
	const line = raw.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max).trimEnd()}...` : line;
}

/** What a failed status means, in our own words. Used instead of server text when that is withheld. */
export function statusLabel(status: number): string {
	if (status >= 500) return "server error";
	return (
		({ 400: "bad request", 401: "invalid API key", 403: "forbidden", 429: "rate limited", 432: "plan credit limit reached", 433: "pay-as-you-go limit reached" } as Record<number, string>)[status] ??
		"HTTP error"
	);
}

/**
 * A fresh error without `cause`: fetch errors can quote the Authorization header (e.g. an invalid
 * header value), and their message or cause chain would carry the whole key.
 */
function requestFailed(path: string, key: string | null, err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	const cause = (err as { cause?: { message?: unknown } } | null)?.cause?.message;
	const detail = typeof cause === "string" && cause ? ` (${cause})` : "";
	const shown = serverText(message + detail, key);
	return new Error(`Tavily ${path}: request failed${shown === null ? " (details withheld)" : shown ? `: ${shown}` : ""}`);
}

function formatLimit(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${+(bytes / 1024 / 1024).toFixed(1)} MiB`;
	return bytes >= 1024 ? `${+(bytes / 1024).toFixed(1)} KiB` : `${bytes} bytes`;
}

/**
 * Read a body as text, at most `limit` decoded bytes (fetch has already decompressed it).
 * `truncated` means the limit was hit and the rest was dropped. With `early`, a declared
 * Content-Length over the limit gives up before reading anything. A read cut short by the
 * signal throws its reason. The stream is always cancelled or finished, and its reader released.
 */
async function readLimited(
	resp: Response,
	limit: number,
	signal: AbortSignal,
	early: boolean,
): Promise<{ text: string; truncated: boolean }> {
	if (!resp.body) return { text: "", truncated: false };
	const declared = Number(resp.headers.get("content-length"));
	if (early && Number.isFinite(declared) && declared > limit) {
		await resp.body.cancel().catch(() => {});
		return { text: "", truncated: true };
	}
	const reader = resp.body.getReader();
	const onAbort = () => void reader.cancel().catch(() => {});
	signal.addEventListener("abort", onAbort, { once: true });
	const decoder = new TextDecoder();
	let text = "";
	let total = 0;
	let finished = false;
	try {
		for (;;) {
			if (signal.aborted) throw signal.reason;
			const { done, value } = await reader.read();
			if (signal.aborted) throw signal.reason;
			if (done) break;
			if (total + value.byteLength > limit) {
				text += decoder.decode(value.subarray(0, limit - total), { stream: true });
				return { text: text + decoder.decode(), truncated: true };
			}
			total += value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
		finished = true;
		return { text: text + decoder.decode(), truncated: false };
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (!finished) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** One HTTP call with one key (or keyless when key is null). Network errors and aborts throw. */
export async function call<T = any>(path: string, key: string | null, opts: CallOptions): Promise<Attempt<T>> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (key) headers.authorization = `Bearer ${key}`;
	else headers["x-tavily-access-mode"] = "keyless";
	const timeout = AbortSignal.timeout(opts.timeoutMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	/** The same rules for the connect and the body phase. */
	const failure = (err: unknown): Error => {
		if (timeout.aborted && !opts.signal?.aborted) return new Error(`Tavily ${path}: timed out after ${opts.timeoutMs / 1000}s`);
		if (opts.signal?.aborted) return err as Error; // the caller cancelled: keep the abort semantics
		return requestFailed(path, key, err);
	};
	let resp: Response;
	let text: string;
	let truncated: boolean;
	try {
		resp = await (opts.fetchImpl ?? fetch)(`${API}${path}`, {
			method: opts.method ?? "POST",
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal,
		});
		const limit = resp.ok ? (opts.maxBytes ?? MAX_RESPONSE_BYTES) : MAX_ERROR_BODY_BYTES;
		({ text, truncated } = await readLimited(resp, limit, signal, resp.ok));
	} catch (err) {
		throw failure(err);
	}
	if (resp.ok && truncated) {
		throw new Error(
			`Tavily ${path}: response exceeds ${formatLimit(opts.maxBytes ?? MAX_RESPONSE_BYTES)}; narrow the request (fewer urls, smaller limit, or pass query/instructions for chunks)`,
		);
	}
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
	const label = statusLabel(resp.status);
	const body = errorText(data, text);
	// Without a usable body, the status line may say something; it passes the same allowlist.
	const shown = serverText(body.trim() ? body : resp.statusText, key);
	const detail = shown === null ? `${label} (server text withheld)` : shown || label;
	return {
		ok: false,
		status: resp.status,
		message: `Tavily ${path} ${resp.status}: ${detail}`,
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
