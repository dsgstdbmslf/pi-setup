// Output helpers shared by the web-* extensions: display sanitizing and full-text files.
// No pi imports, so tests run without node_modules.

import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** Per-user suffix: uid on POSIX, a sanitized user name on Windows (no getuid there). */
function userTag(): string {
	if (process.getuid) return String(process.getuid());
	try {
		return userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_") || "user";
	} catch {
		return "user";
	}
}

/** Where full outputs go when a tool result is truncated. Per user, so no one else's directory is shared. */
export const OUT_DIR = join(tmpdir(), `pi-web-search-${userTag()}`);
const KEEP_MS = 24 * 3600 * 1000;
/** Names saveFull creates; cleanup touches nothing else. */
const SAVED_NAME = /^\d+-[0-9a-f]{6}\.md$/;

/** Strip escape sequences and control characters before display. */
export function sanitize(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** "1 result", "2 results". */
export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Create the directory for 0700 and refuse one that is a symlink, not ours, or not a directory (/tmp is shared). */
export async function ensurePrivateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const st = await lstat(dir);
	if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a private directory`);
	if (process.platform === "win32") return;
	if (st.uid !== process.getuid?.()) throw new Error(`${dir} is not a private directory (owned by another user)`);
	if (st.mode & 0o077) await chmod(dir, 0o700); // created earlier under a looser umask
}

export async function saveFull(text: string, dir = OUT_DIR): Promise<string> {
	await ensurePrivateDir(dir);
	const file = join(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.md`);
	// "wx": exclusive create, never follows or overwrites an existing file or symlink.
	await writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return file;
}

/** Delete saved outputs older than a day. Runs detached, so it never rejects. Returns the number deleted. */
export async function cleanupSaved(dir = OUT_DIR, now = Date.now()): Promise<number> {
	let deleted = 0;
	try {
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names) {
			if (!SAVED_NAME.test(name)) continue;
			try {
				const file = join(dir, name);
				const st = await lstat(file); // lstat: a symlink is not a regular file and stays untouched
				if (!st.isFile() || st.mtimeMs >= now - KEEP_MS) continue;
				await rm(file, { force: true });
				deleted++;
			} catch {
				// one unremovable entry must not stop the rest
			}
		}
	} catch {
		// best effort
	}
	return deleted;
}
