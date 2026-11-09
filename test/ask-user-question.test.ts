import assert from "node:assert/strict";
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
	assert.equal(answersOf(multi, st).length, 2);
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
	assert.equal(buildResultText([{ question: "q", mode: "multi-select", answers: answersOf(multi, st) }]), "User selected:\n- 2. MySQL (note: only on prod)");
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
