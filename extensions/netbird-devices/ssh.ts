// Transport: OpenSSH client through child_process.spawn (no shell, arguments as an array) with
// ControlMaster multiplexing, plus the small operations the device tools need (probe, read, write,
// access, stat, path variants, idle, port check, user detection). No pi imports.
//
// Scripts run through the login shell of the device user (zsh on macOS), so they are POSIX sh.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { ensureDir } from "../bitwarden-ssh/paths.ts";
import { IDLE_PROBE, parseIdle } from "./presence.ts";
import { PROBE_SCRIPT, type ProbeInfo, parseProbe, pathVariantsScript, shq } from "./remote.ts";

export interface SshPaths {
	/** Our own known_hosts. */
	knownHosts: string;
	/** Directory of the ControlMaster sockets. */
	cmDir: string;
}

export interface Target {
	user: string;
	/** IP or DNS name to connect to. */
	host: string;
	port?: number;
	/** Host key identity: the FQDN of the peer (or its name); defaults to `host`. */
	hostKeyAlias?: string;
	paths: SshPaths;
	/** The ssh program (tests substitute a fake). Default "ssh". */
	sshBin?: string;
	/** Seconds for the TCP connect and handshake. Default 8. */
	connectTimeout?: number;
	/** Session namespace: do not share/close another Pi runtime's ControlMaster. */
	controlId?: string;
}

export type SshErrorKind = "auth" | "hostkey-changed" | "jwt-required" | "timeout" | "unreachable";

const SAFE_USER = /^[\w][\w.@-]*$/;
const SAFE_HOST = /^[\w][\w.:%-]*$/;

/** Arguments of `ssh` for a target, up to and including the destination; the remote command follows. */
export function sshArgs(t: Target): string[] {
	if (!SAFE_USER.test(t.user)) throw new Error(`invalid user name: ${JSON.stringify(t.user)}`);
	if (!SAFE_HOST.test(t.host)) throw new Error(`invalid host: ${JSON.stringify(t.host)}`);
	const alias = t.hostKeyAlias ?? t.host;
	if (!SAFE_HOST.test(alias)) throw new Error(`invalid host key alias: ${JSON.stringify(alias)}`);
	const o = (k: string, v: string | number) => ["-o", `${k}=${v}`];
	return [
		"-F", "/dev/null",
		"-p", String(t.port ?? 22),
		"-T",
		...o("BatchMode", "yes"),
		...o("ConnectTimeout", t.connectTimeout ?? 8),
		...o("ServerAliveInterval", 15),
		...o("ServerAliveCountMax", 3),
		...o("ControlMaster", "auto"),
		...o("ControlPath", `${t.paths.cmDir}/${t.controlId ? createHash("sha256").update(JSON.stringify([t.controlId, t.user, t.host, t.port ?? 22, alias])).digest("hex").slice(0, 40) : "%C"}`),
		...o("ControlPersist", "10m"),
		...o("StrictHostKeyChecking", "accept-new"),
		...o("UserKnownHostsFile", t.paths.knownHosts),
		...o("HostKeyAlias", alias),
		...o("ForwardAgent", "no"),
		...o("ForwardX11", "no"),
		...o("ClearAllForwardings", "yes"),
		"--",
		`${t.user}@${t.host}`,
	];
}

export interface ExecOptions {
	stdin?: Buffer | string;
	signal?: AbortSignal;
	/** Kill ssh after this many ms. Default 120 s. */
	timeoutMs?: number;
	/** Called with every chunk as it arrives. */
	onData?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
	/** Stop and flag `truncated` beyond this many combined stdout/stderr bytes. Default 32 MB. */
	maxBytes?: number;
}

export interface ExecResult {
	/** Exit code; null when killed by a signal. */
	code: number | null;
	stdout: Buffer;
	stderr: string;
	/** Terminating signal, if any. */
	signal?: string;
	timedOut?: boolean;
	aborted?: boolean;
	truncated?: boolean;
	/** The ssh program could not be started. */
	spawnError?: string;
}

function prepare(paths: SshPaths): void {
	// In /tmp the parent is just as important as the leaf: another user must
	// not be able to replace cm/ after it has passed the ownership check.
	for (const d of [dirname(paths.cmDir), paths.cmDir, dirname(paths.knownHosts)]) ensureDir(d);
	const fd = openSync(paths.knownHosts, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) throw new Error("known_hosts is not an owned regular file");
		fchmodSync(fd, 0o600);
	} finally { closeSync(fd); }
}

/** ssh prints these on the first connection to a host and when parallel calls race to open the master; not output of the remote command. */
export function stripSshNoise(stderr: string): string {
	return stderr
		.split("\n")
		.filter((l) => !/^Warning: Permanently added .* to the list of known hosts\.?$/.test(l.trim()) && !/^ControlSocket .* already exists, disabling multiplexing$/.test(l.trim()) && !/^mux_client_\w+:/.test(l.trim()))
		.join("\n");
}

/** Run a script on the device. Never throws for remote failures: inspect the result (see `classifyError`). */
export function exec(t: Target, script: string, opts: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve) => {
		if (opts.signal?.aborted) {
			resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", aborted: true });
			return;
		}
		let args: string[];
		try {
			prepare(t.paths);
			args = [...sshArgs(t), script];
		} catch (err) {
			resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", spawnError: (err as Error).message });
			return;
		}
		const out: Buffer[] = [];
		let outputBytes = 0;
		let err = "";
		const max = opts.maxBytes ?? 32 * 1024 * 1024;
		const res: ExecResult = { code: null, stdout: Buffer.alloc(0), stderr: "" };
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let exitTimer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn>;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			clearTimeout(exitTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			res.stdout = Buffer.concat(out);
			res.stderr = stripSshNoise(err);
			resolve(res);
		};
		const kill = () => {
			child?.kill("SIGTERM");
			if (!killTimer) killTimer = setTimeout(() => child?.kill("SIGKILL"), 2000);
			killTimer.unref();
		};
		const onAbort = () => {
			res.aborted = true;
			kill();
		};
		const timer = setTimeout(() => {
			res.timedOut = true;
			kill();
		}, opts.timeoutMs ?? 120_000);
		try {
			child = spawn(t.sshBin ?? "ssh", args, { stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		} catch (e) {
			clearTimeout(timer);
			resolve({ ...res, spawnError: (e as Error).message });
			return;
		}
		child.on("error", (e) => {
			res.spawnError = e.message;
			finish();
		});
		const accept = (c: Buffer): boolean => {
			outputBytes += c.length;
			if (outputBytes > max) {
				if (!res.truncated) {
					res.truncated = true;
					kill();
				}
				return false;
			}
			return true;
		};
		child.stdout!.on("data", (c: Buffer) => {
			if (!accept(c)) return;
			out.push(c);
			opts.onData?.(c, "stdout");
		});
		child.stderr!.on("data", (c: Buffer) => {
			if (!accept(c)) return;
			if (err.length < 1024 * 1024) err += c.toString("utf8");
			opts.onData?.(c, "stderr");
		});
		child.on("close", (code, signal) => {
			res.code = code;
			if (signal) res.signal = signal;
			finish();
		});
		// A grandchild that keeps the pipes open must not keep us waiting after ssh itself is gone.
		child.on("exit", (code, signal) => {
			res.code = code;
			if (signal) res.signal = signal;
			exitTimer = setTimeout(finish, 300);
			exitTimer.unref();
		});
		if (opts.stdin !== undefined && child.stdin) {
			child.stdin.on("error", () => {}); // EPIPE when the remote command does not read its input
			child.stdin.end(opts.stdin);
		}
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/**
 * Why the connection itself failed (ssh exits 255 for its own errors), or undefined when the remote
 * command ran. Pure.
 */
export function classifyError(r: Pick<ExecResult, "code" | "stderr" | "timedOut">): SshErrorKind | undefined {
	if (r.timedOut) return "timeout";
	if (r.code !== 255) return undefined;
	const e = r.stderr;
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .* has changed/i.test(e)) return "hostkey-changed";
	if (/NetBird-JWT-Required|JWT/i.test(e)) return "jwt-required";
	if (/Permission denied|Too many authentication failures|authentication failed|No supported authentication/i.test(e)) return "auth";
	if (/timed out|timeout/i.test(e)) return "timeout";
	if (/Connection refused|No route to host|Network is unreachable|Could not resolve hostname|Connection closed|Connection reset|kex_exchange_identification|Host is down|Broken pipe/i.test(e)) return "unreachable";
	return undefined;
}

/** A sentence for the agent/user. */
export function describeError(kind: SshErrorKind, device: string, user?: string): string {
	switch (kind) {
		case "auth":
			return `${device}: login${user ? ` as ${user}` : ""} was refused (no such user, or NetBird SSH needs authentication). Set the user with /nb user ${device} <name>.`;
		case "hostkey-changed":
			return `${device}: the host key changed. If that is expected, run /nb forget ${device} and retry.`;
		case "jwt-required":
			return `${device}: NetBird SSH requires JWT (OIDC) via netbird ssh proxy and daemon access, unavailable here. Use the device directly or ask the owner to configure supported access; do not disable authentication automatically.`;
		case "timeout":
			return `${device}: connection timed out (device offline or NetBird SSH not reachable).`;
		case "unreachable":
			return `${device}: cannot connect (offline, SSH disabled or blocked by a NetBird ACL).`;
	}
}

export class SshError extends Error {
	kind?: SshErrorKind;
	/** Node-style code for file operations: ENOENT, EACCES, EISDIR... */
	code?: string;
	result?: ExecResult;
	constructor(message: string, init: { kind?: SshErrorKind; code?: string; result?: ExecResult } = {}) {
		super(message);
		this.name = "SshError";
		Object.assign(this, init);
	}
}

/** Throws SshError for connection failures; otherwise returns the result (remote exit codes are the caller's business). */
export function assertConnected(r: ExecResult, device = "device", user?: string): ExecResult {
	if (r.spawnError) throw new SshError(`cannot run ssh: ${r.spawnError}`, { result: r });
	if (r.aborted) throw new SshError("aborted", { result: r });
	const kind = classifyError(r);
	if (kind) throw new SshError(describeError(kind, device, user), { kind, result: r });
	return r;
}

function fileError(r: ExecResult, path: string): SshError {
	const e = r.stderr.trim();
	let code: string | undefined;
	if (/No such file|not found/i.test(e)) code = "ENOENT";
	else if (/Permission denied/i.test(e)) code = "EACCES";
	else if (/Is a directory/i.test(e)) code = "EISDIR";
	return new SshError(`${path}: ${e || `exit ${r.code}`}`, { code, result: r });
}

const SCRIPT_TIMEOUT = 30_000;

export async function probe(t: Target): Promise<ProbeInfo> {
	const r = assertConnected(await exec(t, PROBE_SCRIPT, { timeoutMs: 20_000 }), t.hostKeyAlias ?? t.host, t.user);
	const info = parseProbe(r.stdout.toString("utf8"));
	if (!info) throw new SshError(`unexpected probe output from ${t.host}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`, { result: r });
	return info;
}

/** Resolve file/parent symlinks, including parents of a new file, without Python or GNU realpath.
 * Best effort only: another process can replace a link between this check and the I/O. */
export async function canonicalPath(t: Target, abs: string, opts: ExecOptions = {}): Promise<string> {
	const script = [
		`p=${shq(abs)}; tail=''; n=0`,
		'while [ "$n" -lt 80 ]; do',
		'  n=$((n + 1))',
		'  if [ -L "$p" ]; then',
		'    link=$(readlink "$p") || exit 1',
		'    case "$link" in /*) p="$link";; *) p="$(dirname "$p")/$link";; esac',
		'  elif [ -d "$p" ]; then',
		'    cd -P "$p" || exit 1',
		'    printf "%s%s" "$(pwd -P)" "$tail"; exit 0',
		'  else',
		'    tail="/$(basename "$p")$tail"; p=$(dirname "$p")',
		'  fi',
		'done; exit 1',
	].join("\n");
	const r = assertConnected(await exec(t, script, { timeoutMs: SCRIPT_TIMEOUT, ...opts }), t.hostKeyAlias ?? t.host, t.user);
	const result = r.stdout.toString("utf8");
	if (r.code !== 0 || !result.startsWith("/")) throw new SshError("Cannot resolve remote path safely (symlink loop or inaccessible parent)");
	return result;
}

export async function readFile(t: Target, abs: string, opts: ExecOptions = {}): Promise<Buffer> {
	const r = assertConnected(await exec(t, `cat -- ${shq(abs)}`, { timeoutMs: 120_000, ...opts }), t.hostKeyAlias ?? t.host, t.user);
	if (r.code !== 0) throw fileError(r, abs);
	if (r.truncated) throw new SshError(`${abs}: file is too large`, { code: "EFBIG" });
	return r.stdout;
}

/** Write through stdin: parent directories are created; an existing file is replaced atomically with its mode kept. */
export function writeScript(abs: string): string {
	const p = shq(abs);
	return [
		`p=${p}`,
		'mkdir -p -- "$(dirname -- "$p")" || exit 1',
		'if [ -L "$p" ] || [ ! -e "$p" ]; then cat > "$p"; exit $?; fi',
		'm=$(stat -c %a -- "$p" 2>/dev/null || stat -f %Lp -- "$p" 2>/dev/null)',
		't=$(mktemp "$p.pinb.XXXXXX") || exit 1',
		`trap 'rm -f "$t"' EXIT`,
		'cat > "$t" || exit 1',
		'[ -n "$m" ] && chmod "$m" "$t"',
		'mv -f -- "$t" "$p"',
	].join("\n");
}

export async function writeFile(t: Target, abs: string, data: Buffer | string, opts: ExecOptions = {}): Promise<void> {
	const r = assertConnected(await exec(t, writeScript(abs), { timeoutMs: 120_000, ...opts, stdin: data }), t.hostKeyAlias ?? t.host, t.user);
	if (r.code !== 0) throw fileError(r, abs);
}

/** Throws (ENOENT / EACCES) when the file does not exist or lacks the permission. */
export async function access(t: Target, abs: string, mode: "r" | "w" | "rw" = "r", opts: ExecOptions = {}): Promise<void> {
	const p = shq(abs);
	const checks = [mode.includes("r") ? `[ -r ${p} ] || exit 3` : "", mode.includes("w") ? `[ -w ${p} ] || exit 3` : ""].filter(Boolean).join("; ");
	const r = assertConnected(await exec(t, `[ -e ${p} ] || exit 2; ${checks || ":"}`, { timeoutMs: SCRIPT_TIMEOUT, ...opts }), t.hostKeyAlias ?? t.host, t.user);
	if (r.code === 2) throw new SshError(`${abs}: No such file or directory`, { code: "ENOENT", result: r });
	if (r.code !== 0) throw new SshError(`${abs}: Permission denied`, { code: "EACCES", result: r });
}

export type PathKind = "file" | "dir" | "other" | "none";

export async function stat(t: Target, abs: string): Promise<PathKind> {
	const p = shq(abs);
	const r = assertConnected(await exec(t, `if [ -d ${p} ]; then echo dir; elif [ -f ${p} ]; then echo file; elif [ -e ${p} ]; then echo other; else echo none; fi`, { timeoutMs: SCRIPT_TIMEOUT }), t.hostKeyAlias ?? t.host, t.user);
	const k = r.stdout.toString("utf8").trim();
	return k === "dir" || k === "file" || k === "other" ? k : "none";
}

export const isDirectory = async (t: Target, abs: string): Promise<boolean> => (await stat(t, abs)) === "dir";

/** The existing variant of a path (screenshot names with U+202F, NFD/NFC, curly quotes), or undefined. */
export async function resolveVariant(t: Target, path: string, opts: ExecOptions = {}): Promise<string | undefined> {
	const r = assertConnected(await exec(t, pathVariantsScript(path), { timeoutMs: SCRIPT_TIMEOUT, ...opts }), t.hostKeyAlias ?? t.host, t.user);
	return r.code === 0 ? r.stdout.toString("utf8") : undefined;
}

/** Seconds since the last keyboard/mouse input on the device, or undefined. */
export async function idle(t: Target): Promise<number | undefined> {
	const r = assertConnected(await exec(t, IDLE_PROBE, { timeoutMs: 8000 }), t.hostKeyAlias ?? t.host, t.user);
	return parseIdle(r.stdout.toString("utf8"));
}

/** Close the ControlMaster connection of a target (best effort, bounded). */
export function stopMaster(t: Target): Promise<void> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn> | undefined;
		const timer = setTimeout(() => {
			child?.kill("SIGKILL");
			resolve();
		}, 2000);
		timer.unref?.();
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		try {
			const a = sshArgs(t);
			child = spawn(t.sshBin ?? "ssh", [...a.slice(0, -2), "-O", "exit", ...a.slice(-2)], { stdio: "ignore" });
			child.on("error", done);
			child.on("close", done);
		} catch {
			done();
		}
	});
}

/** True when a TCP connection to ip:port succeeds within `timeoutMs`. */
export function checkPort(ip: string, port: number, timeoutMs = 1500): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect({ host: ip, port });
		let done = false;
		const end = (ok: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			s.destroy();
			resolve(ok);
		};
		const timer = setTimeout(() => end(false), timeoutMs);
		s.once("connect", () => end(true));
		s.once("error", () => end(false));
	});
}

export interface DetectedUser {
	user: string;
	probe: ProbeInfo;
	/** The login user differed from the console user and we switched to the console user. */
	switchedToConsole: boolean;
	tried: string[];
}

/**
 * Find a working login: try the candidates in order (auth failures move on, other connection errors
 * abort), then, when the account differs from the user at the screen, switch to that user if it logs in too.
 * Throws SshError("auth") when no candidate works.
 */
export async function detectUser(base: Omit<Target, "user">, candidates: readonly string[], device = base.host): Promise<DetectedUser> {
	const tried: string[] = [];
	for (const user of candidates) {
		tried.push(user);
		try {
			const info = await probe({ ...base, user });
			const c = info.console;
			if (c && c !== "root" && c !== user && !tried.includes(c) && SAFE_USER.test(c)) {
				tried.push(c);
				try {
					return { user: c, probe: await probe({ ...base, user: c }), switchedToConsole: true, tried };
				} catch (e) {
					if (!(e instanceof SshError) || e.kind !== "auth") throw e;
				}
			}
			return { user, probe: info, switchedToConsole: false, tried };
		} catch (e) {
			if (e instanceof SshError && e.kind === "auth") continue;
			throw e;
		}
	}
	throw new SshError(
		`${device}: no login worked (tried: ${tried.join(", ") || "nobody"}). Set the user with /nb user ${device} <name>.`,
		{ kind: "auth" },
	);
}
