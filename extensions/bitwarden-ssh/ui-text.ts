// Pure formatting helpers for status lines, lists and confirm dialogs. Unit-tested.

export function formatDuration(ms: number): string {
	const min = Math.max(0, Math.round(ms / 60_000));
	if (min < 1) return "<1m";
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}

export type FooterState =
	| { kind: "missing" }
	| { kind: "unauthenticated" }
	| { kind: "locked" | "unlocked"; loaded: number }
	| { kind: "error" };

export function footerText(s: FooterState): string {
	switch (s.kind) {
		case "missing":
			return "bw: not installed";
		case "unauthenticated":
			return "bw: logged out";
		case "error":
			return "bw: ?";
		default:
			return `${s.kind === "unlocked" ? "🔐 unlocked" : "🔒 locked"} · ${s.loaded} key${s.loaded === 1 ? "" : "s"}`;
	}
}

export function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

/** A short line diff (LCS) for confirm dialogs: "- old", "+ new", unchanged lines with "  ". */
export function lineDiff(before: string, after: string, maxLines = 40): string {
	const a = before.replace(/\r/g, "").split("\n");
	const b = after.replace(/\r/g, "").split("\n");
	if (a[a.length - 1] === "") a.pop();
	if (b[b.length - 1] === "") b.pop();
	if (a.length * b.length > 250_000) return `(${a.length} lines -> ${b.length} lines)`;
	const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			out.push(`  ${a[i]}`);
			i++;
			j++;
		} else if (i < a.length && (j >= b.length || dp[i + 1][j] >= dp[i][j + 1])) out.push(`- ${a[i++]}`);
		else out.push(`+ ${b[j++]}`);
	}
	// Keep changed lines plus one line of context around them.
	const keep = out.map((l, k) => l[0] !== " " || (out[k - 1]?.[0] ?? " ") !== " " || (out[k + 1]?.[0] ?? " ") !== " ");
	const shown: string[] = [];
	let skipped = false;
	out.forEach((l, k) => {
		if (keep[k]) {
			shown.push(l);
			skipped = false;
		} else if (!skipped) {
			shown.push("  …");
			skipped = true;
		}
	});
	if (!out.some((l) => l[0] !== " ")) return "(no changes)";
	return shown.length > maxLines ? `${shown.slice(0, maxLines).join("\n")}\n… (${shown.length - maxLines} more lines)` : shown.join("\n");
}

const NET_CMD = /(^|[\s;&|()`'"])(ssh|scp|sftp|rsync|git)(?=$|[\s;&|()`'"])/;

export function mentionsNetworkCommand(command: string): boolean {
	return NET_CMD.test(command);
}

/** Configured host names that appear as a token (`host`, `user@host`, `host:path`, `ssh://user@host:22/x`). */
export function hostsInCommand(command: string, hosts: string[]): string[] {
	if (!hosts.length || !mentionsNetworkCommand(command)) return [];
	const set = new Set(hosts);
	const found = new Set<string>();
	for (let tok of command.split(/[\s;&|()`'"=]+/)) {
		if (!tok) continue;
		tok = tok.replace(/^[a-z+]+:\/\//i, "");
		const at = tok.lastIndexOf("@");
		if (at >= 0) tok = tok.slice(at + 1);
		tok = tok.replace(/[:/].*$/, "");
		if (set.has(tok)) found.add(tok);
	}
	return [...found];
}

export interface KeyRow {
	name: string;
	fingerprint: string;
	loaded: boolean;
}

export function formatKeyRows(rows: KeyRow[]): string {
	if (!rows.length) return "  (no SSH key items)";
	return rows.map((r) => `  ${r.loaded ? "●" : "○"} ${r.name}  ${r.fingerprint}`).join("\n");
}
