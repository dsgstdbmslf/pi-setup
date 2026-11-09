import assert from "node:assert/strict";
import { test } from "node:test";
import { day, formatSearch, searchBody } from "../extensions/web-search/search.ts";

test("searchBody: economical defaults, empty options dropped", () => {
	assert.deepEqual(searchBody({ query: "x", include_domains: [], exact_match: false }), {
		query: "x",
		max_results: 5,
		search_depth: "basic",
		chunks_per_source: 3,
		include_published_date: true,
		include_usage: true,
	});
});

test("searchBody passes filters through under Tavily's names", () => {
	const body = searchBody({
		query: '"exact phrase"',
		max_results: 10,
		depth: "advanced",
		topic: "news",
		time_range: "week",
		include_domains: ["a.dev"],
		exclude_domains: ["b.dev"],
		exact_match: true,
	});
	assert.equal(body.search_depth, "advanced");
	assert.equal(body.max_results, 10);
	assert.equal(body.topic, "news");
	assert.equal(body.time_range, "week");
	assert.deepEqual(body.include_domains, ["a.dev"]);
	assert.deepEqual(body.exclude_domains, ["b.dev"]);
	assert.equal(body.exact_match, true);
});

test("day normalizes ISO and RFC 2822 dates", () => {
	assert.equal(day("2026-01-02T10:00:00Z"), "2026-01-02");
	assert.equal(day("Tue, 13 Oct 2026 10:00:00 GMT"), "2026-10-13");
	assert.equal(day("not a date"), "");
	assert.equal(day(null), "");
});

test("formatSearch produces compact numbered text", () => {
	const s = formatSearch({
		results: [
			{ title: "T", url: "https://a", content: "<p>c &amp; d</p>", published_date: "2026-01-02T00:00:00Z" },
			{ title: "", url: "https://b", content: "e" },
		],
	});
	assert.equal(s.count, 2);
	assert.equal(s.text, "1. T (2026-01-02)\n   https://a\n   c & d\n\n2. Untitled\n   https://b\n   e");
	assert.deepEqual(formatSearch({ results: [] }), { text: "No results.", count: 0 });
	assert.deepEqual(formatSearch(undefined), { text: "No results.", count: 0 });
});
