// `bitwardenSsh` settings from pi's settings.json. Pure: no pi imports, unit-tested.

export interface Settings {
	/** ssh-add lifetime for loaded keys ("8h", "30m", "3600"); "" means no lifetime. */
	keyTtl: string;
	/** Forget the Bitwarden session after this many idle minutes; 0 turns auto-lock off. */
	autoLockMinutes: number;
	/** Name of the Bitwarden Secure Note that holds the SSH config. */
	configNote: string;
	/** ControlPersist of the generated `Host *` block; false leaves connection sharing out. */
	controlPersist: string | false;
}

export const DEFAULTS: Settings = { keyTtl: "8h", autoLockMinutes: 30, configNote: "ssh-config", controlPersist: "10m" };

const TTL = /^\d+[smhdw]?$/i;

export function parseSettings(raw: unknown): { settings: Settings; warnings: string[] } {
	const settings: Settings = { ...DEFAULTS };
	const warnings: string[] = [];
	if (raw === undefined || raw === null) return { settings, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("bitwardenSsh setting must be an object; using defaults");
		return { settings, warnings };
	}
	const s = raw as Record<string, unknown>;
	if (s.keyTtl !== undefined) {
		const v = typeof s.keyTtl === "number" ? String(s.keyTtl) : s.keyTtl;
		if (v === "" || v === "0") settings.keyTtl = "";
		else if (typeof v === "string" && TTL.test(v.trim())) settings.keyTtl = v.trim().toLowerCase();
		else warnings.push(`bitwardenSsh.keyTtl ${JSON.stringify(s.keyTtl)} is invalid (use e.g. "8h", "30m", "0"); using ${DEFAULTS.keyTtl}`);
	}
	if (s.autoLockMinutes !== undefined) {
		const v = s.autoLockMinutes;
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) settings.autoLockMinutes = v;
		else warnings.push(`bitwardenSsh.autoLockMinutes must be a number >= 0; using ${DEFAULTS.autoLockMinutes}`);
	}
	if (s.configNote !== undefined) {
		if (typeof s.configNote === "string" && s.configNote.trim()) settings.configNote = s.configNote.trim();
		else warnings.push(`bitwardenSsh.configNote must be a non-empty string; using "${DEFAULTS.configNote}"`);
	}
	if (s.controlPersist !== undefined) {
		const v = s.controlPersist;
		if (v === false) settings.controlPersist = false;
		else if (typeof v === "string" && /^(yes|no|\d+[smhdw]?)$/i.test(v.trim())) settings.controlPersist = v.trim();
		else warnings.push(`bitwardenSsh.controlPersist must be false, "yes" or a duration like "10m"; using ${DEFAULTS.controlPersist}`);
	}
	return { settings, warnings };
}
