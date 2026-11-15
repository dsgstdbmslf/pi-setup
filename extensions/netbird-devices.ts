// netbird-devices: the user's other computers on NetBird as tools for the agent. Lists devices
// (`devices`), finds the one the user is working at ("here"), and runs read/write/edit/bash on a device
// through the `device` parameter of the built-in tools (OpenSSH over NetBird SSH). Nothing changes for
// calls without `device`. Modules live in extensions/netbird-devices/.
//
// Access: every remote action goes through policy.decide() (modes ro/ask/auto/full per device, protected
// paths, dangerous commands). Confirmations are ctx.ui.select dialogs under the shared UI lock; write/edit
// ask inside the write operation, with the exact diff. Mode and approvals are per session. Settings come
// from the GLOBAL settings.json only. See docs/netbird-devices/IMPLEMENTATION.md.

import { createHash } from "node:crypto";
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
import { askSecret, SECRET_INPUT_NEEDS_TUI, secretInputAvailable } from "./bitwarden-ssh/secret-input.ts";
import { loadKeys } from "./tavily/keys.ts";
import { deviceNames, type Device, findDevice } from "./netbird-devices/devices.ts";
import { assistantText, buildClassifierPrompt, CLASSIFIER_SYSTEM, parseClassifierAnswer, userMessagesFromBranch } from "./netbird-devices/classifier.ts";
import { deviceTargetInCommand, mentionsNetVerb } from "./netbird-devices/guard.ts";
import { Hub } from "./netbird-devices/hub.ts";
import { appendJournal, formatLog, readJournal } from "./netbird-devices/journal.ts";
import { type Paths, resolvePaths } from "./netbird-devices/paths.ts";
import { type Action, type Decision, commandPathCandidates, protectedMatch, resolveRemotePath, splitSudo } from "./netbird-devices/policy.ts";
import { RootCancelled, runRoot, testRoot } from "./netbird-devices/root.ts";
import { canonicalPath } from "./netbird-devices/ssh.ts";
import { type BashOps, type BeforeWrite, remoteTimeoutSeconds, createBashOps, createEditOps, createReadOps, createWriteOps, type Conn } from "./netbird-devices/remote-ops.ts";
import { type ClassifierResult, isMode, MODE_ENTRY, nextMode, SessionPolicy } from "./netbird-devices/session-policy.ts";
import { loadGlobalSettings, MODES, type Mode, type Settings, parseSettings } from "./netbird-devices/settings.ts";
import { type ActionInput, DEVICE_PARAM_DESCRIPTION, deviceListHint, deviceRows, displayArgs, earlyRefusal, guardReason, isRemoteArg, osLabel, parseDeviceArg, remoteAction } from "./netbird-devices/tools.ts";
import { type ConfirmChoice, formatBytes, confirmBody, confirmOptions, confirmTitle, footerText, formatDeviceTable, type HereInfo, lineDiff } from "./netbird-devices/ui-text.ts";

const STATUS_KEY = "netbird-devices";
/** The footer returns to this machine this long after the agent settles. */
const FOOTER_RESET_MS = 8000;
const CLASSIFIER_TIMEOUT_MS = 20_000;
const CLASSIFIER_MAX_TOKENS = 300;
const MODE_SHORTCUT = "alt+m";

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
	let paths: Paths | undefined;
	let journalWarned = false;
	let ctxRef: ExtensionContext | undefined;
	/** Pinned with `/nb here <device>` until the session ends (device name). */
	let pinnedHere: string | undefined;
	/** Mode overrides, approvals and classifier state of this session. */
	const policy = new SessionPolicy();
	/** The device the agent worked on last (alt+m and /nb mode act on it). */
	let lastDevice: string | undefined;
	let footerTimer: ReturnType<typeof setTimeout> | undefined;
	// session_shutdown (any reason) aborts this: open and queued dialogs of the old session settle.
	let session = new AbortController();

	const H = (): Hub => {
		if (!hub) {
			paths = resolvePaths({ agentDir: getAgentDir(), uid: process.getuid?.() ?? 0 });
			hub = new Hub({
				paths,
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
	/** Effective mode: the session override, else settings. */
	const modeOf = (d: Device): Mode => policy.modeFor(d.name, H().modeOf(d));
	const localNames = (): ReadonlySet<string> => (hub ? hub.localNames() : new Set());
	/** The short name the agent should use for a device. */
	const label = (d: Device): string => (d.configured ? d.name : (d.aliases[0] ?? d.name));

	// --- dialogs ----------------------------------------------------------------------------------

	const dialog = <T>(fn: (signal: AbortSignal) => Promise<T>, extra?: AbortSignal): Promise<T | undefined> => {
		const signal = extra ? AbortSignal.any([session.signal, extra]) : session.signal;
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
		if (!ctx?.hasUI || session.signal.aborted) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, footerText({ kind: "local", name: H().localLabel() }));
		} catch {}
	}

	function showRemote(d: Device, ctx = ctxRef, waiting?: "confirm" | "root"): void {
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = undefined;
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, footerText({ kind: "remote", device: label(d), mode: modeOf(d), waiting }));
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
		lastDevice = device.name;
		showRemote(device, ctx);
		const conn = await h.connect(device, { ask: askUser(ctx) });
		return { kind: "remote", device, conn };
	}

	type Remote = Extract<Target, { kind: "remote" }>;

	/** The confirmation dialog (select) for an action; the footer shows "waits for you" while it is open. */
	async function confirm(ctx: ExtensionContext, t: Remote, action: Action, d: Decision, signal?: AbortSignal): Promise<ConfirmChoice | undefined> {
		const name = label(t.device);
		let opts = confirmOptions(action, name, d);
		if (d.reason.startsWith("protected path")) opts = opts.filter((o) => o.id !== "full"); // full does not lift protected paths
		const title = `${confirmTitle(action, name, d, t.conn.home)}\n\n${confirmBody(action, name, d)}`;
		const labels = opts.map((o) => o.label);
		const pick = await dialog(async (sig) => {
			showRemote(t.device, ctx, "confirm");
			try {
				return await ctx.ui.select(title, labels, { signal: sig });
			} finally {
				if (!session.signal.aborted) showRemote(t.device, ctx);
			}
		}, signal);
		return pick === undefined ? undefined : opts[labels.indexOf(pick)]?.id;
	}

	/** One classifier call (auto mode): the user's messages and the action only, never tool output. Undefined = cannot answer. */
	async function classify(ctx: ExtensionContext, t: Remote, action: Action, signal?: AbortSignal): Promise<ClassifierResult | undefined> {
		if (signal?.aborted || session.signal.aborted) return undefined;
		const id = H().state.classifierModel ?? settings.classifierModel;
		const slash = id.indexOf("/");
		if (slash <= 0) return undefined;
		const model = ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1));
		if (!model) return undefined;
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), CLASSIFIER_TIMEOUT_MS);
		const onAbort = () => ctl.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		session.signal.addEventListener("abort", onAbort, { once: true });
		try {
			const prompt = buildClassifierPrompt({
				device: label(t.device),
				os: osLabel(t.conn.probe),
				user: t.conn.user,
				action,
				userMessages: userMessagesFromBranch(ctx.sessionManager.getBranch()),
			});
			const stream = ctx.modelRegistry.streamSimple(model, { systemPrompt: CLASSIFIER_SYSTEM, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { maxTokens: CLASSIFIER_MAX_TOKENS, signal: ctl.signal });
			const msg = await Promise.race([stream.result(), new Promise<undefined>((resolve) => ctl.signal.addEventListener("abort", () => resolve(undefined), { once: true }))]);
			if (!msg || ctl.signal.aborted) return undefined;
			if (msg.stopReason === "error" || msg.stopReason === "aborted") return undefined;
			const parsed = parseClassifierAnswer(assistantText(msg));
			return parsed ? { ...parsed, model: id, usage: msg.usage } : undefined;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
			ctl.abort();
			signal?.removeEventListener("abort", onAbort);
			session.signal.removeEventListener("abort", onAbort);
		}
	}

	/** Mode change from the dialog ("switch to full"): kept in the session and shown in the footer. */
	function persistMode(d: Device, mode: Mode, ctx: ExtensionContext): void {
		policy.setMode(d.name, mode);
		try {
			pi.appendEntry(MODE_ENTRY, { device: d.name, mode });
		} catch {}
		showRemote(d, ctx);
	}

	/** Policy for one action on a device: allowed, or throws the refusal for the agent. Classifier usage goes to `acc`. */
	async function authorize(ctx: ExtensionContext, t: Remote, input: Omit<ActionInput, "home" | "globs">, signal: AbortSignal | undefined, acc: ClassifierResult[], cacheSalt?: string, j?: Journaled): Promise<void> {
		const h = H();
		if (signal?.aborted || session.signal.aborted) throw new Error("Operation aborted");
		const globs = h.protectedGlobs(t.device);
		const { action, protectedHit: lexicalHit } = remoteAction({ ...input, home: t.conn.home, globs });
		// Check the path the device actually follows, not just its spelling. New
		// files resolve existing parents too. This remains subject to TOCTOU races.
		const resolved = input.path ? await canonicalPath(t.conn.target, input.path, { signal }) : undefined;
		const realHome = resolved ? await canonicalPath(t.conn.target, t.conn.home, { signal }) : t.conn.home;
		let protectedHit = lexicalHit ?? (resolved ? protectedMatch(resolved, t.conn.home, globs) ?? protectedMatch(resolved, realHome, globs) : undefined);
		if (action.kind === "bash" && !protectedHit) {
			const candidates = commandPathCandidates(action.command, t.conn.home);
			if (candidates.length > 8) protectedHit = "too many shell paths to verify safely";
			else if (candidates.length) {
				const [home, ...actual] = await Promise.all([t.conn.home, ...candidates].map((path) => canonicalPath(t.conn.target, path, { signal })));
				protectedHit = actual.map((path) => protectedMatch(path, t.conn.home, globs) ?? protectedMatch(path, home, globs)).find(Boolean);
			}
		}
		const intent = createHash("sha256").update(JSON.stringify([userMessagesFromBranch(ctx.sessionManager.getBranch()), h.state.classifierModel ?? settings.classifierModel, cacheSalt ?? ""])).digest("hex");
		const out = await policy.authorize({
			device: t.device.name,
			label: label(t.device),
			baseMode: h.modeOf(t.device),
			action,
			protectedHit,
			cacheSalt: intent,
			scope: JSON.stringify([t.conn.target.host, t.conn.user, t.conn.home]),
			ask: ctx.hasUI ? (d) => confirm(ctx, t, action, d, signal) : undefined,
			classify: () => classify(ctx, t, action, signal),
			onModeChange: (m) => persistMode(t.device, m, ctx),
		});
		if (out.classifier) acc.push(out.classifier);
		if (j) j.how = decisionOf(out.how);
		if (!out.ok) throw new Error(out.message);
		if (signal?.aborted || session.signal.aborted) throw new Error("Operation aborted");
	}

	/** Refusals that need no dialog (ro device); throws. */
	function early(t: Remote, input: Omit<ActionInput, "home" | "globs">, j?: Journaled): void {
		const h = H();
		const why = earlyRefusal({ ...input, home: t.conn.home, globs: h.protectedGlobs(t.device) }, modeOf(t.device), label(t.device));
		if (why) {
			if (j) j.how = "denied";
			throw new Error(why);
		}
	}

	/** Hook of the write operations: the exact new content (and the old one) is confirmed before anything is written. */
	function beforeWrite(ctx: ExtensionContext, t: Remote, tool: "write" | "edit", signal: AbortSignal | undefined, acc: ClassifierResult[], j?: Journaled): BeforeWrite {
		return async ({ path, content, old, isNew }) => {
			const diff = isNew ? lineDiff("", content) : old === undefined ? `(current content unreadable)\n${lineDiff("", content)}` : lineDiff(old, content);
			const salt = createHash("sha256").update(content).digest("hex");
			await authorize(ctx, t, { tool, path, diff, isNew }, signal, acc, salt, j);
		};
	}

	// --- journal ----------------------------------------------------------------------------------

	type Journaled = { how: string };
	/** Journal decision label of an authorize outcome. */
	const decisionOf = (how: string): string => (how === "asked" ? "asked→allowed" : how === "denied" ? "asked→denied" : how === "policy" || how === "no-ui" ? "denied" : how);

	/** One journal line (never content, output or passwords); a failing journal is reported once and ignored. */
	function journal(ctx: ExtensionContext, t: Remote, tool: string, summary: string, how: string, ok: boolean, detail: string | undefined, started: number): void {
		try {
			if (!paths) return;
			appendJournal(paths.journalFile, { ts: Date.now(), session: ctx.sessionManager.getSessionId(), device: label(t.device), user: t.conn.user, tool, summary, decision: how, ok, detail, ms: Date.now() - started });
		} catch (err) {
			if (journalWarned) return;
			journalWarned = true;
			try {
				ctx.ui.notify(`netbird-devices: cannot write the journal (${msg(err)}); further journal errors are not shown`, "warning");
			} catch {}
		}
	}

	/** Runs one remote action and journals it: tool, short summary, decision, result, duration. */
	async function journaled<T>(ctx: ExtensionContext, t: Remote, tool: string, summary: string, fn: (j: Journaled) => Promise<T>, detailOf?: (r: T) => string | undefined): Promise<T> {
		const started = Date.now();
		const j: Journaled = { how: "auto" };
		try {
			const r = await fn(j);
			const ok = !(r as any)?.isError;
			const exit = (r as any)?.structuredContent?.exit_code;
			journal(ctx, t, tool, summary, j.how, ok, typeof exit === "number" ? `exit ${exit}` : detailOf?.(r), started);
			return r;
		} catch (err) {
			const exit = /exited with code (\d+)/.exec(msg(err))?.[1];
			const refused = j.how === "denied" || j.how === "asked→denied" || j.how === "classifier:deny";
			const cancelled = err instanceof RootCancelled;
			journal(ctx, t, tool, summary, cancelled ? "asked→denied" : j.how, false, exit ? `exit ${exit}` : refused || cancelled ? undefined : "error", started);
			throw err;
		}
	}

	const diffStat = (r: any): string | undefined => {
		const diff = r?.details?.diff;
		if (typeof diff !== "string") return undefined;
		let plus = 0;
		let minus = 0;
		for (const l of diff.split("\n")) {
			if (/^\+\s*\d*\s/.test(l)) plus++;
			else if (/^-\s*\d*\s/.test(l)) minus++;
		}
		return `+${plus} −${minus}`;
	};

	/** Adds the classifier usage of this call to the result details. */
	const withUsage = (result: any, acc: ClassifierResult[]): any => {
		if (!acc.length || !result) return result;
		return { ...result, details: { ...(result.details ?? {}), netbirdClassifier: acc.map(({ decision, reason, model, usage }) => ({ decision, reason, model, usage })) } };
	};

	const isRemote = (d: unknown): boolean => isRemoteArg(d, localNames());

	const deviceProp = () => Type.Optional(Type.String({ description: DEVICE_PARAM_DESCRIPTION }));

	/** The built-in tool, plus `device`: without it (or for this machine) the built-in implementation runs unchanged. */
	function override(tool: ToolName, local: any, remoteExecute: (t: Remote, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>) {
		const parameters = Type.Object({ ...(local.parameters as any).properties, device: deviceProp() });
		pi.registerTool({
			...local,
			parameters,
			async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
				if (params?.device === undefined || params.device === null || params.device === "") return local.execute(id, params, signal, onUpdate, ctx);
				const t = await resolveTarget(params.device, ctx);
				if (t.kind === "local") return local.execute(id, params, signal, onUpdate, ctx);
				const remoteSignal = signal ? AbortSignal.any([session.signal, signal]) : session.signal;
				return remoteExecute(t, params, remoteSignal, onUpdate, ctx);
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

	// --- root -------------------------------------------------------------------------------------

	/** The root dialog on the device or in pi (PLAN §8). The password never reaches the model, the journal or a log. */
	function rootRun(ctx: ExtensionContext, t: Remote, command: string, signal?: AbortSignal) {
		const name = label(t.device);
		if (!ctx.hasUI) throw new Error(`root on ${name}: requires an interactive UI; nothing was run`);
		signal = signal ? AbortSignal.any([session.signal, signal]) : session.signal;
		return {
			pref: t.device.settings.rootPrompt,
			from: H().localLabel(),
			askPassword: async (): Promise<string | undefined> => {
				if (!secretInputAvailable(ctx)) throw new Error(`root on ${name}: ${SECRET_INPUT_NEEDS_TUI}`);
				return dialog(
					(sig) =>
						askSecret(ctx, {
							title: `Root password for ${name}`,
							message: `Pi agent asks to run as root on ${name}:\n${command.length > 300 ? `${command.slice(0, 300)}…` : command}`,
							warning: "Enter your password only if you expect this.",
							signal: sig,
						}),
					signal,
				);
			},
			signal,
		};
	}

	/** Is the user at this device right now (decides native dialog vs pi dialog for rootPrompt "auto")? */
	async function userIsAt(t: Remote): Promise<boolean> {
		try {
			const r = await H().resolveHere(pinnedHere);
			return r.kind === "found" && r.device === t.device.name;
		} catch {
			return false;
		}
	}

	/** bash operations that run `sudo <inner>`: password through the dialog, sudo -k (asks every time). */
	function createRootOps(ctx: ExtensionContext, t: Remote, inner: string, j: Journaled): BashOps {
		return {
			async exec(_command, _cwd, { onData, signal, timeout }) {
				const limitS = remoteTimeoutSeconds(timeout);
				const atDevice = await userIsAt(t);
				showRemote(t.device, ctx, "root");
				try {
					const r = await runRoot({ ...t.conn, device: label(t.device) }, {
						...rootRun(ctx, t, inner, signal),
						command: inner,
						userIsAtDevice: atDevice,
						onWaiting: (w) => showRemote(t.device, ctx, w ? "root" : undefined),
						timeoutMs: limitS * 1000,
						onData: (chunk) => onData(chunk),
					});
					return { exitCode: r.exitCode };
				} finally {
					if (!session.signal.aborted) showRemote(t.device, ctx);
				}
			},
		};
	}

	const cwd0 = process.cwd();

	{
		const local = createReadToolDefinition(cwd0) as any;
		override("read", local, async (t, params, signal, onUpdate, ctx) => {
			const abs = resolveRemotePath(String(params.path ?? ""), t.conn.home);
			return journaled(ctx, t, "read", abs, async (j) => {
				const acc: ClassifierResult[] = [];
				const check = (p: string) => authorize(ctx, t, { tool: "read", path: p }, signal, acc, undefined, j);
				const def = createReadToolDefinition(ctx.cwd, { operations: createReadOps(t.conn, check, signal, abs) } as any) as any;
				return withUsage(await def.execute("", { ...params, path: abs }, signal, onUpdate, ctx), acc);
			});
		});
	}
	{
		const local = createWriteToolDefinition(cwd0) as any;
		override("write", local, async (t, params, signal, onUpdate, ctx) => {
			const abs = resolveRemotePath(String(params.path ?? ""), t.conn.home);
			return journaled(
				ctx,
				t,
				"write",
				abs,
				async (j) => {
					early(t, { tool: "write", path: abs }, j);
					const acc: ClassifierResult[] = [];
					const def = createWriteToolDefinition(ctx.cwd, { operations: createWriteOps(t.conn, beforeWrite(ctx, t, "write", signal, acc, j), signal) } as any) as any;
					return withUsage(await def.execute("", { ...params, path: abs }, signal, onUpdate, ctx), acc);
				},
				() => (typeof params.content === "string" ? formatBytes(Buffer.byteLength(params.content)) : undefined),
			);
		});
	}
	{
		const local = createEditToolDefinition(cwd0) as any;
		override("edit", local, async (t, params, signal, onUpdate, ctx) => {
			const abs = resolveRemotePath(String(params.path ?? ""), t.conn.home);
			return journaled(
				ctx,
				t,
				"edit",
				abs,
				async (j) => {
					early(t, { tool: "edit", path: abs }, j);
					const acc: ClassifierResult[] = [];
					const def = createEditToolDefinition(ctx.cwd, { operations: createEditOps(t.conn, beforeWrite(ctx, t, "edit", signal, acc, j), (path) => authorize(ctx, t, { tool: "read", path }, signal, acc, undefined, j), signal) } as any) as any;
					return withUsage(await def.execute("", { ...params, path: abs }, signal, onUpdate, ctx), acc);
				},
				diffStat,
			);
		});
	}
	{
		const local = createBashToolDefinition(cwd0) as any;
		override("bash", local, async (t, params, signal, onUpdate, ctx) => {
			const command = String(params.command ?? "");
			const inner = splitSudo(command);
			return journaled(
				ctx,
				t,
				inner !== undefined ? "sudo" : "bash",
				inner ?? command,
				async (j) => {
					early(t, { tool: "bash", command }, j);
					const acc: ClassifierResult[] = [];
					await authorize(ctx, t, { tool: "bash", command }, signal, acc, undefined, j);
					const operations = inner !== undefined ? createRootOps(ctx, t, inner, j) : createBashOps(t.conn);
					// Do not leak the local session environment (PI_SESSION_FILE...) into the device command.
					const def = createBashToolDefinition(ctx.cwd, { operations, exposeSessionEnvironment: false } as any) as any;
					return withUsage(await def.execute("", params, signal, onUpdate, ctx), acc);
				},
				() => "exit 0",
			);
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
		const rows = deviceRows({ devices, probes, users, online, modeOf, localName: h.localLabel(), labelOf: label });
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

	/** Why a bash call is blocked (ssh/scp/curl… to a device without `device`), else undefined. */
	function guardCheck(command: unknown, device?: unknown): string | undefined {
		const h = H();
		if (isRemote(device)) return undefined; // runs on the device; what it does there is its own business
		const cmd = String(command ?? "");
		if (!mentionsNetVerb(cmd)) return undefined;
		const devices = h.devices();
		const hit = deviceTargetInCommand(cmd, { names: deviceNames(devices), domains: h.domains(), self: h.localNames() });
		return hit ? guardReason(hit, devices) : undefined;
	}

	// bitwarden-ssh loads first (alphabetical) and would open "Load SSH key?" for such a command before our
	// block runs; it asks this function and skips commands that are blocked anyway.
	const GUARD_KEY = "__piNetbirdDevicesGuard";
	(globalThis as any)[GUARD_KEY] = guardCheck;

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown; device?: unknown };
		const reason = guardCheck(input?.command, input?.device);
		if (reason) return { block: true, reason };
	});

	// --- lifecycle --------------------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		if (session.signal.aborted) {
			session = new AbortController();
			hub = undefined;
			(globalThis as any)[GUARD_KEY] = guardCheck;
		}
		ctxRef = ctx;
		try {
			// Global settings only: pi.getSettings() would merge in the project's .pi/settings.json.
			const parsed = loadGlobalSettings(join(getAgentDir(), "settings.json"));
			settings = parsed.settings;
			for (const w of parsed.warnings) ctx.ui.notify(`netbird-devices: ${w}`, "warning");
			if (event.reason !== "reload") {
				pinnedHere = undefined;
				lastDevice = undefined;
				policy.reset();
			}
			policy.restoreModes(ctx.sessionManager.getBranch());
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

	pi.on("session_tree", async (_event, ctx) => {
		policy.restoreModes(ctx.sessionManager.getBranch());
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
		if ((globalThis as any)[GUARD_KEY] === guardCheck) delete (globalThis as any)[GUARD_KEY];
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = undefined;
		ctxRef = undefined;
		await withTimeout(hub?.closeAll() ?? Promise.resolve(), 2500);
	});

	// --- /nb --------------------------------------------------------------------------------------

	const SUBS = ["list", "mode", "here", "classifier", "log", "refresh", "user", "test-root", "forget"];
	const USAGE = "Usage: /nb [list] | mode [device] [ro|ask|auto|full] | here [device|auto] | classifier [provider/model|default] | log [device] [n] | refresh | user <device> <user|auto> | test-root <device> | forget <device>";

	/** The device mode changes act on: the one the agent worked on last, else the one "here" stands for. */
	async function currentDevice(ctx: ExtensionContext): Promise<Device> {
		const h = H();
		await h.refresh();
		const last = lastDevice ? h.devices().find((d) => d.name === lastDevice) : undefined;
		return last ?? (await hereDevice(ctx, false));
	}

	/** Sets a device mode for this session (kept in the session file) and shows it in the footer. */
	function setDeviceMode(d: Device, mode: Mode, ctx: ExtensionContext): void {
		policy.setMode(d.name, mode);
		pi.appendEntry(MODE_ENTRY, { device: d.name, mode });
		showRemote(d, ctx);
		footerTimer = setTimeout(() => showLocal(ctx), FOOTER_RESET_MS);
		footerTimer.unref?.();
	}

	const modeLine = (d: Device) => `${label(d)}: mode ${modeOf(d)}${policy.overridden(d.name) ? " (this session)" : ""}`;

	async function modeCommand(a1: string | undefined, a2: string | undefined, ctx: ExtensionContext): Promise<string> {
		const h = H();
		await h.refresh();
		let d: Device | undefined;
		let mode: string | undefined = a2;
		if (a1 && isMode(a1) && !a2) mode = a1; // /nb mode ro
		else if (a1) d = findOrThrow(a1);
		if (!d) {
			try {
				d = await currentDevice(ctx);
			} catch (e) {
				const ssh = h.devices().filter((x) => x.sshEnabled);
				if (ssh.length === 1) d = ssh[0];
				else if (ctx.hasUI && ssh.length > 1) {
					const names = ssh.map(label);
					const pick = await dialog((signal) => ctx.ui.select("Which device?", names, { signal }));
					if (!pick) return "cancelled";
					d = ssh[names.indexOf(pick)];
				} else return `${msg(e)}\nUse /nb mode <device> [ro|ask|auto|full].`;
			}
		}
		if (!mode) {
			if (!ctx.hasUI) return `${modeLine(d)}. Modes: ${MODES.join(", ")}`;
			const choices = MODES.map((m) => (m === modeOf(d!) ? `${m}  (current)` : m));
			const pick = await dialog((signal) => ctx.ui.select(`Access mode for ${label(d!)}`, choices, { signal }));
			if (!pick) return modeLine(d);
			mode = pick.split(" ")[0];
		}
		if (!isMode(mode)) return `Unknown mode "${mode}". Modes: ${MODES.join(", ")}`;
		setDeviceMode(d, mode, ctx);
		return `${modeLine(d)}`;
	}

	async function classifierCommand(arg: string | undefined, ctx: ExtensionContext): Promise<string> {
		const h = H();
		const current = h.state.classifierModel ?? settings.classifierModel;
		let id = arg;
		if (!id) {
			const models = ctx.modelRegistry.getAvailable().map((m: any) => `${m.provider}/${m.id}`);
			if (!ctx.hasUI) return `classifier model: ${current}${h.state.classifierModel ? " (set with /nb classifier)" : " (settings)"}. Available: ${models.join(", ") || "none"}`;
			if (!models.length) return "No models are available in pi.";
			const choices = models.map((m: string) => (m === current ? `${m}  (current)` : m));
			const pick = await dialog((signal) => ctx.ui.select(`Classifier model for auto mode (now ${current})`, choices, { signal }));
			if (!pick) return `classifier model unchanged: ${current}`;
			id = pick.replace(/ {2}\(current\)$/, "");
		}
		if (id === "default" || id === "reset") {
			h.updateState((s) => {
				delete s.classifierModel;
			});
			return `classifier model: ${settings.classifierModel} (from settings)`;
		}
		const slash = id.indexOf("/");
		if (slash <= 0 || !ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1))) return `Unknown model "${id}" (use provider/model; /nb classifier lists the available ones)`;
		const chosen = id;
		h.updateState((s) => {
			s.classifierModel = chosen;
		});
		return `classifier model: ${chosen} (saved)`;
	}

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
			case "mode":
				return modeCommand(a1, a2, ctx);
			case "classifier":
				return classifierCommand(a1, ctx);
			case "log": {
				await h.refresh();
				const numeric = a1 !== undefined && /^\d+$/.test(a1);
				const n = Number(numeric ? a1 : a2) || 20;
				const dev = numeric || !a1 ? undefined : (findDevice(h.devices(), a1) ? label(findDevice(h.devices(), a1)!) : a1);
				const entries = readJournal(paths!.journalFile, 5000);
				return formatLog(entries, { device: dev, n });
			}
			case "test-root": {
				if (!a1) return "Usage: /nb test-root <device>";
				const d = findOrThrow(a1);
				if (!d.sshEnabled) return `${label(d)}: NetBird SSH is not enabled on this device`;
				const conn = await h.connect(d, { ask: askUser(ctx) });
				const t: Remote = { kind: "remote", device: d, conn };
				const name = label(d);
				showRemote(d, ctx, "root");
				try {
					return await testRoot({ ...conn, device: name }, { ...rootRun(ctx, t, "true"), pref: d.settings.rootPrompt, userIsAtDevice: await userIsAt(t), onWaiting: (w) => showRemote(d, ctx, w ? "root" : undefined) });
				} catch (e) {
					return e instanceof RootCancelled ? `${name}: ${e.message}` : `${name}: ${msg(e)}`;
				} finally {
					showRemote(d, ctx);
					footerTimer = setTimeout(() => showLocal(ctx), FOOTER_RESET_MS);
					footerTimer.unref?.();
				}
			}
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
		description: "NetBird devices: list (default), mode [device] [ro|ask|auto|full], classifier [provider/model], here [device|auto], log [device] [n], refresh, user <device> <user|auto>, test-root <device>, forget <device>",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
				return items.length ? items : null;
			}
			const sub = parts[0];
			if (parts.length === 2 && ["here", "user", "forget", "mode", "log", "test-root"].includes(sub)) {
				const names = hub ? hub.devices().map((d) => label(d)) : [];
				if (sub === "here") names.push("auto");
				if (sub === "mode") names.push(...MODES);
				const items = names.filter((n) => n.startsWith(parts[1] ?? "")).map((n) => ({ value: `${sub} ${n}`, label: n }));
				return items.length ? items : null;
			}
			if (parts.length === 3 && sub === "mode") {
				const items = MODES.filter((m) => m.startsWith(parts[2] ?? "")).map((m) => ({ value: `mode ${parts[1]} ${m}`, label: m }));
				return items.length ? items : null;
			}
			if (parts.length === 2 && sub === "classifier") {
				return "default".startsWith(parts[1] ?? "") ? [{ value: "classifier default", label: "default" }] : null;
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

	pi.registerShortcut(MODE_SHORTCUT, {
		description: "NetBird devices: cycle the access mode (ro → ask → auto → full) of the current device",
		handler: async (ctx) => {
			ctxRef = ctx;
			try {
				const d = await currentDevice(ctx);
				const m = nextMode(modeOf(d));
				setDeviceMode(d, m, ctx);
				ctx.ui.notify(modeLine(d), "info");
			} catch (err) {
				ctx.ui.notify(`netbird-devices: ${msg(err)}. Use /nb mode <device>.`, "warning");
			}
		},
	});
}
