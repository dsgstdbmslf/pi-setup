// A fake `ssh` for tests (sshBin): records its arguments, accepts only some users, and runs the remote
// script locally with /bin/sh. `id -un` is overridden to the login user so probes look like a device.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Target } from "../extensions/netbird-devices/ssh.ts";

export interface FakeSsh {
	dir: string;
	bin: string;
	target: Target;
	/** Argument lists of every call, in order. */
	calls: () => string[][];
}

/** `users`: logins that work (others get "Permission denied"); undefined = everyone. */
export function fakeSsh(opts: { users?: string[]; dir?: string; body?: string } = {}): FakeSsh {
	const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "nbd-fake-"));
	mkdirSync(dir, { recursive: true });
	const log = join(dir, "args.log");
	const bin = join(dir, "ssh");
	const accept = opts.users ? opts.users.map((u) => `${u}@*`).join("|") : "*";
	writeFileSync(
		bin,
		`#!/bin/sh
printf 'ARGS %s\\n' "$(printf %s "$*" | tr '\\n' ' ')" >> '${log}'
for a; do SCRIPT="$a"; done
USER_AT=""; prev=""; for a; do [ "$prev" = "--" ] && USER_AT="$a"; prev="$a"; done
LOGIN="\${USER_AT%@*}"
case "$USER_AT" in
  ${accept}) ;;
  *) echo "$USER_AT: Permission denied (publickey)." >&2; exit 255;;
esac
${opts.body ?? `exec /bin/sh -c "id() { if [ \\"\\$1\\" = -un ]; then echo $LOGIN; else command id \\"\\$@\\"; fi; }; $SCRIPT"`}
`,
	);
	chmodSync(bin, 0o755);
	const target: Target = {
		user: "sergey",
		host: "100.71.171.69",
		hostKeyAlias: "sergeys-macbook-pro.netbird.cloud",
		sshBin: bin,
		paths: { knownHosts: join(dir, "kh", "known_hosts"), cmDir: join(dir, "cm") },
	};
	return {
		dir,
		bin,
		target,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.slice(5).split(" ")) : []),
	};
}
