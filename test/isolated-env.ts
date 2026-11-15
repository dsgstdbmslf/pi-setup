// Import before any test starts a child. Never let a test talk to the parent Pi's
// askpass bridge or ssh-agent, or inherit its sudo shim through PATH.
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export function isolateTestEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if (/_ASKPASS(?:_|$)/.test(key) || /^PI_BW_/.test(key) || ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "BW_SESSION", "BW_PASSWORD", "BASH_ENV", "ENV"].includes(key)) delete env[key];
	}
	env.SSH_ASKPASS_REQUIRE = "never";
	env.PATH = (env.PATH ?? "").split(delimiter).filter((dir) => {
		try { return !readFileSync(join(dir, "sudo"), "utf8").includes("# pi bitwarden-ssh: sudo asks through the pi askpass dialog"); }
		catch { return true; }
	}).join(delimiter);
}

isolateTestEnv(process.env);
