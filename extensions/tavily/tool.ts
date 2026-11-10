// Tool kit shared by the web-* extensions: key pool, requests with failover, result
// truncation and rendering. Not an extension itself: pi loads only extensions/*.ts.

import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	getAgentDir,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { call, credits } from "./client.ts";
import { KEYS_FILE, KeyPool, STATE_DIR, type RotationResult, withRotation } from "./keys.ts";
import { cleanupSaved, sanitize, saveFull } from "./output.ts";

// Output cap for the agent's context (~8k tokens). The full text goes to a temp file.
export const MAX_BYTES = 32 * 1024;
export const MAX_LINES = 1000;

export interface Details {
	summary: string;
	via: string;
	credits?: number;
	notes: string[];
	fullOutputPath?: string;
}

/** Plain `{ type: "string", enum }` schema: every provider accepts it (anyOf is not always supported). */
export const StringEnum = <T extends readonly string[]>(values: T, opts: { description: string }) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...opts });
export const Depth = (what: string) =>
	StringEnum(["basic", "advanced"] as const, { description: `Default basic. advanced: ${what}; costs 2x credits.` });
export const Paths = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));

/** The Tavily key pool in ~/.pi/agent. Rate-limit marks are shared by all pools of a service. */
export function tavilyPool(): KeyPool {
	const agentDir = getAgentDir();
	return new KeyPool("tavily", join(agentDir, KEYS_FILE), join(agentDir, STATE_DIR));
}

export interface RequestOptions {
	/** Fall back to Tavily's keyless mode when no key works (search and extract only). */
	keyless: boolean;
	timeoutMs: number;
	/** Response body cap in bytes; default MAX_RESPONSE_BYTES. */
	maxBytes?: number;
	signal?: AbortSignal;
	ctx: ExtensionContext;
}

/** Everything a web-* extension needs to define Tavily tools. */
export function createTavily(pi: ExtensionAPI) {
	const pool = tavilyPool();

	pi.on("session_start", async () => {
		void cleanupSaved().catch(() => {}); // already never rejects; this keeps it that way
	});

	/** POST to Tavily with key failover; keyless fallback where Tavily allows it. */
	function request(path: string, body: unknown, opts: RequestOptions) {
		return withRotation(pool, (key) => call(path, key, { body, signal: opts.signal, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes }), {
			keyless: opts.keyless,
			onNote: (note) => opts.ctx.hasUI && opts.ctx.ui.notify(note, "warning"),
		});
	}

	/** Tool result: text capped at MAX_BYTES/MAX_LINES, the rest saved to a temp file. */
	async function finish(text: string, summary: string, rot: RotationResult<unknown>, data: unknown) {
		const details: Details = { summary, via: rot.via, credits: credits(data), notes: rot.notes };
		const t = truncateHead(text, { maxBytes: MAX_BYTES, maxLines: MAX_LINES });
		let out = t.content;
		if (t.truncated) {
			details.fullOutputPath = await saveFull(text);
			out += `\n\n[Truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Full text: ${details.fullOutputPath}]`;
		}
		if (rot.via === "keyless") out += "\n\n[Tavily keyless mode: no usable API key, rate-limited]";
		return { content: [{ type: "text" as const, text: out }], details };
	}

	/** renderCall/renderResult: one line with the main argument, summary, key and credits. */
	const render = (name: string, main: (args: any) => string, pending: string) => ({
		renderCall(args: any, theme: any) {
			const value = sanitize(main(args) ?? "").replace(/\s+/g, " ");
			const shown = value.length > 80 ? `${value.slice(0, 77)}...` : value;
			return new Text(theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", shown), 0, 0);
		},
		renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
			const first = result.content.find((c: any) => c.type === "text");
			const body = sanitize(first?.type === "text" ? first.text : "");
			if (isPartial) return new Text(theme.fg("warning", body || pending), 0, 0);
			if (context.isError) return new Text(theme.fg("error", body || "Error"), 0, 0);
			const d = result.details as Details | undefined;
			let line = theme.fg("success", d?.summary ?? "done");
			const meta = [d?.via === "keyless" ? "keyless" : d?.via && `key ${d.via}`, d?.credits !== undefined && `${d.credits} cr`];
			if (d?.fullOutputPath) meta.push("truncated");
			line += theme.fg("muted", ` (${meta.filter(Boolean).join(", ")})`);
			if (expanded) {
				for (const note of d?.notes ?? []) line += `\n${theme.fg("warning", note)}`;
				line += `\n${theme.fg("dim", body.length > 1500 ? `${body.slice(0, 1500)}…` : body)}`;
			}
			return new Text(line, 0, 0);
		},
	});

	return { pool, request, finish, render };
}
