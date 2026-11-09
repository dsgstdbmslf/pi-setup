// /search-keys: status, credits and marks of the Tavily API keys used by the web-* extensions.
// Shared code lives in extensions/tavily/.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { call } from "./tavily/client.ts";
import { KEYS_FILE, mask, nextMonthUtc } from "./tavily/keys.ts";
import { tavilyPool } from "./tavily/tool.ts";

const EXAMPLE = { tavily: [{ key: "tvly-YOUR_KEY", label: "main" }, { key: "tvly-SECOND_KEY", label: "backup" }] };

export default function tavilyKeys(pi: ExtensionAPI) {
	const pool = tavilyPool();

	async function status(ctx: ExtensionContext): Promise<string> {
		const snap = await pool.snapshot();
		if (snap.missing) return `No key file. Run /search-keys init, then put your keys into ${pool.keysFile}.`;
		const all = [...snap.available.map((entry) => ({ entry, mark: undefined })), ...snap.skipped];
		const bad = snap.malformed.length
			? `Warning: skipped ${snap.malformed.length} malformed key(s) (${snap.malformed.join(", ")}): keys may contain only visible ASCII characters.`
			: "";
		const warn = [bad, snap.stateWarning ? `Warning: ${snap.stateWarning}.` : ""].filter(Boolean);
		if (all.length === 0) return [`No tavily keys in ${pool.keysFile}. Tools that allow it use keyless mode.`, ...warn].join("\n");
		const lines = [`tavily keys (${pool.keysFile}), used in file order:`];
		const cleared: string[] = [];
		for (const { entry, mark } of all) {
			let info: string;
			const res = await call("/usage", entry.key, { method: "GET", timeoutMs: 15_000, signal: ctx.signal });
			if (res.ok) {
				const k = res.value?.key ?? {};
				const a = res.value?.account ?? {};
				const keyLeft = k.limit == null || k.usage < k.limit;
				const planLeft =
					a.plan_limit == null || a.plan_usage < a.plan_limit || (a.paygo_limit != null && a.paygo_usage < a.paygo_limit);
				info = `${k.usage ?? "?"}/${k.limit ?? "∞"} credits${a.current_plan ? `, plan ${a.current_plan} ${a.plan_usage}/${a.plan_limit}` : ""}`;
				if (keyLeft && planLeft) {
					if (mark?.status === "exhausted") cleared.push(entry.id);
					info = `ok, ${info}`;
				} else {
					info = `exhausted, ${info}`;
					if (!mark) await pool.mark(entry, { status: "exhausted", until: nextMonthUtc(Date.now()), reason: "usage check" });
				}
			} else if (res.status === 401) {
				info = "invalid key (401)";
				if (mark?.status !== "invalid") await pool.mark(entry, { status: "invalid", until: null, reason: res.message });
			} else {
				info = `${mark ? `${mark.status}; ` : ""}usage check failed: ${res.message}`;
			}
			lines.push(`- ${entry.label} ${mask(entry.key)}: ${info}`);
		}
		if (cleared.length) {
			await pool.clear(cleared);
			lines.push(`Credits are available again for ${cleared.length} key(s) marked exhausted; marks cleared.`);
		}
		lines.push(...warn);
		if (snap.insecure) lines.push(`Warning: ${pool.keysFile} is readable by other users; run chmod 600 on it.`);
		return lines.join("\n");
	}

	pi.registerCommand("search-keys", {
		description: "Tavily API keys: status and remaining credits (default), reset marks, init key file",
		getArgumentCompletions: async (prefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "check every key and its credits" },
				{ value: "reset", label: "reset", description: "forget exhausted/invalid marks" },
				{ value: "init", label: "init", description: `create ${KEYS_FILE} from a template` },
			].filter((i) => i.value.startsWith(prefix.trim()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const cmd = args.trim() || "status";
			try {
				if (cmd === "status") {
					ctx.ui.notify(await status(ctx), "info");
				} else if (cmd === "reset") {
					await pool.clear();
					ctx.ui.notify("tavily: all key marks cleared", "info");
				} else if (cmd === "init") {
					await mkdir(dirname(pool.keysFile), { recursive: true });
					await writeFile(pool.keysFile, `${JSON.stringify(EXAMPLE, null, 2)}\n`, { mode: 0o600, flag: "wx" }).then(
						() => ctx.ui.notify(`Created ${pool.keysFile} (mode 600). Replace the placeholder keys with yours.`, "info"),
						(err: NodeJS.ErrnoException) => {
							if (err.code !== "EEXIST") throw err;
							ctx.ui.notify(`${pool.keysFile} already exists; edit it directly.`, "warning");
						},
					);
				} else {
					ctx.ui.notify(`Unknown argument: ${cmd}. Use status, reset or init.`, "error");
				}
			} catch (err) {
				ctx.ui.notify(`search-keys: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
