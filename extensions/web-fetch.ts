// Page reading tools on Tavily: web_extract, web_map, web_crawl. Keys, failover and output
// handling live in extensions/tavily/; /search-keys comes from tavily-keys.ts.

import { type ExtensionAPI, formatSize } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { plural } from "./tavily/output.ts";
import { Depth, MAX_BYTES, Paths, createTavily } from "./tavily/tool.ts";
import { crawlBody, extractBody, formatCrawl, formatExtract, formatMap, mapBody } from "./web-fetch/fetch.ts";

export default function webFetch(pi: ExtensionAPI) {
	const { request, finish, render } = createTavily(pi);
	const capped = `Output is capped at ${formatSize(MAX_BYTES)}; the full text is then saved to a file you can read.`;

	// ---------- web_extract ----------
	pi.registerTool({
		name: "web_extract",
		label: "web_extract",
		description: `Extract clean markdown from 1-20 known URLs with Tavily (handles JavaScript-heavy pages). With query, returns only the passages most relevant to it instead of whole pages. ${capped}`,
		promptSnippet: "Extract page content from URLs (Tavily), optionally only passages relevant to a query",
		promptGuidelines: [
			"Use web_extract to read known URLs; pass query when you need specific facts, so only the relevant passages come back instead of whole pages.",
			"Use web_map to find pages on a known site and web_crawl to read many pages of one site section; keep their limit small.",
		],
		parameters: Type.Object({
			urls: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "http(s) URLs." }),
			query: Type.Optional(Type.String({ description: "What you are looking for; keeps only the relevant passages." })),
			chunks_per_source: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 5, description: "Passages per URL when query is set (about 800 chars each). Default 3." }),
			),
			depth: Type.Optional(Depth("tables, embedded content and pages basic fails on")),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const timeoutMs = params.depth === "advanced" ? 90_000 : 60_000;
			const rot = await request("/extract", extractBody(params), { keyless: true, timeoutMs, signal, ctx });
			const { text, count, failed } = formatExtract(rot.value);
			return finish(text, `${plural(count, "page")}${failed ? `, ${failed} failed` : ""}`, rot, rot.value);
		},
		...render("web_extract", (a) => (a.urls ?? []).join(" "), "Extracting…"),
	});

	// ---------- web_map / web_crawl ----------
	const siteParams = {
		url: Type.String({ description: "Root URL to start from." }),
		instructions: Type.Optional(
			Type.String({ description: 'Natural-language focus, e.g. "pages about authentication". Doubles the mapping cost.' }),
		),
		max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Link levels from the root. Default 1." })),
		select_paths: Paths('Only paths matching these regexes, e.g. ["/docs/.*"].'),
		exclude_paths: Paths("Skip paths matching these regexes."),
		allow_external: Type.Optional(Type.Boolean({ description: "Include links to other domains. Default false." })),
	};

	pi.registerTool({
		name: "web_map",
		label: "web_map",
		description: "List the URLs of a website without their content (Tavily). About 1 credit per 10 URLs.",
		promptSnippet: "List the URLs of a website (Tavily)",
		parameters: Type.Object({
			...siteParams,
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Max URLs. Default 50." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const rot = await request("/map", mapBody(params), { keyless: false, timeoutMs: 160_000, signal, ctx });
			const { text, count } = formatMap(rot.value);
			return finish(text, plural(count, "URL"), rot, rot.value);
		},
		...render("web_map", (a) => a.url, "Mapping…"),
	});

	pi.registerTool({
		name: "web_crawl",
		label: "web_crawl",
		description: `Crawl a website section and extract the markdown of its pages (Tavily). Costs about 1 credit per 10 pages found plus 1 per 5 pages extracted. ${capped}`,
		promptSnippet: "Crawl a website section and extract its pages (Tavily)",
		parameters: Type.Object({
			...siteParams,
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max pages. Default 10." })),
			chunks_per_source: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 5, description: "Passages per page when instructions is set, instead of whole pages. Default 3." }),
			),
			depth: Type.Optional(Depth("tables and embedded content")),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const rot = await request("/crawl", crawlBody(params), { keyless: false, timeoutMs: 160_000, signal, ctx });
			const { text, count } = formatCrawl(rot.value);
			return finish(text, plural(count, "page"), rot, rot.value);
		},
		...render("web_crawl", (a) => a.url, "Crawling…"),
	});
}
