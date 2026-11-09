// Regression tests for the second review round (R1-R13). No real network, model or agent config:
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
