// `netbirdDevices` settings from pi's settings.json. Pure: no pi imports, unit-tested.

export type Mode = "ro" | "ask" | "auto" | "full";
export const MODES: readonly Mode[] = ["ro", "ask", "auto", "full"];
export type RootPrompt = "auto" | "native" | "pi";

export interface DeviceSettings {
	/** NetBird peer name (short DNS label, FQDN or IP). Defaults to the settings key. */
	peer?: string;
	/** Login user; empty = detect automatically (console user of the device). */
	user?: string;
	mode?: Mode;
	aliases: string[];
	/** Extra protected path globs for this device. */
	protected: string[];
	rootPrompt: RootPrompt;
	port: number;
}

export interface Settings {
	defaultMode: Mode;
	/** "provider/model" used by the auto mode classifier. */
	classifierModel: string;
	/** NetBird management API base URL (token in api-keys.json under "netbird"). */
	apiUrl: string;
	/** Name shown in the footer for this machine; empty = NetBird name or hostname. */
	localName: string;
	/** Protected path globs added to the defaults for every device. */
	protected: string[];
	devices: Record<string, DeviceSettings>;
}

export const DEFAULT_PROTECTED: readonly string[] = [
	"~/.ssh/**",
	"~/.gnupg/**",
	"~/.aws/**",
	"~/.azure/**",
	"~/.config/gcloud/**",
	"~/.config/gh/**",
	"~/.kube/**",
	"~/.docker/config.json",
	"~/.netrc",
	"~/.password-store/**",
	"~/.pi/agent/auth.json",
	"~/.pi/agent/api-keys.json",
	"~/Library/Keychains/**",
	"~/Library/Cookies/**",
	"~/Library/Application Support/Google/Chrome/**",
	"~/.mozilla/**",
	"/etc/shadow",
	"/etc/sudoers",
	"/etc/sudoers.d/**",
	"**/.env",
	"**/.env.*",
];

export const DEFAULTS: Settings = {
	defaultMode: "ask",
	classifierModel: "anthropic/claude-haiku-5-5",
	apiUrl: "https://api.netbird.io",
	localName: "",
	protected: [],
	devices: {},
};

const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);
const strList = (v: unknown): string[] | undefined =>
	Array.isArray(v) && v.every((x) => typeof x === "string") ? v.map((x) => x.trim()).filter(Boolean) : undefined;

export function parseSettings(raw: unknown): { settings: Settings; warnings: string[] } {
	const settings: Settings = { ...DEFAULTS, devices: {}, protected: [] };
	const warnings: string[] = [];
	if (raw === undefined || raw === null) return { settings, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("netbirdDevices setting must be an object; using defaults");
		return { settings, warnings };
	}
	const s = raw as Record<string, unknown>;
	if (s.defaultMode !== undefined) {
		if (isMode(s.defaultMode)) settings.defaultMode = s.defaultMode;
		else warnings.push(`netbirdDevices.defaultMode must be one of ${MODES.join(", ")}; using ${DEFAULTS.defaultMode}`);
	}
	if (s.classifierModel !== undefined) {
		if (typeof s.classifierModel === "string" && /^[^/\s]+\/\S+$/.test(s.classifierModel.trim())) settings.classifierModel = s.classifierModel.trim();
		else warnings.push(`netbirdDevices.classifierModel must look like "provider/model"; using ${DEFAULTS.classifierModel}`);
	}
	if (s.apiUrl !== undefined) {
		if (typeof s.apiUrl === "string" && /^https?:\/\/\S+$/.test(s.apiUrl.trim())) settings.apiUrl = s.apiUrl.trim().replace(/\/+$/, "");
		else warnings.push(`netbirdDevices.apiUrl must be an http(s) URL; using ${DEFAULTS.apiUrl}`);
	}
	if (s.localName !== undefined) {
		if (typeof s.localName === "string") settings.localName = s.localName.trim();
		else warnings.push("netbirdDevices.localName must be a string");
	}
	if (s.protected !== undefined) {
		const l = strList(s.protected);
		if (l) settings.protected = l;
		else warnings.push("netbirdDevices.protected must be an array of path globs");
	}
	if (s.devices !== undefined) {
		if (typeof s.devices !== "object" || s.devices === null || Array.isArray(s.devices)) {
			warnings.push("netbirdDevices.devices must be an object keyed by device name");
		} else {
			for (const [name, v] of Object.entries(s.devices as Record<string, unknown>)) {
				const r = parseDevice(name, v, warnings);
				if (r) settings.devices[name] = r;
			}
		}
	}
	return { settings, warnings };
}

function parseDevice(name: string, raw: unknown, warnings: string[]): DeviceSettings | undefined {
	if (!/^[\w.-]+$/.test(name)) {
		warnings.push(`netbirdDevices.devices: "${name}" is not a valid name (letters, digits, . _ -)`);
		return undefined;
	}
	const d: DeviceSettings = { aliases: [], protected: [], rootPrompt: "auto", port: 22 };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`netbirdDevices.devices.${name} must be an object`);
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const p = `netbirdDevices.devices.${name}`;
	if (o.peer !== undefined) {
		if (typeof o.peer === "string" && o.peer.trim()) d.peer = o.peer.trim();
		else warnings.push(`${p}.peer must be a non-empty string`);
	}
	if (o.user !== undefined) {
		if (typeof o.user === "string" && /^[\w.@-]*$/.test(o.user.trim())) d.user = o.user.trim() || undefined;
		else warnings.push(`${p}.user is not a valid user name`);
	}
	if (o.mode !== undefined) {
		if (isMode(o.mode)) d.mode = o.mode;
		else warnings.push(`${p}.mode must be one of ${MODES.join(", ")}`);
	}
	if (o.aliases !== undefined) {
		const l = strList(o.aliases);
		if (l) d.aliases = l;
		else warnings.push(`${p}.aliases must be an array of strings`);
	}
	if (o.protected !== undefined) {
		const l = strList(o.protected);
		if (l) d.protected = l;
		else warnings.push(`${p}.protected must be an array of path globs`);
	}
	if (o.rootPrompt !== undefined) {
		if (o.rootPrompt === "auto" || o.rootPrompt === "native" || o.rootPrompt === "pi") d.rootPrompt = o.rootPrompt;
		else warnings.push(`${p}.rootPrompt must be "auto", "native" or "pi"`);
	}
	if (o.port !== undefined) {
		if (typeof o.port === "number" && Number.isInteger(o.port) && o.port > 0 && o.port < 65536) d.port = o.port;
		else warnings.push(`${p}.port must be a TCP port number`);
	}
	return d;
}
