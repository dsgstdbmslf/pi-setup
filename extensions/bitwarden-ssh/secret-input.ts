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

/**
 * Masked input needs pi's interactive TUI. RPC and other modes only offer plain ctx.ui.input, which shows
 * and may keep the text, so secret input fails closed there (askSecret returns undefined).
 */
export function secretInputAvailable(ctx: any): boolean {
	return !!ctx?.hasUI && ctx.mode === "tui" && typeof ctx.ui?.custom === "function";
}

export const SECRET_INPUT_NEEDS_TUI = "secret input needs the interactive TUI (pi in RPC or print mode cannot mask it)";

export function askSecret(ctx: any, p: SecretPrompt): Promise<string | undefined> {
	if (!secretInputAvailable(ctx) || p.signal?.aborted) return Promise.resolve(undefined);
	return new Promise<string | undefined>((resolve, reject) => {
		// Settled by finish() (submit, cancel, abort) or by dispose(): pi disposes dialogs on /reload and
		// session replacement without calling done(), and a pending promise would stall the shared UI lock.
		let settled = false;
		const settle = (v: string | undefined) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		const shown = ctx.ui.custom(
			(tui: any, theme: any, kb: any, done: (v: string | undefined) => void) => {
				let value = "";
				let inPaste = false;
				let pasteBuf = "";
				let finished = false;
				const cleanup = () => {
					finished = true;
					p.signal?.removeEventListener("abort", onAbort);
					value = "";
					pasteBuf = "";
				};
				const finish = (v: string | undefined) => {
					if (finished) return;
					cleanup();
					settle(v);
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
						// Not done(): pi already removed the dialog; only settle our promise.
						if (!finished) cleanup();
						value = "";
						pasteBuf = "";
						settle(undefined);
					},
				};
				return component as typeof component & Focusable;
			},
			{ blocked: { kind: "auth", message: p.title } },
		);
		Promise.resolve(shown).then(
			(v: string | undefined) => settle(v),
			(err: unknown) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			},
		);
	});
}
