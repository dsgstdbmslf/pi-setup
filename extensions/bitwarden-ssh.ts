// bitwarden-ssh: Bitwarden login, SSH keys from the vault in a shared ssh-agent, an askpass bridge
// (masked pi dialogs for ssh/sudo/git prompts) and an SSH config synced through a Bitwarden Secure Note.
// Modules live in extensions/bitwarden-ssh/. Secrets stay in local variables and in the stdin/env of
// the one child process that needs them: never in tool results, notifications, logs or files.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addKey, clearKeys, ensureAgent, listLoaded, type LoadedKey, removeKey } from "./bitwarden-ssh/agent.ts";
import { type AskHandler, type AskpassServer, setupAskpassEnv, startAskpassServer, writeClientScript } from "./bitwarden-ssh/askpass.ts";
import { Bitwarden, BwError, type SshKeyItem, shared as bwShared, type StatusInfo } from "./bitwarden-ssh/bw.ts";
import {
	type BuiltConfig,
	buildGenerated,
	ensureInclude,
	expandHome,
	keyForPubPath,
	publishGenerated,
	readSource,
	type RegenerateResult,
	sha256,
	writeSource,
} from "./bitwarden-ssh/config-store.ts";
import { run } from "./bitwarden-ssh/exec.ts";
import { findByName, keyFingerprint } from "./bitwarden-ssh/keyutil.ts";
import { askpassSocket, ensureDir, type Paths, resolvePaths } from "./bitwarden-ssh/paths.ts";
import { withFileLock } from "./bitwarden-ssh/lock.ts";
import { askSecret, SECRET_INPUT_NEEDS_TUI, secretInputAvailable } from "./bitwarden-ssh/secret-input.ts";
import { parseSettings, type Settings } from "./bitwarden-ssh/settings.ts";
import {
	addHost,
	ConfigSyntaxError,
	configErrors,
	getHostBlockText,
	hostNames,
	identityPaths,
	listHosts,
	matchKeyName,
	type OptionValues,
	parseConfig,
	removeHost,
	serializeConfig,
	setHostOptions,
	unquote,
	validateOptions,
} from "./bitwarden-ssh/sshconfig.ts";
import { type CachedKey, loadState, saveState, type State } from "./bitwarden-ssh/state.ts";
import { footerText, formatDuration, formatKeyRows, hostsInCommand, lineDiff, mentionsNetworkCommand, truncate } from "./bitwarden-ssh/ui-text.ts";

const STATUS_KEY = "bitwarden-ssh";
const NOTE_LIMIT_WARN = 9000;
const KEEP_PATH = "(keep path as is)";

// Process-wide resources (survive /new, /resume, /fork and /reload of this pi process).
interface ProcessShared {
	askpass?: AskpassServer;
	askpassStarting?: Promise<AskpassServer>;
	handler?: AskHandler;
	footerTimer?: ReturnType<typeof setInterval>;
	originalSock?: { value: string | undefined };
	agentStarted?: boolean;
}
const G_KEY = Symbol.for("pi.bitwarden-ssh");
function g(): ProcessShared {
	const o = globalThis as any;
	return (o[G_KEY] ??= {});
}

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

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

class UserError extends Error {}
/** The config failed validation (lexical/arity errors or `ssh -G`); nothing was written. */
class InvalidConfig extends UserError {}

const CONFIG_CHANGED = "SSH config changed in another pi session; retry";

export default function bitwardenSsh(pi: ExtensionAPI) {
	const bw = new Bitwarden({ autoLockMinutes: () => settings.autoLockMinutes });
	let settings: Settings = parseSettings(undefined).settings;
	let paths: Paths | undefined;
	let ctxRef: ExtensionContext | undefined;
	let lastStatus: StatusInfo | "missing" | undefined;
	const hostKeyCache = new Map<string, { at: number; keys: CachedKey[] }>();
	// One controller per session generation: session_shutdown (any reason: quit, reload, new, resume,
	// fork) aborts it, which cancels open and queued dialogs and askpass requests of the old session.
	let session = new AbortController();
	let myHandler: AskHandler | undefined;

	const P = (): Paths => {
		if (!paths) paths = resolvePaths({ agentDir: getAgentDir(), home: homedir(), uid: process.getuid?.() ?? 0 });
		return paths;
	};
	const readState = (): State => loadState(P().stateFile).state;
	/** Cross-process lock for the source config, state.json and the generated files (other pi processes share them). */
	const withConfigLock = <T>(fn: () => Promise<T> | T): Promise<T> => {
		ensureDir(P().dataDir);
		return withFileLock(join(P().dataDir, "config.lock"), fn);
	};
	/** Read-modify-write of state.json under the lock, so concurrent pi processes do not lose updates. */
	const updateState = (fn: (s: State) => void): Promise<State> =>
		withConfigLock(() => {
			const s = readState();
			fn(s);
			saveState(P().stateFile, s);
			return s;
		});
	const ttlText = () => (settings.keyTtl ? `TTL ${settings.keyTtl}` : "no TTL");
	const lockedWhy = (ctx: ExtensionContext) => (secretInputAvailable(ctx) ? "unlock declined or not possible" : SECRET_INPUT_NEEDS_TUI);
	/**
	 * One dialog at a time. A dialog of an ended session never opens, and an open one settles (undefined)
	 * when the session ends: pi disposes dialogs on /reload and session switches without resolving them.
	 */
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

	// --- footer -----------------------------------------------------------------------------------

	async function loadedKeys(): Promise<LoadedKey[]> {
		try {
			return await listLoaded(P().agentSock);
		} catch {
			return [];
		}
	}

	async function refreshStatus(): Promise<StatusInfo | "missing" | undefined> {
		try {
			lastStatus = await bw.status();
		} catch (err) {
			if (err instanceof BwError && err.kind === "missing") lastStatus = "missing";
		}
		return lastStatus;
	}

	async function updateFooter(ctx = ctxRef): Promise<void> {
		if (!ctx?.hasUI) return;
		const loaded = (await loadedKeys()).length;
		let text: string;
		if (lastStatus === "missing") text = footerText({ kind: "missing" });
		else if (bw.unlocked) text = footerText({ kind: "unlocked", loaded });
		else if (lastStatus?.status === "unauthenticated") text = footerText({ kind: "unauthenticated" });
		else text = footerText({ kind: "locked", loaded });
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {}
	}

	// --- vault ------------------------------------------------------------------------------------

	async function cacheKeys(items: SshKeyItem[]): Promise<State> {
		const keys = items.map((i) => ({ id: i.id, name: i.name, fingerprint: i.fingerprint, publicKey: i.publicKey }));
		const s = await updateState((st) => {
			st.keys = keys;
		});
		hostKeyCache.clear();
		return s;
	}

	async function unlockDialog(ctx: ExtensionContext, reason?: string): Promise<boolean> {
		// Never ask for the master password through an unmasked input (RPC mode): fail closed.
		if (!secretInputAvailable(ctx)) return false;
		let warning: string | undefined;
		for (let attempt = 1; attempt <= 3; attempt++) {
			const email = lastStatus && lastStatus !== "missing" ? lastStatus.userEmail : undefined;
			let password = await dialog((signal) =>
				askSecret(ctx, {
					title: "Bitwarden master password",
					message: [email ? `Unlock the vault of ${email}` : "Unlock the Bitwarden vault", reason].filter(Boolean).join(" — "),
					warning,
					signal,
				}),
			);
			if (password === undefined) return false;
			try {
				await bw.unlock(password);
				password = "";
				await updateFooter(ctx);
				return true;
			} catch (err) {
				password = "";
				if (err instanceof BwError && err.kind !== "failed") {
					ctx.ui.notify(err.message, "error");
					return false;
				}
				warning = `${msg(err)} (attempt ${attempt} of 3)`;
			}
		}
		ctx.ui.notify("Bitwarden: unlock failed 3 times", "error");
		return false;
	}

	/** Make sure the vault is unlocked, asking the user. False when not possible or declined. */
	async function ensureUnlocked(ctx: ExtensionContext, reason?: string): Promise<boolean> {
		if (bw.unlocked) {
			// Our session may have been invalidated by bw unlock elsewhere.
			const st = await refreshStatus();
			if (st !== "missing" && st?.status === "unlocked") return true;
		}
		if (!ctx.hasUI) return false;
		const st = await refreshStatus();
		if (st === "missing") {
			ctx.ui.notify("bw (Bitwarden CLI) is not installed or not in PATH", "error");
			return false;
		}
		if (!st) return false;
		if (st.status === "unlocked") return true;
		if (!secretInputAvailable(ctx)) return false;
		if (st.status === "unauthenticated") {
			const ok = await dialog((signal) => ctx.ui.confirm("Bitwarden", "Not logged in to Bitwarden. Log in now?", { signal }));
			if (!ok) return false;
			await loginFlow(ctx);
			return bw.unlocked;
		}
		return unlockDialog(ctx, reason);
	}

	async function loginFlow(ctx: ExtensionContext): Promise<string> {
		if (!ctx.hasUI) return "bw login needs interactive pi";
		if (!secretInputAvailable(ctx)) return `Bitwarden login: ${SECRET_INPUT_NEEDS_TUI}`;
		const st = await refreshStatus();
		if (st === "missing") return "bw (Bitwarden CLI) is not installed or not in PATH";
		if (st && st.status !== "unauthenticated") {
			return `Already logged in${st.userEmail ? ` as ${st.userEmail}` : ""} (vault ${st.status}). Use /bw unlock, or /bw logout first.`;
		}
		const how = await dialog((signal) => ctx.ui.select("Bitwarden login", ["API key (recommended)", "Email + master password"], { signal }));
		if (!how) return "Login cancelled";
		if (how.startsWith("API")) {
			const clientId = await dialog((signal) => ctx.ui.input("Bitwarden API key: client_id", "user.xxxxxxxx-...", { signal }));
			if (!clientId?.trim()) return "Login cancelled";
			let secret = await dialog((signal) => askSecret(ctx, { title: "Bitwarden API key: client_secret", message: `client_id ${clientId.trim()}`, signal }));
			if (!secret) return "Login cancelled";
			try {
				await bw.loginApiKey(clientId.trim(), secret);
			} finally {
				secret = "";
			}
			await refreshStatus();
			const ok = await unlockDialog(ctx, "logged in with the API key; now unlock");
			await updateFooter(ctx);
			return ok ? "Bitwarden: logged in and unlocked" : "Bitwarden: logged in (vault locked; /bw unlock)";
		}
		const def = st ? st.userEmail : undefined;
		const emailIn = await dialog((signal) => ctx.ui.input("Bitwarden email", def ?? "you@example.com", { signal }));
		const email = emailIn?.trim() || def;
		if (!email) return "Login cancelled";
		let password = await dialog((signal) => askSecret(ctx, { title: "Bitwarden master password", message: `Log in as ${email}`, signal }));
		if (!password) return "Login cancelled";
		try {
			try {
				await bw.loginPassword(email, password);
			} catch (err) {
				if (!(err instanceof BwError && err.kind === "needs2fa")) throw err;
				const methods: Record<string, 0 | 1 | 3> = { "Authenticator app": 0, Email: 1, YubiKey: 3 };
				const m = await dialog((signal) => ctx.ui.select("Two-step login method", Object.keys(methods), { signal }));
				if (!m) return "Login cancelled";
				const code = await dialog((signal) => ctx.ui.input(`Two-step login code (${m})`, "", { signal }));
				if (!code?.trim()) return "Login cancelled";
				await bw.loginPassword(email, password, { method: methods[m], code: code.trim() });
			}
		} finally {
			password = "";
		}
		await refreshStatus();
		await updateFooter(ctx);
		return `Bitwarden: logged in as ${email} and unlocked`;
	}

	// --- keys -------------------------------------------------------------------------------------

	function nameOf(fp: string, keys: CachedKey[]): string | undefined {
		return keys.find((k) => keyFingerprint(k) === fp)?.name;
	}

	/** Keys a host uses, by reverse-mapping `ssh -G` identity files to generated .pub files. */
	async function hostKeys(host: string): Promise<CachedKey[]> {
		const hit = hostKeyCache.get(host);
		if (hit && Date.now() - hit.at < 30_000) return hit.keys;
		const r = await run("ssh", ["-G", host], { timeoutMs: 10_000 });
		const state = readState();
		const keys: CachedKey[] = [];
		if (r.code === 0) {
			for (const line of r.stdout.split("\n")) {
				const m = /^identityfile\s+(.+)$/i.exec(line.trim());
				if (!m) continue;
				const k = keyForPubPath(P(), state, expandHome(unquote(m[1]), P().home));
				if (k && !keys.some((x) => x.id === k.id)) keys.push(k);
			}
		}
		hostKeyCache.set(host, { at: Date.now(), keys });
		return keys;
	}

	/** Load the given vault key ids into the agent (unlocking first). Returns a summary; never key material. */
	async function loadKeys(ctx: ExtensionContext, select: (items: SshKeyItem[]) => SshKeyItem[] | string): Promise<{ loaded: string[]; failed: string[]; error?: string }> {
		if (!(await ensureUnlocked(ctx, "to load SSH keys"))) return { loaded: [], failed: [], error: `vault locked (${lockedWhy(ctx)})` };
		let items: SshKeyItem[] | undefined = await bw.listSshKeys();
		try {
			await cacheKeys(items);
			const chosen = select(items);
			if (typeof chosen === "string") return { loaded: [], failed: [], error: chosen };
			const loaded: string[] = [];
			const failed: string[] = [];
			for (const it of chosen) {
				try {
					await addKey(P().agentSock, it.privateKey, settings.keyTtl);
					loaded.push(it.name);
				} catch (err) {
					failed.push(`${it.name}: ${msg(err)}`);
				}
			}
			return { loaded, failed };
		} finally {
			items = undefined; // drop the private keys
			void updateFooter(ctx);
		}
	}

	function loadSummary(r: { loaded: string[]; failed: string[]; error?: string }): string {
		if (r.error) return `Not loaded: ${r.error}`;
		const parts: string[] = [];
		if (r.loaded.length) parts.push(`Loaded into ssh-agent (${ttlText()}): ${r.loaded.join(", ")}`);
		if (r.failed.length) parts.push(`Failed: ${r.failed.join("; ")}`);
		return parts.join("\n") || "No keys loaded";
	}

	/** Resolve "all", a key name or a host to a selector over vault items. */
	async function targetSelector(arg: string): Promise<(items: SshKeyItem[]) => SshKeyItem[] | string> {
		const a = arg.trim();
		if (a === "all") return (items) => (items.length ? items : "the vault has no SSH key items");
		const hosts = hostNames(parseConfig(readSource(P()) ?? ""));
		const byHost = hosts.includes(a) ? await hostKeys(a) : [];
		return (items) => {
			const named = findByName(items, a);
			if (named.length === 1) return named;
			if (named.length > 1) return `several SSH key items are named "${a}"`;
			if (byHost.length) {
				const ids = new Set(byHost.map((k) => k.id));
				const hit = items.filter((i) => ids.has(i.id));
				if (hit.length) return hit;
			}
			if (hosts.includes(a)) return `host ${a} has no IdentityFile mapped to a Bitwarden key (see /ssh config map)`;
			return `no SSH key item or configured host named "${a}"`;
		};
	}

	async function keyRows(): Promise<{ text: string; cached: boolean }> {
		let keys: CachedKey[];
		let cached = true;
		if (bw.unlocked) {
			try {
				let items: SshKeyItem[] | undefined = await bw.listSshKeys();
				keys = (await cacheKeys(items)).keys;
				items = undefined;
				cached = false;
			} catch {
				keys = readState().keys;
			}
		} else keys = readState().keys;
		const loaded = new Set((await loadedKeys()).map((k) => k.fingerprint));
		const text = formatKeyRows(keys.map((k) => ({ name: k.name, fingerprint: keyFingerprint(k), loaded: loaded.has(keyFingerprint(k)) })));
		return { text, cached };
	}

	/** Offer to load the keys of hosts named in a command (bash tool, user `!` commands, /ssh test). */
	async function offerHostKeys(ctx: ExtensionContext, hosts: string[]): Promise<void> {
		if (!ctx.hasUI || !hosts.length) return;
		const loaded = new Set((await loadedKeys()).map((k) => k.fingerprint));
		for (const host of hosts) {
			const missing = (await hostKeys(host)).filter((k) => !loaded.has(keyFingerprint(k)));
			if (!missing.length) continue;
			const names = missing.map((k) => k.name).join(", ");
			const ok = await dialog((signal) => ctx.ui.confirm("Load SSH key?", `Load key ${names} for host ${host} into ssh-agent (${ttlText()})?`, { signal }));
			if (!ok) continue;
			const ids = new Set(missing.map((k) => k.id));
			const r = await loadKeys(ctx, (items) => items.filter((i) => ids.has(i.id)));
			ctx.ui.notify(loadSummary(r), r.error || r.failed.length ? "warning" : "info");
			for (const k of missing) loaded.add(keyFingerprint(k));
		}
	}

	// --- status -----------------------------------------------------------------------------------

	async function statusText(): Promise<string> {
		const st = await refreshStatus();
		const lines: string[] = [];
		if (st === "missing") lines.push("vault: bw (Bitwarden CLI) not installed");
		else if (!st) lines.push("vault: status unknown (bw status failed)");
		else {
			lines.push(`vault: ${st.status}${st.userEmail ? ` (${st.userEmail})` : ""}`);
			lines.push(`server: ${st.serverUrl ?? "bitwarden.com (default)"}`);
			if (st.lastSync) lines.push(`last sync: ${st.lastSync}`);
		}
		const rem = bw.lockRemaining();
		lines.push(`auto-lock: ${settings.autoLockMinutes > 0 ? (rem !== undefined ? `in ${formatDuration(rem)}` : `${settings.autoLockMinutes}m idle`) : "off"}`);
		lines.push(`ssh-agent: ${P().agentSock}`);
		const orig = g().originalSock?.value;
		if (orig && orig !== P().agentSock) lines.push(`  (SSH_AUTH_SOCK before pi: ${orig})`);
		const loaded = await loadedKeys();
		const keys = readState().keys;
		lines.push(`loaded keys: ${loaded.length} (new keys get ${ttlText()})`);
		for (const k of loaded) lines.push(`  ● ${nameOf(k.fingerprint, keys) ?? k.comment} ${k.fingerprint} (${k.type})`);
		return lines.join("\n");
	}

	// --- SSH config sync --------------------------------------------------------------------------

	type Regen = (RegenerateResult & { include?: "created" | "added" | "present" }) | undefined;
	/** Regenerate the generated config and .pub files from the current source and state (validated first). */
	function regen(opts: { include?: boolean } = {}): Promise<Regen> {
		return publish({ include: opts.include });
	}
	const includeNote = (r: Regen): string[] =>
		r?.include && r.include !== "present" ? [`${r.include === "created" ? "Created" : "Added an Include line to"} ${P().userConfig}`] : [];

	function regenSummary(r: RegenerateResult | undefined, extra: string[] = []): string {
		if (!r) return "No SSH config yet (run /ssh config pull)";
		const hosts = listHosts(parseConfig(readSource(P()) ?? ""));
		const lines = [`Generated ${r.generatedFile}: ${hosts.length} host block(s), ${r.mapped.length} IdentityFile(s) mapped to Bitwarden keys`, ...extra];
		if (r.unmatched.length) lines.push(`Unmapped IdentityFile (not on this server, no Bitwarden key): ${r.unmatched.join(", ")} — /ssh config map`);
		if (r.disabled.length) lines.push(`Disabled (unusable here): ${r.disabled.join("; ")}`);
		return lines.join("\n");
	}

	/** `ssh -G -F` on exactly `text` (the final generated config); the first error lines, or undefined if valid. */
	async function sshCheck(built: BuiltConfig): Promise<string | undefined> {
		const text = built.text;
		ensureDir(P().runDir);
		const tmp = join(P().runDir, `check-${process.pid}-${randomBytes(4).toString("hex")}.conf`);
		try {
			writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
			const r = await run("ssh", ["-G", "-F", tmp, "pi-bw-syntax-check.invalid"], { timeoutMs: 10_000 });
			if (r.error) return undefined; // ssh missing: skip the check
			if (r.code === 0) return undefined;
			const line = r.stderr
				.split("\n")
				.map((l) =>
					l
						.split(tmp)
						.join("generated config")
						// Point at the source line the user wrote, where there is one.
						.replace(/generated config:? line (\d+)/g, (m, n) => (built.sourceLines[Number(n)] ? `line ${built.sourceLines[Number(n)]}` : m))
						.trim(),
				)
				.filter((l) => l && !/^Pseudo-terminal/.test(l))
				.slice(0, 3)
				.join("; ");
			return line || `ssh -G exit ${r.code}`;
		} finally {
			try {
				unlinkSync(tmp);
			} catch {}
		}
	}

	/** The exact generated config for `source` with `state`; lexical/arity errors become InvalidConfig. */
	function build(source: string, state: State): BuiltConfig {
		try {
			return buildGenerated(P(), state, source, { controlPersist: settings.controlPersist });
		} catch (err) {
			if (err instanceof ConfigSyntaxError) throw new InvalidConfig(err.message);
			throw err;
		}
	}

	/**
	 * Validate, then publish. Builds the exact final generated config from `source` (default: the current
	 * source) with the current state plus `identity` and `mutate`, checks that exact text with `ssh -G -F`,
	 * and only then, under the config lock, re-checks that the source is still `base` (default: what was
	 * read here), writes the source (if given), state.json, the .pub files and the generated config, and
	 * ensures the Include. If the state changed meanwhile, the rebuilt text is checked again. On any
	 * failure nothing is written: the old source and generated files stay in place.
	 */
	async function publish(opts: {
		source?: string;
		base?: string | undefined;
		identity?: State["identityMap"];
		mutate?: (s: State) => void;
		include?: boolean;
	}): Promise<Regen> {
		const current = readSource(P());
		const base = "base" in opts ? opts.base : current;
		if (base !== current) throw new UserError(CONFIG_CHANGED);
		const source = opts.source ?? current;
		if (source === undefined) return undefined;
		const stateFor = (s: State): State => {
			Object.assign(s.identityMap, opts.identity ?? {});
			opts.mutate?.(s);
			return s;
		};
		const built = build(source, stateFor(readState()));
		const bad = await sshCheck(built);
		if (bad) throw new InvalidConfig(`ssh: ${bad}`);
		return withConfigLock(async () => {
			if (readSource(P()) !== base) throw new UserError(CONFIG_CHANGED);
			const st = stateFor(readState());
			const final = build(source, st);
			if (final.text !== built.text) {
				const again = await sshCheck(final);
				if (again) throw new InvalidConfig(`ssh: ${again}`);
			}
			if (opts.source !== undefined) writeSource(P(), source);
			saveState(P().stateFile, st);
			const r = publishGenerated(P(), final);
			hostKeyCache.clear();
			return opts.include ? { ...r, include: ensureInclude(P().userConfig, P().generatedFile) } : r;
		});
	}

	/** Map IdentityFile paths to vault keys: auto-match by name, ask for the rest (or for all with `all`). */
	async function mapIdentities(
		ctx: ExtensionContext,
		source: string,
		opts: { askAll?: boolean } = {},
	): Promise<{ notes: string[]; changes: State["identityMap"] }> {
		const state = readState();
		const notes: string[] = [];
		// Only the entries decided here are returned; publish() merges them into a fresh state.json under
		// the lock (dialogs take time; another pi may have written meanwhile).
		const changes: State["identityMap"] = {};
		const set = (path: string, v: { itemId: string; name: string }) => {
			state.identityMap[path] = v;
			changes[path] = v;
		};
		for (const path of identityPaths(parseConfig(source))) {
			const cur = state.identityMap[path];
			const curValid = cur && (cur.itemId === "" || state.keys.some((k) => k.id === cur.itemId));
			if (curValid && !opts.askAll) continue;
			if (!opts.askAll) {
				const auto = matchKeyName(path, state.keys);
				if (auto) {
					set(path, { itemId: auto.id, name: auto.name });
					notes.push(`${path} -> ${auto.name} (matched by name)`);
					continue;
				}
				if (existsHere(path)) continue;
			}
			if (!ctx.hasUI || !state.keys.length) continue;
			const choices = [...state.keys.map((k) => k.name + (cur?.itemId === k.id ? "  (current)" : "")), KEEP_PATH + (cur?.itemId === "" ? "  (current)" : "")];
			const pick = await dialog((signal) => ctx.ui.select(`Bitwarden SSH key for IdentityFile ${path}`, choices, { signal }));
			if (!pick) continue;
			const name = pick.replace(/ {2}\(current\)$/, "");
			if (name === KEEP_PATH) set(path, { itemId: "", name: "" });
			else {
				const k = state.keys.find((x) => x.name === name);
				if (k) {
					set(path, { itemId: k.id, name: k.name });
					notes.push(`${path} -> ${k.name}`);
				}
			}
		}
		return { notes, changes };
	}

	function existsHere(path: string): boolean {
		return existsSync(expandHome(path, P().home));
	}

	async function pullFlow(ctx: ExtensionContext): Promise<string> {
		if (!(await ensureUnlocked(ctx, "to pull the SSH config"))) throw new UserError(`Vault locked (${lockedWhy(ctx)}): pull cancelled`);
		const warnings: string[] = [];
		try {
			await bw.sync();
		} catch (err) {
			warnings.push(`bw sync failed (${msg(err)}); using the local vault copy`);
		}
		const note = await bw.findNote(settings.configNote);
		if (!note) throw new UserError(`No Bitwarden secure note named "${settings.configNote}". Create it on your computer (see README) or run /ssh config push.`);
		// Lexical errors first (cheap, with source line numbers); the full check runs on the final text below.
		const lexical = configErrors(note.notes);
		if (lexical.length) throw new UserError(`The note "${note.name}" is not a valid SSH config; kept the local config. ${lexical.join("; ")}`);
		const local = readSource(P());
		const state = readState();
		if (local !== undefined && local !== note.notes && (!state.syncedHash || sha256(local) !== state.syncedHash)) {
			const ok = await dialog((signal) =>
				ctx.ui.confirm(
					"Overwrite local SSH config?",
					`The local SSH config changed since the last pull/push. Overwrite it with the note "${note.name}"?\n\n${lineDiff(local, note.notes, 25)}`,
					{ signal },
				),
			);
			if (!ok) throw new UserError("Pull cancelled; local config kept (use /ssh config push to upload it)");
		}
		if (note.notes.length > NOTE_LIMIT_WARN) warnings.push(`the note has ${note.notes.length} characters; Bitwarden notes are limited to 10000`);
		// Refresh the key cache, then map identities with the real current keys, then validate exactly the
		// config that will be installed, and only then replace anything (publish).
		let items: SshKeyItem[] | undefined = await bw.listSshKeys();
		await cacheKeys(items);
		items = undefined;
		const { notes: mapped, changes } = await mapIdentities(ctx, note.notes);
		let r: Regen;
		try {
			r = await publish({
				source: note.notes,
				base: local,
				identity: changes,
				mutate: (st) => {
					st.note = { id: note.id, name: note.name };
					st.syncedHash = sha256(note.notes);
				},
				include: true,
			});
		} catch (err) {
			if (err instanceof InvalidConfig) throw new UserError(`The note "${note.name}" is not a valid SSH config; kept the local config. ${err.message}`);
			throw err;
		}
		const extra = [...mapped.map((m) => `mapped ${m}`), ...includeNote(r)];
		return [`Pulled "${note.name}" (${note.notes.length} chars).`, regenSummary(r, extra), ...warnings.map((w) => `Warning: ${w}`)].join("\n");
	}

	async function pushFlow(ctx: ExtensionContext, confirmed = false): Promise<string> {
		const text = readSource(P());
		if (text === undefined) throw new UserError("No local SSH config to push (run /ssh config pull or /ssh config edit first)");
		if (!(await ensureUnlocked(ctx, "to push the SSH config"))) throw new UserError(`Vault locked (${lockedWhy(ctx)}): push cancelled`);
		const note = await bw.findNote(settings.configNote);
		if (note && note.notes === text) return `Note "${note.name}" is already up to date`;
		if (!confirmed) {
			const body = note
				? `Overwrite the text of the Bitwarden note "${note.name}" with the local SSH config?\n\n${lineDiff(note.notes, text, 25)}`
				: `Create the Bitwarden secure note "${settings.configNote}" with the local SSH config (${text.length} chars)?`;
			const ok = await dialog((signal) => ctx.ui.confirm("Push SSH config to Bitwarden?", body, { signal }));
			if (!ok) throw new UserError("Push cancelled");
		}
		await withConfigLock(async () => {
			// Push only what the user confirmed: if another pi changed the source meanwhile, retry.
			if (readSource(P()) !== text) throw new UserError(CONFIG_CHANGED);
			const id = await bw.saveNote(settings.configNote, text, note?.id);
			const st = readState();
			st.note = { id: id || note?.id || "", name: settings.configNote };
			st.syncedHash = sha256(text);
			saveState(P().stateFile, st);
		});
		const warn = text.length > NOTE_LIMIT_WARN ? `\nWarning: ${text.length} characters; Bitwarden notes are limited to 10000` : "";
		return `${note ? "Updated" : "Created"} Bitwarden note "${settings.configNote}" (${text.length} chars)${warn}`;
	}

	/**
	 * Apply an edit to the source config: syntax check, write, map new identities, regenerate. `base` is the
	 * source text the edit was made from (and the user confirmed); if another pi process changed the source
	 * since, nothing is written and the caller is told to retry.
	 */
	async function applySource(ctx: ExtensionContext, base: string | undefined, next: string): Promise<string> {
		const lexical = configErrors(next);
		if (lexical.length) throw new UserError(`Invalid SSH config: ${lexical.join("; ")}`);
		const { notes: mapped, changes } = await mapIdentities(ctx, next);
		let r: Regen;
		try {
			r = await publish({ source: next, base, identity: changes, include: true });
		} catch (err) {
			if (err instanceof InvalidConfig) throw new UserError(`Invalid SSH config: ${err.message}`);
			throw err;
		}
		const extra = [...mapped.map((m) => `mapped ${m}`), ...includeNote(r)];
		extra.push("Not yet in Bitwarden: /ssh config push (or ssh_config push) uploads it.");
		return regenSummary(r, extra);
	}

	async function hostsText(): Promise<string> {
		const source = readSource(P());
		if (source === undefined) return "No SSH config yet (run /ssh config pull)";
		const state = readState();
		const loaded = new Set((await loadedKeys()).map((k) => k.fingerprint));
		const rows = listHosts(parseConfig(source)).map((h) => {
			const o = (k: string) => h.options[k]?.[0];
			const keys = (h.options.identityfile ?? []).map((p) => {
				const m = state.identityMap[p];
				const k = m?.itemId ? state.keys.find((x) => x.id === m.itemId) : undefined;
				if (!k) return `${p} (unmapped)`;
				return `${k.name} ${loaded.has(keyFingerprint(k)) ? "●" : "○"}`;
			});
			const parts = [
				o("hostname") && `HostName ${o("hostname")}`,
				o("user") && `User ${o("user")}`,
				o("port") && `Port ${o("port")}`,
				o("proxyjump") && `ProxyJump ${o("proxyjump")}`,
				keys.length && `key ${keys.join(", ")}`,
			].filter(Boolean);
			return `  ${h.patterns.join(" ")}${parts.length ? `  — ${parts.join(" · ")}` : ""}`;
		});
		return rows.length ? `Hosts (● key loaded, ○ not loaded):\n${rows.join("\n")}` : "The SSH config has no Host blocks";
	}

	// --- events -----------------------------------------------------------------------------------

	/**
	 * The askpass socket is reachable by every process of this user (also the agent's bash), and the
	 * requester the client names is a claim: the dialog always marks it unverified and always warns.
	 */
	function askHandler(ctx: ExtensionContext, sessionSignal: AbortSignal): AskHandler {
		return async (req, reqSignal) => {
			if (!ctx.hasUI) return undefined;
			const signal = AbortSignal.any([reqSignal, sessionSignal]);
			if (signal.aborted) return undefined;
			const prompt = req.prompt.trim();
			if (req.kind === "secret" && !secretInputAvailable(ctx)) {
				try {
					ctx.ui.notify(`bitwarden-ssh: askpass prompt "${truncate(prompt || "Password", 80)}" cancelled: ${SECRET_INPUT_NEEDS_TUI}`, "warning");
				} catch {}
				return undefined;
			}
			const who = [
				`Requested by (unverified): ${req.requester.cmdline}`,
				...(req.requester.fromThisPi === false ? ["⚠ not started from this pi session"] : []),
			].join("\n");
			const warning = "the program that asked will receive what you type";
			return dialog(async () => {
				if (signal.aborted) return undefined;
				switch (req.kind) {
					case "confirm":
						return ctx.ui.confirm("SSH confirmation", `${prompt}\n\n${who}\n⚠ ${warning}`, { signal });
					case "yesno":
						return ctx.ui.select(`${prompt}\n${who}\n⚠ ${warning}`, ["yes", "no"], { signal });
					case "visible":
						return ctx.ui.input(`${prompt} — ${who.replace(/\n/g, " · ")} (⚠ ${warning})`, "", { signal });
					default:
						return askSecret(ctx, { title: prompt || "Password", message: who, warning, signal });
				}
			});
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		// Before any await: the askpass server must never call a handler of an ended session.
		if (session.signal.aborted) session = new AbortController();
		ctxRef = ctx;
		const shared = g();
		myHandler = askHandler(ctx, session.signal);
		shared.handler = myHandler;
		try {
			const parsed = parseSettings((pi.getSettings() as any)?.bitwardenSsh);
			settings = parsed.settings;
			for (const w of parsed.warnings) ctx.ui.notify(`bitwarden-ssh: ${w}`, "warning");
			const p = P();
			ensureDir(p.dataDir);
			ensureDir(p.runDir);
			ensureDir(p.binDir);
			shared.originalSock ??= { value: process.env.SSH_AUTH_SOCK };
			try {
				const r = await ensureAgent(p.agentSock);
				shared.agentStarted ||= r.started;
				process.env.SSH_AUTH_SOCK = p.agentSock;
			} catch (err) {
				ctx.ui.notify(`bitwarden-ssh: ssh-agent unavailable: ${msg(err)}`, "warning");
			}
			if (!shared.askpass) {
				shared.askpassStarting ??= (async () => {
					writeClientScript(p.askpassScript);
					return startAskpassServer(askpassSocket(p), () => g().handler);
				})();
				try {
					shared.askpass = await shared.askpassStarting;
					setupAskpassEnv(process.env, { scriptPath: p.askpassScript, sockPath: shared.askpass.sockPath, binDir: p.binDir });
				} catch (err) {
					ctx.ui.notify(`bitwarden-ssh: askpass bridge unavailable: ${msg(err)}`, "warning");
				} finally {
					shared.askpassStarting = undefined;
				}
			}
			const bwState = bwShared();
			bwState.onChange = () => void updateFooter();
			bwState.onAutoLock = () => {
				try {
					ctxRef?.ui.notify(`Bitwarden: locked after ${settings.autoLockMinutes} idle minutes (keys in ssh-agent stay until their TTL)`, "info");
				} catch {}
			};
			if (shared.footerTimer) clearInterval(shared.footerTimer);
			if (ctx.hasUI) {
				shared.footerTimer = setInterval(() => void updateFooter(), 30_000);
				shared.footerTimer.unref?.();
				void updateFooter(ctx);
				void refreshStatus().then(() => updateFooter(ctx));
			}
		} catch (err) {
			try {
				ctx.ui.notify(`bitwarden-ssh: ${msg(err)}`, "warning");
			} catch {}
		}
	});

	pi.on("session_shutdown", async (event) => {
		const shared = g();
		// Every reason (quit, reload, new, resume, fork): cancel this session's dialogs and askpass
		// requests; until the next session_start installs its handler, askpass requests get "not ok".
		session.abort();
		if (shared.handler === myHandler) shared.handler = undefined;
		myHandler = undefined;
		if (shared.footerTimer) clearInterval(shared.footerTimer);
		shared.footerTimer = undefined;
		if (event.reason === "quit") {
			bw.forget();
			shared.askpass?.close();
			shared.askpass = undefined;
			shared.handler = undefined;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as any)?.command ?? "");
		if (!ctx.hasUI || !mentionsNetworkCommand(command)) return;
		try {
			await offerHostKeys(ctx, hostsInCommand(command, hostNames(parseConfig(readSource(P()) ?? ""))));
		} catch {}
	});

	pi.on("user_bash", async (event, ctx) => {
		const m = /^\s*bw\s+(login|unlock|lock|status)\b[^;&|]*$/.exec(event.command);
		if (m) {
			let output: string;
			try {
				output = await bwCommand(m[1], "", ctx);
			} catch (err) {
				output = msg(err);
			}
			return { result: { output: `${output}\n(handled by pi bitwarden-ssh: interactive bw prompts cannot work here)\n`, exitCode: 0, cancelled: false, truncated: false } };
		}
		if (!ctx.hasUI || !mentionsNetworkCommand(event.command)) return;
		try {
			await offerHostKeys(ctx, hostsInCommand(event.command, hostNames(parseConfig(readSource(P()) ?? ""))));
		} catch {}
		return;
	});

	// --- /bw --------------------------------------------------------------------------------------

	async function bwCommand(sub: string, rest: string, ctx: ExtensionContext): Promise<string> {
		switch (sub) {
			case "":
			case "status":
				return statusText();
			case "login":
				return loginFlow(ctx);
			case "unlock": {
				const st = await refreshStatus();
				if (st === "missing") return "bw (Bitwarden CLI) is not installed or not in PATH";
				if (st?.status === "unauthenticated") return "Not logged in: run /bw login";
				if (bw.unlocked && st?.status === "unlocked") return "Bitwarden: already unlocked";
				if (!ctx.hasUI) return "bw unlock needs interactive pi";
				if (!secretInputAvailable(ctx)) return `Bitwarden unlock: ${SECRET_INPUT_NEEDS_TUI}`;
				return (await unlockDialog(ctx)) ? "Bitwarden: unlocked" : "Bitwarden: still locked";
			}
			case "lock": {
				const errs: string[] = [];
				try {
					await bw.lock();
				} catch (err) {
					if (!(err instanceof BwError && (err.kind === "locked" || err.kind === "unauthenticated"))) errs.push(msg(err));
				}
				try {
					await clearKeys(P().agentSock);
				} catch (err) {
					errs.push(msg(err));
				}
				await refreshStatus();
				return `Bitwarden: locked; ssh-agent keys removed${errs.length ? ` (warnings: ${errs.join("; ")})` : ""}`;
			}
			case "sync":
				if (!(await ensureUnlocked(ctx, "to sync"))) return `Vault locked (${lockedWhy(ctx)}): sync cancelled`;
				await bw.sync();
				return "Bitwarden: synced";
			case "logout": {
				if (!ctx.hasUI) return "bw logout needs interactive pi";
				const ok = await dialog((signal) => ctx.ui.confirm("Log out of Bitwarden?", "This logs the bw CLI out for every process of this user (keys in ssh-agent stay until their TTL).", { signal }));
				if (!ok) return "Logout cancelled";
				await bw.logout();
				await refreshStatus();
				return "Bitwarden: logged out";
			}
			case "server": {
				const url = rest.trim();
				if (!url) return "Usage: /bw server <url>  (e.g. https://vault.example.com; https://vault.bitwarden.eu for the EU cloud)";
				await bw.setServer(url);
				return `Bitwarden: server set to ${url}`;
			}
			default:
				return `Unknown: /bw ${sub}. Use status, login, unlock, lock, sync, logout or server <url>.`;
		}
	}

	const report = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, level);

	pi.registerCommand("bw", {
		description: "Bitwarden: status (default), login, unlock, lock, sync, logout, server <url>",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				["status", "vault, agent and loaded keys"],
				["login", "log in (API key or email + password)"],
				["unlock", "unlock with the master password"],
				["lock", "lock and remove keys from ssh-agent"],
				["sync", "pull vault changes"],
				["logout", "log out the bw CLI"],
				["server", "set the server URL (logged out only)"],
			]
				.filter(([v]) => v.startsWith(prefix.trim()))
				.map(([v, d]) => ({ value: v === "server" ? "server " : v, label: v, description: d }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			try {
				report(ctx, await bwCommand(sub, rest.join(" "), ctx));
			} catch (err) {
				report(ctx, `bw: ${msg(err)}`, "error");
			} finally {
				void updateFooter(ctx);
			}
		},
	});

	// --- /ssh -------------------------------------------------------------------------------------

	async function sshCommand(sub: string, rest: string, ctx: any): Promise<{ text: string; level?: "info" | "warning" | "error" }> {
		const arg = rest.trim();
		switch (sub) {
			case "":
			case "list": {
				const r = await keyRows();
				return { text: `Bitwarden SSH keys${r.cached ? " (cached, vault locked)" : ""} — ● loaded, ○ not loaded:\n${r.text}` };
			}
			case "add": {
				let target = arg;
				if (!target) {
					if (!ctx.hasUI) return { text: "Usage: /ssh add <name|all|host>", level: "warning" };
					let keys = readState().keys;
					if (!keys.length) {
						if (!(await ensureUnlocked(ctx, "to list SSH keys"))) return { text: `Vault locked (${lockedWhy(ctx)})`, level: "warning" };
						let items: SshKeyItem[] | undefined = await bw.listSshKeys();
						keys = (await cacheKeys(items)).keys;
						items = undefined;
					}
					if (!keys.length) return { text: "The vault has no SSH key items", level: "warning" };
					const pick = await dialog<string | undefined>((signal) => ctx.ui.select("Load which SSH key into ssh-agent?", ["all", ...keys.map((k) => k.name)], { signal }));
					if (!pick) return { text: "Cancelled" };
					target = pick;
				}
				const r = await loadKeys(ctx, await targetSelector(target));
				return { text: loadSummary(r), level: r.error || r.failed.length ? "warning" : "info" };
			}
			case "rm": {
				const loaded = await loadedKeys();
				const keys = readState().keys;
				if (!loaded.length) return { text: "ssh-agent has no keys" };
				let name = arg;
				if (!name) {
					if (!ctx.hasUI) return { text: "Usage: /ssh rm <name>", level: "warning" };
					const labels = loaded.map((k) => nameOf(k.fingerprint, keys) ?? `${k.comment} ${k.fingerprint}`);
					const pick = await dialog<string | undefined>((signal) => ctx.ui.select("Remove which key from ssh-agent?", labels, { signal }));
					if (!pick) return { text: "Cancelled" };
					name = pick;
				}
				const k = findByName(keys, name)[0];
				if (!k) return { text: `No cached Bitwarden key named "${name}" (use /ssh clear to remove all keys)`, level: "warning" };
				await removeKey(P().agentSock, k.publicKey);
				return { text: `Removed ${k.name} from ssh-agent` };
			}
			case "clear":
				await clearKeys(P().agentSock);
				return { text: "Removed all keys from ssh-agent" };
			case "test": {
				let host = arg;
				const hosts = hostNames(parseConfig(readSource(P()) ?? ""));
				if (!host) {
					if (!ctx.hasUI || !hosts.length) return { text: "Usage: /ssh test <host>", level: "warning" };
					const pick = await dialog<string | undefined>((signal) => ctx.ui.select("Test SSH connection to", hosts, { signal }));
					if (!pick) return { text: "Cancelled" };
					host = pick;
				}
				if (!/^[A-Za-z0-9._@:%[\]-]+$/.test(host) || host.startsWith("-")) return { text: `Invalid host ${host}`, level: "error" };
				if (hosts.includes(host)) await offerHostKeys(ctx, [host]);
				const r = await run("ssh", ["-T", "-o", "ConnectTimeout=10", host], { timeoutMs: 60_000 });
				const out = truncate(`${r.stdout}${r.stderr}`.trim(), 2000);
				const head = r.error ? `ssh ${host}: ${r.error}` : `ssh -T ${host}: exit ${r.code}`;
				return { text: `${head}${out ? `\n${out}` : ""}`, level: r.code === 0 ? "info" : "warning" };
			}
			case "hosts":
				return { text: await hostsText() };
			case "config":
				return configCommand(arg, ctx);
			default:
				return { text: `Unknown: /ssh ${sub}. Use list, add, rm, clear, test, hosts or config.`, level: "warning" };
		}
	}

	async function configCommand(arg: string, ctx: any): Promise<{ text: string; level?: "info" | "warning" | "error" }> {
		const sub = arg.split(/\s+/)[0] || "show";
		switch (sub) {
			case "pull":
				return { text: await pullFlow(ctx) };
			case "push":
				return { text: await pushFlow(ctx) };
			case "edit": {
				if (!ctx.hasUI) return { text: "/ssh config edit needs interactive pi", level: "warning" };
				const orig = readSource(P());
				const cur = orig ?? "";
				const next = await dialog<string | undefined>(() => ctx.ui.editor("SSH config (as on your computer; IdentityFile paths stay as there)", cur));
				if (next === undefined || next === cur) return { text: "No changes" };
				return { text: await applySource(ctx, orig, next) };
			}
			case "map": {
				if (!readSource(P())) return { text: "No SSH config yet (run /ssh config pull)", level: "warning" };
				if (bw.unlocked) {
					let items: SshKeyItem[] | undefined = await bw.listSshKeys();
					await cacheKeys(items);
					items = undefined;
				}
				const source = readSource(P()) ?? "";
				const { notes, changes } = await mapIdentities(ctx, source, { askAll: true });
				return { text: regenSummary(await publish({ base: source, identity: changes }), notes.map((n) => `mapped ${n}`)) };
			}
			case "show": {
				const source = readSource(P());
				const st = readState();
				const lines = [
					`source (original form): ${P().sourceFile}${source === undefined ? " (missing)" : ""}`,
					`generated: ${P().generatedFile}`,
					`included from: ${P().userConfig}`,
					`Bitwarden note: ${settings.configNote}${st.note ? ` (id ${st.note.id})` : ""}`,
					`local changes since last pull/push: ${source === undefined ? "-" : st.syncedHash ? (sha256(source) === st.syncedHash ? "no" : "yes") : "unknown"}`,
				];
				if (source !== undefined) {
					try {
						lines.push(regenSummary(await regen()));
					} catch (err) {
						lines.push(`Not regenerated (kept ${P().generatedFile}): ${msg(err)}`);
					}
				}
				return { text: lines.join("\n") };
			}
			default:
				return { text: `Unknown: /ssh config ${sub}. Use pull, push, edit, show or map.`, level: "warning" };
		}
	}

	pi.registerCommand("ssh", {
		description: "SSH keys from Bitwarden: list, add, rm, clear, test, hosts, config pull|push|edit|show|map",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.trimStart().split(/\s+/);
			const top: [string, string][] = [
				["list", "Bitwarden SSH keys and whether they are loaded"],
				["add", "load key(s) into ssh-agent: name, all or host"],
				["rm", "remove a key from ssh-agent"],
				["clear", "remove all keys from ssh-agent"],
				["test", "test the connection to a host"],
				["hosts", "hosts of the synced SSH config"],
				["config", "pull, push, edit, show, map"],
			];
			if (parts.length <= 1) {
				const items = top.filter(([v]) => v.startsWith(parts[0] ?? "")).map(([v, d]) => ({ value: ["add", "rm", "test", "config"].includes(v) ? `${v} ` : v, label: v, description: d }));
				return items.length ? items : null;
			}
			if (parts.length > 2) return null;
			const [sub, word] = parts;
			let values: { v: string; d?: string }[] = [];
			try {
				const hosts = hostNames(parseConfig(readSource(P()) ?? ""));
				const keys = readState().keys;
				if (sub === "add") values = [{ v: "all", d: "every SSH key item" }, ...keys.map((k) => ({ v: k.name, d: "key" })), ...hosts.map((h) => ({ v: h, d: "host" }))];
				else if (sub === "rm") values = keys.map((k) => ({ v: k.name }));
				else if (sub === "test") values = hosts.map((h) => ({ v: h }));
				else if (sub === "config")
					values = [
						{ v: "pull", d: "fetch from the Bitwarden note" },
						{ v: "push", d: "write to the Bitwarden note" },
						{ v: "edit", d: "edit the source config" },
						{ v: "show", d: "paths and summary" },
						{ v: "map", d: "map IdentityFile paths to keys" },
					];
			} catch {}
			const items = values.filter((x) => x.v.startsWith(word)).map((x) => ({ value: `${sub} ${x.v}`, label: x.v, description: x.d }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			try {
				const r = await sshCommand(sub, rest.join(" "), ctx);
				report(ctx, r.text, r.level);
			} catch (err) {
				report(ctx, `ssh: ${msg(err)}`, err instanceof UserError ? "warning" : "error");
			} finally {
				void updateFooter(ctx);
			}
		},
	});

	// --- tools ------------------------------------------------------------------------------------

	const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError: true } : {}) });

	pi.registerTool({
		name: "ssh_keys",
		label: "ssh_keys",
		description:
			"SSH keys stored in Bitwarden and the shared ssh-agent. status: vault state and loaded keys. list: SSH key items (name, fingerprint, loaded). load: ask the user to load a key (by name) or the keys of a configured host into ssh-agent; the user confirms and unlocks the vault. unload: remove a key from ssh-agent. Never returns private keys.",
		promptSnippet: "List SSH keys from Bitwarden and ask the user to load them into ssh-agent",
		promptGuidelines: [
			"SSH keys come from Bitwarden: on \"Permission denied (publickey)\" call ssh_keys (action load, with host or name) before retrying ssh, scp, rsync or git.",
			"Never ask the user to type passwords, passphrases or master passwords in chat: prompts of ssh, sudo and git open a masked pi dialog by themselves, so run plain `sudo` and plain `ssh`.",
			"Never try to read Bitwarden secrets with the bw CLI; use ssh_keys and ssh_config.",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "list", "load", "unload"] as const, "status, list, load or unload"),
			name: Type.Optional(Type.String({ description: 'Key item name (load/unload); "all" loads every key.' })),
			host: Type.Optional(Type.String({ description: "Configured host whose keys to load (load)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "status":
						return text(await statusText());
					case "list": {
						const r = await keyRows();
						return text(`Bitwarden SSH keys${r.cached ? " (cached; vault locked)" : ""} — ● loaded, ○ not loaded:\n${r.text}`);
					}
					case "load": {
						if (!ctx.hasUI) return text("ssh_keys load needs interactive pi (the user must confirm and unlock)", true);
						const target = (params.host ?? params.name ?? "").trim();
						if (!target) return text("load needs name or host", true);
						const ok = await dialog((signal) =>
							ctx.ui.confirm("Load SSH key?", `The agent asks to load SSH key(s) ${params.host ? `for host ${target}` : target} into ssh-agent (${ttlText()}).`, { signal }),
						);
						if (!ok) return text("The user declined loading the key(s).", true);
						const r = await loadKeys(ctx, await targetSelector(target));
						return text(loadSummary(r), !!r.error || (!r.loaded.length && !!r.failed.length));
					}
					case "unload": {
						const name = (params.name ?? "").trim();
						if (!name) return text("unload needs name", true);
						const k = findByName(readState().keys, name)[0];
						if (!k) return text(`No Bitwarden key named "${name}"`, true);
						await removeKey(P().agentSock, k.publicKey);
						return text(`Removed ${k.name} from ssh-agent`);
					}
				}
				return text("unknown action", true);
			} catch (err) {
				return text(msg(err), true);
			} finally {
				void updateFooter(ctx);
			}
		},
	});

	pi.registerTool({
		name: "ssh_config",
		label: "ssh_config",
		description:
			"Read and edit the SSH config synced with Bitwarden (the source form as on the user's computer; IdentityFile paths are mapped to Bitwarden keys when generating ~/.ssh/pi-bitwarden/config). list: hosts. get: one host block. add: new host (patterns + options). update: set options of a host (null removes an option). remove: remove a host. pull: fetch the config from the Bitwarden note. push: upload it. update, remove, pull and push ask the user to confirm.",
		promptSnippet: "Read and edit SSH hosts in the Bitwarden-synced SSH config",
		promptGuidelines: [
			"Edit SSH hosts with ssh_config, never edit ~/.ssh/pi-bitwarden/config directly (it is generated and overwritten).",
			"ssh_config option names are ssh_config keywords (HostName, User, Port, ProxyJump, IdentityFile...); values are strings or string arrays, null removes an option.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "add", "update", "remove", "pull", "push"] as const, "list, get, add, update, remove, pull or push"),
			host: Type.Optional(Type.String({ description: "Host pattern (get, update, remove; add when patterns is omitted)." })),
			patterns: Type.Optional(Type.Array(Type.String(), { description: "Host patterns of a new block (add)." })),
			options: Type.Optional(
				Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()]), {
					description: 'Options, e.g. {"HostName": "10.0.0.5", "User": "root", "Port": null}.',
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const source = readSource(P());
				const host = params.host?.trim();
				switch (params.action) {
					case "list": {
						if (source === undefined) return text("No SSH config yet (ssh_config pull fetches it from Bitwarden)");
						return text(await hostsText());
					}
					case "get": {
						if (!host) return text("get needs host", true);
						const t = getHostBlockText(parseConfig(source ?? ""), host);
						return t ? text(t) : text(`No Host block lists ${host}`, true);
					}
					case "add": {
						const patterns = params.patterns?.length ? params.patterns : host ? [host] : [];
						const opts = (params.options ?? {}) as OptionValues;
						const blocks = parseConfig(source ?? "");
						addHost(blocks, patterns, opts);
						const summary = await applySource(ctx, source, serializeConfig(blocks));
						return text(`Added Host ${patterns.join(" ")}.\n${summary}`);
					}
					case "update":
					case "remove": {
						if (!host) return text(`${params.action} needs host`, true);
						if (source === undefined) return text("No SSH config yet", true);
						if (!ctx.hasUI) return text(`ssh_config ${params.action} needs interactive pi (the user must confirm)`, true);
						const blocks = parseConfig(source);
						const before = getHostBlockText(blocks, host);
						if (!before) return text(`No Host block lists ${host}`, true);
						let found: boolean;
						if (params.action === "update") {
							const opts = (params.options ?? {}) as OptionValues;
							if (!Object.keys(opts).length) return text("update needs options", true);
							const e = validateOptions(opts);
							if (e) return text(e, true);
							found = setHostOptions(blocks, host, opts);
						} else found = removeHost(blocks, host);
						if (!found) return text(`No Host block lists ${host}`, true);
						const next = serializeConfig(blocks);
						const ok = await dialog((signal) =>
							ctx.ui.confirm(`The agent wants to ${params.action} SSH host ${host}`, lineDiff(source, next, 30), { signal }),
						);
						if (!ok) return text("The user declined the change.", true);
						const summary = await applySource(ctx, source, next);
						return text(`${params.action === "update" ? "Updated" : "Removed"} ${host}:\n${lineDiff(source, next, 30)}\n${summary}`);
					}
					case "pull": {
						if (!ctx.hasUI) return text("ssh_config pull needs interactive pi", true);
						const ok = await dialog((signal) =>
							ctx.ui.confirm("Pull SSH config?", `The agent asks to fetch the SSH config from the Bitwarden note "${settings.configNote}" and regenerate ${P().generatedFile}.`, { signal }),
						);
						if (!ok) return text("The user declined the pull.", true);
						return text(await pullFlow(ctx));
					}
					case "push": {
						if (!ctx.hasUI) return text("ssh_config push needs interactive pi", true);
						return text(await pushFlow(ctx));
					}
				}
				return text("unknown action", true);
			} catch (err) {
				return text(msg(err), true);
			} finally {
				void updateFooter(ctx);
			}
		},
	});
}
