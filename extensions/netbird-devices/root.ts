// Running a command as root on a device (PLAN §8). Two ways to get the password:
//  - native: a password dialog on the device itself (`rootNativeWrapper`); the password never leaves the device.
//  - pi: a masked dialog in pi; the password goes to ssh stdin of `rootStdinWrapper` only and is never logged,
//    returned or kept (the buffer is zeroed after the call).
// sudo -k ignores cached credentials (NOPASSWD may skip prompting). No pi imports; ssh is injectable for tests.

import type { Conn } from "./remote-ops.ts";
import { ASKPASS_STATUS_CANCEL, ASKPASS_STATUS_UNAVAILABLE, rootDialogText, rootNativeWrapper, rootStdinWrapper } from "./remote.ts";
import type { RootPrompt } from "./settings.ts";
import { assertConnected, exec, stripSshNoise, type ExecOptions, type ExecResult, type Target } from "./ssh.ts";

export type RootPath = "native" | "pi";

/** `auto`: the native dialog only when the user is at that device, else the pi dialog. */
export function chooseRootPath(pref: RootPrompt, userIsAtDevice: boolean): RootPath {
	if (pref === "native") return "native";
	if (pref === "pi") return "pi";
	return userIsAtDevice ? "native" : "pi";
}

export interface RootRun {
	/** The command after `sudo `. */
	command: string;
	/** Root prompt preference of the device and whether the user is at it. */
	pref: RootPrompt;
	userIsAtDevice: boolean;
	/** Name of this machine, shown in the dialog ("Pi agent on cloudcli asks…"). */
	from: string;
	/** Masked pi dialog; undefined = cancelled or not possible (no TUI). */
	askPassword: () => Promise<string | undefined>;
	/** Called when the user has to enter the password (footer) and when that is over. */
	onWaiting?: (waiting: boolean) => void;
	signal?: AbortSignal;
	timeoutMs: number;
	onData: (chunk: Buffer, stream: "stdout" | "stderr") => void;
	/** Test hook. */
	run?: (t: Target, script: string, o: ExecOptions) => Promise<ExecResult>;
	/** Called with the path actually used ("native", "pi", "native→pi"). */
	onPath?: (p: string) => void;
}

const cleanChunk = (onData: RootRun["onData"]) => (chunk: Buffer, stream: "stdout" | "stderr") => {
	if (stream === "stderr" && /Permanently added|ControlSocket/.test(chunk.toString("utf8"))) {
		const clean = stripSshNoise(chunk.toString("utf8"));
		if (clean) onData(Buffer.from(clean), stream);
		return;
	}
	onData(chunk, stream);
};

export class RootCancelled extends Error {}

/** Runs `sudo <command>` on the device. Throws RootCancelled (user said no) or Error; resolves the exit code. */
export async function runRoot(c: Conn, r: RootRun): Promise<{ exitCode: number | null; path: string }> {
	if (r.signal?.aborted) throw new Error("aborted");
	const run = r.run ?? exec;
	const base: ExecOptions = { signal: r.signal, timeoutMs: r.timeoutMs, maxBytes: 64 * 1024 * 1024, onData: cleanChunk(r.onData) };
	const finish = (res: ExecResult, path: string) => {
		if (res.aborted) throw new Error("aborted");
		if (res.timedOut) throw new Error(`timeout:${Math.round(r.timeoutMs / 1000)}`);
		assertConnected(res, c.device, c.user);
		if (res.truncated) throw new Error("Command output exceeded 64 MB and was stopped");
		return { exitCode: res.code, path };
	};
	let path: string = chooseRootPath(r.pref, r.userIsAtDevice);
	if (path === "native") {
		const script = rootNativeWrapper(r.command, {
			os: c.probe.os,
			path: c.probe.path,
			title: "Pi: root access",
			text: rootDialogText(r.command, r.from),
		});
		// The dialog lives on the device for up to its own 120 s; keep the call alive that long at least.
		const res = await run(c.target, script, { ...base, timeoutMs: Math.max(r.timeoutMs, 150_000) });
		r.onPath?.("native");
		if (res.aborted || res.timedOut) return finish(res, "native");
		if (res.code === ASKPASS_STATUS_CANCEL) throw new RootCancelled(`cancelled by the user on ${c.device}`);
		if (res.code !== ASKPASS_STATUS_UNAVAILABLE) return finish(res, "native");
		if (r.pref === "native") throw new Error(`${c.device}: the native password dialog is not available there (rootPrompt is "native")`);
		path = "native→pi"; // window unavailable: ask in pi instead
	}
	let pw: string | undefined;
	r.onWaiting?.(true);
	try {
		pw = await r.askPassword();
	} finally {
		r.onWaiting?.(false);
	}
	if (!pw) throw new RootCancelled(`cancelled: no root password entered in pi for ${c.device}`);
	if (/[\r\n\0]/.test(pw)) {
		pw = undefined;
		throw new Error("Root password must be a single line");
	}
	const stdin = Buffer.alloc(Buffer.byteLength(pw) + 1);
	stdin.write(pw, "utf8");
	stdin[stdin.length - 1] = 10;
	pw = undefined;
	try {
		if (r.signal?.aborted) throw new Error("aborted");
		const script = rootStdinWrapper(r.command, { path: c.probe.path });
		const res = await run(c.target, script, { ...base, stdin });
		r.onPath?.(path);
		return finish(res, path);
	} finally {
		stdin.fill(0);
	}
}

/** `sudo -k -A true` through the same path: does the root dialog work on this device? */
export async function testRoot(c: Conn, o: Omit<RootRun, "command" | "onData" | "timeoutMs"> & { timeoutMs?: number }): Promise<string> {
	const out: Buffer[] = [];
	const res = await runRoot(c, { ...o, command: "true", timeoutMs: o.timeoutMs ?? 150_000, onData: (b, s) => (s === "stderr" ? out.push(b) : undefined) });
	if (res.exitCode === 0) return `root works on ${c.device} (password dialog: ${res.path})`;
	const err = Buffer.concat(out).toString("utf8").trim().split("\n").pop() ?? "";
	return `sudo failed on ${c.device} (exit ${res.exitCode}, dialog: ${res.path})${err ? `: ${err.slice(0, 160)}` : ""}`;
}
