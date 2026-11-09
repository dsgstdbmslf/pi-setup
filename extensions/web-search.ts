// web_search tool on Tavily. Keys, failover and output handling live in extensions/tavily/;
// /search-keys comes from tavily-keys.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { plural } from "./tavily/output.ts";
import { Depth, Paths, StringEnum, createTavily } from "./tavily/tool.ts";
import { formatSearch, searchBody } from "./web-search/search.ts";

export default function webSearch(pi: ExtensionAPI) {
	const { request, finish, render } = createTavily(pi);

	pi.registerTool({
		name: "web_search",
		label: "web_search",
		description:
			"Search the web with Tavily. Returns title, date, URL and the most relevant excerpts of each result. Write the query like a search-engine query; quote exact phrases.",
		promptSnippet: "Search the web (Tavily): titles, URLs and relevant excerpts",
		promptGuidelines: [
			"Use web_search to find sources and current facts; the excerpts often answer the question without opening the pages.",
			"Narrow web_search with include_domains, time_range or topic instead of adding words to the query; keep max_results small.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query, under 400 characters." }),
			max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Default 5." })),
			depth: Type.Optional(Depth("more precise excerpts for hard or specific queries")),
			topic: Type.Optional(StringEnum(["general", "news", "finance"] as const, { description: "Default general." })),
			time_range: Type.Optional(
				StringEnum(["day", "week", "month", "year"] as const, { description: "Only results published or updated within this period." }),
			),
			include_domains: Paths('Only these domains, e.g. ["docs.python.org"].'),
			exclude_domains: Paths("Never these domains."),
			exact_match: Type.Optional(Type.Boolean({ description: "Only results containing the quoted phrases of query verbatim." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const rot = await request("/search", searchBody(params), { keyless: true, timeoutMs: 30_000, signal, ctx });
			const { text, count } = formatSearch(rot.value);
			return finish(text, plural(count, "result"), rot, rot.value);
		},
		...render("web_search", (a) => a.query, "Searching…"),
	});
}
