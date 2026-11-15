// Operations for the built-in read/write/edit/bash tools (`create*ToolDefinition(cwd, { operations })`)
// that run on a device over ssh. Structural types only (no pi imports): the shapes match pi's
// ReadOperations / WriteOperations / EditOperations / BashOperations. Paths arrive already resolved
// to absolute device paths.

import { bashWrapper, type ProbeInfo } from "./remote.ts";
import { access, assertConnected, exec, readFile, resolveVariant, SshError, stripSshNoise, type Target, writeFile } from "./ssh.ts";
import { imageMimeFromPath } from "./tools.ts";

/** A logged-in device: where to connect, as whom, and what we know about the account. */
export interface Conn {
	/** Device name (as the agent knows it). */
	device: string;
	target: Target;
	user: string;
	home: string;
	probe: ProbeInfo;
}

export interface ReadOps {
	readFile(path: string): Promise<Buffer>;
	access(path: string): Promise<void>;
	detectImageMimeType(path: string): Promise<string | null>;
}
export interface WriteOps {
	writeFile(path: string, content: string): Promise<void>;
	mkdir(dir: string): Promise<void>;
}
export interface EditOps {
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: string): Promise<void>;
	access(path: string): Promise<void>;
}
export interface BashOps {
	exec(
		command: string,
		cwd: string,
		options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: unknown },
	): Promise<{ exitCode: number | null }>;
}

/**
 * `check` runs on every path the read actually opens (a name variant found on the device may differ
 * from the one asked for) and throws to refuse.
 */
export function createReadOps(c: Conn, check?: (abs: string) => void): ReadOps {
	const actual = new Map<string, string>();
	const real = (p: string) => actual.get(p) ?? p;
	return {
		async access(p) {
			try {
				await access(c.target, p, "r");
			} catch (e) {
				if (e instanceof SshError && e.code === "ENOENT") {
					// macOS screenshot names (U+202F before AM/PM), NFD/NFC forms, curly quotes.
					const v = await resolveVariant(c.target, p);
					if (v && v !== p) {
						check?.(v);
						actual.set(p, v);
						return;
					}
				}
				throw e;
			}
		},
		readFile: (p) => readFile(c.target, real(p)),
		detectImageMimeType: async (p) => imageMimeFromPath(real(p)),
	};
}

/** `mkdir` does nothing: the write script creates parent directories (so a refused write leaves no directory behind). */
export function createWriteOps(c: Conn): WriteOps {
	return {
		mkdir: async () => {},
		writeFile: (p, content) => writeFile(c.target, p, content),
	};
}

export function createEditOps(c: Conn): EditOps {
	return {
		access: (p) => access(c.target, p, "rw"),
		readFile: (p) => readFile(c.target, p),
		writeFile: (p, content) => writeFile(c.target, p, content),
	};
}

/** No command runs longer than this unless the agent passes a `timeout` (SSH keepalives detect dead links). */
export const BASH_DEFAULT_TIMEOUT_S = 30 * 60;
export const BASH_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The agent's command runs in /bin/bash on the device from the user's home with their login PATH.
 * The directory the tool gets is the local one and means nothing on the device, so it is ignored.
 */
export function createBashOps(c: Conn): BashOps {
	return {
		async exec(command, _cwd, { onData, signal, timeout }) {
			const limitS = timeout && timeout > 0 ? timeout : BASH_DEFAULT_TIMEOUT_S;
			const script = bashWrapper(command, { path: c.probe.path });
			const r = await exec(c.target, script, {
				signal,
				timeoutMs: limitS * 1000,
				maxBytes: BASH_MAX_BYTES,
				onData: (chunk, stream) => {
					if (stream === "stderr" && /Permanently added|ControlSocket/.test(chunk.toString("utf8"))) {
						const clean = stripSshNoise(chunk.toString("utf8"));
						if (clean) onData(Buffer.from(clean));
						return;
					}
					onData(chunk);
				},
			});
			if (r.aborted) throw new Error("aborted");
			if (r.timedOut) throw new Error(`timeout:${limitS}`);
			assertConnected(r, c.device, c.user);
			if (r.truncated) throw new Error(`Command output exceeded ${BASH_MAX_BYTES / 1024 / 1024} MB and was stopped`);
			return { exitCode: r.code };
		},
	};
}
