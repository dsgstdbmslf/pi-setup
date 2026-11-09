// Searchable model picker for /web-fetch-classifier, styled like pi's /model:
// type to fuzzy-filter, ↑↓ to move, Enter to pick, Esc to cancel.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Focusable, fuzzyFilter, Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { Choice } from "./classify.ts";

const MAX_VISIBLE = 10;
/** Optional lines around the input and the list, in the order they go when the terminal is short. */
const CHROME: [part: string, lines: number][] = [
	["subtitle", 2], // with the blank line below it
	["spacers", 2],
	["counter", 1],
	["hint", 1],
	["borders", 2],
	["title", 1],
];

/** Fuzzy filter over `provider/id`, model name and kind; best matches first. */
export function filterChoices(choices: Choice[], query: string): Choice[] {
	const q = query.trim();
	return q ? fuzzyFilter(choices, q, (c) => `${c.value} ${c.name ?? ""} ${c.kind}`) : choices;
}

export function pickClassifier(
	ctx: Pick<ExtensionContext, "ui">,
	choices: Choice[],
	current: string,
	initialQuery = "",
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => {
			const input = new Input();
			// A bracketed paste inserts the query with the cursor at its end (setValue keeps it at 0).
			if (initialQuery) input.handleInput(`\x1b[200~${initialQuery}\x1b[201~`);
			let filtered = filterChoices(choices, initialQuery);
			let selected = initialQuery ? 0 : Math.max(0, filtered.findIndex((c) => c.value === current));

			const describe = (c: Choice) =>
				c.kind === "auto"
					? "first available classifier, else the session model"
					: `${c.name ? `${c.name} · ` : ""}${c.kind}`;

			// Everything is built at render time: one line per item (cut, never wrapped), the list fits
			// the terminal height, and theme colors are always current.
			const render = (width: number): string[] => {
				const w = Math.max(1, width);
				const fit = (line: string) => truncateToWidth(line, w);
				const rows = Math.max(1, tui.terminal?.rows ?? 24);
				const inputLines = input.render(w).map(fit);
				// Drop optional chrome until the input and at least one list row fit.
				const shown = new Set(CHROME.map(([part]) => part));
				let used = inputLines.length + CHROME.reduce((n, [, lines]) => n + lines, 0);
				for (const [part, lines] of CHROME) {
					if (used + 1 <= rows) break;
					shown.delete(part);
					used -= lines;
				}
				const has = (part: string) => shown.has(part);
				const spacer = has("spacers") ? [""] : [];
				const border = has("borders") ? [theme.fg("border", "─".repeat(w))] : [];
				const visible = Math.max(1, Math.min(MAX_VISIBLE, rows - used));
				const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), filtered.length - visible));
				const end = Math.min(start + visible, filtered.length);
				const lines = [
					...border,
					...(has("title") ? [fit(theme.fg("accent", theme.bold("web_fetch classifier")))] : []),
					...(has("subtitle") ? [fit(theme.fg("muted", "Decides whether a URL may be sent to r.jina.ai. Saved globally.")), ...spacer] : []),
					...inputLines,
					...spacer,
				];
				for (let i = start; i < end; i++) {
					const c = filtered[i];
					const isSel = i === selected;
					lines.push(
						fit(
							(isSel ? theme.fg("accent", "→ ") : "  ") +
								(c.value === current ? theme.fg("accent", "✓ ") : "  ") +
								(isSel ? theme.fg("accent", c.value) : c.value) +
								theme.fg("muted", `  ${describe(c)}`),
						),
					);
				}
				if (filtered.length === 0) lines.push(fit(theme.fg("muted", "  No matching models")));
				else if (has("counter") && (start > 0 || end < filtered.length)) lines.push(fit(theme.fg("muted", `  (${selected + 1}/${filtered.length})`)));
				if (has("hint")) lines.push(...spacer, fit(theme.fg("dim", "  type to search · ↑↓ move · enter select · esc cancel")));
				lines.push(...border);
				return lines.slice(0, rows);
			};

			const component: Focusable & {
				capturesViewportInput: boolean;
				render(width: number): string[];
				invalidate(): void;
				handleInput(data: string): void;
			} = {
				capturesViewportInput: true,
				// Propagate focus to the input so the cursor (and IME) sits in the search box.
				get focused() {
					return input.focused;
				},
				set focused(value: boolean) {
					input.focused = value;
				},
				render,
				invalidate: () => input.invalidate(),
				handleInput(data) {
					if (keybindings.matches(data, "tui.select.up")) {
						if (filtered.length) selected = selected === 0 ? filtered.length - 1 : selected - 1;
					} else if (keybindings.matches(data, "tui.select.down")) {
						if (filtered.length) selected = selected === filtered.length - 1 ? 0 : selected + 1;
					} else if (keybindings.matches(data, "tui.select.confirm")) {
						if (filtered[selected]) done(filtered[selected].value);
						return;
					} else if (keybindings.matches(data, "tui.select.cancel")) {
						done(undefined);
						return;
					} else {
						const before = input.getValue();
						input.handleInput(data);
						if (input.getValue() !== before) {
							filtered = filterChoices(choices, input.getValue());
							selected = 0;
						}
					}
					tui.requestRender();
				},
			};
			return component;
		},
		{ blocked: { kind: "question", message: "Pick the web_fetch classifier model" } },
	);
}
