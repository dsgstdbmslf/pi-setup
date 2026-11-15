// Journal of actions on devices: one JSON line per action, no file contents and no output.
// Pure formatting plus a small file layer (append with rotation, tail read).

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
	/** Epoch ms. */
	ts: number;
	session: string;
	device: string;
	user: string;
	tool: string;
	/** Path or command, at most 200 characters, single line. */
	summary: string;
	/** "auto" | "asked→allowed" | "asked→denied" | "classifier:allow" | "classifier:deny" | "denied" | ... */
	decision: string;
	ok: boolean;
	/** Short result: "1.2 MB", "+3 −1", "exit 0". */
	detail?: string;
	ms: number;
}

export const MAX_SUMMARY = 200;
export const ROTATE_BYTES = 2 * 1024 * 1024;

export const shouldRotate = (size: number): boolean => size > ROTATE_BYTES;

export function cleanSummary(s: string): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > MAX_SUMMARY ? `${one.slice(0, MAX_SUMMARY - 1)}…` : one;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export const clock = (ts: number): string => {
	const d = new Date(ts);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

function fmtMs(ms: number): string {
	return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** "asked→allowed" -> "спросил → разрешено"; automatic decisions show nothing. */
export function decisionLabel(decision: string): string {
	switch (decision) {
		case "auto":
		case "":
			return "";
		case "asked→allowed":
			return "спросил → разрешено";
		case "asked→denied":
			return "спросил → отклонено";
		case "denied":
			return "отклонено";
		default:
			return decision.replace(/→/g, " → ");
	}
}

interface Widths {
	device: number;
	tool: number;
}

function line(e: JournalEntry, w: Widths): string {
	const parts = [clock(e.ts), e.device.padEnd(w.device), e.tool.padEnd(w.tool), cleanSummary(e.summary)];
	const tail: string[] = [e.ok ? "✓" : "✗"];
	const detail = [e.detail, (e.tool === "bash" || e.tool === "sudo") && e.ms >= 100 ? fmtMs(e.ms) : undefined].filter(Boolean).join(" · ");
	if (detail) tail.push(detail);
	const label = decisionLabel(e.decision);
	if (label) tail.push(label);
	return [...parts, tail.join(" ")].join("  ");
}

export function formatEntry(e: JournalEntry): string {
	return line(e, { device: 0, tool: 0 });
}

/** The last `n` entries (optionally of one device) in the §11 format, columns aligned. */
export function formatLog(entries: readonly JournalEntry[], opts: { device?: string; n: number }): string {
	const dev = opts.device?.toLowerCase();
	const list = entries.filter((e) => !dev || e.device.toLowerCase() === dev).slice(-Math.max(1, opts.n));
	if (!list.length) return "(no entries)";
	const w = { device: Math.max(...list.map((e) => e.device.length)), tool: Math.max(...list.map((e) => e.tool.length)) };
	return list.map((e) => line(e, w)).join("\n");
}

// --- files -------------------------------------------------------------------------------------

export const rotatedName = (file: string): string => file.replace(/(\.jsonl)?$/, ".1.jsonl");

/** Append one entry (mode 0600), rotating `log.jsonl` to `log.1.jsonl` beyond 2 MB. Throws on I/O errors. */
export function appendJournal(file: string, e: JournalEntry): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	try {
		if (shouldRotate(statSync(file).size)) renameSync(file, rotatedName(file));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	appendFileSync(file, `${JSON.stringify({ ...e, summary: cleanSummary(e.summary) })}\n`, { mode: 0o600 });
}

function parseLines(text: string): JournalEntry[] {
	const out: JournalEntry[] = [];
	for (const l of text.split("\n")) {
		if (!l.trim()) continue;
		try {
			const o = JSON.parse(l);
			if (o && typeof o.ts === "number" && typeof o.device === "string" && typeof o.tool === "string") {
				out.push({
					ts: o.ts,
					session: String(o.session ?? ""),
					device: o.device,
					user: String(o.user ?? ""),
					tool: o.tool,
					summary: String(o.summary ?? ""),
					decision: String(o.decision ?? ""),
					ok: o.ok === true,
					detail: typeof o.detail === "string" ? o.detail : undefined,
					ms: typeof o.ms === "number" ? o.ms : 0,
				});
			}
		} catch {}
	}
	return out;
}

/** The last `n` entries, oldest first; looks into the rotated file when the current one is short. Missing file = none. */
export function readJournal(file: string, n: number): JournalEntry[] {
	const read = (f: string) => {
		try {
			return parseLines(readFileSync(f, "utf8"));
		} catch {
			return [];
		}
	};
	let list = read(file);
	if (list.length < n) list = [...read(rotatedName(file)), ...list];
	return list.slice(-Math.max(0, n));
}
