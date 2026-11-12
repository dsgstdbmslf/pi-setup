// Askpass bridge: SSH_ASKPASS / SUDO_ASKPASS / GIT_ASKPASS point to a tiny node client that asks this pi
// process over a private Unix socket; pi shows a (masked) dialog and the answer goes straight back to the
// program that asked. Nothing is logged or stored.

import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { delimiter, join } from "node:path";

export type PromptKind = "confirm" | "yesno" | "visible" | "secret";

export function classifyPrompt(prompt: string, confirm: boolean): PromptKind {
	if (confirm) return "confirm";
	if (/\(yes\/no/i.test(prompt)) return "yesno";
	if (/^\s*username\b/i.test(prompt)) return "visible";
	return "secret";
}

export const KNOWN_PROGRAMS = new Set(["ssh", "ssh-add", "sudo", "git", "git-remote-https", "git-remote-http", "scp", "sftp", "rsync"]);

export interface Requester {
	/** Command line of the requesting process (truncated to 200 chars). */
	cmdline: string;
	program: string;
	known: boolean;
}

export function parseCmdline(raw: string): Requester {
	const parts = raw.split("\0").filter(Boolean);
	const program = (parts[0] ?? "").split("/").pop() ?? "";
	let cmdline = parts.join(" ");
	if (cmdline.length > 200) cmdline = `${cmdline.slice(0, 199)}…`;
	return { cmdline: cmdline || "(unknown)", program, known: KNOWN_PROGRAMS.has(program) };
}

export function describeRequester(ppid: number, procRoot = "/proc"): Requester {
	if (!Number.isInteger(ppid) || ppid <= 0) return { cmdline: "(unknown)", program: "", known: false };
	try {
		return parseCmdline(readFileSync(join(procRoot, String(ppid), "cmdline"), "latin1"));
	} catch {
		return { cmdline: `(pid ${ppid})`, program: "", known: false };
	}
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

const MAX_REQUEST = 64 * 1024;

export function startAskpassServer(sockPath: string, getHandler: () => AskHandler | undefined): Promise<AskpassServer> {
	return new Promise((resolve, reject) => {
		try {
			if (existsSync(sockPath)) unlinkSync(sockPath);
		} catch {}
		const server: Server = createServer((sock: Socket) => {
			let buf = "";
			let handled = false;
			const ac = new AbortController();
			sock.setEncoding("utf8");
			sock.on("close", () => ac.abort());
			sock.on("error", () => ac.abort());
			sock.on("data", (chunk: string) => {
				if (handled) return;
				buf += chunk;
				if (buf.length > MAX_REQUEST) return sock.destroy();
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				handled = true;
				const line = buf.slice(0, nl);
				buf = "";
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
				if (handler) {
					const res = await handler({ prompt, kind: classifyPrompt(prompt, confirm), requester: describeRequester(Number(req.ppid)) }, signal);
					if (typeof res === "string") reply = { ok: true, value: res };
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
