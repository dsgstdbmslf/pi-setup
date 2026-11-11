// Guards the renderToken patch against pi-tui API changes. Needs pi-tui (`npm install` pulls it in as a peer dependency).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Markdown } from "@earendil-works/pi-tui";
import codeFenceHide from "../extensions/code-fence-hide.ts";

const id = (s: string) => s;
const theme: any = {
	heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id, quote: id,
	quoteBorder: id, hr: id, listBullet: id, bold: id, italic: id, strikethrough: id, underline: id,
};
const ANSI = /\x1b\[[0-9;:?]*[ -\/]*[@-~]/g;

assert.equal(
	typeof (Markdown as any).prototype.renderToken,
	"function",
	"pi-tui API moved: Markdown.prototype.renderToken is gone. Update extensions/code-fence-hide.ts (and its METHOD constant) or fences will show again.",
);
codeFenceHide();
codeFenceHide(); // idempotent: a second call must not wrap again

const render = (md: string) =>
	new Markdown(md, 0, 0, theme).render(60).map((l) => l.replace(ANSI, "").trimEnd());
const fences = (lines: string[]) => lines.filter((l) => /^[\s│]*(```|~~~)/.test(l));

test("renderToken exists and is patched exactly once", () => {
	const proto = (Markdown as any).prototype;
	assert.equal(typeof proto.renderToken, "function", "pi-tui API moved: update code-fence-hide");
	assert.equal(proto[Symbol.for("code-fence-hide.patched")], true);
	const out = render("```ts\nx\n```");
	assert.deepEqual(out.filter(Boolean), ["  x"]);
});

test("hides fences, keeps code and surrounding text", () => {
	const out = render("before\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nafter");
	assert.deepEqual(fences(out), []);
	assert.deepEqual(out.filter(Boolean), ["before", "  const a = 1;", "  const b = 2;", "after"]);
});

test("fence without language and ~~~ fences are hidden", () => {
	assert.deepEqual(render("```\nplain\n```").filter(Boolean), ["  plain"]);
	// pi-tui re-emits ~~~ blocks as ``` lines, so they are hidden too
	assert.deepEqual(render("~~~sh\nls\n~~~").filter(Boolean), ["  ls"]);
});

test("code inside blockquote and list item", () => {
	const quote = render("> q\n>\n> ```ts\n> y\n> ```");
	assert.deepEqual(fences(quote), []);
	assert.ok(quote.some((l) => l.includes("y")) && quote.some((l) => l.includes("q")));
	const list = render("- item\n\n  ```ts\n  z\n  ```");
	assert.deepEqual(fences(list), []);
	assert.ok(list.some((l) => l.includes("z")) && list.some((l) => l.includes("item")));
});

test("unclosed fence while streaming keeps all code lines", () => {
	const out = render("```ts\nline1\nline2");
	assert.deepEqual(fences(out), []);
	assert.deepEqual(out.filter(Boolean), ["  line1", "  line2"]);
});

test("code that itself contains fence lines is kept", () => {
	const out = render("````md\n```ts\nx\n```\n````");
	assert.deepEqual(out.filter(Boolean), ["  ```ts", "  x", "  ```"]);
});

test("inline backticks are untouched", () => {
	const out = render("use ``` inline and `code` here");
	assert.deepEqual(out.filter(Boolean), ["use ``` inline and code here"]);
});

test("invalid mermaid (falls back to a plain code block) loses fences", () => {
	const out = render("```mermaid\nnot a diagram\n```");
	assert.deepEqual(out.filter(Boolean), ["  not a diagram"]);
});
