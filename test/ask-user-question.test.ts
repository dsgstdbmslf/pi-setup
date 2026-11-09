import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import {
	type Question,
	answersOf,
	buildResultText,
	defaultFor,
	fillDefaults,
	getMode,
	getOtherLabel,
	getStrings,
	newState,
	normalizeOptions,
	pick,
	runAsk,
	setNote,
} from "../extensions/ask-user-question/logic.ts";

const single: Question = { question: "DB?", options: [{ label: "PG" }, { label: "MySQL", value: "my" }] };
const multi: Question = { ...single, multiSelect: true };
const text: Question = { question: "Name?" };

test("normalizeOptions trims, defaults value, drops empty labels", () => {
	const o = normalizeOptions([{ label: " A ", description: " " }, { label: "", value: "x" }, { label: "B", value: " b " }]);
	assert.deepEqual(o, [
		{ label: "A", value: "A", description: undefined },
		{ label: "B", value: "b", description: undefined },
	]);
});

test("getMode", () => {
	assert.equal(getMode(text), "text");
	assert.equal(getMode({ question: "q", options: [] }), "text");
	assert.equal(getMode(single), "single-select");
	assert.equal(getMode(multi), "multi-select");
});

test("getOtherLabel avoids clashing with an option called Other", () => {
	assert.equal(getOtherLabel(normalizeOptions([{ label: "Other" }])), "Other (custom)");
	assert.equal(getOtherLabel(normalizeOptions([{ label: "A" }])), "Other");
});

test("single-select pick replaces the choice and clears custom text", () => {
	const st = newState();
	st.other = "custom";
	pick(single, st, 1);
	assert.deepEqual(answersOf(single, st), [{ type: "option", label: "MySQL", value: "my", index: 2 }]);
	pick(single, st, 0);
	assert.deepEqual(answersOf(single, st), [{ type: "option", label: "PG", value: "PG", index: 1 }]);
});

test("multi-select toggles, sorts, and appends custom text last", () => {
	const st = newState();
	pick(multi, st, 1);
	pick(multi, st, 0);
	st.other = "SQLite";
	assert.deepEqual(answersOf(multi, st).map((a) => a.type + ":" + a.label), ["option:PG", "option:MySQL", "other:SQLite"]);
	pick(multi, st, 0);
	assert.deepEqual(answersOf(multi, st).map((a) => a.label), ["MySQL", "SQLite"]);
});

test("text mode answers come from trimmed text only", () => {
	const st = newState();
	assert.deepEqual(answersOf(text, st), []);
	st.other = "  Ann ";
	assert.deepEqual(answersOf(text, st), [{ type: "text", label: "Ann", value: "Ann" }]);
});

test("defaultFor matches option by label or value, else custom text", () => {
	assert.equal(defaultFor(single), undefined);
	assert.deepEqual(defaultFor({ ...single, defaultAnswer: "pg" })?.[0], { type: "option", label: "PG", value: "PG", index: 1 });
	assert.equal(defaultFor({ ...single, defaultAnswer: "my" })?.[0].label, "MySQL");
	assert.equal(defaultFor({ ...single, defaultAnswer: "Oracle" })?.[0].type, "other");
	assert.equal(defaultFor({ ...text, defaultAnswer: "Bob" })?.[0].type, "text");
});

test("fillDefaults keeps given answers, fills the rest, fails without a default", () => {
	const given = [{ type: "text" as const, label: "Ann", value: "Ann" }];
	const withDefault = { ...single, defaultAnswer: "PG" };
	const r = fillDefaults([text, withDefault], [given, []])!;
	assert.deepEqual(r[0].answers, given);
	assert.equal(r[0].usedDefault, undefined);
	assert.equal(r[1].usedDefault, true);
	assert.equal(r[1].answers[0].label, "PG");
	assert.equal(fillDefaults([text, single], [given, []]), undefined);
});

test("buildResultText: one question vs several", () => {
	const a = fillDefaults([{ ...single, defaultAnswer: "PG" }], [])!;
	assert.equal(buildResultText(a), "User selected: 1. PG");
	const b = fillDefaults([{ ...text, defaultAnswer: "Bob" }, { ...multi, defaultAnswer: "PG" }], [])!;
	assert.equal(buildResultText(b), "Q1: Name?\nUser answered: Bob\n\nQ2: DB?\nUser selected:\n- 1. PG");
});

test("getStrings picks Russian from locale, PI_ASK_LANG wins", () => {
	assert.equal(getStrings({ LANG: "ru_RU.UTF-8" }).other, "Другое");
	assert.equal(getStrings({ LANG: "ru_RU.UTF-8", PI_ASK_LANG: "en" }).other, "Other");
	assert.equal(getStrings({}).other, "Other");
});

test("setNote attaches a comment, selects the option, and empty text clears it", () => {
	const st = newState();
	setNote(multi, st, 1, "  only on prod ");
	assert.deepEqual(answersOf(multi, st)[0], { type: "option", label: "MySQL", value: "my", index: 2, note: "only on prod" });
	assert.equal(buildResultText([{ question: "q", mode: "multi-select", answers: answersOf(multi, st) }]), "User selected:\n- 2. MySQL (value: my; note: only on prod)");
	setNote(multi, st, 1, "");
	assert.equal(st.notes.size, 0);

	const s1 = newState();
	pick(single, s1, 0);
	setNote(single, s1, 1, "why not");
	assert.deepEqual(answersOf(single, s1).map((a) => a.label), ["MySQL"]);
});

test("note of an unselected option is not reported", () => {
	const st = newState();
	setNote(single, st, 0, "hi");
	pick(single, st, 1);
	assert.equal(answersOf(single, st)[0].note, undefined);
});

test("model-visible text includes option value when it differs from the label", () => {
	const r = fillDefaults([{ ...single, defaultAnswer: "my" }], [])!;
	assert.equal(buildResultText(r), "User selected: 2. MySQL (value: my)");
});

const base = { questions: [single], hasUI: true, S: getStrings({}) };

test("runAsk: abort while the dialog is pending/queued settles as cancelled", async () => {
	const ac = new AbortController();
	const p = runAsk({ ...base, signal: ac.signal, ask: () => new Promise(() => {}), abort: () => {} });
	assert.equal(getEventListeners(ac.signal, "abort").length, 1);
	ac.abort();
	const r = await p;
	assert.equal(r.details.status, "cancelled");
	assert.equal("terminate" in r, false);
	assert.equal(getEventListeners(ac.signal, "abort").length, 0);
});

test("runAsk: already aborted never opens the dialog", async () => {
	const ac = new AbortController();
	ac.abort();
	let asked = false;
	const r = await runAsk({ ...base, signal: ac.signal, ask: async () => ((asked = true), { status: "done", answers: [] }), abort: () => {} });
	assert.equal(asked, false);
	assert.equal(r.details.status, "cancelled");
});

test("runAsk: timeout aborts the whole run and sets terminate, no default used", async () => {
	const ac = new AbortController();
	let aborted = 0;
	const r = await runAsk({
		...base,
		questions: [{ ...single, defaultAnswer: "PG" }],
		signal: ac.signal,
		ask: async () => ({ status: "timeout", answers: [[]] }),
		abort: () => {
			aborted++;
			ac.abort();
		},
	});
	assert.equal(aborted, 1);
	assert.equal((r as any).terminate, true);
	assert.equal(r.details.status, "cancelled");
	assert.deepEqual(r.details.results, []);
	assert.deepEqual(r.content, [{ type: "text", text: base.S.timedOut }]);
});

test("runAsk: answered, and no-UI falls back to defaults or reports unavailable", async () => {
	const answers = [[{ type: "option" as const, label: "MySQL", value: "my", index: 2 }]];
	const ok = await runAsk({ ...base, ask: async () => ({ status: "done", answers }), abort: () => {} });
	assert.equal(ok.details.status, "answered");
	assert.deepEqual(ok.details.results[0].answers, answers[0]);
	assert.deepEqual(ok.content, [{ type: "text", text: "User selected: 2. MySQL (value: my)" }]);
	const noUi = { ...base, hasUI: false, ask: async (): Promise<never> => assert.fail("no UI must not open a dialog"), abort: () => {} };
	assert.equal((await runAsk(noUi)).details.status, "unavailable");
	const defaulted = await runAsk({ ...noUi, questions: [{ ...single, defaultAnswer: "PG" }] });
	assert.equal(defaulted.details.status, "answered");
	assert.equal(defaulted.details.results[0].usedDefault, true);
	assert.equal(defaulted.details.results[0].answers[0].label, "PG");
});
