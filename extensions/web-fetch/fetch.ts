// web_extract, web_map and web_crawl request bodies and result text.
// No pi imports, so tests run without node_modules.

import { compact, plain } from "../tavily/client.ts";
import { plural } from "../tavily/output.ts";

export interface ExtractParams {
	urls: string[];
	query?: string;
	chunks_per_source?: number;
	depth?: "basic" | "advanced";
}

export function extractBody(p: ExtractParams) {
	return compact({
		urls: p.urls,
		query: p.query,
		// Chunks only apply with a query; without one Tavily returns the whole page.
		chunks_per_source: p.query ? (p.chunks_per_source ?? 3) : undefined,
		extract_depth: p.depth ?? "basic",
		format: "markdown",
		include_usage: true,
	});
}

export interface SiteParams {
	url: string;
	instructions?: string;
	max_depth?: number;
	limit?: number;
	select_paths?: string[];
	exclude_paths?: string[];
	allow_external?: boolean;
}

export function mapBody(p: SiteParams) {
	return compact({
		url: p.url,
		instructions: p.instructions,
		max_depth: p.max_depth ?? 1,
		limit: p.limit ?? 50,
		select_paths: p.select_paths,
		exclude_paths: p.exclude_paths,
		allow_external: p.allow_external ?? false,
		include_usage: true,
	});
}

export interface CrawlParams extends SiteParams {
	depth?: "basic" | "advanced";
	chunks_per_source?: number;
}

export function crawlBody(p: CrawlParams) {
	return compact({
		...mapBody({ ...p, limit: p.limit ?? 10 }),
		// As with extract: chunks only make sense with instructions to rank them by.
		chunks_per_source: p.instructions ? (p.chunks_per_source ?? 3) : undefined,
		extract_depth: p.depth ?? "basic",
		format: "markdown",
	});
}

function failures(data: any): string {
	const failed: any[] = Array.isArray(data?.failed_results) ? data.failed_results : [];
	return failed.length ? `\n\nFailed:\n${failed.map((f) => `- ${f.url}: ${plain(f.error) || "error"}`).join("\n")}` : "";
}

function pages(results: any[]): string {
	return results.map((r) => `## ${r.url}\n\n${String(r.raw_content ?? "").trim() || "(empty)"}`).join("\n\n---\n\n");
}

export function formatExtract(data: any): { text: string; count: number; failed: number } {
	const results: any[] = Array.isArray(data?.results) ? data.results : [];
	const failed = Array.isArray(data?.failed_results) ? data.failed_results.length : 0;
	const body = results.length ? pages(results) : "No content extracted.";
	return { text: body + failures(data), count: results.length, failed };
}

export function formatMap(data: any): { text: string; count: number } {
	const urls: string[] = Array.isArray(data?.results) ? data.results.map(String) : [];
	if (urls.length === 0) return { text: "No URLs found.", count: 0 };
	return { text: `${plural(urls.length, "URL")} on ${data.base_url ?? "site"}:\n${urls.join("\n")}`, count: urls.length };
}

export function formatCrawl(data: any): { text: string; count: number } {
	const results: any[] = Array.isArray(data?.results) ? data.results : [];
	if (results.length === 0) return { text: "No pages crawled.", count: 0 };
	return { text: `${plural(results.length, "page")} from ${data.base_url ?? "site"}\n\n${pages(results)}`, count: results.length };
}
