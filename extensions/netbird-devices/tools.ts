// Pure helpers of the device tools: `device` argument parsing, the stage-B gate, display arguments
// for the built-in renderers, image MIME by extension, device table rows. No pi imports, unit-tested.

import { type Device, findDevice } from "./devices.ts";
import { type Action, decide, protectedInCommand, protectedMatch, splitSudo } from "./policy.ts";
import type { ProbeInfo } from "./remote.ts";
import type { Mode } from "./settings.ts";
import type { DeviceRow } from "./ui-text.ts";

// --- the `device` argument ------------------------------------------------------------------------

export type DeviceArg =
	| { kind: "local" }
	| { kind: "here" }
	| { kind: "device"; device: Device }
	| { kind: "error"; message: string };

export const DEVICE_PARAM_DESCRIPTION =
	'NetBird device name or alias (see the devices tool), or "here" for the computer the user is working at. Omit to act on this machine.';

const LOCAL_WORDS = new Set(["local", "this", "localhost", "self", "vm"]);

/** "mac (sergeys-macbook-pro), nl" for error messages. */
export function deviceListHint(devices: readonly Device[]): string {
	const names = devices
		.filter((d) => d.sshEnabled)
		.map((d) => {
			const n = d.configured ? d.name : (d.aliases[0] ?? d.name);
			return d.peer && d.peer !== n ? `${n} (${d.peer})` : n;
		});
	return names.length ? names.join(", ") : "none with NetBird SSH enabled";
}

/** What the `device` argument of a tool call means. `localNames` holds the lower-case names of this machine. */
export function parseDeviceArg(arg: unknown, devices: readonly Device[], localNames: ReadonlySet<string>): DeviceArg {
	if (arg === undefined || arg === null) return { kind: "local" };
	if (typeof arg !== "string") return { kind: "error", message: "device must be a string" };
	const q = arg.trim().toLowerCase();
	if (!q) return { kind: "local" };
	if (q === "here") return { kind: "here" };
	if (LOCAL_WORDS.has(q) || localNames.has(q)) return { kind: "local" };
	const d = findDevice(devices, q);
	if (!d) return { kind: "error", message: `Unknown device "${arg.trim()}". Known devices: ${deviceListHint(devices)}. Use the devices tool.` };
	if (!d.sshEnabled) return { kind: "error", message: `${d.name}: NetBird SSH is not enabled on this device, so it cannot be used. Known devices: ${deviceListHint(devices)}.` };
	return { kind: "device", device: d };
}

/** True when a `device` argument names a remote machine (for rendering; `here` counts as remote). */
export function isRemoteArg(arg: unknown, localNames: ReadonlySet<string>): arg is string {
	if (typeof arg !== "string") return false;
	const q = arg.trim().toLowerCase();
	return !!q && !LOCAL_WORDS.has(q) && !localNames.has(q);
}

// --- device mode and the stage-B gate -------------------------------------------------------------

export const STAGE_C_NOTE = "confirmations are not implemented yet (stage C)";

export type Gate = { ok: true } | { ok: false; message: string };

export interface GateInput {
	tool: "read" | "write" | "edit" | "bash";
	device: string;
	mode: Mode;
	home: string;
	/** Absolute path (read/write/edit). */
	path?: string;
	command?: string;
	/** Protected path globs (defaults + settings). */
	globs: readonly string[];
}

/**
 * Stage B has no confirmation dialogs, so only what needs none runs: `read` of unprotected paths, and
 * write/edit/bash on devices in mode `full` (except protected paths, dangerous commands and root,
 * which would need a dialog or the root flow). Everything else is refused with a reason for the agent.
 */
export function remoteGate(i: GateInput): Gate {
	const refuse = (why: string): Gate => ({ ok: false, message: `${i.device}: ${why}` });
	if (i.tool === "read") {
		const hit = i.path ? protectedMatch(i.path, i.home, i.globs) : undefined;
		if (hit) return refuse(`reading ${i.path} is refused: protected path (${hit}); ${STAGE_C_NOTE}.`);
		return { ok: true };
	}
	if (i.mode !== "full") {
		return refuse(`${i.tool} needs confirmation in mode "${i.mode}", but ${STAGE_C_NOTE}. Only devices in mode "full" accept ${i.tool} for now; the user can set the mode in settings.`);
	}
	let action: Action;
	let hit: string | undefined;
	if (i.tool === "bash") {
		const command = i.command ?? "";
		if (splitSudo(command) !== undefined) return refuse("commands starting with sudo (root) are not implemented yet (stage D).");
		action = { kind: "bash", command, root: false };
		hit = protectedInCommand(command, i.home, i.globs, i.home);
	} else {
		action = { kind: "write", path: i.path ?? "", diff: "", isNew: false };
		hit = i.path ? protectedMatch(i.path, i.home, i.globs) : undefined;
	}
	const d = decide({ mode: i.mode, action, protectedHit: hit });
	if (d.verdict === "allow") return { ok: true };
	if (d.verdict === "deny") return refuse(`${i.tool} refused: ${d.reason}.`);
	return refuse(`${i.tool} refused: ${d.reason}${d.warning ? ` (${d.warning})` : ""} needs confirmation, but ${STAGE_C_NOTE}.`);
}

// --- rendering ------------------------------------------------------------------------------------

/**
 * Arguments as the built-in renderers should show them for a call to a device: `mac:~/x` instead of the
 * bare path, `[mac] cmd` for bash. For `edit` the `edits` are dropped so the built-in preview does not
 * read a local file with the same path (it fills in the diff from the result instead).
 */
export function displayArgs<T>(tool: "read" | "write" | "edit" | "bash", args: T, isRemote: (device: unknown) => boolean): T {
	if (!args || typeof args !== "object") return args;
	const a = args as Record<string, unknown>;
	if (!isRemote(a.device)) return args;
	const d = String(a.device).trim();
	if (tool === "bash") return { ...a, command: typeof a.command === "string" ? `[${d}] ${a.command}` : a.command } as T;
	const path = typeof a.path === "string" ? `${d}:${a.path}` : a.path;
	if (tool === "edit") return { ...a, path, edits: undefined } as T;
	return { ...a, path } as T;
}

// --- files ----------------------------------------------------------------------------------------

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

/** Image MIME type by file extension (the device is not asked), or null. */
export function imageMimeFromPath(path: string): string | null {
	const m = /\.([A-Za-z0-9]+)$/.exec(path);
	return (m && IMAGE_MIME[m[1].toLowerCase()]) || null;
}

// --- device list ----------------------------------------------------------------------------------

/** "macOS 27.0 arm64" from a probe, or undefined. */
export function osLabel(p?: Pick<ProbeInfo, "os" | "osver" | "arch">): string | undefined {
	if (!p) return undefined;
	const name = p.osver || p.os;
	return name ? [name, p.arch].filter(Boolean).join(" ") : undefined;
}

export interface RowInput {
	devices: readonly Device[];
	probes: Record<string, ProbeInfo | undefined>;
	users: Record<string, string | undefined>;
	online: ReadonlyMap<string, boolean>;
	modeOf: (d: Device) => Mode;
	localName?: string;
	/** Short name shown and used by the agent (default: the device name). */
	labelOf?: (d: Device) => string;
}

export function deviceRows(i: RowInput): DeviceRow[] {
	const rows: DeviceRow[] = [];
	if (i.localName) rows.push({ name: i.localName, local: true });
	for (const d of i.devices) {
		const p = i.probes[d.name];
		const name = i.labelOf ? i.labelOf(d) : d.name;
		const os = osLabel(p) ?? d.os;
		rows.push({
			name,
			peer: d.peer && d.peer !== name ? d.peer : undefined,
			os,
			user: p?.user ?? i.users[d.name],
			online: i.online.get(d.name) ?? d.connected,
			ssh: d.sshEnabled,
			mode: i.modeOf(d),
		});
	}
	return rows;
}

// --- ssh guard text -------------------------------------------------------------------------------

/** Reason shown to the agent when its bash command reaches a device directly. */
export function guardReason(target: string, devices: readonly Device[]): string {
	const d = findDevice(devices, target);
	const label = d ? d.aliases[0] ?? d.name : undefined;
	return label
		? `Do not reach NetBird devices with ssh/scp/curl in bash. Use the device parameter of the tools instead, e.g. bash/read/write/edit with device: "${label}" (or "here" for the user's computer).`
		: `${target} is a NetBird address. Do not reach NetBird devices from bash; call the devices tool to see them, then use the device parameter of read/write/edit/bash.`;
}
