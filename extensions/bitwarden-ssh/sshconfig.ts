// ssh_config parser, editor and generator. Pure (no I/O); the main unit-test target.
// Lossless: every block keeps its raw lines, so serializeConfig(parseConfig(t)) === t.

export interface Line {
	/** Raw text including the line ending. */
	raw: string;
	/** Lowercased keyword; undefined for blank and comment lines. */
	key?: string;
	/** Keyword as written. */
	keyRaw?: string;
	/** Argument text as written (quotes and any trailing comment kept). */
	value?: string;
	/** Arguments as OpenSSH reads them: quotes removed, a trailing `# comment` dropped. */
	args?: string[];
	/** Trailing comment of the line (from "#"), if any. */
	comment?: string;
	/** A quote was not closed: OpenSSH rejects the line ("invalid quotes"). */
	unterminated?: boolean;
	indent: string;
}

export interface Block {
	kind: "preamble" | "host" | "match";
	/** Host patterns (empty for preamble and Match). */
	patterns: string[];
	lines: Line[];
}

export interface HostInfo {
	patterns: string[];
	options: Record<string, string[]>;
	wildcard: boolean;
}

export type OptionValues = Record<string, string | string[] | null>;

const LINE_RE = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*?)\s*$/;
const BARE_RE = /^\s*([A-Za-z][A-Za-z0-9]*)\s*$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

export interface Tokens {
	args: string[];
	/** The trailing comment starting with "#", if any. */
	comment?: string;
	/** True when a quote was not closed (OpenSSH rejects such a line). */
	unterminated?: boolean;
}

/**
 * Split an argument string like OpenSSH's argv_split(): whitespace separates arguments; double and single
 * quotes group (quoted fragments join the surrounding text, e.g. a"b c"d is one argument); a backslash
 * escapes a quote, a backslash and (outside quotes) a space; a "#" at the start of an argument (outside
 * quotes) starts a comment that runs to the end of the line.
 */
export function tokenize(value: string): Tokens {
	const args: string[] = [];
	let i = 0;
	const n = value.length;
	while (i < n) {
		const c = value[i];
		if (c === " " || c === "\t") {
			i++;
			continue;
		}
		if (c === "#") return { args, comment: value.slice(i) };
		let arg = "";
		let quote = "";
		for (; i < n; i++) {
			const ch = value[i];
			if (ch === "\\") {
				const nx = value[i + 1];
				if (nx === "'" || nx === '"' || nx === "\\" || (!quote && nx === " ")) {
					i++;
					arg += nx;
				} else arg += ch;
			} else if (!quote && (ch === " " || ch === "\t")) break;
			else if (!quote && (ch === '"' || ch === "'")) quote = ch;
			else if (quote && ch === quote) quote = "";
			else arg += ch;
		}
		if (quote) return { args: [...args, arg], unterminated: true };
		args.push(arg);
	}
	return { args };
}

export function parseLine(raw: string): Line {
	const body = raw.replace(/\r?\n$/, "");
	const indent = /^\s*/.exec(body)![0];
	if (/^\s*(#|$)/.test(body)) return { raw, indent };
	const m = LINE_RE.exec(body) ?? BARE_RE.exec(body);
	if (!m) return { raw, indent };
	const value = m[2] ?? "";
	const t = tokenize(value);
	return {
		raw,
		key: m[1].toLowerCase(),
		keyRaw: m[1],
		value,
		args: t.args,
		...(t.comment ? { comment: t.comment } : {}),
		...(t.unterminated ? { unterminated: true } : {}),
		indent,
	};
}

/** Split arguments like OpenSSH (quotes removed, trailing comment dropped). */
export function splitArgs(value: string): string[] {
	return tokenize(value).args;
}

/** A value with one pair of surrounding double quotes removed. */
export function unquote(value: string): string {
	const v = value.trim();
	return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

/** First argument of a directive as OpenSSH reads it (e.g. the path of IdentityFile). */
export function firstArg(line: Line): string {
	return line.args?.[0] ?? "";
}

export function parseConfig(text: string): Block[] {
	const raws = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const blocks: Block[] = [{ kind: "preamble", patterns: [], lines: [] }];
	for (const raw of raws) {
		const line = parseLine(raw);
		if (line.key === "host" || line.key === "match") {
			blocks.push({
				kind: line.key,
				patterns: line.key === "host" ? [...(line.args ?? [])] : [],
				lines: [line],
			});
		} else {
			blocks[blocks.length - 1].lines.push(line);
		}
	}
	return blocks;
}

/** 1-based numbers of lines that are neither blank, comment nor `Keyword value`. */
export function invalidLines(text: string): number[] {
	const out: number[] = [];
	(text.match(/[^\n]*\n|[^\n]+$/g) ?? []).forEach((raw, i) => {
		const l = parseLine(raw);
		if (!l.key && raw.trim() && !raw.trim().startsWith("#")) out.push(i + 1);
	});
	return out;
}

/** Directives the generator rewrites, with the exact number of arguments OpenSSH accepts for them. */
const ARITY: Record<string, number> = { identityfile: 1 };

/**
 * Lexical and arity errors, with 1-based line numbers: lines that are not `Keyword value`, unterminated
 * quotes, and rewritten directives (IdentityFile) with other than one argument. The generator refuses a
 * source with any of them: rewriting such a line could hide the error from the `ssh -G` check.
 */
export function configErrors(text: string): string[] {
	const out: string[] = [];
	(text.match(/[^\n]*\n|[^\n]+$/g) ?? []).forEach((raw, i) => {
		const l = parseLine(raw);
		const at = `line ${i + 1}`;
		if (!l.key) {
			if (raw.trim() && !raw.trim().startsWith("#")) out.push(`${at}: not "Keyword value"`);
			return;
		}
		if (l.unterminated) out.push(`${at}: unterminated quote`);
		else if (l.key in ARITY && (l.args ?? []).length !== ARITY[l.key])
			out.push(`${at}: ${l.keyRaw} takes exactly ${ARITY[l.key]} argument (got ${(l.args ?? []).length})`);
	});
	return out;
}

export class ConfigSyntaxError extends Error {
	readonly errors: string[];
	constructor(errors: string[]) {
		super(errors.join("; "));
		this.errors = errors;
	}
}

export function serializeConfig(blocks: Block[]): string {
	return blocks.map((b) => b.lines.map((l) => l.raw).join("")).join("");
}

function eolOf(blocks: Block[]): string {
	for (const b of blocks) for (const l of b.lines) if (l.raw.endsWith("\r\n")) return "\r\n";
	return "\n";
}

export function isWildcard(pattern: string): boolean {
	return /[*?]/.test(pattern) || pattern.startsWith("!");
}

function options(block: Block): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const l of block.lines.slice(block.kind === "preamble" ? 0 : 1)) {
		if (!l.key) continue;
		(out[l.key] ??= []).push((l.args ?? []).join(" "));
	}
	return out;
}

export function listHosts(blocks: Block[]): HostInfo[] {
	return blocks
		.filter((b) => b.kind === "host")
		.map((b) => ({ patterns: [...b.patterns], options: options(b), wildcard: b.patterns.some(isWildcard) }));
}

/** Concrete host names (no wildcards, no negations), for completions and command matching. */
export function hostNames(blocks: Block[]): string[] {
	const out = new Set<string>();
	for (const b of blocks) if (b.kind === "host") for (const p of b.patterns) if (!isWildcard(p)) out.add(p);
	return [...out];
}

function hostBlocks(blocks: Block[], name: string): Block[] {
	return blocks.filter((b) => b.kind === "host" && b.patterns.includes(name));
}

export function getHostBlockText(blocks: Block[], name: string): string | undefined {
	const found = hostBlocks(blocks, name);
	return found.length ? found.map((b) => b.lines.map((l) => l.raw).join("")).join("") : undefined;
}

// --- validation -------------------------------------------------------------------------------

const PATH_KEYS = new Set(["identityfile", "certificatefile", "identityagent", "controlpath"]);

export function validateKey(key: string): string | undefined {
	if (!KEY_RE.test(key)) return `invalid option name ${JSON.stringify(key)}`;
	const k = key.toLowerCase();
	if (k === "host" || k === "match") return `${key} cannot be set as an option; use the host/patterns parameters`;
	if (k === "include") return "Include cannot be set through host options";
	return undefined;
}

export function validateValue(value: string): string | undefined {
	if (/[\r\n\0]/.test(value)) return "values must be single-line";
	if (!value.trim()) return "empty value (use null to remove an option)";
	return undefined;
}

export function validatePattern(p: string): string | undefined {
	if (!p || /[\s"\0#]/.test(p) || /[\r\n]/.test(p)) return `invalid host pattern ${JSON.stringify(p)}`;
	return undefined;
}

/** Validate an options object; returns the first problem or undefined. */
export function validateOptions(opts: OptionValues): string | undefined {
	for (const [k, v] of Object.entries(opts)) {
		const kErr = validateKey(k);
		if (kErr) return kErr;
		if (v === null) continue;
		const vals = Array.isArray(v) ? v : [v];
		if (vals.length === 0) return `${k}: empty list (use null to remove an option)`;
		for (const val of vals) {
			if (typeof val !== "string") return `${k}: values must be strings`;
			const e = validateValue(val);
			if (e) return `${k}: ${e}`;
		}
	}
	return undefined;
}

function formatValue(key: string, value: string): string {
	const v = value.trim();
	if (PATH_KEYS.has(key.toLowerCase()) && /\s/.test(v) && !(v.startsWith('"') && v.endsWith('"'))) return `"${v}"`;
	return v;
}

function makeLine(indent: string, key: string, value: string, eol: string): Line {
	return parseLine(`${indent}${key} ${formatValue(key, value)}${eol}`);
}

function ensureEol(line: Line | undefined, eol: string): void {
	if (line && !line.raw.endsWith("\n")) line.raw += eol;
}

function blockIndent(block: Block): string {
	for (const l of block.lines.slice(1)) if (l.key && l.indent) return l.indent;
	return "    ";
}

// --- editing ----------------------------------------------------------------------------------

/**
 * Set options of the first Host block that lists `name` as one of its patterns. Each key replaces all its
 * lines at the position of the first one; null removes the key; new keys go after the last option line
 * (before trailing blank and comment lines). Returns false when no such host exists.
 */
export function setHostOptions(blocks: Block[], name: string, opts: OptionValues): boolean {
	const err = validateOptions(opts);
	if (err) throw new Error(err);
	const block = hostBlocks(blocks, name)[0];
	if (!block) return false;
	const eol = eolOf(blocks);
	// An edited block always ends with a newline (the file may have lacked a final one).
	ensureEol(block.lines[block.lines.length - 1], eol);
	for (const [key, v] of Object.entries(opts)) {
		const k = key.toLowerCase();
		const vals = v === null ? [] : Array.isArray(v) ? v : [v];
		const idx = block.lines.findIndex((l, i) => i > 0 && l.key === k);
		if (idx >= 0) {
			const indent = block.lines[idx].indent || blockIndent(block);
			const keyName = block.lines[idx].keyRaw ?? key;
			const fresh = vals.map((val) => makeLine(indent, keyName, val, eol));
			block.lines = block.lines.flatMap((l, i) => (i === idx ? fresh : i > 0 && l.key === k ? [] : [l]));
		} else if (vals.length) {
			let at = 1;
			block.lines.forEach((l, i) => {
				if (i > 0 && l.key) at = i + 1;
			});
			const indent = blockIndent(block);
			block.lines.splice(at, 0, ...vals.map((val) => makeLine(indent, key, val, eol)));
		}
	}
	return true;
}

/** Add a Host block before the first `Host *` block, otherwise at the end. Throws if a pattern exists. */
export function addHost(blocks: Block[], patterns: string[], opts: OptionValues): void {
	if (!patterns.length) throw new Error("no host patterns given");
	for (const p of patterns) {
		const e = validatePattern(p);
		if (e) throw new Error(e);
		if (hostBlocks(blocks, p).length) throw new Error(`host ${p} already exists`);
	}
	const err = validateOptions(opts);
	if (err) throw new Error(err);
	const eol = eolOf(blocks);
	const lines: Line[] = [parseLine(`Host ${patterns.join(" ")}${eol}`)];
	for (const [k, v] of Object.entries(opts)) {
		if (v === null) continue;
		for (const val of Array.isArray(v) ? v : [v]) lines.push(makeLine("    ", k, val, eol));
	}
	lines.push(parseLine(eol));
	const block: Block = { kind: "host", patterns: [...patterns], lines };
	const starIdx = blocks.findIndex((b) => b.kind === "host" && b.patterns.includes("*"));
	const at = starIdx >= 0 ? starIdx : blocks.length;
	const prev = blocks[at - 1];
	const prevLast = prev.lines[prev.lines.length - 1];
	ensureEol(prevLast, eol);
	// Separate from the previous block with a blank line.
	if (prevLast && prevLast.raw.trim() !== "") prev.lines.push(parseLine(eol));
	blocks.splice(at, 0, block);
}

/** Remove `name` from every Host header listing it; a block left without patterns is removed. */
export function removeHost(blocks: Block[], name: string): boolean {
	let found = false;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i];
		if (b.kind !== "host" || !b.patterns.includes(name)) continue;
		found = true;
		const rest = b.patterns.filter((p) => p !== name);
		if (!rest.length) {
			blocks.splice(i, 1);
			continue;
		}
		const head = b.lines[0];
		const eol = /\r?\n$/.exec(head.raw)?.[0] ?? "";
		const quoted = rest.map((p) => (/[\s#'"\\]/.test(p) ? `"${p.replace(/(["\\])/g, "\\$1")}"` : p));
		const comment = head.comment ? ` ${head.comment}` : "";
		b.lines[0] = parseLine(`${head.indent}${head.keyRaw ?? "Host"} ${quoted.join(" ")}${comment}${eol}`);
		b.patterns = rest;
	}
	return found;
}

/** Distinct IdentityFile values (unquoted, as written). */
export function identityPaths(blocks: Block[]): string[] {
	const out = new Set<string>();
	for (const b of blocks) for (const l of b.lines) if (l.key === "identityfile") out.add(firstArg(l));
	return [...out].filter(Boolean);
}

// --- key name matching ------------------------------------------------------------------------

function norm(s: string): string {
	return s
		.trim()
		.toLowerCase()
		.replace(/\.(pub|pem|key)$/, "");
}

export function basename(path: string): string {
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/** The single key whose normalized name equals the IdentityFile basename; undefined if none or ambiguous. */
export function matchKeyName<T extends { name: string }>(path: string, keys: T[]): T | undefined {
	const want = norm(basename(path));
	if (!want) return undefined;
	const hits = keys.filter((k) => {
		const n = norm(k.name);
		return n === want || n.replace(/\s+/g, "_") === want || n.replace(/\s+/g, "-") === want;
	});
	return hits.length === 1 ? hits[0] : undefined;
}

// --- generation -------------------------------------------------------------------------------

export interface GenerateOptions {
	/** Absolute public key path for an IdentityFile value as written, or undefined if unmapped. */
	mapIdentity(path: string): string | undefined;
	/** Whether a path (already ~-expanded by the caller if needed) exists on this machine. */
	pathExists(path: string): boolean;
	controlPersist: string | false;
	cmDir: string;
	/** Header comment; each line is prefixed with "# ". */
	header: string;
}

export interface GenerateResult {
	text: string;
	mapped: string[];
	unmatched: string[];
	disabled: string[];
	/** Source line number (1-based) of each generated line, indexed by generated line number; 0 = added. */
	sourceLines: number[];
}

const DISABLED = "# [pi-bw disabled] ";

/** Throws ConfigSyntaxError for a source with lexical or arity errors (see configErrors). */
export function generateConfig(sourceText: string, opts: GenerateOptions): GenerateResult {
	const errors = configErrors(sourceText);
	if (errors.length) throw new ConfigSyntaxError(errors);
	const blocks = parseConfig(sourceText);
	const eol = eolOf(blocks);
	const mapped = new Set<string>();
	const unmatched = new Set<string>();
	const disabled: string[] = [];
	const hasControlMaster = blocks.some((b) => b.lines.some((l) => l.key === "controlmaster"));
	// Source line number of every line object, also for the lines that replace or follow a source line.
	const srcNo = new Map<Line, number>();
	let no = 0;
	for (const b of blocks) for (const l of b.lines) srcNo.set(l, ++no);

	for (const b of blocks) {
		const hasIdOnly = b.lines.some((l) => l.key === "identitiesonly");
		let addedIdOnly = false;
		const out: Line[] = [];
		for (const l of b.lines) {
			const lineEol = /\r?\n$/.exec(l.raw)?.[0] ?? eol;
			const n = srcNo.get(l) ?? 0;
			const push = (x: Line) => {
				srcNo.set(x, n);
				out.push(x);
			};
			const disable = () => {
				const text = l.raw.replace(/\r?\n$/, "");
				disabled.push(text.trim());
				push(parseLine(`${l.indent}${DISABLED}${text.trimStart()}${lineEol}`));
			};
			const value = firstArg(l);
			if (l.key === "identityfile") {
				const pub = opts.mapIdentity(value);
				if (pub) {
					mapped.add(value);
					push(parseLine(`${l.indent}${l.keyRaw} "${pub}"${lineEol}`));
					if (!hasIdOnly && !addedIdOnly) {
						push(parseLine(`${l.indent}IdentitiesOnly yes${lineEol}`));
						addedIdOnly = true;
					}
					continue;
				}
				if (!opts.pathExists(value)) unmatched.add(value);
				out.push(l);
			} else if (l.key === "usekeychain") {
				disable();
			} else if (l.key === "identityagent") {
				const v = value;
				if (v === "none" || v === "SSH_AUTH_SOCK" || v.startsWith("$") || opts.pathExists(v)) out.push(l);
				else disable();
			} else if (l.key === "include" && (l.args ?? []).some((a) => /pi-bitwarden/.test(a))) {
				disable();
			} else {
				out.push(l);
			}
		}
		b.lines = out;
	}

	const headerLines = opts.header.split("\n");
	const header = headerLines.map((l) => `# ${l}`.trimEnd() + eol).join("");
	const sourceLines = [0, ...headerLines.map(() => 0), 0, ...blocks.flatMap((b) => b.lines.map((l) => srcNo.get(l) ?? 0))];
	let body = serializeConfig(blocks);
	if (body && !body.endsWith("\n")) body += eol;
	let text = `${header}${eol}${body}`;
	if (opts.controlPersist !== false && !hasControlMaster) {
		if (!/(\r?\n){2}$/.test(text)) text += eol;
		text +=
			`# Added by pi bitwarden-ssh: connection sharing (set bitwardenSsh.controlPersist to false to drop it)${eol}` +
			`Host *${eol}` +
			`    ControlMaster auto${eol}` +
			`    ControlPath "${opts.cmDir}/%C"${eol}` +
			`    ControlPersist ${opts.controlPersist}${eol}`;
	}
	return { text, mapped: [...mapped], unmatched: [...unmatched], disabled, sourceLines };
}
