// File layout. Pure path computation plus ensureDir(); every path is injectable for tests.

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Paths {
	dataDir: string;
	stateFile: string;
	/** The SSH config in its original form (as on the local machine, as stored in Bitwarden). */
	sourceFile: string;
	/** Sockets, the askpass client and the sudo shim. */
	runDir: string;
	agentSock: string;
	askpassScript: string;
	binDir: string;
	sshDir: string;
	generatedFile: string;
	keysDir: string;
	cmDir: string;
	userConfig: string;
	home: string;
}

/** Linux sun_path holds 108 bytes; keep a margin. */
export const MAX_SOCKET_PATH = 100;
// Longest askpass socket name (pid_max is at most 2^22 on Linux).
const LONGEST_SOCK = "askpass-4194304.sock";

export function resolvePaths(opts: { agentDir: string; home: string; uid: number }): Paths {
	const dataDir = join(opts.agentDir, "bitwarden-ssh");
	let runDir = join(dataDir, "run");
	if (Buffer.byteLength(join(runDir, LONGEST_SOCK)) > MAX_SOCKET_PATH) runDir = `/tmp/pi-bw-${opts.uid}`;
	const sshDir = join(opts.home, ".ssh", "pi-bitwarden");
	return {
		dataDir,
		stateFile: join(dataDir, "state.json"),
		sourceFile: join(dataDir, "config"),
		runDir,
		agentSock: join(runDir, "ssh-agent.sock"),
		askpassScript: join(runDir, "askpass"),
		binDir: join(runDir, "bin"),
		sshDir,
		generatedFile: join(sshDir, "config"),
		keysDir: join(sshDir, "keys"),
		cmDir: join(sshDir, "cm"),
		userConfig: join(opts.home, ".ssh", "config"),
		home: opts.home,
	};
}

export function askpassSocket(paths: Paths, pid = process.pid): string {
	return join(paths.runDir, `askpass-${pid}.sock`);
}

/**
 * Create a directory (and parents) and force mode 0700. Refuses a symlink or a directory owned by
 * someone else (matters for the /tmp fallback, where another user could pre-create the path).
 */
export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const st = lstatSync(path);
	if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path} is not a directory`);
	const uid = process.getuid?.();
	if (uid !== undefined && st.uid !== uid) throw new Error(`${path} is owned by another user`);
	if ((st.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}
