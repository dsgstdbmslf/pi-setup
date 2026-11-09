// Regression tests for the review rounds (R1-R13, S1-S3). No real network, model or agent config:
// local HTTP fixtures, mocked fetch/registry, and temp directories for the agent dir and TMPDIR.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AUTO, saveChoice } from "../extensions/web-fetch/classify.ts";
import {
	FetchError,
	MAX_PDF_TEXT_CHARS,
	MAX_REDIRECTS,
	fetchAndExtract,
	fetchDirect,
	isPrivateIP,
	parseJina,
	pdfToText,
	preview,
	privateReason,
} from "../extensions/web-fetch/logic.ts";
import { pickClassifier } from "../extensions/web-fetch/picker.ts";

const article = `<!doctype html><html><head><title>Hello page</title></head><body><article><h1>Hello page</h1>${"<p>Readable paragraph with enough words to count as content. </p>".repeat(20)}</article></body></html>`;

/** A one-page PDF; `pad` bytes of comment before the objects make it large without compression tricks. */
function makePdf(lines: string[], pad = 0): Buffer {
	const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? "0 -16 Td " : ""}(${l}) Tj`).join(" ")} ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = `%PDF-1.4\n${pad ? `%${"x".repeat(pad)}\n` : ""}`;
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

// ── Local HTTP server ───────────────────────────────────────────────

let base = "";
const hits: Record<string, number> = {};
const closed: Record<string, boolean> = {};

/** Stream `chunk` until the client goes away; records that it did. */
function endless(res: ServerResponse, name: string, type: string, chunk: Uint8Array) {
	res.writeHead(200, { "content-type": type });
	const timer = setInterval(() => res.write(chunk), 5);
	res.on("close", () => {
		clearInterval(timer);
		closed[name] = true;
	});
	res.write(chunk);
}

const server = createServer((req, res) => {
	const path = req.url ?? "";
	const name = path.split("?")[0];
	hits[name] = (hits[name] ?? 0) + 1;
	const redirect = (status: number, location: string) => {
		res.writeHead(status, { location });
		res.end();
	};
	const chain = /^\/chain\/(\d+)$/.exec(name);
	if (chain) return Number(chain[1]) ? redirect(302, `/chain/${Number(chain[1]) - 1}`) : res.end(article);
	const status = /^\/s(\d{3})$/.exec(name);
	if (status) return redirect(Number(status[1]), "/counted");
	switch (name) {
		case "/article":
			res.writeHead(200, { "content-type": "text/html" });
			return res.end(article);
		case "/counted":
			return res.end("reached");
		case "/ra": // A → B → A → 403: the second visit of A answers differently
			return hits[name] === 1 ? redirect(302, "/rb") : (res.writeHead(403), res.end("no"));
		case "/rb":
			return redirect(302, "/ra");
		case "/to-creds":
			return redirect(302, `http://user:hunter2@${req.headers.host}/counted`);
		case "/to-bad":
			return redirect(302, "http://[bad");
		case "/to-long":
			return redirect(302, `/counted?${"x".repeat(9000)}`);
		case "/bigtext":
			res.writeHead(200, { "content-type": "text/plain" });
			return res.end(Array.from({ length: 3000 }, (_, i) => `line ${i} \x1b]52;c;aGk=\x07`).join("\n"));
		case "/to-bigtext":
			return redirect(302, "/bigtext");
		case "/bom-html": // no Content-Type
			return res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(article)]));
		case "/nomime-pdf":
			return res.end(makePdf(["Big line"], 6 * 1024 * 1024));
		case "/nomime-big":
			return endless(res, name, "", Buffer.alloc(256 * 1024, "x"));
		case "/octet-text":
			return endless(res, name, "application/octet-stream", Buffer.alloc(256 * 1024, "x"));
		case "/image.pdf":
			return endless(res, name, "image/png", Buffer.alloc(256 * 1024, 1));
		default:
			res.writeHead(404);
			return res.end("nope");
	}
});
before(async () => {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const pub = async () => ["93.184.216.34"];
const ok = { url: "https://a.com/", title: "T", content: "c" };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ── R1: cancellation ────────────────────────────────────────────────

type Item = { str: string; hasEOL?: boolean };

/** A fake PDF.js document with call counters. */
function fakePdf(pages: Item[][], o: { text?: (i: number) => Promise<{ items: Item[] }>; meta?: () => Promise<unknown> } = {}) {
	const stats = { opened: 0, destroyed: 0, cleaned: 0 };
	const doc = {
		numPages: pages.length,
		getMetadata: o.meta ?? (async () => ({ info: {} })),
		getPage: async (i: number) => ({
			getTextContent: () => (o.text ? o.text(i) : Promise.resolve({ items: pages[i - 1] })),
			cleanup: () => (stats.cleaned++, true),
		}),
		loadingTask: { destroy: async () => void stats.destroyed++ },
	};
	return { stats, doc, open: async () => (stats.opened++, doc as any) };
}

test("R1: abort during a getTextContent that never settles rejects promptly, destroys the PDF once, skips Jina", async () => {
	const pdf = fakePdf([[]], { text: () => new Promise(() => {}) });
	const ac = new AbortController();
	let jina = 0;
	const t = Date.now();
	const pending = fetchAndExtract("https://a.com/x.pdf", {
		jina: true,
		signal: ac.signal,
		direct: (u, sig) => pdfToText(new Uint8Array(), u, sig, pdf.open),
		guard: async () => null,
		classify: async () => null,
		viaJina: async () => (jina++, ok),
	});
	setTimeout(() => ac.abort(), 10);
	await assert.rejects(pending, (e: Error) => e.name === "AbortError");
	assert.ok(Date.now() - t < 500);
	await tick();
	assert.equal(pdf.stats.destroyed, 1);
	assert.equal(pdf.stats.cleaned, 1);
	assert.equal(jina, 0);
});

test("R1: abort while opening or reading metadata never succeeds; a late document is destroyed", async () => {
	let arrive!: (doc: any) => void;
	const pdf = fakePdf([[{ str: "x" }]]);
	const ac = new AbortController();
	const pending = pdfToText(new Uint8Array(), "https://a.com/x.pdf", ac.signal, () => new Promise((r) => (arrive = r)));
	ac.abort();
	await assert.rejects(pending, (e: Error) => e.name === "AbortError");
	arrive(pdf.doc);
	await tick();
	assert.equal(pdf.stats.destroyed, 1);

	const stuck = fakePdf([[{ str: "x" }]], { meta: () => new Promise(() => {}) });
	const ac2 = new AbortController();
	const pending2 = pdfToText(new Uint8Array(), "https://a.com/x.pdf", ac2.signal, stuck.open);
	setTimeout(() => ac2.abort(), 5);
	await assert.rejects(pending2, (e: Error) => e.name === "AbortError");
	await tick();
	assert.equal(stuck.stats.destroyed, 1);
});

test("R1: an abort during the last page is reported even when the page returns its text", async () => {
	const ac = new AbortController();
	const pdf = fakePdf([[{ str: "one" }], [{ str: "two" }]], {
		text: async (i) => {
			if (i === 2) ac.abort();
			return { items: [{ str: `page ${i}` }] };
		},
	});
	await assert.rejects(pdfToText(new Uint8Array(), "https://a.com/x.pdf", ac.signal, pdf.open), (e: Error) => e.name === "AbortError");
	await tick();
	assert.equal(pdf.stats.destroyed, 1);

	const ac2 = new AbortController();
	let jina = 0;
	const pdf2 = fakePdf([[{ str: "one" }]], { text: async () => (ac2.abort(), { items: [{ str: "one" }] }) });
	await assert.rejects(
		fetchAndExtract("https://a.com/x.pdf", {
			jina: true,
			signal: ac2.signal,
			direct: (u, sig) => pdfToText(new Uint8Array(), u, sig, pdf2.open),
			guard: async () => null,
			classify: async () => null,
			viaJina: async () => (jina++, ok),
		}),
		(e: Error) => e.name === "AbortError",
	);
	assert.equal(jina, 0);
	// A direct fetch that ignores the signal still cannot succeed after an abort.
	const ac3 = new AbortController();
	await assert.rejects(
		fetchAndExtract("https://a.com/", { jina: false, signal: ac3.signal, direct: async () => (ac3.abort(), ok) }),
		(e: Error) => e.name === "AbortError",
	);
});

/** A fake PDF whose destroy starts, reports it, and waits for the test to settle it. */
function slowCleanupPdf() {
	const pdf = fakePdf([[{ str: "text" }]]);
	let started!: () => void;
	const cleanupStarted = new Promise<void>((r) => (started = r));
	const release = { resolve: () => {}, reject: (_: Error) => {} };
	pdf.doc.loadingTask.destroy = () => {
		pdf.stats.destroyed++;
		started();
		return new Promise<void>((res, rej) => Object.assign(release, { resolve: res, reject: rej }));
	};
	return { pdf, cleanupStarted, release };
}

const within = <T>(p: Promise<T>, ms = 500) =>
	Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("still pending")), ms))]);

test("S2: an abort during normal cleanup rejects promptly; cleanup runs once in the background", async () => {
	const { pdf, cleanupStarted, release } = slowCleanupPdf();
	const ac = new AbortController();
	let jina = 0;
	try {
		const pending = fetchAndExtract("https://a.com/x.pdf", {
			jina: true,
			signal: ac.signal,
			direct: (u, sig) => pdfToText(new Uint8Array(), u, sig, pdf.open),
			guard: async () => null,
			classify: async () => null,
			viaJina: async () => (jina++, ok),
		});
		pending.catch(() => {});
		await within(cleanupStarted);
		ac.abort();
		await assert.rejects(within(pending), (e: Error) => e.name === "AbortError");
		assert.equal(pdf.stats.destroyed, 1);
		assert.equal(jina, 0);
	} finally {
		release.resolve();
	}
	await tick();
	assert.equal(pdf.stats.destroyed, 1);
});

test("S2: without an abort cleanup is awaited; a late cleanup failure after an abort stays quiet", async () => {
	const a = slowCleanupPdf();
	let settled = false;
	try {
		const pending = pdfToText(new Uint8Array(), "u", new AbortController().signal, a.pdf.open).finally(() => (settled = true));
		await within(a.cleanupStarted);
		await tick();
		assert.equal(settled, false);
		a.release.resolve();
		assert.equal((await within(pending)).content, "Pages: 1\n\ntext");
	} finally {
		a.release.resolve();
	}

	const unhandled: unknown[] = [];
	const onUnhandled = (e: unknown) => unhandled.push(e);
	process.on("unhandledRejection", onUnhandled);
	const b = slowCleanupPdf();
	const ac = new AbortController();
	try {
		const pending = pdfToText(new Uint8Array(), "u", ac.signal, b.pdf.open);
		pending.catch(() => {});
		await within(b.cleanupStarted);
		ac.abort();
		await assert.rejects(within(pending), (e: Error) => e.name === "AbortError");
		b.release.reject(new Error("cleanup failed"));
		await tick(20);
		assert.deepEqual(unhandled, []);
		assert.equal(b.pdf.stats.destroyed, 1);
	} finally {
		b.release.resolve();
		process.off("unhandledRejection", onUnhandled);
	}
});

test("R1: an already-aborted signal starts no PDF work", async () => {
	const pdf = fakePdf([[{ str: "x" }]]);
	await assert.rejects(pdfToText(new Uint8Array(), "https://a.com/x.pdf", AbortSignal.abort(), pdf.open), (e: Error) => e.name === "AbortError");
	assert.equal(pdf.stats.opened, 0);
	let direct = 0;
	await assert.rejects(fetchAndExtract("https://a.com/", { jina: false, signal: AbortSignal.abort(), direct: async () => (direct++, ok) }));
	assert.equal(direct, 0);
});

// ── R2: PDF text budget ─────────────────────────────────────────────

function body(content: string): string {
	return content.slice(content.indexOf("\n\n") + 2);
}

test("R2: the PDF text budget holds inside a page, also on the last page", async () => {
	const one = fakePdf([[{ str: "a".repeat(2_500_000) }]]);
	const r1 = await pdfToText(new Uint8Array(), "https://a.com/x.pdf", undefined, one.open);
	assert.equal(body(r1.content).length, MAX_PDF_TEXT_CHARS);
	assert.match(r1.content, /^Pages: 1 \(text cut at 2000000 characters, on page 1\)/);
	assert.equal(one.stats.destroyed, 1);
	assert.equal(one.stats.cleaned, 1);

	const many = fakePdf([[{ str: "b".repeat(1_500_000) }], Array.from({ length: 1000 }, () => ({ str: "c".repeat(1000) }))]);
	const r2 = await pdfToText(new Uint8Array(), "https://a.com/x.pdf", undefined, many.open);
	assert.ok(body(r2.content).length <= MAX_PDF_TEXT_CHARS);
	assert.match(r2.content, /text cut at 2000000 characters, on page 2/);
	assert.equal(many.stats.cleaned, 2);
	assert.equal(many.stats.destroyed, 1);
});

test("R2: text at or below the budget is kept whole, with its line breaks", async () => {
	const exact = await pdfToText(new Uint8Array(), "u", undefined, fakePdf([[{ str: "a".repeat(MAX_PDF_TEXT_CHARS) }]]).open);
	assert.equal(exact.content, `Pages: 1\n\n${"a".repeat(MAX_PDF_TEXT_CHARS)}`);
	const below = await pdfToText(new Uint8Array(), "u", undefined, fakePdf([[{ str: "a".repeat(MAX_PDF_TEXT_CHARS - 1) }]]).open);
	assert.doesNotMatch(below.content, /cut/);
	const lines = await pdfToText(new Uint8Array(), "u", undefined, fakePdf([[{ str: "Line  one ", hasEOL: true }, { str: " Line two" }], [{ str: "Next" }]]).open);
	assert.equal(lines.content, "Pages: 2\n\nLine one\nLine two\n\nNext");
	// A cut never leaves half a surrogate pair.
	const emoji = await pdfToText(new Uint8Array(), "u", undefined, fakePdf([[{ str: `a${"😀".repeat(MAX_PDF_TEXT_CHARS)}` }]]).open);
	assert.doesNotMatch(body(emoji.content), /[\ud800-\udbff]$/);
	assert.ok(body(emoji.content).length <= MAX_PDF_TEXT_CHARS);
});

// ── S1: whitespace never costs text that fits ───────────────────────

const pdfText = (pages: Item[][]) => pdfToText(new Uint8Array(), "u", undefined, fakePdf(pages).open);

test("S1: a long whitespace run does not drop the text after it", async () => {
	const two = await pdfText([[{ str: "x".repeat(MAX_PDF_TEXT_CHARS - 20) }], [{ str: `A${" ".repeat(2000)}TAIL` }]]);
	assert.equal(two.content, `Pages: 2\n\n${"x".repeat(MAX_PDF_TEXT_CHARS - 20)}\n\nA TAIL`);
	const one = await pdfText([[{ str: `${" ".repeat(4_001_100)}IMPORTANT` }]]);
	assert.equal(one.content, "Pages: 1\n\nIMPORTANT");
});

test("S1: whitespace runs split across items normalize as if joined", async () => {
	const r = await pdfText([
		[{ str: " a " }, { str: "\t b" }, { str: "  ", hasEOL: true }, { str: " " }, { str: "\n" }, { str: " \n\n c", hasEOL: true }, { str: "d " }, { str: "  " }],
	]);
	assert.equal(r.content, "Pages: 1\n\na b\n\nc\nd");
});

test("S1: a suffix that really does not fit is cut with a note, also on the last page", async () => {
	const r = await pdfText([[{ str: "x".repeat(MAX_PDF_TEXT_CHARS - 20) }], [{ str: `A${" ".repeat(2000)}${"T".repeat(100)}` }]]);
	assert.equal(r.content, `Pages: 2 (text cut at 2000000 characters, on page 2)\n\n${"x".repeat(MAX_PDF_TEXT_CHARS - 20)}\n\nA ${"T".repeat(16)}`);
	assert.equal(body(r.content).length, MAX_PDF_TEXT_CHARS);
});

// ── R3: percent-encoded paths ───────────────────────────────────────

test("R3: percent-encoded token paths are refused like their decoded form", async () => {
	const reason = (url: string) => privateReason(url, { resolve: pub });
	assert.match((await reason("https://example.com/s/aB3dE5fG7hJ9kL1mN3pQ5rS7"))!, /token-like path/);
	assert.match((await reason("https://example.com/s/aB3%64E5fG7hJ9kL1mN3pQ5rS7"))!, /token-like path/);
	assert.match((await reason("https://example.com/s%2FaB3dE5fG7hJ9kL1mN3pQ5rS7"))!, /token-like path/);
	assert.match((await reason("https://example.com/x%5CaB3dE5fG7hJ9kL1mN3pQ5rS7"))!, /token-like path/);
	assert.match((await reason("https://example.com/a%zz/b"))!, /malformed percent-encoding/);
	assert.match((await reason("https://example.com/a%E0%A4"))!, /malformed percent-encoding/);
	assert.equal(await reason("https://ru.wikipedia.org/wiki/%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82"), null);
	assert.equal(await reason("https://example.com/docs/hello%20world"), null);
	assert.equal(await reason("https://github.com/a/b/commit/0123456789abcdef0123456789abcdef01234567"), null);
});

test("R3: an encoded token URL reaches neither the classifier nor Jina", async () => {
	let classified = 0;
	let jina = 0;
	await assert.rejects(
		fetchAndExtract("https://example.com/s/aB3%64E5fG7hJ9kL1mN3pQ5rS7", {
			jina: true,
			direct: async () => {
				throw new FetchError("HTTP 403", true, 403);
			},
			guard: (u, o) => privateReason(u, { ...o, resolve: pub }),
			classify: async () => (classified++, null),
			viaJina: async () => (jina++, ok),
		}),
		/skipped: token-like path/,
	);
	assert.equal(classified + jina, 0);
});

// ── R4: the real last hop ───────────────────────────────────────────

test("R4: a redirect chain A → B → A keeps A as its last hop", async () => {
	const A = "https://a.com/start";
	const B = "https://b.com/login";
	const guarded: string[] = [];
	let classified: string[] = [];
	let sent = "";
	const r = await fetchAndExtract(`${A}#frag`, {
		jina: true,
		direct: async () => {
			throw new FetchError("HTTP 403", true, 403, [`${A}#frag`, B, A]);
		},
		guard: async (u) => (guarded.push(u), null),
		classify: async (urls) => ((classified = urls), null),
		viaJina: async (u) => ((sent = u), { ...ok, url: u }),
	});
	assert.equal(r.via, "jina");
	assert.deepEqual(classified, [A, B, A]);
	assert.deepEqual(guarded, [A, B]);
	assert.equal(sent, A);

	// The same with a real server that answers the second visit differently.
	await assert.rejects(fetchDirect(`${base}/ra`), (e: FetchError) => e.status === 403 && e.chain?.join(" ") === `${base}/ra ${base}/rb ${base}/ra`);
});

// ── R12: redirect statuses and next-hop checks ──────────────────────

test("R12: only 301/302/303/307/308 are followed", async () => {
	for (const s of [301, 302, 303, 307, 308]) assert.equal((await fetchDirect(`${base}/s${s}`)).content, "reached", String(s));
	hits["/counted"] = 0;
	for (const s of [300, 304, 305, 306]) {
		await assert.rejects(fetchDirect(`${base}/s${s}`), (e: FetchError) => e.status === s, String(s));
	}
	assert.equal(hits["/counted"], 0);
});

test("R12: every redirect target passes the same URL checks before it is fetched", async () => {
	hits["/counted"] = 0;
	await assert.rejects(fetchDirect(`${base}/to-creds`), (e: FetchError) => !e.fallback && /credentials/.test(e.message) && !/hunter2/.test(e.message));
	await assert.rejects(fetchDirect(`${base}/to-bad`), (e: FetchError) => !e.fallback && /Invalid redirect/.test(e.message));
	await assert.rejects(fetchDirect(`${base}/to-long`), (e: FetchError) => !e.fallback && /too long/.test(e.message));
	assert.equal(hits["/counted"], 0);
	assert.equal((await fetchDirect(`${base}/chain/${MAX_REDIRECTS}`)).title, "Hello page");
	await assert.rejects(fetchDirect(`${base}/chain/${MAX_REDIRECTS + 1}`), /Too many redirects/);
});

// ── R6: content types and budgets ───────────────────────────────────

test("R6: missing-type HTML with a BOM is converted; a missing-type PDF gets the PDF budget", async () => {
	const html = await fetchDirect(`${base}/bom-html`);
	assert.equal(html.title, "Hello page");
	assert.match(html.content, /Readable paragraph/);
	assert.doesNotMatch(html.content, /<p>/);
	const pdf = await fetchDirect(`${base}/nomime-pdf`);
	assert.match(pdf.content, /^Pages: 1\n\nBig line$/);
});

test("R6: oversized generic text stops at 5MB; known and generic non-PDF binaries are refused unread", async () => {
	await assert.rejects(fetchDirect(`${base}/nomime-big`), (e: FetchError) => !e.fallback && /too large \(over 5MB\)/.test(e.message));
	for (const [path, type] of [["/image.pdf", "image/png"], ["/octet-text", "application/octet-stream"]]) {
		await assert.rejects(fetchDirect(`${base}${path}`), (e: FetchError) => !e.fallback && e.message === `Unsupported content type: ${type}`);
		for (let i = 0; i < 50 && !closed[path]; i++) await tick(10);
		assert.equal(closed[path], true, `${path} body cancelled`);
	}
});

// ── R7: Jina header ─────────────────────────────────────────────────

test("R7: the Jina header is read line by line, with every warning", () => {
	const normal = parseJina("Title: T\n\nURL Source: https://a.com/f\n\nMarkdown Content:\nbody", "https://a.com/");
	assert.deepEqual(normal, { url: "https://a.com/f", title: "T", content: "body" });
	const twoWarnings = "Title: T\nWarning: This page maybe requiring CAPTCHA\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\nbody";
	assert.throws(() => parseJina(twoWarnings, "u"), (e: FetchError) => e.status === 403);
	assert.throws(() => parseJina("Warning: Target URL returned error 404: Not Found\nMarkdown Content:\nx", "u"), (e: FetchError) => e.status === 404);
	const kept = parseJina("Title: T\nWarning: one\nWarning: two\n\nMarkdown Content:\nbody", "u");
	assert.equal(kept.content, "> Warning from r.jina.ai: one\n> Warning from r.jina.ai: two\n\nbody");
	const tricky = parseJina("Title: Why Markdown Content: matters\n\nMarkdown Content:\nreal body", "u");
	assert.equal(tricky.title, "Why Markdown Content: matters");
	assert.equal(tricky.content, "real body");
	const crlf = parseJina("Title: T\r\nURL Source: https://a.com/c\r\n\r\nMarkdown Content:\r\nline1\r\nline2", "u");
	assert.equal(crlf.url, "https://a.com/c");
	assert.equal(crlf.title, "T");
	assert.match(crlf.content, /^line1\r?\nline2$/);
	assert.throws(() => parseJina("Title: T Markdown Content: x", "u"), /unexpected response format/);
	assert.throws(() => parseJina("Title: T\n\nMarkdown Content:\nLoading...", "u"), /no readable content/);
	assert.equal(parseJina("Markdown Content:\nok", "https://a.com/page").content, "ok");
});

// ── R11: IPv4-mapped IPv6 ───────────────────────────────────────────

test("R11: IPv4-mapped IPv6 addresses get the decision of their IPv4 address in every spelling", async () => {
	for (const ip of ["::ffff:8.8.8.8", "::FFFF:8.8.8.8", "::ffff:808:808", "0:0:0:0:0:ffff:808:808", "0000:0000:0000:0000:0000:FFFF:0808:0808"])
		assert.equal(isPrivateIP(ip), false, ip);
	for (const ip of ["::ffff:10.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:7f00:1", "::FFFF:C0A8:101", "::ffff:0:0", "::ffff:a9fe:a9fe"])
		assert.equal(isPrivateIP(ip), true, ip);
	assert.equal(await privateReason("http://[::ffff:8.8.8.8]/", { resolve: pub }), null);
	assert.equal(await privateReason("http://[0:0:0:0:0:ffff:808:808]/", { resolve: pub }), null);
	assert.match((await privateReason("http://[::ffff:127.0.0.1]/", { resolve: pub }))!, /private IP/);
	assert.match((await privateReason("http://[::ffff:c0a8:101]/", { resolve: pub }))!, /private IP/);
});

// ── R13: preview ────────────────────────────────────────────────────

test("R13: preview keeps genuine U+FFFD and cuts multi-byte characters whole", () => {
	assert.equal(preview("a\uFFFDrest", 4, 100).text, "a\uFFFD");
	assert.equal(preview("aé", 2, 100).text, "a");
	assert.equal(preview("a€", 3, 100).text, "a");
	assert.equal(preview("a😀", 4, 100).text, "a");
	assert.equal(preview("a😀b", 5, 100).text, "a😀");
	const text = "aé€😀\uFFFDz".repeat(50);
	for (let max = 0; max < 120; max++) {
		const p = preview(text, max, 1000);
		assert.ok(p.shownBytes <= max, String(max));
		assert.ok(text.startsWith(p.text), String(max));
		assert.equal(Buffer.byteLength(p.text), p.shownBytes);
	}
	assert.equal(preview("abcdef", 3, 100).text, "abc");
	assert.equal(preview("a\nb\nc", 100, 2).text, "a\nb");
});

// ── R5: concurrent config saves ─────────────────────────────────────

test("R5: concurrent saves in the same millisecond all succeed and leave no temp files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "wf-r5-"));
	const file = join(dir, "web-fetch.json");
	await writeFile(file, '{"other": 1}');
	const realNow = Date.now;
	Date.now = () => 1_700_000_000_000;
	try {
		for (let round = 0; round < 5; round++) {
			const choices = Array.from({ length: 20 }, (_, i) => `p/m${i}`);
			await Promise.all(choices.map((c) => saveChoice(file, c)));
			const saved = JSON.parse(await readFile(file, "utf8"));
			assert.equal(saved.other, 1);
			assert.ok(choices.includes(saved.classifier));
			assert.deepEqual(await readdir(dir), ["web-fetch.json"]);
		}
		await saveChoice(file, AUTO);
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { other: 1 });
	} finally {
		Date.now = realNow;
	}
});

// ── R8: picker on short terminals ───────────────────────────────────

function openPicker(terminal: { rows: number }, initialQuery = "") {
	let comp: any;
	const theme: any = { fg: (_: string, s: string) => s, bold: (s: string) => s };
	const choices = [
		{ value: AUTO, kind: "auto" as const },
		...Array.from({ length: 12 }, (_, i) => ({ value: `provider-${i}/model-haiku-${i}`, kind: "chat" as const })),
	];
	const keys: Record<string, string> = { "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r", "tui.select.cancel": "\x1b" };
	const result = pickClassifier(
		{ ui: { custom: (factory: any) => new Promise((resolve) => (comp = factory({ terminal, requestRender() {} }, theme, { matches: (d: string, k: string) => keys[k] === d }, resolve))) } } as any,
		choices,
		AUTO,
		initialQuery,
	);
	return { result, comp: () => comp };
}

function assertFits(lines: string[], rows: number, width: number) {
	assert.ok(lines.length <= rows, `${lines.length} lines for ${rows} rows`);
	for (const l of lines) assert.ok(visibleWidth(l) <= width, l);
}

test("R8: the picker drops chrome to fit short terminals, keeping the input and the selection", async () => {
	for (const rows of [5, 8, 10, 15]) {
		for (const width of [12, 80]) {
			const p = openPicker({ rows }, "haiku");
			const lines: string[] = p.comp().render(width);
			assertFits(lines, rows, width);
			assert.ok(lines.some((l) => l.includes("→")), `selection shown at ${rows}x${width}`);
			if (width === 80) assert.ok(lines.some((l) => l.includes("haiku") && !l.includes("→")), "input shown");
		}
	}
	assert.equal(openPicker({ rows: 8 }).comp().render(80).length, 8);
	assertFits(openPicker({ rows: 1 }).comp().render(1), 1, 1);

	// Resize an open picker downward.
	const terminal = { rows: 40 };
	const p = openPicker(terminal);
	assert.ok(p.comp().render(80).length > 10);
	terminal.rows = 8;
	assertFits(p.comp().render(80), 8, 80);

	// No matches, then navigation and confirm still work on a short terminal.
	const q = openPicker({ rows: 8 });
	for (const ch of "zzz") q.comp().handleInput(ch);
	assert.match(q.comp().render(80).join("\n"), /No matching models/);
	for (let i = 0; i < 3; i++) q.comp().handleInput("\x7f");
	q.comp().handleInput("\x1b[B");
	q.comp().handleInput("\x1b[B");
	q.comp().handleInput("\r");
	assert.equal(await q.result, "provider-1/model-haiku-1");
});

// ── R9 / R10: the registered tool ───────────────────────────────────

const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };

/** Register the extension with a temp agent dir and TMPDIR; restores the environment afterwards. */
async function withTool(fn: (tool: any, env: { tmp: string }) => Promise<void>) {
	const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "TMPDIR", "PI_WEB_FETCH_CLASSIFIER", "PI_WEB_FETCH_JINA"].map((k) => [k, process.env[k]]));
	const root = await mkdtemp(join(tmpdir(), "wf-tool-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.TMPDIR = join(root, "tmp");
	delete process.env.PI_WEB_FETCH_CLASSIFIER;
	delete process.env.PI_WEB_FETCH_JINA;
	try {
		const { default: webFetch } = await import("../extensions/web-fetch.ts");
		let tool: any;
		webFetch({ on() {}, registerCommand() {}, registerTool: (t: any) => (tool = t) } as any);
		await fn(tool, { tmp: process.env.TMPDIR });
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** A session chat model that answers `reply` with usage. */
function ctxReplying(reply: string) {
	const registry = {
		find: () => undefined,
		findOfType: () => undefined,
		getAvailable: () => [],
		getAvailableOfType: async () => [],
		streamSimple: () => ({ result: async () => ({ stopReason: "stop", usage, content: [{ type: "text", text: reply }] }) }),
	};
	return { modelRegistry: registry, model: { provider: "p", id: "m" } };
}

/** Mock fetch: the direct request gets 403; r.jina.ai gets `jina`. Never touches the network. */
async function withFetch(jina: (signal?: AbortSignal) => Promise<Response>, fn: () => Promise<void>) {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://r.jina.ai/")) return jina(init?.signal ?? undefined);
		return new Response("blocked", { status: 403 });
	}) as typeof fetch;
	try {
		await fn();
	} finally {
		globalThis.fetch = realFetch;
	}
}

const PUBLIC_URL = "http://93.184.216.34/page";
const jinaPage = (content: string) => async () => new Response(`Title: T\n\nMarkdown Content:\n${content}`, { status: 200 });

test("R10: redirect metadata and the tool text are free of control characters, in the preview and the saved file", async () => {
	await withTool(async (tool) => {
		const r = await tool.execute("id", { url: `${base}/to-bigtext?\x1b]52;c;aGk=\x07\u202e#x` }, undefined, undefined, ctxReplying("PUBLIC"));
		const text: string = r.content[0].text;
		assert.equal(r.isError, undefined);
		assert.match(text, /Redirected from: http:\/\/127\.0\.0\.1:\d+\/to-bigtext\?/);
		assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/);
		assert.ok(r.details.fullOutputPath);
		assert.doesNotMatch(await readFile(r.details.fullOutputPath, "utf8"), /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/);
	});
});

test("R9: usage of a finished model call survives every later outcome", async () => {
	await withTool(async (tool, env) => {
		// Classifier says PUBLIC, Jina fails.
		await withFetch(async () => new Response("down", { status: 500 }), async () => {
			const r = await tool.execute("id", { url: PUBLIC_URL }, undefined, undefined, ctxReplying("PUBLIC"));
			assert.equal(r.isError, true);
			assert.match(r.content[0].text, /Jina\) failed: HTTP 500/);
			assert.deepEqual(r.usage, usage);
		});
		// Classifier refuses.
		await withFetch(jinaPage("never"), async () => {
			const r = await tool.execute("id", { url: PUBLIC_URL }, undefined, undefined, ctxReplying("PRIVATE"));
			assert.equal(r.isError, true);
			assert.match(r.content[0].text, /model judged the URL private/);
			assert.deepEqual(r.usage, usage);
		});
		// Classifier says PUBLIC, then the user aborts during Jina.
		const ac = new AbortController();
		await withFetch(async () => {
			ac.abort();
			throw ac.signal.reason;
		}, async () => {
			const r = await tool.execute("id", { url: PUBLIC_URL }, ac.signal, undefined, ctxReplying("PUBLIC"));
			assert.equal(r.isError, true);
			assert.equal(r.content[0].text, "Operation aborted");
			assert.deepEqual(r.usage, usage);
		});
		// Success.
		await withFetch(jinaPage("short body"), async () => {
			const r = await tool.execute("id", { url: PUBLIC_URL }, undefined, undefined, ctxReplying("PUBLIC"));
			assert.notEqual(r.isError, true);
			assert.match(r.content[0].text, /via r\.jina\.ai/);
			assert.deepEqual(r.usage, usage);
		});
		// Success, but the full text cannot be saved (TMPDIR is a file).
		await writeFile(env.tmp, "not a directory");
		await withFetch(jinaPage("x\n".repeat(40_000)), async () => {
			const r = await tool.execute("id", { url: PUBLIC_URL }, undefined, undefined, ctxReplying("PUBLIC"));
			assert.equal(r.isError, true);
			assert.deepEqual(r.usage, usage);
		});
	});
});

test("S3: the description is one line naming the preview and the saved extracted text", async () => {
	await withTool(async (tool) => {
		assert.doesNotMatch(tool.description, /\n/);
		assert.match(tool.description, /32KB\/1000-line preview plus a truncation note; full extracted text is saved when truncated/);
		assert.doesNotMatch(tool.description, /capped/);
	});
});

test("R9: without a model call, errors are thrown as before", async () => {
	await withTool(async (tool) => {
		await assert.rejects(tool.execute("id", { url: "file:///etc/passwd" }, undefined, undefined, ctxReplying("PUBLIC")), /Only http/);
	});
});
