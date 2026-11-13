// state.json: identity mapping and a cache of NON-secret key data (names, fingerprints, public keys),
// so lists work while the vault is locked. Never holds private keys, passwords or session keys.

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CachedKey {
	id: string;
	name: string;
	fingerprint: string;
	publicKey: string;
}

export interface State {
	version: 1;
	/** IdentityFile value as written in the source config -> Bitwarden SSH key item. */
	identityMap: Record<string, { itemId: string; name: string }>;
	keys: CachedKey[];
	note?: { id: string; name: string };
	/** sha256 of the source config at the last pull/push. */
	syncedHash?: string;
}

export function emptyState(): State {
	return { version: 1, identityMap: {}, keys: [] };
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
			if (raw.identityMap && typeof raw.identityMap === "object") {
				for (const [k, v] of Object.entries(raw.identityMap as Record<string, any>)) {
					if (v && typeof v.itemId === "string") state.identityMap[k] = { itemId: v.itemId, name: String(v.name ?? "") };
				}
			}
			if (Array.isArray(raw.keys)) {
				state.keys = raw.keys
					.filter((k: any) => k && typeof k.id === "string")
					.map((k: any) => ({ id: k.id, name: String(k.name ?? ""), fingerprint: String(k.fingerprint ?? ""), publicKey: String(k.publicKey ?? "") }));
			}
			if (raw.note && typeof raw.note.id === "string") state.note = { id: raw.note.id, name: String(raw.note.name ?? "") };
			if (typeof raw.syncedHash === "string") state.syncedHash = raw.syncedHash;
		}
		return { state };
	} catch {
		return { state: emptyState(), warning: `${file} is not valid JSON; starting with an empty state` };
	}
}

/** Write a file atomically (tmp + rename) with the given mode. */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
	const tmp = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
	try {
		writeFileSync(tmp, text, { mode, flag: "wx" });
		renameSync(tmp, file);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw err;
	}
}

/** The serialized form of state.json. */
export function stateText(state: State): string {
	return `${JSON.stringify(state, null, "\t")}\n`;
}

export function saveState(file: string, state: State): void {
	writeFileAtomic(file, stateText(state), 0o600);
}
