// Fetch a URL like a browser and turn it into compact markdown.
// No pi imports here, so tests can run this file directly.

import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Per request (direct fetch with its redirects, or Jina). */
const TIMEOUT_MS = 30_000;
/** The whole tool call: direct fetch, privacy checks, model check and Jina. */
export const OPERATION_TIMEOUT_MS = 120_000;
const DNS_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const MAX_PDF_TEXT_CHARS = 2_000_000;
export const MAX_REDIRECTS = 10;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_CHARS = 200;
// Readability slows down sharply on deep or huge DOMs, and runs synchronously in pi.
export const MAX_HTML_ELEMENTS = 60_000;
export const MAX_HTML_DEPTH = 200;
const MIN_USEFUL_CONTENT = 500;
const JINA_READER_BASE = "https://r.jina.ai/";

export interface FetchResult {
	/** Final URL (after redirects). */
	url: string;
	title: string;
	content: string;
	/** Every URL visited, when there were redirects. */
	redirects?: string[];
}

/** A failed fetch. `fallback` says whether a reader proxy may still help. */
export class FetchError extends Error {
	readonly fallback: boolean;
	readonly status?: number;
	/** URLs visited by the direct fetch (start, redirects, final). */
	readonly chain?: string[];
	constructor(message: string, fallback: boolean, status?: number, chain?: string[]) {
		super(sanitize(message)); // messages can quote server data (status text, Location)
		this.fallback = fallback;
		this.status = status;
		this.chain = chain;
	}
}

// ── Small helpers ───────────────────────────────────────────────────

// ESC sequences (CSI, OSC, DCS/PM/APC, two-char), then C0/C1 controls except \n and \t, and bidi overrides.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[^[\]PX^_]?/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/** Make untrusted text safe to print in a terminal: no escape sequences or control characters. */
export function sanitize(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(ESCAPES, "").replace(CONTROLS, "");
}

function errorMessage(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	return (err.cause as Error | undefined)?.message || err.message;
}

/** Reject when `signal` aborts, for work that does not take a signal itself. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);
}

function cancelBody(response: Response): Promise<void> {
	return response.body?.cancel().catch(() => {}) ?? Promise.resolve();
}

/** Throws a non-fallback FetchError unless `url` is a plain http(s) URL. */
export function checkUrl(url: string): URL {
	if (url.length > MAX_URL_LENGTH) throw new FetchError(`URL too long (limit ${MAX_URL_LENGTH} characters)`, false);
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new FetchError("Invalid URL", false);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError(`Only http(s) URLs are supported, not ${u.protocol}`, false);
	if (u.username || u.password) throw new FetchError("URLs with credentials (user:pass@) are not supported", false);
	return u;
}

// ── Reading the body with a hard size limit ─────────────────────────

/** Read a response body, aborting as soon as it exceeds `maxBytes` (Content-Length may be absent or wrong). */
export async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (declared > maxBytes) {
		await cancelBody(response);
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

function latin1Head(bytes: Uint8Array, length = 2048): string {
	return new TextDecoder("latin1").decode(bytes.subarray(0, length));
}

/** Decode like a browser: BOM, then the Content-Type charset, then (for HTML) a `<meta>` charset, then UTF-8. */
export function decodeText(bytes: Uint8Array, contentType: string, html = false): string {
	let charset: string | undefined;
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
	else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
	else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
	charset ??= /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
	if (!charset && html) {
		charset = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(latin1Head(bytes))?.[1];
		// A meta tag cannot really declare UTF-16: the bytes it was read from are ASCII.
		if (charset && /^utf-16/i.test(charset)) charset = "utf-8";
	}
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

// ── Content type ────────────────────────────────────────────────────

function mimeOf(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

function isTextMime(mime: string): boolean {
	return mime.startsWith("text/") || /[/+](json|xml|javascript|ecmascript|x-javascript|yaml|x-yaml|toml|ndjson|x-ndjson|markdown|csv|x-sh|sql|graphql)$/.test(mime);
}

/** Generic types that may hide a PDF; anything else that is not text is refused. */
const GENERIC_MIME = new Set(["application/octet-stream", "binary/octet-stream", "application/download", "application/x-download", "application/force-download"]);

export function looksLikePDF(bytes: Uint8Array): boolean {
	return latin1Head(bytes, 1024).includes("%PDF-");
}

function hasPdfSuffix(url: string): boolean {
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

// ── Content extraction ──────────────────────────────────────────────

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

interface Node {
	children?: ArrayLike<Node>;
}

/** Throws when the DOM is too big or too deep to extract without stalling pi. */
function checkComplexity(root: Node): void {
	const stack: [Node, number][] = [[root, 1]];
	let count = 0;
	while (stack.length) {
		const [node, depth] = stack.pop()!;
		if (++count > MAX_HTML_ELEMENTS) throw new FetchError(`Page too large to extract (over ${MAX_HTML_ELEMENTS} elements)`, true);
		if (depth > MAX_HTML_DEPTH) throw new FetchError(`Page too deeply nested to extract (over ${MAX_HTML_DEPTH} levels)`, true);
		const kids = node.children ?? [];
		for (let i = 0; i < kids.length; i++) stack.push([kids[i], depth + 1]);
	}
}

/** Make link and image URLs absolute against the page URL (or its `<base href>`). */
function absolutizeLinks(document: Document, pageUrl: string): void {
	let base = pageUrl;
	const baseHref = document.querySelector("base[href]")?.getAttribute("href");
	if (baseHref) {
		try {
			base = new URL(baseHref, pageUrl).href;
		} catch {}
	}
	for (const [selector, attr] of [["a[href]", "href"], ["img[src]", "src"]] as const) {
		for (const el of Array.from(document.querySelectorAll(selector))) {
			const value = el.getAttribute(attr)?.trim();
			if (!value || value.startsWith("#") || /^(javascript|data|mailto|tel):/i.test(value)) continue;
			try {
				el.setAttribute(attr, new URL(value, base).href);
			} catch {}
		}
	}
}

/** HTML → markdown via Readability + Turndown. Throws FetchError when nothing readable is found. */
export function htmlToMarkdown(html: string, url: string): FetchResult {
	const { document } = parseHTML(html);
	checkComplexity(document.documentElement as unknown as Node);
	absolutizeLinks(document as unknown as Document, url);
	const article = new Readability(document as unknown as Document, { maxElemsToParse: MAX_HTML_ELEMENTS }).parse();
	const jsHint = isLikelyJSRendered(html)
		? "Page appears to be JavaScript-rendered"
		: "Could not extract readable content";
	if (!article?.content) throw new FetchError(jsHint, true);
	const content = turndown.turndown(article.content).trim();
	if (content.length < MIN_USEFUL_CONTENT && isLikelyJSRendered(html)) throw new FetchError(jsHint, true);
	if (!content) throw new FetchError(jsHint, true);
	return { url, title: article.title?.trim() || urlTitle(url), content };
}

type PdfItem = { str?: string; hasEOL?: boolean };
type PdfDoc = Awaited<ReturnType<typeof import("unpdf").getDocumentProxy>>;

function normalizeSpaces(text: string): string {
	return text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** At most `max` UTF-16 units of `text`, never ending in half a surrogate pair. */
function cutChars(text: string, max: number): string {
	const cut = text.slice(0, max);
	return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The text of one page, keeping line breaks. Stops reading items once the text cannot fit in
 * `room` characters; `cut` says whether anything was left out.
 */
function pageText(items: PdfItem[], room: number): { text: string; cut: boolean } {
	// Whitespace collapses, so the raw text may run ahead of the budget before it is normalized.
	const slack = 2 * room + 1024;
	let text = "";
	for (const item of items) {
		text += (item.str ?? "").slice(0, slack) + (item.hasEOL ? "\n" : "");
		if (text.length > slack) {
			text = normalizeSpaces(text);
			if (text.trim().length > room) break;
		}
	}
	text = normalizeSpaces(text).trim();
	return text.length > room ? { text: cutChars(text, room).trimEnd(), cut: true } : { text, cut: false };
}

/**
 * PDF → text, page by page, keeping line breaks. Destroys the PDF.js document when done, failed
 * or aborted. Cancellation is cooperative: it is checked around every PDF.js call, but PDF.js work
 * already running in this process is not interrupted.
 */
export async function pdfToText(
	bytes: Uint8Array,
	url: string,
	signal?: AbortSignal,
	open?: (bytes: Uint8Array) => Promise<PdfDoc>,
): Promise<FetchResult> {
	signal?.throwIfAborted();
	const opening = (open ?? (await import("unpdf")).getDocumentProxy)(bytes);
	let pdf: PdfDoc;
	try {
		pdf = await abortable(opening, signal);
	} catch (err) {
		// Given up on (abort): destroy the document should it still open.
		opening.then((late) => late.loadingTask.destroy()).catch(() => {});
		throw err;
	}
	let destroyed: Promise<void> | undefined;
	const destroy = () => (destroyed ??= pdf.loadingTask.destroy().catch(() => {}));
	signal?.addEventListener("abort", destroy, { once: true });
	try {
		const info = (await abortable(pdf.getMetadata(), signal)).info as Record<string, unknown> | undefined;
		const title = (typeof info?.Title === "string" && info.Title.trim()) || urlTitle(url);
		const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
		const parts: string[] = [];
		let chars = 0; // of the joined text below, page separators included
		let cut = false;
		let done = 0;
		for (let i = 1; i <= pages && !cut; i++) {
			signal?.throwIfAborted();
			const page = await abortable(pdf.getPage(i), signal);
			try {
				const items = (await abortable(page.getTextContent(), signal)).items as PdfItem[];
				const sep = parts.length ? 2 : 0;
				const r = pageText(items, Math.max(0, MAX_PDF_TEXT_CHARS - chars - sep));
				if (r.text) {
					parts.push(r.text);
					chars += sep + r.text.length;
				}
				cut = r.cut;
			} finally {
				try {
					page.cleanup();
				} catch {}
			}
			done = i;
		}
		signal?.throwIfAborted();
		const notes: string[] = [];
		if (cut) notes.push(`text cut at ${MAX_PDF_TEXT_CHARS} characters, on page ${done}`);
		else if (done < pdf.numPages) notes.push(`text of the first ${done} pages only (limit ${MAX_PDF_PAGES} pages)`);
		if (!parts.length) notes.push("no text layer found (scanned or image-only PDF?); OCR is not performed");
		const head = `Pages: ${pdf.numPages}${notes.length ? ` (${notes.join("; ")})` : ""}`;
		return { url, title, content: parts.length ? `${head}\n\n${parts.join("\n\n")}` : head };
	} finally {
		signal?.removeEventListener("abort", destroy);
		// After an abort, start the cleanup but do not wait for it.
		if (signal?.aborted) destroy();
		else await destroy();
	}
}

// ── Direct fetch ────────────────────────────────────────────────────

/**
 * Fetch with browser headers. Redirects are followed by hand (up to MAX_REDIRECTS) so every
 * hop is known: errors carry the chain, so the Jina fallback can check all of it.
 */
export async function fetchDirect(url: string, signal?: AbortSignal): Promise<FetchResult> {
	const chain = [url];
	const requestSignal = withTimeout(TIMEOUT_MS, signal);
	let status: number | undefined;
	try {
		let response: Response;
		for (;;) {
			const current = chain[chain.length - 1];
			try {
				response = await fetch(current, { headers: BROWSER_HEADERS, redirect: "manual", signal: requestSignal });
			} catch (err) {
				signal?.throwIfAborted();
				throw new FetchError(errorMessage(err), true, undefined, chain);
			}
			status = response.status;
			const location = response.headers.get("location");
			if (status < 300 || status >= 400 || status === 304 || !location) break;
			await cancelBody(response);
			if (chain.length > MAX_REDIRECTS) throw new FetchError(`Too many redirects (over ${MAX_REDIRECTS})`, false, status, chain);
			let next: URL;
			try {
				next = new URL(location, current);
			} catch {
				throw new FetchError(`Invalid redirect location: ${location}`, false, status, chain);
			}
			if (next.protocol !== "http:" && next.protocol !== "https:")
				throw new FetchError(`Redirect to unsupported ${next.protocol} URL`, false, status, chain);
			chain.push(next.href);
		}
		const result = await readResponse(response, chain, signal);
		return chain.length > 1 ? { ...result, redirects: chain } : result;
	} catch (err) {
		signal?.throwIfAborted();
		if (err instanceof FetchError) throw err.chain ? err : new FetchError(err.message, err.fallback, err.status ?? status, chain);
		// Body cut off after the headers, a parser crash, a timeout while reading: Jina may still help.
		throw new FetchError(errorMessage(err), true, status, chain);
	}
}

async function readResponse(response: Response, chain: string[], signal?: AbortSignal): Promise<FetchResult> {
	const finalUrl = chain[chain.length - 1];
	if (!response.ok) {
		await cancelBody(response);
		throw new FetchError(`HTTP ${response.status} ${response.statusText}`.trim(), true, response.status);
	}
	const contentType = response.headers.get("content-type") ?? "";
	const mime = mimeOf(contentType);
	// The declared type wins; the `.pdf` suffix and `%PDF-` magic only help for generic or missing types.
	if (mime === "application/pdf" || mime === "application/x-pdf") {
		return pdfToText(await readLimited(response, MAX_PDF_BYTES), finalUrl, signal);
	}
	const textual = !mime || isTextMime(mime);
	const maybePdf = !mime || GENERIC_MIME.has(mime) || (!textual && hasPdfSuffix(finalUrl));
	if (!textual && !maybePdf) {
		await cancelBody(response);
		throw new FetchError(`Unsupported content type: ${mime}`, false);
	}
	const bytes = await readLimited(response, maybePdf && (!textual || hasPdfSuffix(finalUrl)) ? MAX_PDF_BYTES : MAX_RESPONSE_BYTES);
	if (maybePdf && looksLikePDF(bytes)) return pdfToText(bytes, finalUrl, signal);
	if (!textual) throw new FetchError(`Unsupported content type: ${mime}`, false);
	const html = mime.includes("html") || (!mime && /^\s*<(!doctype html|html)/i.test(latin1Head(bytes, 512)));
	const text = decodeText(bytes, contentType, html);
	if (html) return htmlToMarkdown(text, finalUrl);
	return { url: finalUrl, title: headingTitle(text) ?? urlTitle(finalUrl), content: text };
}

// ── Jina Reader fallback ────────────────────────────────────────────

/** Parse r.jina.ai's text format: `Title:`, `URL Source:`, optional `Warning:`, then `Markdown Content:`. */
export function parseJina(body: string, url: string): FetchResult {
	const marker = "Markdown Content:";
	const start = body.indexOf(marker);
	if (start < 0) throw new FetchError("unexpected response format", false);
	const header = body.slice(0, start);
	const field = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(header)?.[1].trim() || undefined;
	const warning = field("Warning");
	// Jina answers 200 even when the target failed; the target status is only in the warning.
	const upstream = /returned error (\d{3})/i.exec(warning ?? "")?.[1];
	if (upstream) throw new FetchError(`target returned HTTP ${upstream}`, false, Number(upstream));
	const content = body.slice(start + marker.length).trim();
	if (!content || /^(Loading\.\.\.|Please enable JavaScript)/i.test(content)) throw new FetchError("no readable content", false);
	const source = field("URL Source");
	return {
		url: source && /^https?:\/\//i.test(source) ? source : url,
		title: field("Title") ?? headingTitle(content) ?? urlTitle(url),
		content: warning ? `> Warning from r.jina.ai: ${warning}\n\n${content}` : content,
	};
}

/** Fetch through r.jina.ai. Throws FetchError on failure; an abort propagates as is. */
export async function fetchViaJina(url: string, signal?: AbortSignal): Promise<FetchResult> {
	try {
		const res = await fetch(JINA_READER_BASE + url, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: withTimeout(TIMEOUT_MS, signal),
		});
		if (!res.ok) {
			await cancelBody(res);
			throw new FetchError(`HTTP ${res.status}`, false, res.status);
		}
		const bytes = await readLimited(res, MAX_RESPONSE_BYTES);
		return parseJina(decodeText(bytes, res.headers.get("content-type") ?? ""), url);
	} catch (err) {
		signal?.throwIfAborted();
		throw err instanceof FetchError ? err : new FetchError(errorMessage(err), false);
	}
}

// ── Privacy guard for third-party proxies ───────────────────────────

const privateV4 = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
] as const)
	privateV4.addSubnet(net, prefix, "ipv4");
// IPv6: only global unicast (2000::/3) counts as public, minus special-use and transition ranges
// (Teredo, 6to4, documentation, benchmarking...), whose real destination is not obvious.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [net, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const)
	specialV6.addSubnet(net, prefix, "ipv6");

/** True unless `ip` is a publicly routable address (fails closed for anything unusual). */
export function isPrivateIP(ip: string): boolean {
	const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
	if (v4) return privateV4.check(v4, "ipv4");
	const family = isIP(ip);
	if (family === 4) return privateV4.check(ip, "ipv4");
	if (family === 6) return !globalV6.check(ip, "ipv6") || specialV6.check(ip, "ipv6");
	return true;
}

const PRIVATE_HOST = /(^localhost$|\.(localhost|local|internal|intranet|lan|home|corp|private|home\.arpa)$)/i;
// Links on these hosts are usually personal share links: the URL itself is the key.
const SHARE_HOST =
	/(^|\.)(docs\.google\.com|drive\.google\.com|dropbox\.com|dropboxusercontent\.com|sharepoint\.com|onedrive\.live\.com|1drv\.ms|box\.com|wetransfer\.com|we\.tl)$/i;
// Parameter names are compared lowercased with separators removed: `client_secret`, `access-token`, `authToken`.
const SECRET_NAMES = new Set(
	"token auth authorization key apikey secret password passwd pwd sig signature session sessionid sid code ticket otp jwt credential credentials samlresponse samlrequest keypairid".split(" "),
);
const SECRET_NAME_PART = /^(xamz|xgoog)|(token|secret|signature|password|passwd|apikey|sessionid|credentials?)$/;

export function isSecretParam(name: string): boolean {
	const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	return SECRET_NAMES.has(n) || SECRET_NAME_PART.test(n);
}

/** Long mixed-case random strings (capability IDs, JWTs, keys). Lowercase hashes such as git SHAs do not count. */
export function isTokenLike(value: string): boolean {
	if (/eyJ[\w-]{8,}\.[\w-]{8,}\./.test(value)) return true;
	return /^[A-Za-z0-9_-]{24,}$/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

export type Resolver = (host: string, signal?: AbortSignal) => Promise<string[]>;

/**
 * Rule-based check whether a URL may be sent to a third-party reader.
 * Returns the reason it must stay local, or null when it looks public.
 * The fragment is ignored: it is never sent to Jina or the classifier.
 */
export async function privateReason(
	url: string,
	opts: { resolve?: Resolver; signal?: AbortSignal } = {},
): Promise<string | null> {
	const { resolve = defaultResolve, signal } = opts;
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
	if (SHARE_HOST.test(host)) return "file-sharing host (links are often private)";
	for (const [name, value] of u.searchParams) {
		if (isSecretParam(name)) return `secret-looking query parameter "${name}"`;
		if (isTokenLike(value)) return `token-like value in query parameter "${name}"`;
	}
	if (u.pathname.split("/").some((part) => isTokenLike(part))) return "token-like path segment";
	if (isIP(host)) return isPrivateIP(host) ? "private IP address" : null;
	if (!host.includes(".")) return "single-label host name";
	let addrs: string[];
	try {
		addrs = await resolve(host, signal);
	} catch {
		signal?.throwIfAborted();
		return "host does not resolve publicly";
	}
	if (addrs.length === 0 || addrs.some(isPrivateIP)) return "host resolves to a private address";
	return null;
}

async function defaultResolve(host: string, signal?: AbortSignal): Promise<string[]> {
	signal?.throwIfAborted();
	const found = lookup(host, { all: true, verbatim: true });
	return (await abortable(found, withTimeout(DNS_TIMEOUT_MS, signal))).map((a) => a.address);
}

// ── Orchestration ───────────────────────────────────────────────────

export interface FetchOptions {
	signal?: AbortSignal;
	/** Whether the Jina fallback is enabled at all. */
	jina: boolean;
	/**
	 * Final say on sending the URLs (a redirect chain, fragments removed) to Jina, after the
	 * rule-based guard passed. Return a reason to refuse. Without it Jina is never used.
	 */
	classify?: (urls: string[], signal: AbortSignal) => Promise<string | null>;
	direct?: typeof fetchDirect;
	viaJina?: typeof fetchViaJina;
	guard?: typeof privateReason;
}

export type FetchOutcome = FetchResult & { via: "direct" | "jina" };

function withoutHash(url: string): string {
	const u = new URL(url);
	u.hash = "";
	return u.href;
}

function clean(result: FetchResult, via: FetchOutcome["via"]): FetchOutcome {
	const title = sanitize(result.title).replace(/\s+/g, " ").trim();
	return {
		...result,
		url: sanitize(result.url),
		title: title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title || "Untitled",
		content: sanitize(result.content),
		via,
	};
}

/**
 * The deadline is cooperative: waiting on HTTP, DNS and the model stops at it, but parsing that is
 * already running in this process (HTML, PDF) finishes its current step first.
 */
export async function fetchAndExtract(url: string, opts: FetchOptions): Promise<FetchOutcome> {
	url = checkUrl(url).href;
	opts.signal?.throwIfAborted();
	const deadline = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
	const signal = AbortSignal.any([deadline, ...(opts.signal ? [opts.signal] : [])]);
	try {
		return await run(url, opts, signal);
	} catch (err) {
		opts.signal?.throwIfAborted();
		if (deadline.aborted && !(err instanceof FetchError)) throw new FetchError(`Timed out after ${OPERATION_TIMEOUT_MS / 1000}s`, false);
		throw err;
	}
}

async function run(url: string, opts: FetchOptions, signal: AbortSignal): Promise<FetchOutcome> {
	const { direct = fetchDirect, viaJina = fetchViaJina, guard = privateReason } = opts;
	let error: FetchError;
	try {
		const result = await direct(url, signal);
		signal.throwIfAborted();
		return clean(result, "direct");
	} catch (err) {
		signal.throwIfAborted();
		if (!(err instanceof FetchError)) throw err;
		error = err;
	}
	if (!error.fallback) throw error;
	// Check every hop: a harmless URL may redirect to a private host or a signed URL.
	const chain = [...new Set((error.chain?.length ? error.chain : [url]).map(withoutHash))];
	const skip = await (async () => {
		if (!opts.jina) return "disabled";
		// 401/407 mean the page needs our credentials: it is not public.
		if (error.status === 401 || error.status === 407) return "page requires authentication";
		if (!opts.classify) return "no classifier";
		for (const hop of chain) {
			const reason = await guard(hop, { signal });
			if (reason) return chain.length > 1 ? `${reason} (in redirect chain)` : reason;
		}
		signal.throwIfAborted();
		return opts.classify(chain, signal);
	})();
	signal.throwIfAborted();
	let why = `reader proxy skipped: ${skip}`;
	if (!skip) {
		try {
			// Ask for the last known hop, so Jina does not have to replay the redirects.
			const result = await viaJina(chain[chain.length - 1], signal);
			signal.throwIfAborted();
			return clean(result, "jina");
		} catch (err) {
			signal.throwIfAborted();
			if (!(err instanceof FetchError)) throw err;
			why = `reader proxy (Jina) failed: ${err.message}`;
		}
	}
	throw new FetchError(`${error.message} (${why})`, false, error.status, error.chain);
}

// ── Output for the agent ────────────────────────────────────────────

export interface Preview {
	text: string;
	truncated: boolean;
	shownBytes: number;
	totalBytes: number;
	shownLines: number;
	totalLines: number;
}

/** First `maxLines` lines, cut to `maxBytes` on a character boundary (a single long line still shows its start). */
export function preview(text: string, maxBytes: number, maxLines: number): Preview {
	const lines = text.split("\n");
	let out = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : text;
	const bytes = Buffer.from(out, "utf8");
	if (bytes.byteLength > maxBytes) out = new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/, "");
	return {
		text: out,
		truncated: out.length < text.length,
		shownBytes: Buffer.byteLength(out),
		totalBytes: Buffer.byteLength(text),
		shownLines: out.split("\n").length,
		totalLines: lines.length,
	};
}

export const SAVED_PREFIX = "pi-web-fetch-";
export const SAVED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Save the full text in a private temp dir. */
export async function saveFullText(text: string, dir = tmpdir()): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = join(await mkdtemp(join(dir, SAVED_PREFIX)), "page.md");
	await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
	return file;
}

/** Remove our own saved pages older than `maxAgeMs`. Best effort, never throws. */
export async function cleanupSaved(dir = tmpdir(), maxAgeMs = SAVED_MAX_AGE_MS, now = Date.now()): Promise<number> {
	let removed = 0;
	const names = await readdir(dir).catch(() => [] as string[]);
	for (const name of names) {
		if (!name.startsWith(SAVED_PREFIX)) continue;
		const path = join(dir, name);
		try {
			const s = await stat(path);
			if (!s.isDirectory() || (process.getuid && s.uid !== process.getuid()) || now - s.mtimeMs < maxAgeMs) continue;
			await rm(path, { recursive: true, force: true });
			removed++;
		} catch {}
	}
	return removed;
}
