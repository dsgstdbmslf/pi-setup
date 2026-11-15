// File layout of the extension: ~/.pi/agent/netbird-devices/{state.json,known_hosts,log.jsonl,cm/}.
// Pure path computation (plus the shared ensureDir); injectable for tests.

import { join } from "node:path";
import { CM_SOCKET_NAME, MAX_SOCKET_PATH } from "../bitwarden-ssh/paths.ts";

export { ensureDir } from "../bitwarden-ssh/paths.ts";

export interface Paths {
	dataDir: string;
	stateFile: string;
	knownHosts: string;
	journalFile: string;
	/** ControlMaster sockets (`<cmDir>/%C`). */
	cmDir: string;
}

export function resolvePaths(opts: { agentDir: string; uid: number }): Paths {
	const dataDir = join(opts.agentDir, "netbird-devices");
	let cmDir = join(dataDir, "cm");
	// sun_path is short (104 bytes on macOS, 108 on Linux): fall back to /tmp when the agent dir is deep.
	if (Buffer.byteLength(cmDir) + CM_SOCKET_NAME > MAX_SOCKET_PATH) cmDir = join(`/tmp/pi-nb-${opts.uid}`, "cm");
	return {
		dataDir,
		stateFile: join(dataDir, "state.json"),
		knownHosts: join(dataDir, "known_hosts"),
		journalFile: join(dataDir, "log.jsonl"),
		cmDir,
	};
}
