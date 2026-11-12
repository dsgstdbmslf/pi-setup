// Masked input dialog for ctx.ui.custom(): one "•" per character, no kill ring, no undo, no history,
// so the secret exists only in this closure until done() hands it to the caller.

import { CURSOR_MARKER, decodeKittyPrintable, type Focusable, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface SecretPrompt {
	title: string;
	message?: string;
	warning?: string;
	signal?: AbortSignal;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function hasControl(s: string): boolean {
	return [...s].some((ch) => {
		const c = ch.charCodeAt(0);
		return c < 32 || c === 0x7f || (c >= 0x80 && c <= 0x9f);
	});
}

export async function askSecret(ctx: any, p: SecretPrompt): Promise<string | undefined> {
	if (!ctx.hasUI || p.signal?.aborted) return undefined;
	if (ctx.mode !== "tui") {
		// RPC and other dialog-capable modes: the client's input dialog (it may not mask the text).
		return ctx.ui.input(`${p.title}${p.message ? ` — ${p.message}` : ""}`, "", { signal: p.signal });
	}
	return ctx.ui.custom(
		(tui: any, theme: any, kb: any, done: (v: string | undefined) => void) => {
			let value = "";
			let inPaste = false;
			let pasteBuf = "";
			let finished = false;
			const finish = (v: string | undefined) => {
				if (finished) return;
				finished = true;
				p.signal?.removeEventListener("abort", onAbort);
				value = "";
				pasteBuf = "";
				done(v);
			};
			const onAbort = () => finish(undefined);
			p.signal?.addEventListener("abort", onAbort, { once: true });

			const insert = (s: string) => {
				const clean = s.replace(/[\r\n]/g, "");
				if (clean && !hasControl(clean)) value += clean;
			};

			const component: { focused: boolean } & Record<string, any> = {
				focused: false,
				render(width: number): string[] {
					const lines: string[] = [];
					const add = (t: string) => lines.push(truncateToWidth(t, width));
					const wrap = (t: string) => {
						for (const l of wrapTextWithAnsi(t, Math.max(1, width - 1))) add(` ${l}`);
					};
					add(theme.fg("accent", "─".repeat(width)));
					wrap(theme.fg("accent", theme.bold(p.title)));
					if (p.message) wrap(theme.fg("muted", p.message));
					if (p.warning) wrap(theme.fg("warning", `⚠ ${p.warning}`));
					lines.push("");
					const dots = "•".repeat([...value].length);
					add(` ${theme.fg("text", "> ")}${dots}${component.focused ? CURSOR_MARKER : ""}${theme.inverse(" ")}`);
					lines.push("");
					add(theme.fg("dim", " Enter submit · Esc cancel · Ctrl+U clear"));
					add(theme.fg("accent", "─".repeat(width)));
					return lines;
				},
				invalidate() {},
				handleInput(data: string) {
					if (inPaste || data.includes(PASTE_START)) {
						if (!inPaste) {
							inPaste = true;
							data = data.slice(data.indexOf(PASTE_START) + PASTE_START.length);
						}
						pasteBuf += data;
						const end = pasteBuf.indexOf(PASTE_END);
						if (end < 0) return;
						insert(pasteBuf.slice(0, end));
						const rest = pasteBuf.slice(end + PASTE_END.length);
						pasteBuf = "";
						inPaste = false;
						tui.requestRender();
						if (rest) component.handleInput(rest);
						return;
					}
					if (kb.matches(data, "tui.select.cancel")) return finish(undefined);
					if (kb.matches(data, "tui.input.submit") || data === "\r" || data === "\n") return finish(value);
					if (kb.matches(data, "tui.editor.deleteCharBackward") || data === "\x7f" || data === "\b") {
						const chars = [...value];
						chars.pop();
						value = chars.join("");
					} else if (kb.matches(data, "tui.editor.deleteToLineStart") || data === "\x15") {
						value = "";
					} else {
						const kitty = decodeKittyPrintable(data);
						if (kitty !== undefined) insert(kitty);
						else if (!hasControl(data)) insert(data);
						else return;
					}
					tui.requestRender();
				},
				dispose() {
					value = "";
					pasteBuf = "";
				},
			};
			return component as typeof component & Focusable;
		},
		{ blocked: { kind: "auth", message: p.title } },
	);
}
