// Output helpers shared by the web-* extensions: display sanitizing and full-text files.
// No pi imports, so tests run without node_modules.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where full outputs go when a tool result is truncated. */
export const OUT_DIR = join(tmpdir(), "pi-web-search");
const KEEP_MS = 24 * 3600 * 1000;

/** Strip escape sequences and control characters before display. */
export function sanitize(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** "1 result", "2 results". */
export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export async function saveFull(text: string, dir = OUT_DIR): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.md`);
	await writeFile(file, text, "utf8");
	return file;
}

/** Delete saved outputs older than a day. */
export async function cleanupSaved(dir = OUT_DIR, now = Date.now()): Promise<void> {
	const names = await readdir(dir).catch(() => [] as string[]);
	for (const name of names) {
		const file = join(dir, name);
		const st = await stat(file).catch(() => null);
		if (st && st.mtimeMs < now - KEEP_MS) await rm(file, { force: true });
	}
}
