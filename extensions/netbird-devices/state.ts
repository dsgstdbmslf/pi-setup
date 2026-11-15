// state.json: per-device user and probe cache, classifier model, "where is the user" choice.
// Never holds passwords, keys or tokens. Written atomically with mode 0600.

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../bitwarden-ssh/state.ts";
import type { ProbeInfo } from "./remote.ts";

export type UserSource = "settings" | "asked" | "detected";

export interface DeviceState {
	user?: string;
	userSource?: UserSource;
	probe?: ProbeInfo & { at: number };
}

export interface State {
	version: 1;
	devices: Record<string, DeviceState>;
	/** "provider/model" chosen with /nb classifier (overrides the setting). */
	classifierModel?: string;
	hereChoice?: { device: string; at: number };
}

export function emptyState(): State {
	return { version: 1, devices: {} };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function parseProbe(raw: any): (ProbeInfo & { at: number }) | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const os = str(raw.os);
	const user = str(raw.user);
	const home = str(raw.home);
	if (!os || !user || !home || typeof raw.at !== "number") return undefined;
	const probe: ProbeInfo & { at: number } = { os, user, home, sudo: raw.sudo === true, at: raw.at };
	for (const k of ["arch", "shell", "osver", "console", "path"] as const) {
		const v = str(raw[k]);
		if (v) probe[k] = v;
	}
	return probe;
}

export function loadState(file: string): { state: State; warning?: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: emptyState() };
		return { state: emptyState(), warning: `cannot read ${file}: ${(err as Error).message}` };
	}
	try {
		const raw = JSON.parse(text);
		const state = emptyState();
		if (raw && typeof raw === "object") {
			if (raw.devices && typeof raw.devices === "object") {
				for (const [name, v] of Object.entries(raw.devices as Record<string, any>)) {
					if (!v || typeof v !== "object") continue;
					const d: DeviceState = {};
					const user = str(v.user);
					if (user) d.user = user;
					if (v.userSource === "settings" || v.userSource === "asked" || v.userSource === "detected") d.userSource = v.userSource;
					const probe = parseProbe(v.probe);
					if (probe) d.probe = probe;
					state.devices[name] = d;
				}
			}
			if (str(raw.classifierModel)) state.classifierModel = raw.classifierModel;
			if (raw.hereChoice && typeof raw.hereChoice.device === "string" && typeof raw.hereChoice.at === "number") {
				state.hereChoice = { device: raw.hereChoice.device, at: raw.hereChoice.at };
			}
		}
		return { state };
	} catch {
		return { state: emptyState(), warning: `${file} is not valid JSON; starting with an empty state` };
	}
}

export function stateText(state: State): string {
	return `${JSON.stringify(state, null, "\t")}\n`;
}

export function saveState(file: string, state: State): void {
	writeFileAtomic(file, stateText(state), 0o600);
}
