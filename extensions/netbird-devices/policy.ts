// Access policy per device: modes, protected paths, read-only and dangerous commands.
// Pure: no pi imports, unit-tested.

import type { Mode } from "./settings.ts";

export type Action =
	| { kind: "read"; path: string }
	| { kind: "write"; path: string; diff: string; isNew: boolean }
	| { kind: "bash"; command: string; root: boolean };

export type Verdict = "allow" | "ask" | "deny" | "classify";

export interface Decision {
	verdict: Verdict;
	reason: string;
	/** Shown in the dialog: why this needs extra care. */
	warning?: string;
	/** Dangerous command: always asked, never cached, no "always allow"/"full" choices in the dialog. */
	danger?: boolean;
}

// --- paths -------------------------------------------------------------------------------------

export function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${p.slice(2)}`;
	return p;
}

/** Normalize a POSIX path: collapse //, resolve . and .. (no symlinks). */
export function normalizePosix(p: string): string {
	const abs = p.startsWith("/");
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(seg);
	}
	return `${abs ? "/" : ""}${out.join("/")}` || (abs ? "/" : ".");
}

/** Resolve a path given to a tool on the device: "~" and relative paths are taken from the device home. */
export function resolveRemotePath(p: string, home: string): string {
	let s = p.trim().replace(/^@/, "");
	s = expandHome(s, home);
	if (!s.startsWith("/")) s = `${home.replace(/\/+$/, "")}/${s}`;
	return normalizePosix(s);
}

export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else re += ".*";
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/** The first protected glob that matches the absolute path (a protected directory also covers itself). */
export function protectedMatch(absPath: string, home: string, globs: readonly string[]): string | undefined {
	for (const g of globs) {
		let pat = expandHome(g, home);
		if (!pat.startsWith("/") && !pat.startsWith("**")) pat = `**/${pat}`;
		const re = globToRegExp(pat);
		if (re.test(absPath)) return g;
		if (pat.endsWith("/**") && absPath === pat.slice(0, -3)) return g;
	}
	return undefined;
}

// --- commands ----------------------------------------------------------------------------------

/** Split a shell command into simple commands at ; && || | and newlines (quotes respected). */
export function splitCommands(cmd: string): string[] | undefined {
	const parts: string[] = [];
	let cur = "";
	let q: '"' | "'" | undefined;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (q) {
			if (c === q) q = undefined;
			else if (c === "\\" && q === '"') {
				cur += c + (cmd[++i] ?? "");
				continue;
			}
			cur += c;
			continue;
		}
		if (c === "'" || c === '"') {
			q = c;
			cur += c;
		} else if (c === "\\") {
			cur += c + (cmd[++i] ?? "");
		} else if (c === ";" || c === "\n" || c === "|" || c === "&") {
			if (c === "&" && cmd[i + 1] !== "&") return undefined; // background job
			if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
			parts.push(cur.trim());
			cur = "";
		} else cur += c;
	}
	if (q) return undefined;
	parts.push(cur.trim());
	return parts.filter(Boolean);
}

/** Words of a simple command, unquoted (no expansion). */
export function words(simple: string): string[] {
	const out: string[] = [];
	let cur = "";
	let has = false;
	let q: '"' | "'" | undefined;
	for (let i = 0; i < simple.length; i++) {
		const c = simple[i];
		if (q) {
			if (c === q) q = undefined;
			else cur += c;
			continue;
		}
		if (c === "'" || c === '"') {
			q = c;
			has = true;
		} else if (/\s/.test(c)) {
			if (has || cur) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += c === "\\" ? (simple[++i] ?? "") : c;
		}
	}
	if (has || cur) out.push(cur);
	return out;
}

const READ_ONLY = new Set([
	"ls", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "pwd", "whoami", "id", "groups", "uname", "sw_vers",
	"uptime", "ps", "pgrep", "which", "type", "echo", "printf", "grep", "egrep", "fgrep",
	"ag", "cut", "tr", "jq", "column", "basename", "dirname", "realpath", "readlink",
	"md5", "md5sum", "shasum", "sha1sum", "sha256sum", "diff", "cmp", "vm_stat", "free", "lsblk",
	"ioreg", "system_profiler", "mdfind", "mdls", "lsof", "netstat",
	"nproc", "lscpu", "lsusb", "lspci", "locale", "test", "true", "false", "sleep", "hexdump", "od",
	"strings", "nl", "fold", "expand", "zcat", "tac", "rev", "seq", "getent", "dig", "host", "nslookup",
	"otool", "last", "w", "who", "users",
]);

// Argument checks for tools that can also write or execute. `args` are the unquoted words after the command.
type ArgCheck = (args: readonly string[]) => boolean;
/** A short-option cluster (`-o`, `-ro`) that contains one of `chars`. */
const hasShort = (args: readonly string[], chars: string): boolean =>
	args.some((a) => /^-[^-]/.test(a) && [...a.slice(1)].some((c) => chars.includes(c)));
const hasLong = (args: readonly string[], re: RegExp): boolean => args.some((a) => re.test(a));
/** Positional (non-option) arguments, skipping the values of the options in `valued`. */
function positionals(args: readonly string[], valued: readonly string[] = []): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (valued.includes(a)) i++;
		else if (a === "-" || !a.startsWith("-")) out.push(a);
	}
	return out;
}
const gitAllOpts = (args: readonly string[]) => !hasLong(args, /^--(output|ext-diff|textconv)\b/);

const READ_ONLY_FN: Record<string, ArgCheck> = {
	sort: (a) => !hasShort(a, "o") && !hasLong(a, /^--(o|co)/), // -o FILE writes, --compress-program runs a program
	uniq: (a) => positionals(a, ["-f", "-s", "-w"]).length <= 1, // uniq IN OUT writes OUT
	xxd: (a) => !hasShort(a, "r") && positionals(a, ["-c", "-g", "-l", "-s", "-o"]).length <= 1, // -r rebuilds a file, `xxd IN OUT` writes
	base64: (a) => !hasShort(a, "o") && !hasLong(a, /^--o/) && positionals(a, ["-w", "-b"]).length <= 1,
	tree: (a) => !hasShort(a, "o") && !hasLong(a, /^--o\b|^--output/),
	rg: (a) => !hasLong(a, /^--(pre|hostname-bin)(=|$)/), // --pre runs a program per file
	codesign: (a) => a.every((x) => !x.startsWith("-") || /^-[dvh]+$/.test(x) || /^--(display|verify|verbose(=\d+)?|deep|strict)$/.test(x)),
	date: (a) => {
		for (let i = 0; i < a.length; i++) {
			const x = a[i];
			if (["-d", "-r", "-v", "-f", "--date", "--reference"].includes(x)) i++;
			else if (x.startsWith("--")) {
				if (/^--(set|s)\b/.test(x)) return false;
			} else if (x.startsWith("-")) {
				if (hasShort([x], "s")) return false; // -s sets the clock
			} else if (!x.startsWith("+")) return false; // `date 1231235959` sets the clock
		}
		return true;
	},
	hostname: (a) => a.every((x) => /^(-[fsiIdaAy]+|--(fqdn|short|ip-address|all-ip-addresses|domain|long|alias|all-fqdns|yp))$/.test(x)), // `hostname NAME` renames
	mount: (a) => {
		const rest: string[] = [];
		for (let i = 0; i < a.length; i++) {
			if (a[i] === "-t") i++;
			else rest.push(a[i]);
		}
		return rest.every((x) => ["-l", "-v", "-V", "-h"].includes(x)); // `mount DEV DIR` mounts
	},
	command: (a) => /^-[vV]$/.test(a[0] ?? ""), // `command rm ...` runs rm
	dmesg: (a) => !hasShort(a, "cCDE") && !hasLong(a, /^--(c|r)/), // clearing the ring buffer
	ifconfig: (a) => a.every((x) => /^-[aluLdvmrs]+$/.test(x)) || (a.length === 1 && /^[a-z]+\d*$/.test(a[0])), // `ifconfig en0 down`
	scutil: (a) => /^--(get|dns|proxy|nwi)\b|^-r\b/.test(a[0] ?? ""),
	networksetup: (a) => /^-(list|get|print|show)\w*/.test(a[0] ?? ""),
	git: (a) => {
		const sub = a[0];
		const rest = a.slice(1);
		switch (sub) {
			case "status":
			case "log":
			case "show":
			case "diff":
			case "rev-parse":
			case "describe":
			case "blame":
			case "ls-files":
			case "ls-tree":
			case "shortlog":
				return gitAllOpts(rest);
			case "branch": {
				const flags = rest.filter((x) => x.startsWith("-"));
				const listing = flags.some((x) => x === "-l" || x === "--list");
				if (!flags.every((x) => /^(-[alrv]+|--(list|all|remotes|verbose|show-current|no-color|color)(=\S*)?)$/.test(x))) return false;
				return listing || positionals(rest).length === 0;
			}
			case "remote":
				return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || (["show", "get-url"].includes(rest[0]) && !rest.slice(1).some((x) => /^-/.test(x) && x !== "-n"));
			case "tag":
				return rest.length === 0 || ((rest[0] === "-l" || rest[0] === "--list") && rest.every((x) => !x.startsWith("-") || /^(-l|--list|-n\d*|--sort=\S+|--format=\S+|--contains|--merged|--no-merged)$/.test(x)));
			case "config":
				return /^--get/.test(rest[0] ?? "");
			case "stash":
				return rest[0] === "list" && gitAllOpts(rest);
			case "reflog":
				return rest.length === 0;
			default:
				return false;
		}
	},
};
/** Subcommands that only read, for tools that can also write. */
const READ_ONLY_SUB: Record<string, RegExp> = {
	brew: /^(list|ls|info|search|--prefix|--version|config|doctor|outdated|deps|uses|leaves|services\s+list)\b/,
	npm: /^(ls|list|view|info|outdated|config\s+get|root|prefix|--version|-v)\b/,
	systemctl: /^(status|list-units|list-unit-files|is-active|is-enabled|is-failed|show|cat|list-timers)\b/,
	journalctl: /^(?!.*--(vacuum|rotate|flush))/,
	launchctl: /^(list|print|blame|managername|print-disabled)\b/,
	defaults: /^(read|domains|read-type|find)\b/,
	docker: /^(ps|images|logs|inspect|version|info|stats\s+--no-stream)\b/,
	ip: /^(-\w+\s+)*(a|addr|address|r|route|l|link|n|neigh)(\s+(show|list))?\b(?!.*\b(add|del|delete|flush|set|change|replace)\b)/,
	sysctl: /^(?!.*(-w\b|=))/,
	find: /^(?!.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b)/,
	sed: /^(?!.*(\s-i|--in-place))/,
	awk: /^(?!.*(\bsystem\b|\|\s*&?\s*\S|\bgetline\b|print\s*>|(^|\s)-i\b))/,
	csrutil: /^status\b/,
	fdesetup: /^(status|isactive|list)\b/,
	spctl: /^(--status|-a\b|--assess)/,
	pmset: /^-g\b/,
	plutil: /^(-p|-lint|-help)\b/,
	ping: /^(?=.*-c\s*\d)/,
};

/** True when every part of the command is a known read-only command without redirections or substitutions. */
export function isReadOnlyCommand(command: string): boolean {
	// `2>&1` and redirections to /dev/null are harmless (and their `&` must not look like a background job).
	const plain = command.replace(/2>&1|>\s*\/dev\/null|2>\s*\/dev\/null/g, " ");
	if (/[`]|\$\(|>|<\(|>\(/.test(plain)) return false;
	const parts = splitCommands(plain);
	if (!parts?.length) return false;
	for (const part of parts) {
		const w = words(part);
		while (w.length && /^\w+=/.test(w[0])) w.shift(); // VAR=x cmd
		if (!w.length) return false;
		const cmd = w[0].replace(/^.*\//, "");
		if (cmd === "sudo") return false;
		const fn = READ_ONLY_FN[cmd];
		if (fn) {
			if (!fn(w.slice(1))) return false;
			continue;
		}
		const sub = READ_ONLY_SUB[cmd];
		if (sub) {
			if (!sub.test(w.slice(1).join(" "))) return false;
			continue;
		}
		if (!READ_ONLY.has(cmd)) return false;
	}
	return true;
}

/** Simple commands of a line; a crude split when the line cannot be parsed (background jobs, open quotes). */
function simpleCommands(cmd: string): string[] {
	return splitCommands(cmd) ?? cmd.split(/[;&|\n]+/).map((x) => x.trim()).filter(Boolean);
}

const RM_TARGETS = new Set(["/", "/*", "/.*", "~", "~/*", "~/.*", "$HOME", "$HOME/*", "$HOME/.*", "${HOME}", "${HOME}/*", "${HOME}/.*"]);

/** `rm` with a recursive flag on / or the home directory (also `~/*`, `$HOME/*`, `"${HOME}"/*`). */
export function rmRecursiveOfRoot(command: string, depth = 0): boolean {
	for (const part of simpleCommands(command)) {
		const w = words(part);
		for (let i = 0; i < w.length; i++) {
			if (depth < 2 && /\s/.test(w[i]) && rmRecursiveOfRoot(w[i], depth + 1)) return true; // sh -c 'rm -rf ~'
			if (w[i].replace(/^.*\//, "") !== "rm") continue;
			const args = w.slice(i + 1);
			const recursive = args.some((a) => /^-[^-]*[rR]/.test(a) || a === "--recursive");
			if (!recursive) continue;
			for (const a of args) {
				if (a.startsWith("-")) continue;
				const t = a.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
				if (RM_TARGETS.has(t)) return true;
			}
		}
	}
	return false;
}

const DANGER: [RegExp | ((c: string) => boolean), string][] = [
	[rmRecursiveOfRoot, "recursive delete of / or home"],
	[/\bmkfs(\.\w+)?\b|\bnewfs\w*\b/, "formats a file system"],
	[/\bdiskutil\s+(erase\w*|zeroDisk|randomDisk|secureErase|partitionDisk|apfs\s+delete\w*)/i, "erases a disk"],
	[/\bdd\b[^|;&]*\bof=\/dev\//, "writes to a raw device"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
	[/\bcsrutil\s+disable\b|\bspctl\s+--master-disable\b/, "disables system protection"],
	[/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, "chmod 777 /"],
	[/>\s*\/dev\/(sd|nvme|disk|rdisk)\w*/, "writes to a raw device"],
	[/\b(shutdown|reboot|halt|poweroff)\b/, "stops or restarts the machine"],
	[/\bfdesetup\s+(disable|removerecovery)/, "changes disk encryption"],
	[/\btmutil\s+delete/, "deletes backups"],
	[/\bsecurity\s+(delete-\w+|dump-keychain|find-\w+-password\s+.*-w)/, "keychain secrets"],
];

export function dangerReason(command: string): string | undefined {
	for (const [t, why] of DANGER) if (typeof t === "function" ? t(command) : t.test(command)) return why;
	return undefined;
}

// --- protected paths in commands ---------------------------------------------------------------

function expandWord(w: string, home: string): string {
	const h = home.replace(/\/+$/, "");
	const m = /^(\$HOME|\$\{HOME\})(\/|$)/.exec(w);
	if (m) return `${h}${w.slice(m[1].length)}`;
	return expandHome(w, home);
}

/**
 * The first protected glob hit by a path-like word of a shell command (`cat ~/.ssh/id_rsa`,
 * `grep -r . $HOME/.aws`, `cd ~/.ssh && cat id_rsa`, `echo x >~/.netrc`). Words are expanded
 * for `~`/`$HOME`, relative ones are taken from `cwd` (tracked through `cd`). Best effort: shell
 * globs in the middle of a word (`~/.s*`/id_rsa) and variables other than HOME are not resolved.
 */
export function protectedInCommand(command: string, home: string, globs: readonly string[], cwd = home): string | undefined {
	let dir = cwd;
	for (const part of simpleCommands(command)) {
		const w = words(part);
		while (w.length && /^\w+=/.test(w[0])) w.shift();
		if (w[0] === "cd" && w[1] && !w[1].startsWith("-")) {
			const t = expandWord(w[1], home);
			dir = normalizePosix(t.startsWith("/") ? t : `${dir}/${t}`);
		}
		for (const word of w) {
			const cands = new Set<string>([word]);
			const eq = word.indexOf("=");
			if (eq > 0) cands.add(word.slice(eq + 1)); // --file=~/.ssh/x, VAR=~/.ssh/x
			for (const c of [...cands]) cands.add(c.replace(/^\d*[<>]+&?/, "")); // 2>~/x, >>file
			for (const c of cands) {
				if (!c || c.startsWith("-") || /\s/.test(c)) continue;
				const e = expandWord(c, home);
				const abs = normalizePosix(e.startsWith("/") ? e : `${dir}/${e}`);
				const hit = protectedMatch(abs, home, globs);
				if (hit) return hit;
			}
		}
	}
	return undefined;
}

/** `sudo <command>` at the start (no sudo options) runs the rest as root through a password dialog. */
export function splitSudo(command: string): string | undefined {
	const m = /^\s*sudo\s+(?:--\s+)?(?!-)([\s\S]+)$/.exec(command);
	return m ? m[1].trim() : undefined;
}

// --- decision ----------------------------------------------------------------------------------

export interface PolicyInput {
	mode: Mode;
	action: Action;
	/**
	 * Protected glob that matches the action's path (for bash: a path word of the command, see
	 * `protectedInCommand`).
	 */
	protectedHit?: string;
	/** The user already allowed this exact action in this session. Ignored for dangerous commands. */
	approved?: boolean;
}

export function decide({ mode, action, protectedHit, approved }: PolicyInput): Decision {
	if (action.kind === "read") {
		if (protectedHit) return { verdict: approved ? "allow" : "ask", reason: `protected path (${protectedHit})`, warning: "may contain secrets" };
		return { verdict: "allow", reason: "read" };
	}
	if (action.kind === "write") {
		if (mode === "ro") return { verdict: "deny", reason: "device is read-only (mode ro)" };
		if (protectedHit) return { verdict: approved ? "allow" : "ask", reason: `protected path (${protectedHit})`, warning: "protected path" };
		if (approved) return { verdict: "allow", reason: "allowed earlier in this session" };
		if (mode === "full") return { verdict: "allow", reason: "mode full" };
		if (mode === "auto") return { verdict: "classify", reason: "mode auto" };
		return { verdict: "ask", reason: "mode ask" };
	}
	const danger = dangerReason(action.command);
	const askDanger = (): Decision => ({ verdict: "ask", reason: danger!, warning: `dangerous: ${danger}`, danger: true });
	const askProtected = (): Decision => ({ verdict: "ask", reason: `protected path (${protectedHit})`, warning: "may contain secrets or credentials" });
	if (action.root) {
		if (mode === "ro") return { verdict: "deny", reason: "device is read-only (mode ro): no root commands" };
		if (danger) return askDanger();
		if (protectedHit && !approved) return askProtected();
		if (mode === "auto") return { verdict: "classify", reason: "root command, mode auto" };
		// ask/full: the password dialog on the device (or in pi) is the confirmation.
		return { verdict: "allow", reason: "root: password dialog confirms" };
	}
	// Dangerous commands are always asked: an earlier approval, mode full and the read-only list do not count.
	if (danger) return askDanger();
	if (protectedHit && !approved) return askProtected();
	if (isReadOnlyCommand(action.command)) return { verdict: "allow", reason: "read-only command" };
	if (approved) return { verdict: "allow", reason: "allowed earlier in this session" };
	if (mode === "full") return { verdict: "allow", reason: "mode full" };
	if (mode === "auto") return { verdict: "classify", reason: "mode auto" };
	return { verdict: "ask", reason: mode === "ro" ? "mode ro: command may write" : "mode ask" };
}

export function approvalKey(action: Action): string {
	switch (action.kind) {
		case "read":
			return `read:${action.path}`;
		case "write":
			return `write:${action.path}`;
		case "bash":
			return `bash:${action.root ? "root:" : ""}${action.command.trim()}`;
	}
}
