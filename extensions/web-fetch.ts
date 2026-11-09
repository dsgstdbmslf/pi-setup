import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, formatSize, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	AUTO,
	type Choice,
	ENV_VAR,
	classifyUrl,
	configPath,
	findModel,
	listChoices,
	resolveChoice,
	saveChoice,
} from "./web-fetch/classify.ts";
import { fetchAndExtract } from "./web-fetch/logic.ts";
import { filterChoices, pickClassifier } from "./web-fetch/picker.ts";

// Output cap for the agent's context (~8k tokens). The full text goes to a temp file.
const MAX_BYTES = 32 * 1024;
const MAX_LINES = 1000;

interface Details {
	url: string;
	title: string;
	via: "direct" | "jina";
	bytes: number;
	fullOutputPath?: string;
}

export default function webFetch(pi: ExtensionAPI) {
	const configFile = configPath(getAgentDir());
	// Completions get no ctx, so keep the model list from the session start.
	let known: Choice[] = [{ value: AUTO, kind: "auto" }];
	pi.on("session_start", async (_event, ctx) => {
		known = await listChoices(ctx.modelRegistry).catch(() => known);
	});

	pi.registerCommand("web-fetch-classifier", {
		description: "Choose the model that decides whether web_fetch may send a URL to r.jina.ai",
		getArgumentCompletions: async (prefix: string) => {
			const hits = filterChoices(known, prefix).map((c) => ({ value: c.value, label: c.value, description: c.kind }));
			return hits.length ? hits : null;
		},
		handler: async (args, ctx) => {
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
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "web_fetch",
		description: `Fetch a URL (HTML, PDF, text) as markdown. Output is capped at ${formatSize(MAX_BYTES)}; the full text is then saved to a file you can read with offset/limit.`,
		promptSnippet: "Fetch a web page or PDF as markdown",
		parameters: Type.Object({ url: Type.String({ description: "http(s) URL" }) }),

		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await fetchAndExtract(params.url, {
				signal,
				jina: process.env.PI_WEB_FETCH_JINA !== "0",
				classify: async (url) =>
					classifyUrl(ctx.modelRegistry, ctx.model, url, signal, (await resolveChoice(configFile)).choice),
			});
			const full = `# ${result.title}\nSource: ${result.url}${result.via === "jina" ? " (via r.jina.ai)" : ""}\n\n${result.content}`;
			const details: Details = {
				url: result.url,
				title: result.title,
				via: result.via,
				bytes: Buffer.byteLength(full),
			};
			const t = truncateHead(full, { maxBytes: MAX_BYTES, maxLines: MAX_LINES });
			let text = t.content;
			if (t.truncated) {
				const file = join(await mkdtemp(join(tmpdir(), "pi-web-fetch-")), "page.md");
				await writeFile(file, full, "utf8");
				details.fullOutputPath = file;
				text += `\n\n[Truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Full text: ${file}]`;
			}
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme) {
			const url = String((args as { url?: string }).url ?? "");
			const shown = url.length > 80 ? `${url.slice(0, 77)}...` : url;
			return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", shown), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);
			const first = result.content.find((c) => c.type === "text");
			const body = first?.type === "text" ? first.text : "";
			if (context.isError) return new Text(theme.fg("error", body || "Error"), 0, 0);
			const d = result.details as Details | undefined;
			let line = theme.fg("success", d?.title || "Untitled") + theme.fg("muted", ` (${formatSize(d?.bytes ?? 0)}`);
			if (d?.via === "jina") line += theme.fg("muted", ", via Jina");
			if (d?.fullOutputPath) line += theme.fg("warning", ", truncated");
			line += theme.fg("muted", ")");
			if (expanded) line += `\n${theme.fg("dim", body.length > 1000 ? `${body.slice(0, 1000)}…` : body)}`;
			return new Text(line, 0, 0);
		},
	});
}
