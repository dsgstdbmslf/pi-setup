// Show pasted screenshots as "[Image #N]" (like Claude Code) instead of raw file paths,
// and attach the image itself to the prompt.
//
// - Editor: a pasted image path (pi-clipboard-*, or <app>-paste-* saved by a terminal app)
//   becomes "[Image #N]".
// - Submit: the marker expands to "[Image #N: /path]" so the model still knows the path,
//   and the file is attached as an image block (input event; also covers typed paths).
// - Chat: user messages render "[Image #N: /path]" as "[Image #N]" (display-only).
// Rollback: delete this file and run /reload (or restart pi).
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

const IMG_EXT = "png|jpe?g|gif|webp";
// Paths produced by pi's own clipboard paste and by terminal apps that save pasted
// images as <app>-paste-<id>.<ext>.
const PASTE_PATH = new RegExp(
  String.raw`(?:/[^\s'"\]]*/)?(?:[A-Za-z0-9]+-paste|pi-clipboard)-[A-Za-z0-9-]+\.(?:${IMG_EXT})`,
  "gi",
);
const BARE_MARKER = /\[Image #(\d+)\]/g;
const FULL_MARKER = new RegExp(String.raw`\[Image #(\d+): ([^\]\n]+?\.(?:${IMG_EXT}))\]`, "gi");
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Session-wide numbering, shared by editor and input handler.
const paths = new Map<number, string>();
let counter = 0;
const register = (path: string): number => {
  for (const [id, p] of paths) if (p === path) return id;
  paths.set(++counter, path);
  return counter;
};

// "[Image #N: /path]" -> "[Image #N]", only when /path is the one registered for N.
export const collapseMarkers = (text: string): string =>
  text.replace(FULL_MARKER, (m, id, p) => (paths.get(Number(id)) === p ? `[Image #${id}]` : m));

// @ts-ignore TS2415: expandPasteMarkers is private in pi-tui typings; overriding it is intentional (see below).
export class ImageMarkerEditor extends CustomEditor {
  handlePaste(text: string): void {
    const replaced = text.replace(PASTE_PATH, (p) => `[Image #${register(p)}]`);
    super.handlePaste(replaced);
  }
  // pi pulls the editor text through getExpandedText() and restores it with setText()
  // (ctx.ui.custom(), editor component swap, queued-message restore), which would leave the
  // full "[Image #N: /path]" in the editor. Fold registered markers back to "[Image #N]".
  // Note: setText() resets pi's own [paste #N] registry, so those come back expanded (pi behaviour).
  setText(text: string): void {
    super.setText(collapseMarkers(text));
  }
  // Prompt history stores the expanded submitted text; navigateHistory() uses the private
  // setTextInternal() (bypasses setText), so collapse on the way in instead.
  addToHistory(text: string): void {
    super.addToHistory(collapseMarkers(text));
  }
  // pi-tui declares expandPasteMarkers `private`, but both getExpandedText() and the submit
  // path (private submitValue) call it, so overriding it is the only hook that covers submit.
  // test/image-paste-markers.test.ts fails if pi-tui stops calling it.
  expandPasteMarkers(text: string): string {
    // @ts-ignore TS2340: super.expandPasteMarkers is private in pi-tui typings.
    const expanded = super.expandPasteMarkers(text);
    return expanded.replace(BARE_MARKER, (m: string, id: string) => {
      const p = paths.get(Number(id));
      return p ? `[Image #${id}: ${p}]` : m;
    });
  }
}

async function loadImage(path: string) {
  try {
    if (!(await stat(path)).isFile()) return undefined;
    const mimeType = MIME[extname(path).toLowerCase()];
    if (!mimeType) return undefined;
    return { type: "image" as const, data: (await readFile(path)).toString("base64"), mimeType };
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    paths.clear();
    counter = 0;
    try {
      for (const entry of ctx.sessionManager.getEntries() as any[]) {
        const content = entry?.message?.role === "user" ? entry.message.content : undefined;
        const texts = typeof content === "string" ? [content] : (content ?? []).map((c: any) => c?.text ?? "");
        for (const t of texts) for (const m of String(t).matchAll(/\[Image #(\d+)/g)) counter = Math.max(counter, Number(m[1]));
      }
    } catch {}
    if (ctx.hasUI === false || ctx.ui.getEditorComponent?.()) return; // keep another extension's editor
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new ImageMarkerEditor(tui, theme, keybindings));
  });

  pi.on("input", async (event) => {
    let text = event.text;
    // Raw paths that bypassed the editor paste (typed, prefill, rpc).
    text = text.replace(PASTE_PATH, (p, offset: number, all: string) =>
      /\[Image #\d+: $/.test(all.slice(Math.max(0, offset - 20), offset)) ? p : `[Image #${register(p)}: ${p}]`,
    );
    const known = new Set((event.images ?? []).map((i: any) => i?.data));
    const images = [...(event.images ?? [])];
    let added = 0;
    for (const m of text.matchAll(FULL_MARKER)) {
      const img = await loadImage(m[2]);
      if (img && !known.has(img.data)) {
        known.add(img.data);
        images.push(img);
        added++;
      }
    }
    if (!added && text === event.text) return { action: "continue" };
    return { action: "transform", text, images };
  });

  pi.registerMarkdownTransformer((markdown, { messageType }) =>
    messageType === "user" ? markdown.replace(FULL_MARKER, "[Image #$1]") : markdown,
  );
}
