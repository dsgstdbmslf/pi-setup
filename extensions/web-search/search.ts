// web_search request body and result text. No pi imports, so tests run without node_modules.

import { compact, plain } from "../tavily/client.ts";

export interface SearchParams {
	query: string;
	max_results?: number;
	depth?: "basic" | "advanced";
	topic?: "general" | "news" | "finance";
	time_range?: "day" | "week" | "month" | "year";
	include_domains?: string[];
	exclude_domains?: string[];
	exact_match?: boolean;
}

/** Economical defaults: 5 results, basic depth (1 credit), 3 excerpts per result. */
export function searchBody(p: SearchParams) {
	return compact({
		query: p.query,
		max_results: p.max_results ?? 5,
		search_depth: p.depth ?? "basic",
		chunks_per_source: 3,
		topic: p.topic,
		time_range: p.time_range,
		include_domains: p.include_domains,
		exclude_domains: p.exclude_domains,
		exact_match: p.exact_match || undefined,
		include_published_date: true,
		include_usage: true,
	});
}

/** Tavily dates come as ISO or RFC 2822 strings; show YYYY-MM-DD or nothing. */
export function day(value: unknown): string {
	if (typeof value !== "string" || !value) return "";
	const t = Date.parse(value);
	return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
}

export function formatSearch(data: any): { text: string; count: number } {
	const results: any[] = Array.isArray(data?.results) ? data.results : [];
	if (results.length === 0) return { text: "No results.", count: 0 };
	const text = results
		.map((r, i) => {
			const date = day(r.published_date) && ` (${day(r.published_date)})`;
			return `${i + 1}. ${plain(r.title) || "Untitled"}${date}\n   ${r.url}\n   ${plain(r.content)}`;
		})
		.join("\n\n");
	return { text, count: results.length };
}
