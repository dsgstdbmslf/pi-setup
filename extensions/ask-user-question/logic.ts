// Pure logic for ask_user_question: no pi imports, so it can be unit-tested with plain node.

export interface Option {
	label: string;
	value: string;
	description?: string;
}

export interface Question {
	question: string;
	details?: string;
	options?: Array<{ label: string; value?: string; description?: string }>;
	multiSelect?: boolean;
	defaultAnswer?: string;
}

export type Mode = "text" | "single-select" | "multi-select";

export interface Answer {
	type: "text" | "option" | "other";
	label: string;
	value: string;
	index?: number; // 1-based, options only
	note?: string; // user's comment on the option (Tab in the UI)
}

export interface QuestionResult {
	question: string;
	mode: Mode;
	answers: Answer[];
	usedDefault?: boolean;
}

/** Per-question UI state. `picked` holds 0-based option indexes; `other` is custom/free text. */
export interface QState {
	cursor: number;
	picked: Set<number>;
	other?: string;
	notes: Map<number, string>; // option index -> comment
}

// ---------- strings (en / ru) ----------

const EN = {
	other: "Other",
	otherCustom: "Other (custom)",
	submit: "Submit",
	more: "%d more",
	review: "Review",
	notAnswered: "not answered",
	writeAnswer: "Write your custom answer:",
	pickOne: "Select at least one answer before continuing.",
	allFirst: "Answer every question before submitting.",
	noteHint: "Tab — add a comment to the highlighted option",
	writeNote: "Comment on option",
	hintSingle: "↑↓ navigate • Enter/1-9 select • Esc cancel",
	hintMulti: "↑↓ navigate • Space/1-9 toggle • Enter edit/continue • Esc cancel",
	hintEdit: "Enter to save • Shift+Enter new line • Esc back",
	hintText: "Enter to submit • Shift+Enter new line • Esc cancel",
	hintTabs: " • ←/→ switch question",
	hintTabsText: " • Tab switch question",
	hintReview: "Enter submit • ←/→ go back and edit • Esc cancel",
	cancelled: "User cancelled the question",
	timedOut: "The question timed out without an answer; the run was stopped",
	noUI: "ask_user_question requires interactive mode UI",
	usedDefaults: "No user available; default answers were used",
	answered: "User answered:",
	selected: "User selected:",
	empty: "(empty response)",
};
export type Strings = typeof EN;

const RU: Strings = {
	other: "Другое",
	otherCustom: "Другое (свой вариант)",
	submit: "Далее",
	more: "ещё %d",
	review: "Проверка",
	notAnswered: "нет ответа",
	writeAnswer: "Напишите свой ответ:",
	pickOne: "Выберите хотя бы один ответ, чтобы продолжить.",
	allFirst: "Ответьте на все вопросы перед отправкой.",
	noteHint: "Tab — добавить комментарий к выбранной опции",
	writeNote: "Комментарий к опции",
	hintSingle: "↑↓ навигация • Enter/1-9 выбор • Esc отмена",
	hintMulti: "↑↓ навигация • Space/1-9 отметить • Enter ввод/далее • Esc отмена",
	hintEdit: "Enter сохранить • Shift+Enter новая строка • Esc назад",
	hintText: "Enter отправить • Shift+Enter новая строка • Esc отмена",
	hintTabs: " • ←/→ другой вопрос",
	hintTabsText: " • Tab другой вопрос",
	hintReview: "Enter отправить • ←/→ вернуться и изменить • Esc отмена",
	cancelled: "User cancelled the question",
	timedOut: "The question timed out without an answer; the run was stopped",
	noUI: "ask_user_question requires interactive mode UI",
	usedDefaults: "No user available; default answers were used",
	answered: "User answered:",
	selected: "User selected:",
	empty: "(empty response)",
};

/** Language: PI_ASK_LANG=en|ru, else the system locale. Only UI text is localized; text sent to the model stays English. */
export function getStrings(env: Record<string, string | undefined> = process.env): Strings {
	const lang = env.PI_ASK_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
	return /^ru/i.test(lang) ? RU : EN;
}

// ---------- questions ----------

export function normalizeOptions(options: Question["options"]): Option[] {
	return (options || [])
		.map((o) => ({
			label: o.label.trim(),
			value: o.value?.trim() || o.label.trim(),
			description: o.description?.trim() || undefined,
		}))
		.filter((o) => o.label.length > 0);
}

export function getMode(q: Question): Mode {
	return normalizeOptions(q.options).length === 0 ? "text" : q.multiSelect ? "multi-select" : "single-select";
}

export function getOtherLabel(options: Option[], s: Strings = EN): string {
	return options.some((o) => o.label.toLowerCase() === "other") ? s.otherCustom : s.other;
}

// ---------- state / answers ----------

export function newState(): QState {
	return { cursor: 0, picked: new Set(), notes: new Map() };
}

/** Answers for the current state, ordered: options by index, then custom text. */
export function answersOf(q: Question, st: QState): Answer[] {
	const text = st.other?.trim();
	if (getMode(q) === "text") return text ? [{ type: "text", label: text, value: text }] : [];
	const options = normalizeOptions(q.options);
	const answers: Answer[] = [...st.picked]
		.filter((i) => i >= 0 && i < options.length)
		.sort((a, b) => a - b)
		.map((i) => ({ type: "option", label: options[i].label, value: options[i].value, index: i + 1, ...(st.notes.has(i) ? { note: st.notes.get(i) } : {}) }));
	if (text) answers.push({ type: "other", label: text, value: text });
	return answers;
}

/** Single-select picks exactly one option (clearing custom text); multi-select toggles. */
export function pick(q: Question, st: QState, index: number): void {
	if (getMode(q) === "multi-select") {
		if (st.picked.has(index)) st.picked.delete(index);
		else st.picked.add(index);
	} else {
		st.picked = new Set([index]);
		st.other = undefined;
	}
}

/** Set (or clear, with empty text) the comment on an option; a non-empty comment also selects the option. */
export function setNote(q: Question, st: QState, index: number, text: string): void {
	const note = text.trim();
	if (!note) {
		st.notes.delete(index);
		return;
	}
	st.notes.set(index, note);
	if (getMode(q) === "multi-select") st.picked.add(index);
	else {
		st.picked = new Set([index]);
		st.other = undefined;
	}
}

/** Default answer for a question: matches an option by label/value, otherwise becomes custom text. */
export function defaultFor(q: Question): Answer[] | undefined {
	const d = q.defaultAnswer?.trim();
	if (!d) return undefined;
	const st = newState();
	if (getMode(q) !== "text") {
		const i = normalizeOptions(q.options).findIndex(
			(o) => o.label.toLowerCase() === d.toLowerCase() || o.value.toLowerCase() === d.toLowerCase(),
		);
		if (i >= 0) st.picked.add(i);
		else st.other = d;
	} else st.other = d;
	return answersOf(q, st);
}

/** Fill unanswered questions with their defaults. Returns undefined if some question has neither. */
export function fillDefaults(questions: Question[], answers: Answer[][]): QuestionResult[] | undefined {
	const results: QuestionResult[] = [];
	for (let i = 0; i < questions.length; i++) {
		const given = answers[i] ?? [];
		const fallback = given.length === 0 ? defaultFor(questions[i]) : undefined;
		const final = given.length > 0 ? given : fallback;
		if (!final) return undefined;
		results.push({
			question: questions[i].question,
			mode: getMode(questions[i]),
			answers: final,
			usedDefault: given.length === 0 ? true : undefined,
		});
	}
	return results;
}

// ---------- text for the model ----------

export function formatAnswer(a: Answer): string {
	if (a.type === "other") return `Other: ${a.label}`;
	if (a.type === "text") return a.label;
	const extras = [a.value !== a.label ? `value: ${a.value}` : "", a.note ? `note: ${a.note}` : ""].filter(Boolean);
	return `${a.index}. ${a.label}${extras.length ? ` (${extras.join("; ")})` : ""}`;
}

function describe(r: QuestionResult, s: Strings = EN): string {
	if (r.mode === "text") return `${s.answered} ${r.answers[0].label}`;
	if (r.mode === "single-select") return `${s.selected} ${formatAnswer(r.answers[0])}`;
	return `${s.selected}\n${r.answers.map((a) => `- ${formatAnswer(a)}`).join("\n")}`;
}

export function buildResultText(results: QuestionResult[], s: Strings = EN): string {
	if (results.length === 1) return describe(results[0], s);
	return results.map((r, i) => `Q${i + 1}: ${r.question}\n${describe(r, s)}`).join("\n\n");
}

// ---------- tool flow (UI injected, so it can be tested) ----------

export interface UiOutcome {
	status: "done" | "cancelled" | "timeout";
	answers: Answer[][]; // per question; empty array = unanswered
}

export interface ToolDetails {
	status: "answered" | "cancelled" | "unavailable";
	results: QuestionResult[];
	message?: string;
}

function toolResult(status: ToolDetails["status"], results: QuestionResult[], text: string, terminate?: boolean) {
	return {
		content: [{ type: "text" as const, text }],
		details: { status, results, message: text } as ToolDetails,
		...(terminate ? { terminate: true } : {}),
	};
}

/**
 * Whole tool flow. `ask` shows the dialog (and must close it itself when `signal` aborts);
 * `abort` stops the agent run. A timeout both sets `terminate` and aborts the run, because
 * `terminate` alone is ignored when a sibling tool call in the same batch succeeds.
 */
export async function runAsk(opts: {
	questions: Question[];
	signal?: AbortSignal;
	hasUI: boolean;
	ask: () => Promise<UiOutcome>;
	abort: () => void;
	S: Strings;
}) {
	const { questions, signal, hasUI, ask, abort, S } = opts;
	const cancelled = () => toolResult("cancelled", [], S.cancelled);
	if (signal?.aborted) return cancelled();

	if (!hasUI) {
		const defaults = fillDefaults(questions, []);
		if (!defaults) return toolResult("unavailable", [], S.noUI);
		return toolResult("answered", defaults, `${S.usedDefaults}.\n${buildResultText(defaults)}`);
	}

	// Race against abort so a queued (not yet shown) dialog cannot hang the run.
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<UiOutcome>((resolve) => {
		onAbort = () => resolve({ status: "cancelled", answers: [] });
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	let outcome: UiOutcome;
	try {
		outcome = await Promise.race([ask(), aborted]);
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}

	if (outcome.status === "timeout") {
		// Nobody answered: stop the run instead of guessing a default.
		abort();
		return toolResult("cancelled", [], S.timedOut, true);
	}
	if (outcome.status === "cancelled") return cancelled();
	const results = fillDefaults(questions, outcome.answers);
	return results ? toolResult("answered", results, buildResultText(results)) : cancelled();
}
