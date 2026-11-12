// Askpass bridge: SSH_ASKPASS / SUDO_ASKPASS / GIT_ASKPASS point to a tiny node client that asks this pi
// process over a private Unix socket; pi shows a (masked) dialog and the answer goes straight back to the
// program that asked. Nothing is logged or stored.

import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { delimiter, join } from "node:path";
import { run } from "./exec.ts";

export type PromptKind = "confirm" | "yesno" | "visible" | "secret";

export function classifyPrompt(prompt: string, confirm: boolean): PromptKind {
	if (confirm) return "confirm";
	if (/\(yes\/no/i.test(prompt)) return "yesno";
	if (/^\s*username\b/i.test(prompt)) return "visible";
	return "secret";
}

/**
 * What the askpass client CLAIMS about its requester. Unverified: any process of this user can connect to
 * the socket and name any pid (and argv[0] is chosen by whoever starts a process), so this is only a hint
 * for the dialog and must never decide whether a warning is shown.
 */
export interface Requester {
	/** Command line of the claimed requesting process (truncated to 200 chars). */
	cmdline: string;
	program: string;
	/** Whether the claimed pid descends from this pi process (undefined when unknown). Also only a hint. */
	fromThisPi?: boolean;
}

export function parseCmdline(raw: string): Requester {
	const parts = raw.split("\0").filter(Boolean);
	const program = (parts[0] ?? "").split("/").pop() ?? "";
	let cmdline = parts.join(" ");
	if (cmdline.length > 200) cmdline = `${cmdline.slice(0, 199)}…`;
	return { cmdline: cmdline || "(unknown)", program };
}

/** Process table lookups for the requester hint: /proc on Linux, `ps` elsewhere (macOS). */
export interface ProcInfo {
	ppid(pid: number): Promise<number | undefined>;
	/** Command line (NUL- or space-separated), or undefined when the process is unknown. */
	cmdline(pid: number): Promise<string | undefined>;
}

/** Linux: /proc/<pid>/stat (the command name in parentheses may contain spaces) and /proc/<pid>/cmdline. */
export function procfsInfo(procRoot = "/proc"): ProcInfo {
	return {
		async ppid(pid) {
			try {
				const stat = readFileSync(join(procRoot, String(pid), "stat"), "latin1");
				const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
				return Number.isInteger(ppid) ? ppid : undefined;
			} catch {
				return undefined;
			}
		},
		async cmdline(pid) {
			try {
				return readFileSync(join(procRoot, String(pid), "cmdline"), "latin1");
			} catch {
				return undefined;
			}
		},
	};
}

export type PsRunner = (args: string[]) => Promise<{ code: number | null; stdout: string }>;
const defaultPs: PsRunner = (args) => run("ps", args, { timeoutMs: 5000 });

/** macOS (and any POSIX ps): `ps -o ppid= -p <pid>` and `ps -o command= -p <pid>`. */
export function psInfo(ps: PsRunner = defaultPs): ProcInfo {
	const query = async (field: string, pid: number): Promise<string | undefined> => {
		if (!Number.isInteger(pid) || pid <= 0) return undefined;
		const r = await ps(["-o", `${field}=`, "-p", String(pid)]);
		const out = r.stdout.trim();
		return r.code === 0 && out ? out : undefined;
	};
	return {
		async ppid(pid) {
			const v = Number(await query("ppid", pid));
			return Number.isInteger(v) && v >= 0 ? v : undefined;
		},
		cmdline: (pid) => query("command", pid),
	};
}

export function defaultProcInfo(platform: NodeJS.Platform = process.platform): ProcInfo {
	return platform === "linux" ? procfsInfo() : psInfo();
}

/** Parent pid of `pid` (undefined when unknown). */
export function parentPid(pid: number, info: ProcInfo = defaultProcInfo()): Promise<number | undefined> {
	return info.ppid(pid);
}

/** Whether `ancestor` is in the parent chain of `pid` (undefined when the process table cannot tell). */
export async function descendsFrom(pid: number, ancestor: number, info: ProcInfo = defaultProcInfo()): Promise<boolean | undefined> {
	let cur = pid;
	for (let i = 0; i < 64; i++) {
		if (cur === ancestor) return true;
		if (cur <= 1) return false;
		const next = await info.ppid(cur);
		if (next === undefined) return i === 0 ? undefined : false;
		cur = next;
	}
	return false;
}

export async function describeRequester(ppid: number, info: ProcInfo = defaultProcInfo(), self = process.pid): Promise<Requester> {
	if (!Number.isInteger(ppid) || ppid <= 0) return { cmdline: "(unknown)", program: "" };
	const raw = await info.cmdline(ppid);
	if (raw === undefined) return { cmdline: `(pid ${ppid})`, program: "" };
	// ps prints the command line space-separated; /proc separates arguments with NUL.
	const r = parseCmdline(raw.includes("\0") ? raw : raw.replace(/ +/g, "\0"));
	r.fromThisPi = await descendsFrom(ppid, self, info);
	return r;
}

export interface AskRequest {
	prompt: string;
	kind: PromptKind;
	requester: Requester;
}

/** Return the answer (string), true/false for confirm prompts, or undefined to cancel. */
export type AskHandler = (req: AskRequest, signal: AbortSignal) => Promise<string | boolean | undefined>;

export interface AskpassServer {
	sockPath: string;
	close(): void;
}

/** Longest accepted request line. */
export const MAX_REQUEST = 16 * 1024;
/** A client must send its request line within this time. */
export const REQUEST_DEADLINE_MS = 10_000;

export function startAskpassServer(
	sockPath: string,
	getHandler: () => AskHandler | undefined,
	opts: { deadlineMs?: number } = {},
): Promise<AskpassServer> {
	const deadlineMs = opts.deadlineMs ?? REQUEST_DEADLINE_MS;
	return new Promise((resolve, reject) => {
		try {
			if (existsSync(sockPath)) unlinkSync(sockPath);
		} catch {}
		// Accepted connections and their request controllers: close() destroys and aborts them all
		// (server.close() alone keeps accepted sockets open).
		const clients = new Map<Socket, AbortController>();
		const server: Server = createServer((sock: Socket) => {
			let buf = "";
			let handled = false;
			const ac = new AbortController();
			clients.set(sock, ac);
			const deadline = setTimeout(() => {
				if (!handled) sock.destroy();
			}, deadlineMs);
			deadline.unref?.();
			const gone = () => {
				clearTimeout(deadline);
				clients.delete(sock);
				ac.abort();
			};
			sock.setEncoding("utf8");
			sock.on("close", gone);
			sock.on("error", gone);
			sock.on("data", (chunk: string) => {
				if (handled) return;
				buf += chunk;
				const nl = buf.indexOf("\n");
				if (nl < 0) {
					if (buf.length > MAX_REQUEST) sock.destroy();
					return;
				}
				handled = true;
				clearTimeout(deadline);
				const line = buf.slice(0, nl);
				buf = "";
				if (line.length > MAX_REQUEST) return sock.destroy();
				void answer(line, sock, ac.signal);
			});
		});
		const answer = async (line: string, sock: Socket, signal: AbortSignal) => {
			let reply: { ok: boolean; value?: string } = { ok: false };
			try {
				const req = JSON.parse(line);
				const prompt = typeof req.prompt === "string" ? req.prompt.slice(0, 2000) : "";
				const confirm = req.confirm === true;
				const handler = getHandler();
				if (handler && !signal.aborted) {
					const res = await handler({ prompt, kind: classifyPrompt(prompt, confirm), requester: await describeRequester(Number(req.ppid)) }, signal);
					if (signal.aborted) reply = { ok: false };
					else if (typeof res === "string") reply = { ok: true, value: res };
					else if (res === true) reply = { ok: true, value: "" };
				}
			} catch {
				reply = { ok: false };
			}
			if (!sock.destroyed) sock.end(`${JSON.stringify(reply)}\n`);
			reply = { ok: false }; // drop the reference to the answer
		};
		const cleanup = () => {
			try {
				unlinkSync(sockPath);
			} catch {}
		};
		server.on("error", reject);
		server.listen(sockPath, () => {
			try {
				chmodSync(sockPath, 0o600);
			} catch {}
			server.removeListener("error", reject);
			server.on("error", () => {});
			server.unref();
			process.on("exit", cleanup);
			resolve({
				sockPath,
				close() {
					process.removeListener("exit", cleanup);
					server.close();
					for (const [sock, ac] of clients) {
						ac.abort();
						sock.destroy();
					}
					clients.clear();
					cleanup();
				},
			});
		});
	});
}

/** Source of the client. Plain JS that works as CommonJS and as ESM (no require/import). */
export function clientScript(execPath: string): string {
	return `#!${execPath}
// pi bitwarden-ssh askpass client (generated). Asks the pi process at $PI_BW_ASKPASS_SOCK.
const net = process.getBuiltinModule("node:net");
const sock = process.env.PI_BW_ASKPASS_SOCK;
if (!sock) { process.stderr.write("pi askpass: PI_BW_ASKPASS_SOCK is not set\\n"); process.exit(1); }
let buf = "";
let done = false;
const c = net.createConnection(sock);
c.setEncoding("utf8");
c.on("connect", () => {
	c.write(JSON.stringify({ prompt: process.argv[2] ?? "", ppid: process.ppid, confirm: process.env.SSH_ASKPASS_PROMPT === "confirm" }) + "\\n");
});
c.on("data", (d) => {
	buf += d;
	const nl = buf.indexOf("\\n");
	if (nl < 0 || done) return;
	done = true;
	let r = {};
	try { r = JSON.parse(buf.slice(0, nl)); } catch {}
	buf = "";
	c.destroy();
	if (r.ok) { process.stdout.write(String(r.value ?? "") + "\\n", () => process.exit(0)); }
	else process.exit(1);
});
c.on("error", (e) => { process.stderr.write("pi askpass: cannot reach pi (" + e.code + ")\\n"); process.exit(1); });
c.on("close", () => { if (!done) process.exit(1); });
`;
}

export function writeClientScript(path: string, execPath = process.execPath): void {
	const text = clientScript(execPath);
	let same = false;
	try {
		same = readFileSync(path, "utf8") === text && (statSync(path).mode & 0o777) === 0o700;
	} catch {}
	if (same) return;
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o700 });
	chmodSync(tmp, 0o700);
	// rename is atomic: a concurrent pi never sees a half-written script
	renameSync(tmp, path);
}

/** PATH lookup without a shell. */
export function which(cmd: string, pathEnv = process.env.PATH ?? ""): string | undefined {
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, cmd);
		try {
			const st = statSync(p);
			if (st.isFile() && st.mode & 0o111) return p;
		} catch {}
	}
	return undefined;
}

/**
 * Point the askpass variables of `env` (process.env in pi) at the client. If sudo exists, a shim in
 * binDir runs `sudo -A` so plain `sudo` asks through the bridge; binDir goes first in PATH.
 */
export function setupAskpassEnv(env: NodeJS.ProcessEnv, opts: { scriptPath: string; sockPath: string; binDir: string }): { sudoShim?: string } {
	env.SSH_ASKPASS = opts.scriptPath;
	env.SUDO_ASKPASS = opts.scriptPath;
	env.GIT_ASKPASS = opts.scriptPath;
	// "force", not "prefer": prefer only uses askpass when DISPLAY is set, and this server has no display.
	env.SSH_ASKPASS_REQUIRE = "force";
	env.PI_BW_ASKPASS_SOCK = opts.sockPath;
	const pathParts = (env.PATH ?? "").split(delimiter).filter((p) => p && p !== opts.binDir);
	const realSudo = which("sudo", pathParts.join(delimiter));
	if (!realSudo) {
		env.PATH = pathParts.join(delimiter);
		return {};
	}
	const shim = join(opts.binDir, "sudo");
	const text = `#!/bin/sh\n# pi bitwarden-ssh: sudo asks through the pi askpass dialog\nexec ${shQuote(realSudo)} -A "$@"\n`;
	let same = false;
	try {
		same = readFileSync(shim, "utf8") === text;
	} catch {}
	if (!same) {
		writeFileSync(`${shim}.${process.pid}.tmp`, text, { mode: 0o700 });
		renameSync(`${shim}.${process.pid}.tmp`, shim);
	}
	env.PATH = [opts.binDir, ...pathParts].join(delimiter);
	return { sudoShim: shim };
}

function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
