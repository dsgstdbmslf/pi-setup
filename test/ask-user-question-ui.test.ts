// Drives the real dialog component with a stub TUI. Needs pi-tui (`npm install` pulls it in as a peer dependency).
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { getStrings, type Question, type UiOutcome } from "../extensions/ask-user-question/logic.ts";

import { askQuestions } from "../extensions/ask-user-question/ui.ts";

const theme: any = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s };
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

const text: Question = { question: "Name?" };
const single: Question = { question: "DB?", options: [{ label: "PG" }, { label: "My", value: "my" }] };
const multi: Question = { question: "Many?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] };

function open(questions: Question[], timeoutSec?: number, signal?: AbortSignal) {
	let comp: any;
	let completed = false;
	const ctx = {
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					comp = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, null, (outcome: UiOutcome) => {
						completed = true;
						resolve(outcome);
					});
				}),
		},
	};
	const result = askQuestions(ctx, questions, getStrings({}), timeoutSec, signal) as Promise<UiOutcome>;
	const press = (...keys: string[]) => keys.forEach((k) => comp.handleInput(k));
	const screen = () => comp.render(80).join("\n");
	return { result, press, screen, completed: () => completed };
}

test("single question, single-select: Enter picks and finishes", async () => {
	const d = open([single]);
	d.press(DOWN, ENTER);
	const r = await d.result;
	assert.equal(r.status, "done");
	assert.deepEqual(r.answers[0].map((a) => a.label), ["My"]);
});

test("digit key selects directly", async () => {
	const d = open([single]);
	d.press("1");
	const r = await d.result;
	assert.equal(r.status, "done");
	assert.equal(r.answers[0][0].label, "PG");
});

test("regression: typed text survives Enter and moving to the next question", async () => {
	const d = open([text, single]);
	d.press("h", "i", ENTER, "1");
	d.press(ENTER); // Review -> submit
	const r = await d.result;
	assert.equal(r.status, "done");
	assert.equal(r.answers[0][0].label, "hi");
	assert.equal(r.answers[1][0].label, "PG");
});

test("Tab adds a comment to the highlighted option and selects it", async () => {
	const d = open([single]);
	d.press(DOWN, TAB, "o", "k", ENTER);
	assert.match(d.screen(), /↳ ok/);
	assert.match(d.screen(), /\(•\) 2\. My/); // selected by the note, not by the Enter below
	d.press(ENTER); // confirm the (already selected) option
	const a = (await d.result).answers[0][0];
	assert.equal(a.label, "My");
	assert.equal(a.note, "ok");
});

test("Tab does not switch questions in option mode (←/→ does)", async () => {
	const d = open([single, multi]);
	d.press(TAB);
	assert.match(d.screen(), /Comment on option 1/);
	d.press(ESC); // discards the note editor, still on Q1
	assert.match(d.screen(), /DB\?/);
	assert.doesNotMatch(d.screen(), /Many\?/);
	d.press(RIGHT);
	assert.match(d.screen(), /Many\?/);
	assert.doesNotMatch(d.screen(), /DB\?/);
	d.press(LEFT);
	assert.match(d.screen(), /DB\?/);
	d.press(ESC);
	assert.equal((await d.result).status, "cancelled");
});

test("Review refuses to submit until every question is answered", async () => {
	const d = open([single, multi]);
	d.press("1"); // Q1 answered and advances to Q2, which stays unanswered
	d.press(RIGHT); // -> Review
	d.press(ENTER);
	assert.equal(d.completed(), false);
	assert.match(d.screen(), /Answer every question/);
	d.press(LEFT, "1", RIGHT, ENTER); // answer Q2, then submit from Review
	const r = await d.result;
	assert.equal(r.status, "done");
	assert.deepEqual(r.answers.map((answers) => answers.map((a) => a.label)), [["PG"], ["a"]]);
});

test("Esc cancels", async () => {
	const d = open([single]);
	d.press(ESC);
	assert.equal((await d.result).status, "cancelled");
});

test("regression: abort closes the open dialog", async () => {
	const ac = new AbortController();
	const d = open([single], undefined, ac.signal);
	assert.equal(getEventListeners(ac.signal, "abort").length, 1);
	ac.abort();
	assert.equal((await d.result).status, "cancelled");
	assert.equal(getEventListeners(ac.signal, "abort").length, 0);
});

test("timeout resolves as timeout and keeps partial answers", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const d = open([single, multi], 0.05);
	d.press("1"); // answers Q1, moves to Q2
	t.mock.timers.tick(49);
	assert.equal(d.completed(), false);
	t.mock.timers.tick(1);
	const r = await d.result;
	assert.equal(r.status, "timeout");
	assert.equal(r.answers[0][0].label, "PG");
	assert.deepEqual(r.answers[1], []);
});
