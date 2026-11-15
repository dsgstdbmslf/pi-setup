// Pure text for the footer, the device list and confirm dialogs. Unit-tested.

import type { Action, Decision } from "./policy.ts";
import type { Mode } from "./settings.ts";

export { lineDiff, truncate } from "../bitwarden-ssh/ui-text.ts";
import { truncate } from "../bitwarden-ssh/ui-text.ts";

// --- footer ------------------------------------------------------------------------------------

export type FooterState =
	| { kind: "local"; name: string }
	| { kind: "remote"; device: string; mode: Mode; waiting?: "confirm" | "root" };

export function footerText(s: FooterState): string {
	if (s.kind === "local") return `⌂ ${s.name}`;
	const base = `→ ${s.device} · ${s.mode}`;
	if (s.waiting === "confirm") return `${base} · ⏸ ждёт тебя`;
	if (s.waiting === "root") return `${base} · 🔑 пароль root`;
	return base;
}

// --- paths and sizes ---------------------------------------------------------------------------

/** `mac:~/x` for a path under the device home, `mac:/etc/hosts` otherwise. */
export function displayPath(device: string, abs: string, home: string): string {
	const h = home.replace(/\/+$/, "");
	if (abs === h) return `${device}:~`;
	if (h && abs.startsWith(`${h}/`)) return `${device}:~${abs.slice(h.length)}`;
	return `${device}:${abs}`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

// --- device list -------------------------------------------------------------------------------

export interface DeviceRow {
	name: string;
	peer?: string;
	/** "macOS 27.0 arm64"; undefined = unknown. */
	os?: string;
	user?: string;
	/** undefined = not known. */
	online?: boolean;
	ssh?: boolean;
	mode?: Mode;
	/** This machine. */
	local?: boolean;
}

export interface HereInfo {
	device?: string;
	why?: string;
}

/** The compact table of `devices list` (PLAN §6). */
export function formatDeviceTable(rows: readonly DeviceRow[], here?: HereInfo): string {
	const lines: string[] = [here?.device ? `here: ${here.device}${here.why ? ` (${here.why})` : ""}` : `here: unknown${here?.why ? ` (${here.why})` : ""}`];
	const remote = rows.filter((r) => !r.local);
	const w = (f: (r: DeviceRow) => string) => Math.max(0, ...remote.map((r) => f(r).length));
	const cell = {
		name: (r: DeviceRow) => r.name,
		peer: (r: DeviceRow) => r.peer ?? "",
		os: (r: DeviceRow) => r.os ?? "?",
		user: (r: DeviceRow) => r.user ?? "",
		status: (r: DeviceRow) => (r.online === undefined ? "? unknown" : r.online ? "● online" : "○ offline"),
	};
	const widths = { name: w(cell.name), peer: w(cell.peer), os: w(cell.os), user: w(cell.user), status: w(cell.status) };
	for (const r of rows) {
		if (r.local) {
			lines.push(`${r.name} — this VM (local)`);
			continue;
		}
		const parts = [cell.name(r).padEnd(widths.name), cell.peer(r).padEnd(widths.peer), cell.os(r).padEnd(widths.os), cell.user(r).padEnd(widths.user), cell.status(r).padEnd(widths.status)];
		const tail = [r.ssh ? "ssh" : "", r.ssh && r.mode ? `mode ${r.mode}` : ""].filter(Boolean).join("  ");
		lines.push([...parts, tail].join("  ").trimEnd());
	}
	if (!remote.length) lines.push("(no other NetBird devices found)");
	return lines.join("\n");
}

// --- confirm dialogs ---------------------------------------------------------------------------

export function actionSummary(action: Action, device: string, home?: string): string {
	switch (action.kind) {
		case "read":
			return `read ${home ? displayPath(device, action.path, home) : `${device}:${action.path}`}`;
		case "write":
			return `${action.isNew ? "create" : "edit"} ${home ? displayPath(device, action.path, home) : `${device}:${action.path}`}`;
		case "bash":
			return `run ${action.root ? "as root " : ""}on ${device}`;
	}
}

export function confirmTitle(action: Action, device: string, decision: Decision, home?: string): string {
	const what = actionSummary(action, device, home);
	return `${decision.danger ? "⚠ " : ""}Pi wants to ${what}`;
}

/** Dialog body: the action (diff or command), then why it is asked. */
export function confirmBody(action: Action, device: string, decision: Decision): string {
	const lines: string[] = [];
	if (action.kind === "bash") lines.push(`$ [${device}] ${action.root ? "sudo " : ""}${truncate(action.command, 1500)}`);
	else if (action.kind === "write") lines.push(truncate(action.diff, 3000));
	else lines.push(action.path);
	if (decision.warning) lines.push("", `⚠ ${decision.warning}`);
	lines.push("", `Why asked: ${decision.reason}`);
	return lines.join("\n");
}

export type ConfirmChoice = "once" | "always" | "full" | "deny";

/**
 * The buttons of the dialog (PLAN §9). Dangerous commands offer only "once" and "deny": they are asked
 * every time and cannot switch the device to full.
 */
export function confirmOptions(action: Action, device: string, decision: Decision): { id: ConfirmChoice; label: string }[] {
	const once = { id: "once" as const, label: "Разрешить один раз" };
	const deny = { id: "deny" as const, label: "Отклонить" };
	if (decision.danger) return [once, deny];
	const what = action.kind === "bash" ? "эту команду" : "этот путь";
	return [once, { id: "always", label: `Всегда разрешать ${what} в сессии` }, { id: "full", label: `Переключить ${device} в full до конца сессии` }, deny];
}
