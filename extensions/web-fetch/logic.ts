// Fetch a URL like a browser and turn it into compact markdown.
// No pi imports here, so tests can run this file directly.

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
export const BROWSER_HEADERS: Record<string, string> = {
	"User-Agent": USER_AGENT,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "no-cache",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
};

const TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MIN_USEFUL_CONTENT = 500;
const JINA_READER_BASE = "https://r.jina.ai/";

export interface FetchResult {
	url: string;
	title: string;
	content: string;
}

/** A failed fetch. `fallback` says whether a reader proxy may still help. */
export class FetchError extends Error {
	readonly fallback: boolean;
	readonly status?: number;
	constructor(message: string, fallback: boolean, status?: number) {
		super(message);
		this.fallback = fallback;
		this.status = status;
	}
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
// Token savers: no link titles (they repeat the text), in-page anchors become plain text.
turndown.addRule("compactLinks", {
	filter: (node) => node.nodeName === "A" && !!node.getAttribute("href"),
	replacement: (text, node) => {
		const href = (node as HTMLElement).getAttribute("href") ?? "";
		if (!text.trim()) return "";
		return href.startsWith("#") || href.startsWith("javascript:") ? text : `[${text}](${href.replace(/[()]/g, "\\$&")})`;
	},
});

// ── Reading the body with a hard size limit ─────────────────────────

/** Read a response body, aborting as soon as it exceeds `maxBytes` (Content-Length may be absent or wrong). */
export async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new FetchError(`Response too large (${formatMB(declared)}, limit ${formatMB(maxBytes)})`, false);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new FetchError(`Response too large (over ${formatMB(maxBytes)})`, false);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let pos = 0;
	for (const c of chunks) {
		out.set(c, pos);
		pos += c.byteLength;
	}
	return out;
}

function formatMB(bytes: number): string {
	return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
}

/** Decode using the charset from Content-Type, falling back to UTF-8. */
export function decodeText(bytes: Uint8Array, contentType: string): string {
	const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

// ── Content extraction ──────────────────────────────────────────────

export function isPDF(url: string, contentType: string): boolean {
	if (contentType.includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

function isBinary(contentType: string): boolean {
	return /^(image|audio|video|font)\/|application\/(octet-stream|zip|gzip|x-tar|x-7z)/.test(contentType);
}

export function isLikelyJSRendered(html: string): boolean {
	const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
	if (body === undefined) return false;
	const text = body
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length < 500 && (html.match(/<script/gi) ?? []).length > 3;
}

export function headingTitle(text: string): string | null {
	return /^#{1,2}\s+(.+)/m.exec(text)?.[1].replace(/\*+/g, "").trim() || null;
}

function urlTitle(url: string): string {
	try {
		return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "") || url;
	} catch {
		return url;
	}
}

/** HTML → markdown via Readability + Turndown. Throws FetchError when nothing readable is found. */
export function htmlToMarkdown(html: string, url: string): FetchResult {
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as Document).parse();
	const jsHint = isLikelyJSRendered(html)
		? "Page appears to be JavaScript-rendered"
		: "Could not extract readable content";
	if (!article?.content) throw new FetchError(jsHint, true);
	const content = turndown.turndown(article.content).trim();
	if (content.length < MIN_USEFUL_CONTENT && isLikelyJSRendered(html)) throw new FetchError(jsHint, true);
	if (!content) throw new FetchError(jsHint, true);
	return { url, title: article.title?.trim() || urlTitle(url), content };
}

async function pdfToText(bytes: Uint8Array, url: string): Promise<FetchResult> {
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(bytes);
	const info = (await pdf.getMetadata()).info as Record<string, unknown> | undefined;
	const title = (typeof info?.Title === "string" && info.Title.trim()) || urlTitle(url);
	const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
	const parts: string[] = [];
	for (let i = 1; i <= pages; i++) {
		const text = (await (await pdf.getPage(i)).getTextContent()).items
			.map((item) => (item as { str?: string }).str ?? "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) parts.push(text);
	}
	const note = pdf.numPages > pages ? ` (first ${pages} extracted)` : "";
	return { url, title, content: `Pages: ${pdf.numPages}${note}\n\n${parts.join("\n\n")}` };
}

// ── Direct fetch ────────────────────────────────────────────────────

function timeoutSignal(signal?: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
}

export async function fetchDirect(url: string, signal?: AbortSignal): Promise<FetchResult> {
	let response: Response;
	try {
		response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: timeoutSignal(signal) });
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new FetchError(err instanceof Error ? (err.cause as Error)?.message || err.message : String(err), true);
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new FetchError(`HTTP ${response.status} ${response.statusText}`.trim(), true, response.status);
	}
	const finalUrl = response.url || url;
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	if (isPDF(finalUrl, contentType)) return pdfToText(await readLimited(response, MAX_PDF_BYTES), finalUrl);
	if (isBinary(contentType)) {
		await response.body?.cancel().catch(() => {});
		throw new FetchError(`Unsupported content type: ${contentType.split(";")[0]}`, false);
	}
	const text = decodeText(await readLimited(response, MAX_RESPONSE_BYTES), contentType);
	if (contentType.includes("html") || (!contentType && /^\s*<(!doctype html|html)/i.test(text))) {
		return htmlToMarkdown(text, finalUrl);
	}
	return { url: finalUrl, title: headingTitle(text) ?? urlTitle(finalUrl), content: text };
}

// ── Jina Reader fallback ────────────────────────────────────────────

export async function fetchViaJina(url: string, signal?: AbortSignal): Promise<FetchResult | null> {
	try {
		const res = await fetch(JINA_READER_BASE + url, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: timeoutSignal(signal),
		});
		if (!res.ok) return null;
		const body = decodeText(await readLimited(res, MAX_RESPONSE_BYTES), "");
		const start = body.indexOf("Markdown Content:");
		if (start < 0) return null;
		const content = body.slice(start + "Markdown Content:".length).trim();
		if (content.length < 100 || /^(Loading\.\.\.|Please enable JavaScript)/.test(content)) return null;
		return { url, title: headingTitle(content) ?? urlTitle(url), content };
	} catch {
		return null;
	}
}

// ── Privacy guard for third-party proxies ───────────────────────────

const privateNets = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 3],
] as const)
	privateNets.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 127],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	privateNets.addSubnet(net, prefix, "ipv6");

export function isPrivateIP(ip: string): boolean {
	const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
	if (v4) return privateNets.check(v4, "ipv4");
	const family = isIP(ip);
	if (family === 0) return false;
	return privateNets.check(ip, family === 6 ? "ipv6" : "ipv4");
}

const PRIVATE_HOST = /(^localhost$|\.(localhost|local|internal|intranet|lan|home|corp|private|home\.arpa)$)/i;
const SECRET_PARAM =
	/^(x-amz-|x-goog-)|^(token|access_token|id_token|refresh_token|auth|authorization|key|api_?key|apikey|secret|password|passwd|pwd|sig|signature|session|sessionid|sid|code|ticket|otp|jwt|credential)$/i;

/**
 * Rule-based check whether a URL may be sent to a third-party reader.
 * Returns the reason it must stay local, or null when it looks public.
 */
export async function privateReason(
	url: string,
	resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<string | null> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return "invalid URL";
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol} URL`;
	if (u.username || u.password) return "URL contains credentials";
	const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (PRIVATE_HOST.test(host)) return "private host name";
	if (isIP(host)) {
		if (isPrivateIP(host)) return "private IP address";
	} else {
		if (!host.includes(".")) return "single-label host name";
		let addrs: string[];
		try {
			addrs = await resolve(host);
		} catch {
			return "host does not resolve publicly";
		}
		if (addrs.length === 0 || addrs.some(isPrivateIP)) return "host resolves to a private address";
	}
	for (const name of u.searchParams.keys()) {
		if (SECRET_PARAM.test(name)) return `secret-looking query parameter "${name}"`;
	}
	return null;
}

async function defaultResolve(host: string): Promise<string[]> {
	return (await lookup(host, { all: true })).map((a) => a.address);
}

// ── Orchestration ───────────────────────────────────────────────────

export interface FetchOptions {
	signal?: AbortSignal;
	/** Whether the Jina fallback is enabled at all. */
	jina: boolean;
	/** Final say on sending the URL to Jina, after the rule-based guard passed. Return a reason to refuse. */
	classify?: (url: string) => Promise<string | null>;
	direct?: typeof fetchDirect;
	viaJina?: typeof fetchViaJina;
	guard?: typeof privateReason;
}

export async function fetchAndExtract(url: string, opts: FetchOptions): Promise<FetchResult & { via: "direct" | "jina" }> {
	try {
		new URL(url);
	} catch {
		throw new FetchError("Invalid URL", false);
	}
	const { direct = fetchDirect, viaJina = fetchViaJina, guard = privateReason } = opts;
	let error: FetchError;
	try {
		return { ...(await direct(url, opts.signal)), via: "direct" };
	} catch (err) {
		if (!(err instanceof FetchError)) throw err;
		error = err;
	}
	if (!error.fallback) throw error;
	const skip = await (async () => {
		if (!opts.jina) return "disabled";
		// 401/407 mean the page needs our credentials: it is not public.
		if (error.status === 401 || error.status === 407) return "page requires authentication";
		return (await guard(url)) ?? (opts.classify ? await opts.classify(url) : null);
	})();
	if (opts.signal?.aborted) throw new Error("Aborted");
	if (!skip) {
		const result = await viaJina(url, opts.signal);
		if (result) return { ...result, via: "jina" };
	}
	const why = skip ? `reader proxy skipped: ${skip}` : "reader proxy (Jina) failed too";
	throw new FetchError(`${error.message} (${why})`, false, error.status);
}
