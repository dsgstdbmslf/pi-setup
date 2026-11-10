import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PAGE_CHARS, crawlBody, extractBody, formatCrawl, formatExtract, formatMap, mapBody } from "../extensions/web-fetch/fetch.ts";

test("extractBody: whole pages by default, chunks only with a query", () => {
	assert.deepEqual(extractBody({ urls: ["https://a"] }), {
		urls: ["https://a"],
		extract_depth: "basic",
		format: "markdown",
		include_usage: true,
	});
	const q = extractBody({ urls: ["https://a"], query: "pricing", depth: "advanced" });
	assert.equal(q.chunks_per_source, 3);
	assert.equal(q.query, "pricing");
	assert.equal(q.extract_depth, "advanced");
	assert.equal(extractBody({ urls: ["u"], query: "q", chunks_per_source: 5 }).chunks_per_source, 5);
	assert.equal(extractBody({ urls: ["u"], chunks_per_source: 5 }).chunks_per_source, undefined, "ignored without a query");
});

test("mapBody and crawlBody: small defaults, same site, empty options dropped", () => {
	assert.deepEqual(mapBody({ url: "https://x.dev", select_paths: [] }), {
		url: "https://x.dev",
		max_depth: 1,
		limit: 50,
		allow_external: false,
		include_usage: true,
	});
	const crawl = crawlBody({ url: "https://x.dev" });
	assert.equal(crawl.limit, 10);
	assert.equal(crawl.allow_external, false);
	assert.equal(crawl.chunks_per_source, undefined);
	assert.equal(crawl.extract_depth, "basic");
	assert.equal(crawl.format, "markdown");
	const focused = crawlBody({ url: "https://x.dev", instructions: "auth", limit: 3, exclude_paths: ["/blog/.*"] });
	assert.equal(focused.limit, 3);
	assert.equal(focused.chunks_per_source, 3);
	assert.deepEqual(focused.exclude_paths, ["/blog/.*"]);
});

test("formatExtract lists pages and failures", () => {
	const e = formatExtract({
		results: [
			{ url: "https://a", raw_content: "# A\n" },
			{ url: "https://c", raw_content: "" },
		],
		failed_results: [{ url: "https://b", error: "<b>404</b>" }],
	});
	assert.equal(e.text, "## https://a\n\n# A\n\n---\n\n## https://c\n\n(empty)\n\nFailed:\n- https://b: 404");
	assert.equal(e.count, 2);
	assert.equal(e.failed, 1);
	assert.deepEqual(formatExtract({}), { text: "No content extracted.", count: 0, failed: 0 });
});

test("formatMap and formatCrawl", () => {
	assert.deepEqual(formatMap({ base_url: "x.dev", results: ["https://x.dev/a", "https://x.dev/b"] }), {
		text: "2 URLs on x.dev:\nhttps://x.dev/a\nhttps://x.dev/b",
		count: 2,
	});
	assert.equal(formatMap({ results: ["https://x.dev"] }).text, "1 URL on site:\nhttps://x.dev");
	assert.deepEqual(formatMap({ results: [] }), { text: "No URLs found.", count: 0 });
	const c = formatCrawl({ base_url: "x.dev", results: [{ url: "https://x.dev/a", raw_content: "A" }] });
	assert.equal(c.text, "1 page from x.dev\n\n## https://x.dev/a\n\nA");
	assert.deepEqual(formatCrawl(undefined), { text: "No pages crawled.", count: 0 });
});

test("formatExtract and formatCrawl cut a very long page and mark it", () => {
	const marker = `\n\n[page truncated at ${MAX_PAGE_CHARS} chars]`;
	const long = "a".repeat(MAX_PAGE_CHARS + 5000);
	const e = formatExtract({ results: [{ url: "https://a", raw_content: long }, { url: "https://b", raw_content: "b".repeat(MAX_PAGE_CHARS) }] });
	assert.equal(e.text, `## https://a\n\n${"a".repeat(MAX_PAGE_CHARS)}${marker}\n\n---\n\n## https://b\n\n${"b".repeat(MAX_PAGE_CHARS)}`);
	const c = formatCrawl({ base_url: "x.dev", results: [{ url: "https://x.dev/a", raw_content: long }] });
	assert.ok(c.text.endsWith(marker));
	assert.equal(c.text.length, "1 page from x.dev\n\n## https://x.dev/a\n\n".length + MAX_PAGE_CHARS + marker.length);
	// never ends on half a surrogate pair
	const emoji = formatExtract({ results: [{ url: "u", raw_content: `${"a".repeat(MAX_PAGE_CHARS - 1)}😀😀` }] });
	assert.ok(!/[\ud800-\udbff]\n\n\[page/.test(emoji.text));
});
