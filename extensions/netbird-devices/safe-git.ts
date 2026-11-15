// Narrow read-only Git recognition AND execution rewriting. Never whitelist an
// agent's raw `git ...`: repository/global config can launch other programs.
import { shq } from "./remote.ts";

interface Token { value: string; expandHome: boolean }
interface ReadOnlyGit { directories: Token[]; subcommand: string; args: string[] }

// No shell evaluation, pipelines, redirects, substitutions or glob expansion.
// Quoted spaces and quote concatenation are fine; ambiguous syntax falls back to ask.
function literalWords(command: string): Token[] | undefined {
	if (/[\0\r\n;$`\\|&<>()*?\[\]{}#]/.test(command)) return undefined;
	const out: Token[] = [];
	let value = "", active = false, expandHome = false;
	let quote: "'" | '"' | undefined;
	for (const c of command) {
		if (quote) {
			if (c === quote) quote = undefined;
			else value += c;
		} else if (c === "'" || c === '"') {
			quote = c; active = true;
		} else if (/\s/.test(c)) {
			if (active) out.push({ value, expandHome });
			value = ""; active = false; expandHome = false;
		} else {
			if (!active) expandHome = c === "~";
			value += c; active = true;
		}
	}
	if (quote) return undefined;
	if (active) out.push({ value, expandHome });
	return out;
}

const COMMON = new Set(["--no-color", "--color=never", "--no-ext-diff", "--no-textconv"]);
const DIFF = new Set(["-p", "--patch", "--no-patch", "-s", "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--raw", "--summary", "--check", "--exit-code", "--quiet", "--cached", "--staged", "-w", "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines", "--no-renames", "--binary"]);
const LOG = new Set(["--oneline", "--graph", "--all", "--branches", "--tags", "--remotes", "--decorate", "--no-decorate", "--reverse", "--first-parent", "--no-merges", "--merges", "--date-order", "--topo-order"]);
const STATUS = new Set(["-s", "--short", "-b", "--branch", "--porcelain", "--porcelain=1", "--porcelain=2", "--porcelain=v1", "--porcelain=v2", "-z", "--untracked-files", "-u", "-uno", "-unormal", "-uall", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all", "--ignored", "--ignore-submodules=all"]);
const REV_PARSE = new Set(["--show-toplevel", "--git-dir", "--absolute-git-dir", "--show-prefix", "--show-cdup", "--is-inside-work-tree", "--is-bare-repository", "--verify", "--short", "--abbrev-ref", "--symbolic-full-name", "--show-object-format", "--show-superproject-working-tree", "--end-of-options"]);
const LS_FILES = new Set(["-z", "--cached", "--stage", "-s", "--modified", "-m", "--deleted", "-d", "--others", "-o", "--exclude-standard", "--full-name", "--error-unmatch", "--deduplicate", "--eol"]);

function safeArgs(sub: string, args: string[]): boolean {
	if (sub === "branch") return args.every((a) => /^-[arv]+$/.test(a) || ["--list", "--all", "--remotes", "--verbose", "--show-current"].includes(a));
	let paths = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (paths) continue; // after -- everything is a literal path/revision, not an option
		if (a === "--") { paths = true; continue; }
		if (!a.startsWith("-")) {
			// A bare leading ~ would have been shell expansion, not a literal Git arg.
			if (a.startsWith("~")) return false;
			continue;
		}
		if (sub === "status" && STATUS.has(a)) continue;
		if (sub === "rev-parse" && (REV_PARSE.has(a) || /^--short=\d+$/.test(a))) continue;
		if (sub === "ls-files" && LS_FILES.has(a)) continue;
		if (["diff", "log", "show"].includes(sub)) {
			if (COMMON.has(a) || DIFF.has(a) || /^(-U\d+|--unified=\d+)$/.test(a)) continue;
			if (sub !== "diff") {
				if (LOG.has(a) || /^(-\d+|--max-count=\d+|--pretty=(oneline|short|medium|full|fuller|email|raw))$/.test(a)) continue;
				if (["-n", "--max-count"].includes(a) && /^\d+$/.test(args[i + 1] ?? "")) { i++; continue; }
				if (["--since", "--until", "--after", "--before", "--author", "--committer", "--grep"].includes(a) && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) { i++; continue; }
				if (/^--(since|until|after|before|author|committer|grep)=.+$/.test(a)) continue;
			}
		}
		return false; // no option abbreviations, agent -c, output, helpers, signatures, etc.
	}
	return true;
}

function parse(command: string): ReadOnlyGit | undefined {
	const tokens = literalWords(command);
	if (!tokens?.length || !["git", "/usr/bin/git", "/bin/git"].includes(tokens[0].value)) return undefined;
	let at = 1;
	const directories: Token[] = [];
	while (tokens[at]?.value === "-C") {
		const dir = tokens[at + 1];
		if (!dir?.value || (dir.expandHome && dir.value !== "~" && !dir.value.startsWith("~/"))) return undefined;
		directories.push(dir); at += 2;
	}
	const subcommand = tokens[at++]?.value;
	if (!["status", "log", "diff", "show", "branch", "rev-parse", "ls-files"].includes(subcommand)) return undefined;
	if (tokens.slice(at).some((t) => t.expandHome)) return undefined;
	const args = tokens.slice(at).map((t) => t.value);
	return safeArgs(subcommand, args) ? { directories, subcommand, args } : undefined;
}

export const isSafeReadOnlyGit = (command: string): boolean => parse(command) !== undefined;

const CONFIG = [
	"core.fsmonitor=false", "core.pager=cat", "diff.external=", "core.hooksPath=/dev/null",
	"credential.helper=", "core.askPass=", "core.sshCommand=/usr/bin/false", "core.gitProxy=",
	"submodule.recurse=false", "diff.ignoreSubmodules=all", "status.submoduleSummary=false",
	"log.showSignature=false", "gpg.program=/usr/bin/false", "gpg.openpgp.program=/usr/bin/false",
	"gpg.ssh.program=/usr/bin/false", "gpg.x509.program=/usr/bin/false",
	"gc.auto=0", "maintenance.auto=false", "protocol.allow=never", "core.untrackedCache=false",
];

/** The caller must run this replacement, never the original command, after a read-only verdict. */
export function rewriteReadOnlyGit(command: string, home: string): string | undefined {
	const parsed = parse(command);
	if (!parsed) return undefined;
	const dirs = parsed.directories.flatMap((t) => ["-C", t.expandHome ? home.replace(/\/+$/, "") + t.value.slice(1) : t.value]);
	const base = ["/usr/bin/git", "--no-pager", "--no-optional-locks", ...CONFIG.flatMap((c) => ["-c", c]), ...dirs];
	const fixed = ["diff", "log", "show"].includes(parsed.subcommand) ? ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"] : parsed.subcommand === "status" ? ["--ignore-submodules=all"] : [];
	const script = [
		`_git=(${base.map(shq).join(" ")})`,
		"_filters=(); _count=0",
		// status/diff may invoke clean/process filters even with --no-textconv.
		// Read config names only (NUL-delimited), quote every override, and fail
		// closed on parser errors; no config value is executed or eval'ed.
		"while IFS= read -r -d '' _key; do",
		"  _count=$((_count + 1)); [ \"$_count\" -le 256 ] || exit 2",
		"  case \"$_key\" in *.required) _filters+=(-c \"$_key=false\");; *) _filters+=(-c \"$_key=\");; esac",
		"done < <(\"${_git[@]}\" config --null --name-only --get-regexp '^filter\\..*\\.(clean|smudge|process|required)$')",
		"_pid=$!; wait \"$_pid\"; _rc=$?; [ \"$_rc\" -le 1 ] || exit \"$_rc\"",
		`exec "\${_git[@]}" "\${_filters[@]}" ${[parsed.subcommand, ...fixed, ...parsed.args].map(shq).join(" ")}`,
	].join("\n");
	// An empty environment unsets GIT_EXTERNAL_DIFF/GIT_PAGER/PAGER/askpass,
	// tracing, config injection, exec-path and loader/startup variables too.
	return `/usr/bin/env -i ${[
		`HOME=${home}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0",
		"GIT_ALLOW_PROTOCOL=", "GIT_NO_LAZY_FETCH=1", "GIT_ATTR_NOSYSTEM=1",
	].map(shq).join(" ")} /bin/bash --noprofile --norc -c ${shq(script)}`;
}
