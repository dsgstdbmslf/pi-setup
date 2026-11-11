import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type UiOutcome,
	type Question,
	type Strings,
	answersOf,
	getMode,
	formatAnswer,
	getOtherLabel,
	newState,
	normalizeOptions,
	pick,
	setNote,
} from "./logic.ts";

const MAX_VISIBLE = 10; // option rows shown at once

function editorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

/** One dialog for all questions: tabs when there are several, a review tab before submitting. */
export function askQuestions(
	ctx: any,
	questions: Question[],
	S: Strings,
	timeoutSec?: number,
	signal?: AbortSignal,
): Promise<UiOutcome> {
	// One-line, bounded text of the first question for the "pi is waiting" status.
	const blockedMessage = (questions[0]?.question ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
	return ctx.ui.custom<UiOutcome>(
		(tui: any, theme: any, _kb: any, done: (r: UiOutcome) => void) => {
			const states = questions.map(newState);
			const multiTab = questions.length > 1;
			const reviewTab = multiTab ? questions.length : -1;
			const tabCount = questions.length + (multiTab ? 1 : 0);
			const editor = new Editor(tui, editorTheme(theme));
			let tab = 0;
			let editMode = getMode(questions[0]) === "text";
			let noteIdx: number | undefined; // option being commented on (edit mode)
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const allAnswers = () => questions.map((q, i) => answersOf(q, states[i]));
			const allAnswered = () => allAnswers().every((a) => a.length > 0);
			const cur = () => questions[tab];
			const isText = () => tab !== reviewTab && getMode(cur()) === "text";
			const refresh = () => tui.requestRender();

			function finish(status: UiOutcome["status"]) {
				if (finished) return;
				finished = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				commitText();
				done({ status, answers: allAnswers() });
			}
			const onAbort = () => finish("cancelled");
			signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutSec) timer = setTimeout(() => finish("timeout"), timeoutSec * 1000);

			function commitText() {
				if (editMode && isText()) states[tab].other = editor.getText().trim() || undefined;
			}

			function startEdit() {
				editMode = true;
				editor.setText(states[tab].other ?? "");
			}

			function goTo(n: number) {
				commitText();
				noteIdx = undefined;
				tab = (n + tabCount) % tabCount;
				editMode = false;
				if (isText()) startEdit();
				refresh();
			}

			function advance() {
				if (tab + 1 < questions.length) goTo(tab + 1);
				else if (multiTab) goTo(reviewTab);
				else finish("done");
			}

			editor.onSubmit = (value) => {
				const text = value.trim();
				const st = states[tab];
				if (noteIdx !== undefined) {
					setNote(cur(), st, noteIdx, text);
					noteIdx = undefined;
					editMode = false;
					refresh();
					return;
				}
				if (isText()) {
					if (!text) return;
					st.other = text;
					editMode = false; // the editor is already cleared; don't re-read it
					advance();
					return;
				}
				st.other = text || undefined;
				editMode = false;
				if (text && getMode(cur()) === "single-select") {
					st.picked.clear();
					advance();
					return;
				}
				refresh();
			};

			function handleInput(data: string) {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						if (isText()) finish("cancelled");
						else {
							editMode = false;
							noteIdx = undefined;
							refresh();
						}
						return;
					}
					if (isText() && multiTab && matchesKey(data, Key.tab)) return goTo(tab + 1);
					if (isText() && multiTab && matchesKey(data, Key.shift("tab"))) return goTo(tab - 1);
					editor.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.escape)) return finish("cancelled");
				if (multiTab) {
					if (matchesKey(data, Key.right)) return goTo(tab + 1);
					if (matchesKey(data, Key.left)) return goTo(tab - 1);
				}
				if (tab === reviewTab) {
					if (matchesKey(data, Key.enter)) {
						if (allAnswered()) finish("done");
						else refresh();
					}
					return;
				}

				const q = cur();
				const st = states[tab];
				const options = normalizeOptions(q.options);
				const multi = getMode(q) === "multi-select";
				const otherIdx = options.length;
				const itemCount = options.length + 1 + (multi ? 1 : 0); // options, Other, [Submit]

				const choose = (i: number) => {
					pick(q, st, i);
					if (multi) refresh();
					else advance();
				};

				if (matchesKey(data, Key.tab)) {
					if (st.cursor < otherIdx) {
						noteIdx = st.cursor;
						editMode = true;
						editor.setText(st.notes.get(noteIdx) ?? "");
					}
				} else if (matchesKey(data, Key.up)) st.cursor = Math.max(0, st.cursor - 1);
				else if (matchesKey(data, Key.down)) st.cursor = Math.min(itemCount - 1, st.cursor + 1);
				else if (/^[1-9]$/.test(data) && Number(data) <= options.length) {
					st.cursor = Number(data) - 1;
					return choose(st.cursor);
				} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
					if (st.cursor < otherIdx) return choose(st.cursor);
					if (st.cursor === otherIdx) {
						if (multi && st.other && matchesKey(data, Key.space)) st.other = undefined; // Space toggles off
						else startEdit();
					} else if (matchesKey(data, Key.enter) && answersOf(q, st).length > 0) return advance();
				}
				refresh();
			}

			function render(width: number): string[] {
				const lines: string[] = [];
				const add = (text: string) => lines.push(truncateToWidth(text, width));
				const wrap = (text: string, indent = "") => {
					for (const l of wrapTextWithAnsi(text, Math.max(1, width - indent.length))) add(`${indent}${l}`);
				};
				const answers = allAnswers();

				add(theme.fg("accent", "─".repeat(width)));

				if (multiTab) {
					const tabs = questions.map((_, i) => {
						const label = ` ${answers[i].length > 0 ? "✓" : "○"} ${i + 1} `;
						return i === tab ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(answers[i].length ? "success" : "muted", label);
					});
					const rev = ` ${S.review} `;
					tabs.push(tab === reviewTab ? theme.bg("selectedBg", theme.fg("text", rev)) : theme.fg(allAnswered() ? "success" : "dim", rev));
					add(` ${tabs.join(" ")}`);
					lines.push("");
				}

				if (tab === reviewTab) {
					questions.forEach((q, i) => {
						wrap(theme.fg("text", ` ${i + 1}. ${q.question}`));
						if (answers[i].length === 0) add(theme.fg("warning", `    ${S.notAnswered}`));
						for (const a of answers[i]) {
							const text = a.type === "other" ? `${S.other}: ${a.label}` : formatAnswer(a);
							wrap(theme.fg("accent", text), "    ");
						}
					});
					lines.push("");
					if (!allAnswered()) add(theme.fg("warning", ` ${S.allFirst}`));
					add(theme.fg("dim", ` ${S.hintReview}`));
					add(theme.fg("accent", "─".repeat(width)));
					return lines;
				}

				const q = cur();
				const st = states[tab];
				const options = normalizeOptions(q.options);
				const mode = getMode(q);
				wrap(theme.fg("text", ` ${q.question}`));
				if (q.details) {
					lines.push("");
					wrap(theme.fg("muted", ` ${q.details}`));
				}
				lines.push("");

				if (mode !== "text") {
					const multi = mode === "multi-select";
					const mark = (on: boolean) => (multi ? (on ? "[x]" : "[ ]") : on ? "(•)" : "( )");
					const items = [
						...options.map((o, i) => ({ text: `${mark(st.picked.has(i))} ${i + 1}. ${o.label}`, on: st.picked.has(i), desc: o.description })),
						{
							text: `${mark(!!st.other)} ${getOtherLabel(options, S)}${st.other ? ` — ${st.other.replace(/\s+/g, " ")}` : ""}`,
							on: !!st.other,
							desc: undefined,
						},
					];
					const n = answers[tab].length;
					if (multi) items.push({ text: n > 0 ? `✓ ${S.submit} (${n})` : `○ ${S.submit}`, on: n > 0, desc: undefined });
					// Window of at most MAX_VISIBLE items centred on the cursor, like pi's own selectors.
					const start = Math.max(0, Math.min(st.cursor - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE));
					const end = Math.min(start + MAX_VISIBLE, items.length);
					if (start > 0) add(theme.fg("dim", `  ↑ ${S.more.replace("%d", String(start))}`));
					for (let i = start; i < end; i++) {
						const it = items[i];
						const focused = i === st.cursor && !editMode;
						add(`${focused ? theme.fg("accent", "> ") : "  "}${theme.fg(focused ? "accent" : it.on ? "success" : "text", it.text)}`);
						if (it.desc) wrap(theme.fg("muted", it.desc), "     ");
						const note = i < options.length ? st.notes.get(i) : undefined;
						if (note) wrap(theme.fg("success", `↳ ${note.replace(/\s+/g, " ")}`), "     ");
					}
					if (end < items.length) add(theme.fg("dim", `  ↓ ${S.more.replace("%d", String(items.length - end))}`));
					lines.push("");
				}

				if (editMode) {
					if (noteIdx !== undefined) add(theme.fg("muted", ` ${S.writeNote} ${noteIdx + 1}. ${options[noteIdx].label}:`));
					else if (mode !== "text") add(theme.fg("muted", ` ${S.writeAnswer}`));
					for (const l of editor.render(Math.max(1, width - 2))) add(` ${l}`);
					lines.push("");
					add(theme.fg("dim", ` ${mode === "text" ? S.hintText : S.hintEdit}${mode === "text" && multiTab ? S.hintTabsText : ""}`));
				} else {
					if (mode !== "text") add(theme.fg("muted", ` ${S.noteHint}`));
					if (mode === "multi-select" && answers[tab].length === 0) add(theme.fg("warning", ` ${S.pickOne}`));
					add(theme.fg("dim", ` ${mode === "multi-select" ? S.hintMulti : S.hintSingle}${multiTab ? S.hintTabs : ""}`));
				}
				add(theme.fg("accent", "─".repeat(width)));
				return lines;
			}

			return { render, invalidate: () => {}, handleInput };
		},
		{ blocked: { kind: "question", message: blockedMessage } },
	);
}
