import { type ExtensionAPI, formatSize, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	AUTO,
	type Choice,
	ENV_VAR,
	type Usage,
	classifyUrl,
	configPath,
	findModel,
	listChoices,
	resolveChoice,
	saveChoice,
} from "./classify.ts";
import { cleanupSaved, fetchAndExtract, outline, preview, sanitize, saveFullText } from "./logic.ts";
import { filterChoices, pickClassifier } from "./picker.ts";

// Output cap for the agent's context (~3k tokens). The full text goes to a temp file; the
// headings after the preview point into it, so the agent can read only the part it needs.
const MAX_BYTES = 12 * 1024;
const MAX_LINES = 400;
const MAX_OUTLINE = 40;

interface Details {
	url: string;
	title: string;
	via: "direct" | "jina";
	bytes: number;
	fullOutputPath?: string;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function webFetch(pi: ExtensionAPI) {
	const configFile = configPath(getAgentDir());
	// Completions get no ctx, so keep the model list from the session start.
	let known: Choice[] = [{ value: AUTO, kind: "auto" }];
	pi.on("session_start", async (_event, ctx) => {
		void cleanupSaved(); // saved pages older than a day
		known = await listChoices(ctx.modelRegistry).catch(() => known);
	});

	pi.registerCommand("web-fetch-classifier", {
		description: "Choose the model that decides whether web_fetch may send a URL to r.jina.ai",
		getArgumentCompletions: async (prefix: string) => {
			const hits = filterChoices(known, prefix).map((c) => ({ value: c.value, label: c.value, description: c.kind }));
			return hits.length ? hits : null;
		},
		handler: async (args, ctx) => {
			try {
				const current = await resolveChoice(configFile);
				const query = args.trim();
				let choice = query;
				// An exact `auto` or `provider/id` is saved directly; anything else opens the picker
				// with the text as the search query, like `/model <query>`.
				if (!query || (query !== AUTO && !findModel(ctx.modelRegistry, query))) {
					if (ctx.mode !== "tui") {
						ctx.ui.notify(
							query
								? `Unknown model: ${query}. Use provider/id or ${AUTO}.`
								: `web_fetch classifier: ${current.choice} (${current.from})`,
							query ? "error" : "info",
						);
						return;
					}
					known = await listChoices(ctx.modelRegistry).catch(() => known);
					const picked = await pickClassifier(ctx, known, current.choice, query);
					if (!picked) return;
					choice = picked;
				}
				await saveChoice(configFile, choice);
				const note = current.from === "env" ? ` (${ENV_VAR} is set and still wins)` : "";
				ctx.ui.notify(`web_fetch classifier: ${choice}${note}`, current.from === "env" ? "warning" : "info");
			} catch (err) {
				ctx.ui.notify(`web_fetch classifier: ${message(err)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "web_fetch",
		description: `Fetch HTML, PDF or text as markdown. Returns a ${MAX_BYTES / 1024}KB/${MAX_LINES}-line preview plus a truncation note; full extracted text is saved when truncated, with the line numbers of the remaining headings.`,
		promptSnippet: "Fetch a web page or PDF as markdown",
		parameters: Type.Object({ url: Type.String({ description: "http(s) URL" }) }),

		async execute(_id, params, signal, _onUpdate, ctx) {
			let usage: Usage | undefined;
			const classify = async (urls: string[], sig: AbortSignal) => {
				let choice: string;
				try {
					choice = (await resolveChoice(configFile)).choice;
				} catch (err) {
					return `classifier config error: ${message(err)}`;
				}
				const verdict = await classifyUrl(ctx.modelRegistry, ctx.model, urls, sig, choice);
				usage = verdict.usage;
				return verdict.reason;
			};
			try {
				const result = await fetchAndExtract(params.url, { signal, jina: process.env.PI_WEB_FETCH_JINA !== "0", classify });
				const via = result.via === "jina" ? " (via r.jina.ai)" : "";
				const from = result.redirects ? `\nRedirected from: ${result.redirects[0]}` : "";
				const full = sanitize(`# ${result.title}\nSource: ${result.url}${via}${from}\n\n${result.content}`);
				const details: Details = { url: result.url, title: result.title, via: result.via, bytes: Buffer.byteLength(full) };
				const p = preview(full, MAX_BYTES, MAX_LINES);
				let text = p.text;
				if (p.truncated) {
					const file = await saveFullText(full);
					details.fullOutputPath = file;
					text += `\n\n[Truncated: ${p.shownLines} of ${p.totalLines} lines (${formatSize(p.shownBytes)} of ${formatSize(p.totalBytes)}). Full text: ${file}]`;
					// The last shown line may be cut, so its heading (if any) is listed again.
					const rest = outline(full, p.shownLines, MAX_OUTLINE);
					if (rest.length) text += `\nRemaining headings (line numbers in the full text):\n${rest.join("\n")}`;
				}
				signal?.throwIfAborted();
				return { content: [{ type: "text", text }], details, usage };
			} catch (err) {
				// Without a model call, let pi report the error. With one, return the error so its usage is still counted.
				if (!usage) throw err;
				const text = signal?.aborted ? "Operation aborted" : sanitize(message(err));
				return { content: [{ type: "text", text }], details: undefined, isError: true, usage };
			}
		},

		renderCall(args, theme) {
			const url = sanitize(String((args as { url?: string }).url ?? "")).replace(/\s+/g, " ");
			const shown = url.length > 80 ? `${url.slice(0, 77)}...` : url;
			return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", shown), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);
			const first = result.content.find((c) => c.type === "text");
			// Strip escape sequences before any theme color is added.
			const body = sanitize(first?.type === "text" ? first.text : "");
			if (context.isError) return new Text(theme.fg("error", body || "Error"), 0, 0);
			const d = result.details as Details | undefined;
			let line = theme.fg("success", sanitize(d?.title || "Untitled")) + theme.fg("muted", ` (${formatSize(d?.bytes ?? 0)}`);
			if (d?.via === "jina") line += theme.fg("muted", ", via Jina");
			if (d?.fullOutputPath) line += theme.fg("warning", ", truncated");
			line += theme.fg("muted", ")");
			if (expanded) line += `\n${theme.fg("dim", body.length > 1000 ? `${body.slice(0, 1000)}…` : body)}`;
			return new Text(line, 0, 0);
		},
	});
}
