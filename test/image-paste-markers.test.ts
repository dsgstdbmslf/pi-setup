// Drives the real ImageMarkerEditor (pi-coding-agent CustomEditor) with a stub TUI and the
// extension's event handlers with a fake pi API. Needs `npm install` (peer deps).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { Editor, KeybindingsManager, TUI_KEYBINDINGS, setKeybindings } from "@earendil-works/pi-tui";
import extension, { collapseMarkers, ImageMarkerEditor } from "../extensions/image-paste-markers.ts";

const id = (s: string) => s;
const theme: any = { borderColor: id, selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id } };
const keybindings: any = new KeybindingsManager(TUI_KEYBINDINGS);
setKeybindings(keybindings);
const tui: any = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
const BACKSPACE = "\x7f";

const handlers = new Map<string, any>();
let transformer: any;
extension({
  on: (name: string, fn: any) => handlers.set(name, fn),
  registerMarkdownTransformer: (fn: any) => (transformer = fn),
} as any);

let installed: any;
const startSession = (entries: any[] = [], extra: any = {}) =>
  handlers.get("session_start")({}, {
    sessionManager: { getEntries: () => entries },
    hasUI: true,
    ui: { getEditorComponent: () => undefined, setEditorComponent: (f: any) => (installed = f) },
    ...extra,
  });
const newEditor = () => new ImageMarkerEditor(tui, theme, keybindings);
const paste = (e: { handleInput(d: string): void }, text: string) => e.handleInput(`\x1b[200~${text}\x1b[201~`);

const dir = await mkdtemp(join(tmpdir(), "img-markers-"));
after(() => rm(dir, { recursive: true, force: true }));
const png = join(dir, "pi-clipboard-abc.png");
const png2 = join(dir, "Ghostty-paste-xyz.jpg");
await writeFile(png, "png-bytes");
await writeFile(png2, "jpg-bytes");

beforeEach(async () => {
  await startSession();
});

test("session_start installs the editor component", () => {
  assert.ok(installed(tui, theme, keybindings) instanceof ImageMarkerEditor);
});

test("handlePaste: image paths become [Image #N]; same path reuses N", () => {
  const e = newEditor();
  paste(e, png);
  assert.equal(e.getText(), "[Image #1]");
  paste(e, ` ${png2}`);
  assert.equal(e.getText(), "[Image #1] [Image #2]");
  paste(e, ` ${png}`);
  assert.equal(e.getText(), "[Image #1] [Image #2] [Image #1]");
});

test("handlePaste: non-image text and other paths are untouched", () => {
  const e = newEditor();
  paste(e, "hello /tmp/photo.png and /tmp/notes.txt");
  assert.equal(e.getText(), "hello /tmp/photo.png and /tmp/notes.txt");
});

test("round trip: getExpandedText expands, setText collapses back", () => {
  const e = newEditor();
  paste(e, `see ${png}`);
  assert.equal(e.getText(), "see [Image #1]");
  const expanded = e.getExpandedText();
  assert.equal(expanded, `see [Image #1: ${png}]`);
  const e2 = newEditor();
  e2.setText(expanded);
  assert.equal(e2.getText(), "see [Image #1]");
  assert.equal(e2.getExpandedText(), expanded);
});

test("setText keeps markers whose path is unregistered or different", () => {
  const e = newEditor();
  paste(e, png); // #1
  const other = `[Image #1: ${png2}] [Image #7: ${png}] [Image #1: /nope/x.png] [Image #1]`;
  e.setText(other);
  assert.equal(e.getText(), other);
  assert.equal(collapseMarkers("plain [paste #1 +20 lines] text"), "plain [paste #1 +20 lines] text");
});

test("restored text: cursor at end, undoable, and submit still expands", () => {
  const e = newEditor();
  paste(e, png);
  let submitted: string | undefined;
  e.onSubmit = (t) => (submitted = t);
  e.setText("other");
  e.setText(`x [Image #1: ${png}]`);
  assert.equal(e.getText(), "x [Image #1]");
  assert.deepEqual(e.getCursor(), { line: 0, col: "x [Image #1]".length });
  e.handleInput("\x1f"); // ctrl+- = undo
  assert.equal(e.getText(), "other");
  e.setText(`[Image #1: ${png}]`);
  e.handleInput("\r");
  assert.equal(submitted, `[Image #1: ${png}]`);
});

test("history: submitted expanded text is recalled as the short marker and re-expands", () => {
  const e = newEditor();
  e.addToHistory(`look [Image #1: ${png}]`); // registered? not yet -> unchanged
  paste(e, png);
  e.setText("");
  e.addToHistory(`look [Image #1: ${png}]`);
  e.handleInput("\x1b[A");
  assert.equal(e.getText(), "look [Image #1]");
  assert.equal(e.getExpandedText(), `look [Image #1: ${png}]`);
});

test("pi-tui contract: getExpandedText and submit both go through expandPasteMarkers", () => {
  // Guards the override of a private pi-tui method: fail loudly if pi-tui stops calling it.
  const calls: string[] = [];
  class Probe extends ImageMarkerEditor {
    expandPasteMarkers(text: string): string {
      calls.push(text);
      return super.expandPasteMarkers(text);
    }
  }
  const e = new Probe(tui, theme, keybindings);
  paste(e, png);
  assert.equal(e.getExpandedText(), `[Image #1: ${png}]`);
  assert.equal(calls.length, 1);
  let submitted = "";
  e.onSubmit = (t) => (submitted = t);
  e.handleInput("\r");
  assert.equal(calls.length, 2);
  assert.equal(submitted, `[Image #1: ${png}]`);
  assert.equal(typeof (Editor.prototype as any).expandPasteMarkers, "function");
});

const bigPaste = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");

test("backspace: [paste #1 ...][Image #2] — image marker deleted per char, paste marker stays atomic", () => {
  const e = newEditor();
  paste(e, bigPaste);
  paste(e, png);
  assert.equal(e.getText(), "[paste #1 +12 lines][Image #1]");
  e.handleInput(BACKSPACE);
  assert.equal(e.getText(), "[paste #1 +12 lines][Image #1");
  for (let i = 0; i < "[Image #1".length; i++) e.handleInput(BACKSPACE);
  assert.equal(e.getText(), "[paste #1 +12 lines]");
  assert.equal(e.getExpandedText(), bigPaste);
});

test("backspace: [Image #1][paste #1 ...] — deleting the paste marker removes it whole, image marker intact", () => {
  const e = newEditor();
  paste(e, png);
  paste(e, bigPaste);
  assert.equal(e.getText(), "[Image #1][paste #1 +12 lines]");
  assert.equal(e.getExpandedText(), `[Image #1: ${png}]${bigPaste}`);
  e.handleInput(BACKSPACE);
  assert.equal(e.getText(), "[Image #1]");
  assert.equal(e.getExpandedText(), `[Image #1: ${png}]`);
});

const run = (text: string, images?: any[]) => handlers.get("input")({ text, images, source: "interactive" });

test("input: full marker attaches the image", async () => {
  const r = await run(`a [Image #1: ${png}]`);
  assert.equal(r.action, "transform");
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].mimeType, "image/png");
  assert.equal(r.images[0].data, Buffer.from("png-bytes").toString("base64"));
  assert.equal(r.text, `a [Image #1: ${png}]`);
});

test("input: raw path is wrapped into a full marker and attached", async () => {
  const r = await run(`look ${png2}`);
  assert.equal(r.action, "transform");
  assert.equal(r.text, `look [Image #1: ${png2}]`);
  assert.equal(r.images[0].mimeType, "image/jpeg");
});

test("input: both forms together, duplicates are not attached twice", async () => {
  const r = await run(`[Image #1: ${png}] and ${png} again [Image #1: ${png}]`);
  assert.equal(r.images.length, 1);
  assert.equal(r.text, `[Image #1: ${png}] and [Image #1: ${png}] again [Image #1: ${png}]`);
});

test("input: an already attached identical image is not duplicated", async () => {
  const data = Buffer.from("png-bytes").toString("base64");
  const r = await run(`[Image #1: ${png}]`, [{ type: "image", data, mimeType: "image/png" }]);
  assert.equal(r.action, "continue");
});

test("input: missing file is ignored; plain text continues", async () => {
  const missing = join(dir, "pi-clipboard-missing.png");
  const r = await run(`[Image #3: ${missing}]`);
  assert.equal(r.action, "continue");
  assert.equal((await run("just text")).action, "continue");
});

test("input: image-only message still carries text and image (steer/follow-up use the same handler)", async () => {
  const r = await run(`[Image #1: ${png}]`);
  assert.equal(r.action, "transform");
  assert.ok(r.text.trim().length > 0);
  assert.equal(r.images.length, 1);
});

test("markdown transformer shortens full markers for user messages only", () => {
  const md = `x [Image #2: ${png}]`;
  assert.equal(transformer(md, { messageType: "user" }), "x [Image #2]");
  assert.equal(transformer(md, { messageType: "assistant" }), md);
});

test("session_start resets paths/counter and continues numbering from history", async () => {
  const e = newEditor();
  paste(e, png);
  assert.equal(e.getText(), "[Image #1]");
  await startSession([
    { message: { role: "user", content: [{ type: "text", text: `x [Image #4: ${png2}]` }] } },
    { message: { role: "user", content: "[Image #2] y" } },
    { message: { role: "assistant", content: "[Image #9]" } },
  ]);
  const e2 = newEditor();
  paste(e2, png);
  assert.equal(e2.getText(), "[Image #5]");
  // registry was reset: old #1 path is no longer registered, so it is not collapsed
  e2.setText(`[Image #1: ${png}]`);
  assert.equal(e2.getText(), `[Image #1: ${png}]`);
  // a fresh session starts again from 1
  await startSession();
  const e3 = newEditor();
  paste(e3, png2);
  assert.equal(e3.getText(), "[Image #1]");
});

test("session_start keeps another extension's editor", async () => {
  installed = undefined;
  await startSession([], { ui: { getEditorComponent: () => () => ({}), setEditorComponent: (f: any) => (installed = f) } });
  assert.equal(installed, undefined);
});
