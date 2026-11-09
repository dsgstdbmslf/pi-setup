// Searchable model picker for /web-fetch-classifier, styled like pi's /model:
// type to fuzzy-filter, ↑↓ to move, Enter to pick, Esc to cancel.

import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, fuzzyFilter, Input, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Choice } from "./classify.ts";

const MAX_VISIBLE = 10;

/** Fuzzy filter over `provider/id`, model name and kind; best matches first. */
export function filterChoices(choices: Choice[], query: string): Choice[] {
	const q = query.trim();
	return q ? fuzzyFilter(choices, q, (c) => `${c.value} ${c.name ?? ""} ${c.kind}`) : choices;
}

export function pickClassifier(
	ctx: ExtensionContext,
	choices: Choice[],
	current: string,
	initialQuery = "",
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => {
			const input = new Input();
			input.setValue(initialQuery);
			const list = new Container();
			let filtered = filterChoices(choices, initialQuery);
			let selected = initialQuery ? 0 : Math.max(0, filtered.findIndex((c) => c.value === current));

			const describe = (c: Choice) =>
				c.kind === "auto"
					? "first available classifier, else the session model"
					: `${c.name ? `${c.name} · ` : ""}${c.kind}`;

			const update = () => {
				list.clear();
				const start = Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE));
				const end = Math.min(start + MAX_VISIBLE, filtered.length);
				for (let i = start; i < end; i++) {
					const c = filtered[i];
					const isSel = i === selected;
					const line =
						(isSel ? theme.fg("accent", "→ ") : "  ") +
						(c.value === current ? theme.fg("accent", "✓ ") : "  ") +
						(isSel ? theme.fg("accent", c.value) : c.value) +
						theme.fg("muted", `  ${describe(c)}`);
					list.addChild(new Text(line, 0, 0));
				}
				if (filtered.length === 0) list.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
				else if (start > 0 || end < filtered.length)
					list.addChild(new Text(theme.fg("muted", `  (${selected + 1}/${filtered.length})`), 0, 0));
			};

			const root = new Container();
			root.addChild(new DynamicBorder());
			root.addChild(new Text(theme.fg("accent", theme.bold("web_fetch classifier")), 0, 0));
			root.addChild(new Text(theme.fg("muted", "Decides whether a URL may be sent to r.jina.ai. Saved globally."), 0, 0));
			root.addChild(new Spacer(1));
			root.addChild(input);
			root.addChild(new Spacer(1));
			root.addChild(list);
			root.addChild(new Spacer(1));
			root.addChild(new Text(theme.fg("dim", "  type to search · ↑↓ move · enter select · esc cancel"), 0, 0));
			root.addChild(new DynamicBorder());
			update();

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
				render: (width) => root.render(width).map((l) => truncateToWidth(l, width)),
				invalidate: () => root.invalidate(),
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
					update();
					tui.requestRender();
				},
			};
			return component;
		},
		{ blocked: { kind: "question", message: "Pick the web_fetch classifier model" } },
	);
}
