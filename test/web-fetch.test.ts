import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO, classifyUrl, findModel, listChoices, loadChoice, resolveChoice, saveChoice } from "../extensions/web-fetch/classify.ts";
import {
	FetchError,
	MAX_RESPONSE_BYTES,
	decodeText,
	fetchAndExtract,
	fetchDirect,
	htmlToMarkdown,
	isPrivateIP,
	privateReason,
	readLimited,
} from "../extensions/web-fetch/logic.ts";

const article = `<!doctype html><html><head><title>Hello page</title></head><body>
<nav>menu menu menu</nav><article><h1>Hello page</h1>${"<p>Readable paragraph with enough words to count as content. </p>".repeat(20)}
<pre><code>const x = 1;</code></pre></article></body></html>`;

// ── Local HTTP server ───────────────────────────────────────────────

let base = "";
const seen: Record<string, string | undefined> = {};
const server = createServer((req, res) => {
	seen.ua = req.headers["user-agent"];
	if (req.url === "/article") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(article);
	} else if (req.url === "/big") {
		// Chunked, no Content-Length: the limit must still apply.
		res.writeHead(200, { "content-type": "text/plain" });
		const chunk = "x".repeat(1024 * 1024);
		for (let i = 0; i < 6; i++) res.write(chunk);
		res.end();
	} else if (req.url === "/text") {
		res.writeHead(200, { "content-type": "text/markdown" });
		res.end("# Notes\n\nplain");
	} else if (req.url === "/image") {
		res.writeHead(200, { "content-type": "image/png" });
		res.end("png");
	} else {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("nope");
	}
});
before(async () => {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("fetchDirect extracts an article as markdown with browser headers", async () => {
	const r = await fetchDirect(`${base}/article`);
	assert.equal(r.title, "Hello page");
	assert.match(r.content, /Readable paragraph/);
	assert.match(r.content, /```\nconst x = 1;\n```/);
	assert.doesNotMatch(r.content, /menu menu/);
	assert.match(seen.ua ?? "", /Chrome/);
});

test("fetchDirect enforces the size limit without Content-Length", async () => {
	await assert.rejects(fetchDirect(`${base}/big`), (e: FetchError) => e.fallback === false && /too large/.test(e.message));
	assert.ok(MAX_RESPONSE_BYTES < 6 * 1024 * 1024);
});

test("fetchDirect passes text through and rejects binaries and HTTP errors", async () => {
	assert.deepEqual(await fetchDirect(`${base}/text`), { url: `${base}/text`, title: "Notes", content: "# Notes\n\nplain" });
	await assert.rejects(fetchDirect(`${base}/image`), (e: FetchError) => !e.fallback && /image\/png/.test(e.message));
	await assert.rejects(fetchDirect(`${base}/missing`), (e: FetchError) => e.fallback && e.status === 404);
});

// ── Helpers ─────────────────────────────────────────────────────────

test("readLimited rejects a declared oversize body early", async () => {
	const res = new Response("abc", { headers: { "content-length": "999999" } });
	await assert.rejects(readLimited(res, 10), /too large/);
	assert.equal(new TextDecoder().decode(await readLimited(new Response("abc"), 10)), "abc");
});

test("decodeText honours the charset", () => {
	assert.equal(decodeText(new Uint8Array([0xcf, 0xf0, 0xe8]), "text/html; charset=windows-1251"), "При");
	assert.equal(decodeText(new TextEncoder().encode("ok"), "text/html; charset=bogus"), "ok");
});

test("htmlToMarkdown drops link titles and in-page anchors", () => {
	const html = `<html><body><article>${"<p>Some long enough text here. </p>".repeat(30)}<p><a href="https://x.org/A_(b)" title="A (b)">A</a> and note<a href="#cite-1">[1]</a></p></article></body></html>`;
	const md = htmlToMarkdown(html, "https://a.com/").content;
	assert.match(md, /\[A\]\(https:\/\/x\.org\/A_\\\(b\\\)\) and note\\\[1\\\]/);
	assert.doesNotMatch(md, /#cite|"A \(b\)"/);
});

test("htmlToMarkdown flags JS-rendered shells", () => {
	const shell = `<html><body><div id="root"></div>${"<script>x</script>".repeat(5)}</body></html>`;
	assert.throws(() => htmlToMarkdown(shell, "https://a.com/"), (e: FetchError) => e.fallback && /JavaScript/.test(e.message));
});

// ── Privacy guard ───────────────────────────────────────────────────

test("isPrivateIP", () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
		assert.equal(isPrivateIP(ip), true, ip);
	for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "172.32.0.1"]) assert.equal(isPrivateIP(ip), false, ip);
});

test("privateReason", async () => {
	const pub = async () => ["93.184.216.34"];
	assert.equal(await privateReason("https://example.com/a?page=2", pub), null);
	assert.match((await privateReason("http://localhost:3000/", pub))!, /private host/);
	assert.match((await privateReason("http://grafana.corp/", pub))!, /private host/);
	assert.match((await privateReason("http://intranet/", pub))!, /single-label/);
	assert.match((await privateReason("http://10.0.0.5/", pub))!, /private IP/);
	assert.match((await privateReason("https://u:p@example.com/", pub))!, /credentials/);
	assert.match((await privateReason("https://example.com/?token=abc", pub))!, /token/);
	assert.match((await privateReason("https://b.s3.amazonaws.com/f?X-Amz-Signature=1", pub))!, /X-Amz/);
	assert.match((await privateReason("https://example.com/", async () => ["10.0.0.1"]))!, /resolves to a private/);
	assert.match((await privateReason("https://nx.example/", async () => { throw new Error("ENOTFOUND"); }))!, /does not resolve/);
	assert.match((await privateReason("ftp://example.com/", pub))!, /ftp/);
});

// ── Orchestration ───────────────────────────────────────────────────

const ok = { url: "https://a.com/", title: "T", content: "c" };
const fail = (status?: number, fallback = true) => async () => {
	throw new FetchError("HTTP x", fallback, status);
};

test("fetchAndExtract: direct success never touches Jina", async () => {
	let jina = 0;
	const r = await fetchAndExtract("https://a.com/", { jina: true, direct: async () => ok, viaJina: async () => (jina++, ok) });
	assert.equal(r.via, "direct");
	assert.equal(jina, 0);
});

test("fetchAndExtract: guard and classifier must both pass before Jina", async () => {
	const calls: string[] = [];
	const opts = {
		jina: true,
		direct: fail(403),
		viaJina: async () => (calls.push("jina"), ok),
		guard: async () => (calls.push("guard"), null),
		classify: async () => (calls.push("classify"), null),
	};
	assert.equal((await fetchAndExtract("https://a.com/", opts)).via, "jina");
	assert.deepEqual(calls, ["guard", "classify", "jina"]);

	calls.length = 0;
	await assert.rejects(fetchAndExtract("https://a.com/", { ...opts, guard: async () => (calls.push("guard"), "private IP address") }), /skipped: private IP/);
	assert.deepEqual(calls, ["guard"]);

	calls.length = 0;
	await assert.rejects(fetchAndExtract("https://a.com/", { ...opts, classify: async () => "classifier judged the URL private" }), /skipped: classifier judged/);
	assert.deepEqual(calls, ["guard"]);
});

test("fetchAndExtract: no Jina for 401, non-fallback errors, or when disabled", async () => {
	let jina = 0;
	const viaJina = async () => (jina++, ok);
	const guard = async () => null;
	await assert.rejects(fetchAndExtract("https://a.com/", { jina: true, direct: fail(401), viaJina, guard }), /requires authentication/);
	await assert.rejects(fetchAndExtract("https://a.com/", { jina: true, direct: fail(undefined, false), viaJina, guard }), /HTTP x/);
	await assert.rejects(fetchAndExtract("https://a.com/", { jina: false, direct: fail(500), viaJina, guard }), /skipped: disabled/);
	await assert.rejects(fetchAndExtract("not a url", { jina: true }), /Invalid URL/);
	assert.equal(jina, 0);
});

// ── Classifier ──────────────────────────────────────────────────────

function fakeRegistry(o: { classifiers?: any[]; chats?: any[]; probability?: number; reply?: string; throws?: boolean }) {
	const used: string[] = [];
	return {
		used,
		find: (p: string, id: string) => (o.chats ?? [{ provider: p, id }]).find((m) => m.provider === p && m.id === id),
		findOfType: (_t: string, p: string, id: string) => (o.classifiers ?? []).find((m) => m.provider === p && m.id === id),
		getAvailable: () => o.chats ?? [],
		getAvailableOfType: async () => o.classifiers ?? [],
		classify: async (m: any) => (used.push(`classifier:${m.id}`), { stopReason: "stop", answers: { private: { type: "bool", probability: o.probability ?? 0 } } }),
		complete: async (m: any) => {
			used.push(`chat:${m.id}`);
			if (o.throws) throw new Error("boom");
			return { stopReason: "stop", content: [{ type: "text", text: o.reply ?? "" }] };
		},
	} as any;
}
const chat = { provider: "anthropic", id: "x" } as any;

test("classifyUrl uses a classifier model when available", async () => {
	assert.equal(await classifyUrl(fakeRegistry({ classifiers: [{}], probability: 0.1 }), chat, "https://a.com"), null);
	assert.match((await classifyUrl(fakeRegistry({ classifiers: [{}], probability: 0.9 }), chat, "https://a.com"))!, /private/);
});

test("classifyUrl falls back to the chat model and fails closed", async () => {
	assert.equal(await classifyUrl(fakeRegistry({ reply: "PUBLIC" }), chat, "https://a.com"), null);
	assert.match((await classifyUrl(fakeRegistry({ reply: "PRIVATE" }), chat, "https://a.com"))!, /private/);
	assert.match((await classifyUrl(fakeRegistry({ reply: "dunno" }), chat, "https://a.com"))!, /no clear answer/);
	assert.match((await classifyUrl(fakeRegistry({ throws: true }), chat, "https://a.com"))!, /failed: boom/);
	assert.match((await classifyUrl(fakeRegistry({}), undefined, "https://a.com"))!, /no model/);
});

test("classifyUrl honours an explicit model choice", async () => {
	const reg = fakeRegistry({
		classifiers: [{ provider: "typesafe", id: "jev" }],
		chats: [{ provider: "anthropic", id: "haiku" }],
		reply: "PUBLIC",
	});
	assert.equal(await classifyUrl(reg, chat, "https://a.com", undefined, "anthropic/haiku"), null);
	assert.equal(await classifyUrl(reg, chat, "https://a.com", undefined, "typesafe/jev"), null);
	assert.match((await classifyUrl(reg, chat, "https://a.com", undefined, "nope/x"))!, /not found/);
	assert.deepEqual(reg.used, ["chat:haiku", "classifier:jev"]);
});

test("findModel and listChoices", async () => {
	const reg = fakeRegistry({ classifiers: [{ provider: "typesafe", id: "jev" }], chats: [{ provider: "anthropic", id: "haiku" }] });
	assert.equal(findModel(reg, "typesafe/jev")?.kind, "classifier");
	assert.equal(findModel(reg, "anthropic/haiku")?.kind, "chat");
	assert.equal(findModel(reg, "anthropic/missing"), undefined);
	assert.deepEqual((await listChoices(reg)).map((c) => c.value), [AUTO, "typesafe/jev", "anthropic/haiku"]);
});

test("model choice: env > config file > auto", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "wf-")), "sub", "web-fetch.json");
	assert.deepEqual(await resolveChoice(file, undefined), { choice: AUTO, from: "default" });
	await saveChoice(file, "anthropic/haiku");
	assert.equal(await loadChoice(file), "anthropic/haiku");
	assert.deepEqual(await resolveChoice(file, ""), { choice: "anthropic/haiku", from: "config" });
	assert.deepEqual(await resolveChoice(file, "openai/x"), { choice: "openai/x", from: "env" });
	await saveChoice(file, AUTO);
	assert.equal(await readFile(file, "utf8"), "{}\n");
	assert.equal(await loadChoice(file), AUTO);
});

test("filterChoices fuzzy-matches like /model", async () => {
	const { filterChoices } = await import("../extensions/web-fetch/picker.ts");
	const choices = [
		{ value: AUTO, kind: "auto" as const },
		{ value: "anthropic/claude-haiku-4-5", kind: "chat" as const, name: "Claude Haiku 4.5" },
		{ value: "anthropic/claude-sonnet-5-5", kind: "chat" as const },
		{ value: "typesafe/jev-latest", kind: "classifier" as const },
	];
	assert.equal(filterChoices(choices, "").length, 4);
	assert.equal(filterChoices(choices, "haik")[0].value, "anthropic/claude-haiku-4-5");
	assert.equal(filterChoices(choices, "anth son")[0].value, "anthropic/claude-sonnet-5-5");
	assert.deepEqual(filterChoices(choices, "classif").map((c) => c.value), ["typesafe/jev-latest"]);
	assert.deepEqual(filterChoices(choices, "zzz"), []);
});
