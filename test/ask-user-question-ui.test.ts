// Drives the real dialog component with a stub TUI. Needs pi-tui (`npm install` pulls it in as a peer dependency).
import assert from "node:assert/strict";
import { test } from "node:test";
import { getStrings, type Question, type UiOutcome } from "../extensions/ask-user-question/logic.ts";

let askQuestions: typeof import("../extensions/ask-user-question/ui.ts").askQuestions | undefined;
try {
	({ askQuestions } = await import("../extensions/ask-user-question/ui.ts"));
} catch {
	// pi-tui not installed: tests below are skipped
}
const skip = askQuestions ? false : "pi-tui is not installed (run npm install)";

const theme: any = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s };
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";

const text: Question = { question: "Name?" };
const single: Question = { question: "DB?", options: [{ label: "PG" }, { label: "My", value: "my" }] };
const multi: Question = { question: "Many?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] };

function open(questions: Question[], timeoutSec?: number, signal?: AbortSignal) {
	let comp: any;
	const ctx = {
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					comp = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, null, resolve);
				}),
		},
	};
	const result = askQuestions!(ctx, questions, getStrings({}), timeoutSec, signal) as Promise<UiOutcome>;
	const press = (...keys: string[]) => keys.forEach((k) => comp.handleInput(k));
	const screen = () => comp.render(80).join("\n");
	return { result, press, screen };
}

test("single question, single-select: Enter picks and finishes", { skip }, async () => {
	const d = open([single]);
	d.press(DOWN, ENTER);
	assert.deepEqual((await d.result).answers[0].map((a) => a.label), ["My"]);
});

test("digit key selects directly", { skip }, async () => {
	const d = open([single]);
	d.press("1");
	assert.equal((await d.result).answers[0][0].label, "PG");
});

test("regression: typed text survives Enter and moving to the next question", { skip }, async () => {
	const d = open([text, single]);
	d.press("h", "i", ENTER, "1");
	d.press(ENTER); // Review -> submit
	const r = await d.result;
	assert.equal(r.status, "done");
	assert.equal(r.answers[0][0].label, "hi");
	assert.equal(r.answers[1][0].label, "PG");
});

test("Tab adds a comment to the highlighted option and selects it", { skip }, async () => {
	const d = open([single]);
	d.press(DOWN, TAB, "o", "k", ENTER);
	assert.match(d.screen(), /↳ ok/);
	d.press(ENTER); // confirm the (already selected) option
	const a = (await d.result).answers[0][0];
	assert.equal(a.label, "My");
	assert.equal(a.note, "ok");
});

test("Tab does not switch questions in option mode (←/→ does)", { skip }, async () => {
	const d = open([single, multi]);
	d.press(TAB, ESC); // opens and discards a note editor, still on Q1
	assert.match(d.screen(), /DB\?/);
	d.press(RIGHT);
	assert.match(d.screen(), /Many\?/);
});

test("Review refuses to submit until every question is answered", { skip }, async () => {
	const d = open([single, multi]);
	d.press("1"); // Q1 answered and advances to Q2, which stays unanswered
	d.press(RIGHT); // -> Review
	let settled = false;
	d.result.then(() => (settled = true));
	d.press(ENTER);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(settled, false);
	assert.match(d.screen(), /Answer every question/);
});

test("Esc cancels", { skip }, async () => {
	const d = open([single]);
	d.press(ESC);
	assert.equal((await d.result).status, "cancelled");
});

test("regression: abort closes the open dialog", { skip }, async () => {
	const ac = new AbortController();
	const d = open([single], undefined, ac.signal);
	ac.abort();
	assert.equal((await d.result).status, "cancelled");
});

test("timeout resolves as timeout and keeps partial answers", { skip }, async () => {
	const d = open([single, multi], 0.05);
	d.press("1"); // answers Q1, moves to Q2
	const r = await d.result;
	assert.equal(r.status, "timeout");
	assert.equal(r.answers[0][0].label, "PG");
	assert.deepEqual(r.answers[1], []);
});
