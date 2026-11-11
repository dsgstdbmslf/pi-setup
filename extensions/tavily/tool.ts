// Tool kit shared by the web-* extensions: key pool, requests with failover, result
// truncation and rendering. Not an extension itself: pi loads only extensions/*.ts.

import { createRequire } from "node:module";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	getAgentDir,
	getPackageDir,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { call, credits, cut } from "./client.ts";
import { describeNetwork, parseProxySetting } from "./network.ts";
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

let directAgent: unknown;
const warned = new Set<string>();

/**
 * A direct undici Agent (ignores HTTP(S)_PROXY), or null when undici cannot be loaded. Extensions
 * cannot import undici themselves; it is pi's own dependency, so it is resolved from pi's package dir.
 */
function directDispatcher(): unknown {
	if (directAgent === undefined) {
		try {
			const undici = createRequire(join(getPackageDir(), "package.json"))("undici");
			directAgent = new undici.Agent();
		} catch {
			directAgent = null;
		}
	}
	return directAgent;
}

/**
 * How Tavily connects, read from `tavily.proxy` in pi's settings on every call (so /reload or an
 * edit takes effect). `dispatcher` is set only to bypass the proxy; the options go to `call()`
 * for tool requests and the /search-keys check alike. Problems are shown once per text.
 */
export function tavilyNetwork(pi: ExtensionAPI, ctx?: ExtensionContext): { dispatcher?: unknown; description: string } {
	const warn = (text: string) => {
		if (warned.has(text)) return;
		warned.add(text);
		if (ctx?.hasUI) ctx.ui.notify(`tavily: ${text}`, "warning");
	};
	const { proxy, invalid } = parseProxySetting(pi.getSettings());
	if (invalid) warn(`${invalid}; using the default (true, follow pi's proxy)`);
	if (proxy) return { description: describeNetwork(true, process.env) };
	const dispatcher = directDispatcher();
	if (!dispatcher) warn("tavily.proxy = false could not be applied: undici is not available from pi; following pi's proxy");
	return dispatcher ? { dispatcher, description: describeNetwork(false, process.env) } : { description: describeNetwork(false, process.env, false) };
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
		const { dispatcher } = tavilyNetwork(pi, opts.ctx);
		return withRotation(pool, (key) => call(path, key, { body, signal: opts.signal, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, dispatcher }), {
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
			const shown = value.length > 80 ? `${cut(value, 77)}...` : value;
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
				line += `\n${theme.fg("dim", body.length > 1500 ? `${cut(body, 1500)}…` : body)}`;
			}
			return new Text(line, 0, 0);
		},
	});

	return { pool, request, finish, render };
}
