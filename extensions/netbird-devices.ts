// netbird-devices: the user's other computers on NetBird as tools for the agent. Lists devices
// (`devices`), finds the one the user is working at ("here"), and runs read/write/edit/bash on a device
// through the `device` parameter of the built-in tools (OpenSSH over NetBird SSH). Nothing changes for
// calls without `device`. Modules live in extensions/netbird-devices/.
//
// Stage B: no confirmation dialogs yet. Remote write/edit/bash run only on devices in mode "full";
// remote read works except for protected paths. See docs/netbird-devices/IMPLEMENTATION.md.

import { userInfo } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadKeys } from "./tavily/keys.ts";
import { deviceNames, type Device, findDevice } from "./netbird-devices/devices.ts";
import { deviceTargetInCommand, mentionsNetVerb } from "./netbird-devices/guard.ts";
import { Hub } from "./netbird-devices/hub.ts";
import { resolvePaths } from "./netbird-devices/paths.ts";
import { resolveRemotePath } from "./netbird-devices/policy.ts";
import { createBashOps, createEditOps, createReadOps, createWriteOps, type Conn } from "./netbird-devices/remote-ops.ts";
import { parseSettings, type Settings } from "./netbird-devices/settings.ts";
import { DEVICE_PARAM_DESCRIPTION, deviceListHint, deviceRows, displayArgs, guardReason, isRemoteArg, parseDeviceArg, remoteGate } from "./netbird-devices/tools.ts";
import { footerText, formatDeviceTable, type HereInfo } from "./netbird-devices/ui-text.ts";

const STATUS_KEY = "netbird-devices";
/** The footer returns to this machine this long after the agent settles. */
const FOOTER_RESET_MS = 8000;

// One dialog at a time, shared with other extensions' popups (see ask-user-question.ts).
const LOCK_KEY = "__piSharedUiLock";
function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	const o = globalThis as any;
	o[LOCK_KEY] ??= {
		chain: Promise.resolve(),
		withLock(f: () => Promise<any>) {
			const r = this.chain.then(f);
			this.chain = r.then(
				() => {},
				() => {},
			);
			return r;
		},
	};
	return o[LOCK_KEY].withLock(fn);
}

const StringEnum = <T extends readonly string[]>(values: T, description: string) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(undefined), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			() => {
				clearTimeout(t);
				resolve(undefined);
			},
		);
	});
}

type ToolName = "read" | "write" | "edit" | "bash";

export default function netbirdDevices(pi: ExtensionAPI) {
	let settings: Settings = parseSettings(undefined).settings;
	let hub: Hub | undefined;
	let ctxRef: ExtensionContext | undefined;
	/** Pinned with `/nb here <device>` until the session ends (device name). */
	let pinnedHere: string | undefined;
	let footerTimer: ReturnType<typeof setTimeout> | undefined;
	// session_shutdown (any reason) aborts this: open and queued dialogs of the old session settle.
	let session = new AbortController();

	const H = (): Hub => {
		if (!hub) {
			hub = new Hub({
				paths: resolvePaths({ agentDir: getAgentDir(), uid: process.getuid?.() ?? 0 }),
				settings: () => settings,
				vmUser: safeUser(),
				apiToken: async () => (await loadKeys(join(getAgentDir(), "api-keys.json"), "netbird")).entries[0]?.key,
			});
		}
		return hub;
	};
	const safeUser = () => {
		try {
			return userInfo().username;
		} catch {
			return undefined;
		}
	};
	const localNames = (): ReadonlySet<string> => (hub ? hub.localNames() : new Set());
	/** The short name the agent should use for a device. */
	const label = (d: Device): string => (d.configured ? d.name : (d.aliases[0] ?? d.name));

	// --- dialogs ----------------------------------------------------------------------------------

	const dialog = <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
		const signal = session.signal;
		return withUILock(async () => {
			if (signal.aborted) return undefined;
			let onAbort: (() => void) | undefined;
			const aborted = new Promise<undefined>((res) => {
				onAbort = () => res(undefined);
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				return await Promise.race([fn(signal), aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort!);
			}
		});
	};

	/** Ask the user once which account to log in as (nothing detected). Without UI: no answer. */
	const askUser = (ctx: ExtensionContext) => async (d: Device, reason: string): Promise<string | undefined> => {
		if (!ctx.hasUI) return undefined;
		return dialog((signal) => ctx.ui.input(`Which user should Pi log in as on ${label(d)}? (${reason.slice(0, 120)})`, "e.g. sergey", { signal }));
	};

	// --- footer -----------------------------------------------------------------------------------

	function showLocal(ctx = ctxRef): void {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, footerText({ kind: "local", name: H().localLabel() }));
		} catch {}
	}

	function showRemote(d: Device, ctx = ctxRef): void {
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = undefined;
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, footerText({ kind: "remote", device: label(d), mode: H().modeOf(d) }));
		} catch {}
	}

	// --- where is the user ------------------------------------------------------------------------

	/** The device "here" stands for. Asks the user when several are possible; throws a message for the agent otherwise. */
	async function hereDevice(ctx: ExtensionContext, interactive = true): Promise<Device> {
		const h = H();
		const r = await h.resolveHere(pinnedHere, { ask: askUser(ctx) });
		const byName = (n: string) => {
			const d = h.devices().find((x) => x.name === n);
			if (!d) throw new Error(`Device ${n} is not known any more. Call the devices tool.`);
			return d;
		};
		if (r.kind === "found") return byName(r.device);
		if (r.kind === "none") {
			throw new Error(`Cannot tell which computer the user is at (${r.why}). Call the devices tool and pass a device name, or ask the user.`);
		}
		const names = r.candidates.map((c) => label(byName(c.device)));
		if (interactive && ctx.hasUI) {
			const choice = await dialog((signal) => ctx.ui.select("Where are you working? (Pi needs to know which computer 'here' is)", names, { signal }));
			if (choice) {
				const d = byName(r.candidates[names.indexOf(choice)].device);
				h.rememberHere(d.name);
				return d;
			}
			throw new Error("The user did not say which computer they are at. Ask them, or pass a device name.");
		}
		throw new Error(`Several devices could be the user's computer: ${names.join(", ")}. Pass one of them as device, or ask the user.`);
	}

	// --- device tool calls ------------------------------------------------------------------------

	type Target = { kind: "local" } | { kind: "remote"; device: Device; conn: Conn };

	async function resolveTarget(arg: unknown, ctx: ExtensionContext): Promise<Target> {
		const h = H();
		await h.refresh();
		const p = parseDeviceArg(arg, h.devices(), h.localNames());
		if (p.kind === "local") return { kind: "local" };
		if (p.kind === "error") throw new Error(p.message);
		const device = p.kind === "here" ? await hereDevice(ctx) : p.device;
		if (!device.sshEnabled) throw new Error(`${label(device)}: NetBird SSH is not enabled on this device. Known devices: ${deviceListHint(h.devices())}.`);
		showRemote(device, ctx);
		const conn = await h.connect(device, { ask: askUser(ctx) });
		return { kind: "remote", device, conn };
	}

	/** Gate for a path or command on a device; throws the refusal as the tool error. */
	function gate(tool: ToolName, t: Extract<Target, { kind: "remote" }>, extra: { path?: string; command?: string }): void {
		const h = H();
		const g = remoteGate({ tool, device: label(t.device), mode: h.modeOf(t.device), home: t.conn.home, globs: h.protectedGlobs(t.device), ...extra });
		if (!g.ok) throw new Error(g.message);
	}

	const isRemote = (d: unknown): boolean => isRemoteArg(d, localNames());

	const deviceProp = () => Type.Optional(Type.String({ description: DEVICE_PARAM_DESCRIPTION }));

	/** The built-in tool, plus `device`: without it (or for this machine) the built-in implementation runs unchanged. */
	function override(tool: ToolName, local: any, remoteExecute: (t: Extract<Target, { kind: "remote" }>, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>) {
		const parameters = Type.Object({ ...(local.parameters as any).properties, device: deviceProp() });
		pi.registerTool({
			...local,
			parameters,
			async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
				if (params?.device === undefined || params.device === null || params.device === "") return local.execute(id, params, signal, onUpdate, ctx);
				const t = await resolveTarget(params.device, ctx);
				if (t.kind === "local") return local.execute(id, params, signal, onUpdate, ctx);
				return remoteExecute(t, params, signal, onUpdate, ctx);
			},
			renderCall(args: any, theme: any, context: any) {
				const a = displayArgs(tool, args, isRemote);
				return local.renderCall(a, theme, a === args ? context : { ...context, args: a });
			},
			renderResult(result: any, options: any, theme: any, context: any) {
				const a = displayArgs(tool, context.args, isRemote);
				return local.renderResult(result, options, theme, a === context.args ? context : { ...context, args: a });
			},
		} as any);
	}

	const cwd0 = process.cwd();

	{
		const local = createReadToolDefinition(cwd0) as any;
		override("read", local, async (t, params, signal, onUpdate, ctx) => {
			const abs = resolveRemotePath(String(params.path ?? ""), t.conn.home);
			gate("read", t, { path: abs });
			const check = (p: string) => gate("read", t, { path: p });
			const def = createReadToolDefinition(ctx.cwd, { operations: createReadOps(t.conn, check) } as any) as any;
			return def.execute("", { ...params, path: abs }, signal, onUpdate, ctx);
		});
	}
	{
		const local = createWriteToolDefinition(cwd0) as any;
		override("write", local, async (t, params, signal, onUpdate, ctx) => {
			const abs = resolveRemotePath(String(params.path ?? ""), t.conn.home);
			gate("write", t, { path: abs });
			const def = createWriteToolDefinition(ctx.cwd, { operations: createWriteOps(t.conn) } as any) as any;
			return def.execute("", { ...params, path: abs }, signal, onUpdate, ctx);
		});
	}
	{
		const local = createEditToolDefinition(cwd0) as any;
		override("edit", local, async (t, params, signal, onUpdate, ctx) => {
			const abs = resolveRemotePath(String(params.path ?? ""), t.conn.home);
			gate("edit", t, { path: abs });
			const def = createEditToolDefinition(ctx.cwd, { operations: createEditOps(t.conn) } as any) as any;
			return def.execute("", { ...params, path: abs }, signal, onUpdate, ctx);
		});
	}
	{
		const local = createBashToolDefinition(cwd0) as any;
		override("bash", local, async (t, params, signal, onUpdate, ctx) => {
			gate("bash", t, { command: String(params.command ?? "") });
			// Do not leak the local session environment (PI_SESSION_FILE...) into the device command.
			const def = createBashToolDefinition(ctx.cwd, { operations: createBashOps(t.conn), exposeSessionEnvironment: false } as any) as any;
			return def.execute("", params, signal, onUpdate, ctx);
		});
	}

	// --- devices tool -----------------------------------------------------------------------------

	/** The table of `devices list` and `/nb`. Probes online devices without a cached login (silently, bounded). */
	async function deviceTable(ctx: ExtensionContext): Promise<string> {
		const h = H();
		await h.refresh();
		const first = h.devices();
		const online = await h.online(first);
		await Promise.all(first.filter((d) => d.sshEnabled && online.get(d.name) && !h.state.devices[d.name]?.probe).map((d) => withTimeout(h.connect(d), 10_000)));
		const devices = h.devices();
		const probes: Record<string, any> = {};
		const users: Record<string, string | undefined> = {};
		for (const d of devices) {
			probes[d.name] = h.state.devices[d.name]?.probe;
			users[d.name] = h.state.devices[d.name]?.user ?? d.settings.user;
		}
		const rows = deviceRows({ devices, probes, users, online, modeOf: (d) => h.modeOf(d), localName: h.localLabel(), labelOf: label });
		let here: HereInfo;
		try {
			const r = await h.resolveHere(pinnedHere);
			const name = (n: string) => {
				const d = devices.find((x) => x.name === n);
				return d ? label(d) : n;
			};
			here =
				r.kind === "found"
					? { device: name(r.device), why: r.why }
					: r.kind === "ambiguous"
						? { why: `could be ${r.candidates.map((c) => name(c.device)).join(" or ")}` }
						: { why: r.why };
		} catch (e) {
			here = { why: msg(e) };
		}
		return formatDeviceTable(rows, here);
	}

	async function hereText(ctx: ExtensionContext): Promise<string> {
		const d = await hereDevice(ctx);
		const h = H();
		await withTimeout(h.connect(d), 10_000); // fills in OS and login user (errors do not matter here)
		const ds = h.state.devices[d.name];
		const p = ds?.probe;
		const bits = [d.peer !== label(d) ? d.peer : undefined, p ? [p.osver || p.os, p.arch].filter(Boolean).join(" ") : undefined, ds?.user ? `user ${ds.user}` : undefined].filter(Boolean);
		return `here: ${label(d)}${bits.length ? ` (${bits.join(", ")})` : ""}`;
	}

	pi.registerTool({
		name: "devices",
		label: "devices",
		description:
			"The user's NetBird devices: action list shows each device with online state, NetBird SSH, OS, login user and access mode; action here names the computer the user is working at right now. Use these names as the device parameter of read, write, edit and bash.",
		promptSnippet: "List the user's NetBird devices and find the computer they are working at",
		promptGuidelines: [
			'Use the device parameter of read, write, edit and bash to work on the user\'s other computers (NetBird devices); device "here" is the computer the user is working at, and the devices tool lists the names.',
			"Do not reach NetBird devices with ssh, scp, rsync or curl in bash; use the device parameter of the file and bash tools.",
		],
		parameters: Type.Object({ action: Type.Optional(StringEnum(["list", "here"] as const, "list (default): all devices; here: the computer the user is at")) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const text = params.action === "here" ? await hereText(ctx) : await deviceTable(ctx);
			return { content: [{ type: "text", text }], details: undefined };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("devices ")) + theme.fg("muted", (args as any)?.action ?? "list"), 0, 0);
		},
	} as any);

	// --- ssh guard --------------------------------------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash" || !hub) return;
		const input = event.input as { command?: unknown; device?: unknown };
		if (isRemote(input?.device)) return; // runs on the device; what it does there is its own business
		const command = String(input?.command ?? "");
		if (!mentionsNetVerb(command)) return;
		const devices = hub.devices();
		const hit = deviceTargetInCommand(command, { names: deviceNames(devices), domains: hub.domains(), self: hub.localNames() });
		if (hit) return { block: true, reason: guardReason(hit, devices) };
	});

	// --- lifecycle --------------------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		if (session.signal.aborted) session = new AbortController();
		ctxRef = ctx;
		try {
			const parsed = parseSettings((pi.getSettings() as any)?.netbirdDevices);
			settings = parsed.settings;
			for (const w of parsed.warnings) ctx.ui.notify(`netbird-devices: ${w}`, "warning");
			if (event.reason !== "reload") pinnedHere = undefined;
			const h = H();
			for (const w of h.warnings.splice(0)) ctx.ui.notify(`netbird-devices: ${w}`, "warning");
			showLocal(ctx);
			void h.refresh().then(() => showLocal(ctx), () => {});
		} catch (err) {
			try {
				ctx.ui.notify(`netbird-devices: ${msg(err)}`, "warning");
			} catch {}
		}
	});

	pi.on("agent_start", async () => {
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = setTimeout(() => showLocal(ctx), FOOTER_RESET_MS);
		footerTimer.unref?.();
	});

	pi.on("session_shutdown", async (event) => {
		session.abort();
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = undefined;
		ctxRef = undefined;
		if (event.reason === "quit") await withTimeout(hub?.closeAll() ?? Promise.resolve(), 2500);
	});

	// --- /nb --------------------------------------------------------------------------------------

	const SUBS = ["list", "here", "refresh", "user", "forget"];
	const USAGE = "Usage: /nb [list] | here [device|auto] | refresh | user <device> <user|auto> | forget <device>";

	function findOrThrow(name: string): Device {
		const h = H();
		const d = findDevice(h.devices(), name);
		if (!d) throw new Error(`Unknown device "${name}". Known: ${deviceListHint(h.devices())}`);
		return d;
	}

	async function nbCommand(args: string, ctx: ExtensionContext): Promise<string> {
		ctxRef = ctx;
		const [sub = "", a1, a2] = args.trim().split(/\s+/);
		const h = H();
		const warnings = () => (h.warnings.length ? `\n\nWarnings:\n${h.warnings.map((w) => `- ${w}`).join("\n")}` : "");
		switch (sub) {
			case "":
			case "list":
				return (await deviceTable(ctx)) + warnings();
			case "refresh":
				await h.refresh(true);
				return (await deviceTable(ctx)) + warnings();
			case "here": {
				if (!a1) return `${await hereText(ctx)}${pinnedHere ? " (pinned)" : ""}`;
				if (a1 === "auto") {
					pinnedHere = undefined;
					return `here: detected automatically again`;
				}
				const d = findOrThrow(a1);
				pinnedHere = d.name;
				return `here: ${label(d)} (pinned until the session ends; /nb here auto to release)`;
			}
			case "user": {
				if (!a1 || !a2) return "Usage: /nb user <device> <user|auto>";
				const d = findOrThrow(a1);
				if (a2 === "auto") {
					h.setUser(d, undefined);
					return `${label(d)}: login user will be detected automatically`;
				}
				if (!/^[\w][\w.@-]*$/.test(a2) || a2 === "root") return `"${a2}" is not a usable login user`;
				h.setUser(d, a2);
				try {
					const c = await h.connect(d);
					return `${label(d)}: logging in as ${c.user} works (home ${c.home})`;
				} catch (e) {
					return `${label(d)}: user set to ${a2}, but login failed: ${msg(e)}`;
				}
			}
			case "forget": {
				if (!a1) return "Usage: /nb forget <device>";
				const d = findOrThrow(a1);
				await h.forget(d);
				return `${label(d)}: host key, cached login and connection forgotten`;
			}
			default:
				return `Unknown: /nb ${sub}. ${USAGE}`;
		}
	}

	pi.registerCommand("nb", {
		description: "NetBird devices: list (default), here [device|auto], refresh, user <device> <user|auto>, forget <device>",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
				return items.length ? items : null;
			}
			const sub = parts[0];
			if (parts.length === 2 && ["here", "user", "forget"].includes(sub)) {
				const names = hub ? hub.devices().map((d) => label(d)) : [];
				if (sub === "here") names.push("auto");
				const items = names.filter((n) => n.startsWith(parts[1] ?? "")).map((n) => ({ value: `${sub} ${n}`, label: n }));
				return items.length ? items : null;
			}
			if (parts.length === 3 && sub === "user") return "auto".startsWith(parts[2] ?? "") ? [{ value: `user ${parts[1]} auto`, label: "auto" }] : null;
			return null;
		},
		handler: async (args, ctx) => {
			try {
				ctx.ui.notify(await nbCommand(args ?? "", ctx), "info");
			} catch (err) {
				ctx.ui.notify(`netbird-devices: ${msg(err)}`, "error");
			}
		},
	});
}
