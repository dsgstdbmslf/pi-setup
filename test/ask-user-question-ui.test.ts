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
const SHIFT_TAB = "\x1b[Z";

const text: Question = { question: "Name?" };
const single: Question = { question: "DB?", options: [{ label: "PG" }, { label: "My", value: "my" }] };
const multi: Question = { question: "Many?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] };

function open(questions: Question[], timeoutSec?: number, signal?: AbortSignal) {
	let comp: any;
	let completed = false;
	let options: any;
	const ctx = {
		ui: {
			custom: (factory: any, opts?: any) =>
				new Promise((resolve) => {
					options = opts;
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
	return { result, press, screen, completed: () => completed, options: () => options };
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

test("reports pi as blocked on the first question (one line, bounded)", () => {
	const long = { question: `Line one\nline two ${"x".repeat(300)}` };
	const d = open([long, single]);
	const { blocked } = d.options();
	assert.equal(blocked.kind, "question");
	assert.ok(!blocked.message.includes("\n"));
	assert.ok(blocked.message.startsWith("Line one line two"));
	assert.ok(blocked.message.length <= 200);
	assert.equal(open([single]).options().blocked.message, "DB?");
});

const many = (n: number, multiSelect = false): Question => ({
	question: "Pick?",
	multiSelect,
	options: Array.from({ length: n }, (_, i) => ({ label: `opt${i + 1}`, description: i === 12 ? "desc13" : undefined })),
});
const rows = (screen: string) => screen.split("\n").filter((l) => /^(> |  )(\(•\)|\( \)|\[x\]|\[ \]|[✓○]) /.test(l));

test("long list shows a window of 10 items with a 'more' hint", () => {
	const d = open([many(15)]);
	assert.equal(rows(d.screen()).length, 10);
	assert.match(d.screen(), /↓ 6 more/);
	assert.doesNotMatch(d.screen(), /↑ \d+ more/);
	assert.match(d.screen(), /> \( \) 1\. opt1/);
});

test("window follows the cursor (Down) and keeps it highlighted", () => {
	const d = open([many(15)]);
	d.press(...Array(12).fill(DOWN)); // cursor on opt13
	const s = d.screen();
	assert.ok(rows(s).length <= 10);
	assert.match(s, /> \( \) 13\. opt13/);
	assert.match(s, /desc13/);
	assert.match(s, /↑ \d+ more/);
	assert.doesNotMatch(s, /\. opt1\n/);
	d.press(...Array(10).fill(DOWN)); // clamps on Other
	assert.match(d.screen(), /> \( \) Other/);
	assert.doesNotMatch(d.screen(), /↓ \d+ more/);
});

test("multi-select window includes Other and Submit", () => {
	const d = open([many(15, true)]);
	d.press(...Array(20).fill(DOWN));
	assert.match(d.screen(), /> ○ Submit/);
	assert.match(d.screen(), /Other/);
	assert.ok(rows(d.screen()).length <= 10);
});

test("digit picks an option outside the window", async () => {
	const d = open([many(15)]);
	d.press("9");
	assert.equal((await d.result).answers[0][0].label, "opt9");
	const d2 = open([many(15)]);
	d2.press(...Array(14).fill(DOWN), "3"); // window scrolled to the bottom, opt3 is out of view
	assert.equal((await d2.result).answers[0][0].label, "opt3");
});

test("list of 10 or fewer renders without a window", () => {
	const d = open([many(9)]);
	assert.equal(rows(d.screen()).length, 10); // 9 options + Other
	assert.doesNotMatch(d.screen(), /more/);
});

// ---- large pastes: marker on screen, full text to the model ----
const BIG = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n");
const PASTE = `\x1b[200~${BIG}\x1b[201~`;
const MARKER = "[paste #1 +15 lines]";

test("paste into Other: marker on screen and in the editor, full text in the answer", async () => {
	const d = open([single]);
	d.press(DOWN, DOWN, ENTER, PASTE);
	assert.ok(d.screen().includes(MARKER));
	assert.doesNotMatch(d.screen(), /line7/);
	d.press(ENTER);
	const a = (await d.result).answers[0][0];
	assert.equal(a.type, "other");
	assert.equal(a.label, BIG);
});

test("paste into Other stays a marker in the option row and on Review", async () => {
	const d = open([multi, single]);
	d.press(DOWN, DOWN, ENTER, PASTE, ENTER); // Other of the multi-select, saved
	assert.match(d.screen(), new RegExp(`\\[x\\] Other — \\[paste #1 \\+15 lines\\]`));
	assert.doesNotMatch(d.screen(), /line7/);
	d.press(RIGHT, RIGHT); // Review
	assert.ok(d.screen().includes(`Other: ${MARKER}`));
	assert.doesNotMatch(d.screen(), /line7/);
});

test("paste into a text question", async () => {
	const d = open([text]);
	d.press(PASTE);
	assert.ok(d.screen().includes(MARKER));
	d.press(ENTER);
	const a = (await d.result).answers[0][0];
	assert.equal(a.type, "text");
	assert.equal(a.label, BIG);
});

test("paste into an option comment (Tab)", async () => {
	const d = open([single]);
	d.press(TAB, PASTE);
	assert.ok(d.screen().includes(MARKER));
	d.press(ENTER);
	assert.ok(d.screen().includes(`↳ ${MARKER}`));
	assert.doesNotMatch(d.screen(), /line7/);
	d.press(ENTER);
	const a = (await d.result).answers[0][0];
	assert.equal(a.label, "PG");
	assert.equal(a.note, BIG);
});

test("unsent paste survives Tab / Shift+Tab between questions", async () => {
	const d = open([text, text]);
	d.press(PASTE, TAB); // Q1 -> Q2 with an unsent paste
	d.press("b", SHIFT_TAB); // back to Q1
	assert.ok(d.screen().includes(MARKER));
	d.press(TAB, TAB); // Q2 -> Review
	assert.ok(d.screen().includes(MARKER));
	assert.doesNotMatch(d.screen(), /line7/);
	d.press(ENTER);
	const r = await d.result;
	assert.equal(r.answers[0][0].label, BIG);
	assert.equal(r.answers[1][0].label, "b");
});

test("returning to a field shows the marker again and still sends the full text", async () => {
	const d = open([text, single]);
	d.press(PASTE, ENTER); // Q1 answered, now Q2
	d.press(LEFT); // back to Q1
	assert.ok(d.screen().includes(MARKER));
	assert.doesNotMatch(d.screen(), /line7/);
	d.press(ENTER); // resubmit unchanged -> Q2
	d.press("1", ENTER); // PG, then Review submit
	const r = await d.result;
	assert.equal(r.answers[0][0].label, BIG);
	assert.equal(r.answers[1][0].label, "PG");
});

test("Esc on a comment discards the edit but keeps the saved paste valid", async () => {
	const d = open([single]);
	d.press(TAB, PASTE, ENTER); // saved comment with a paste
	d.press(TAB, "x", ESC); // edit and discard
	d.press(TAB);
	assert.ok(d.screen().includes(MARKER));
	assert.doesNotMatch(d.screen(), /lines\]x/);
	d.press(ENTER, ENTER);
	assert.equal((await d.result).answers[0][0].note, BIG);
});
