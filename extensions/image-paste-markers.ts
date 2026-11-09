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

class ImageMarkerEditor extends CustomEditor {
  handlePaste(text: string): void {
    const replaced = text.replace(PASTE_PATH, (p) => `[Image #${register(p)}]`);
    super.handlePaste(replaced);
  }
  expandPasteMarkers(text: string): string {
    const expanded = super.expandPasteMarkers(text);
    return expanded.replace(BARE_MARKER, (m, id) => {
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
