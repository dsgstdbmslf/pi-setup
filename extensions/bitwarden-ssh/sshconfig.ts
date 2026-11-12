// ssh_config parser, editor and generator. Pure (no I/O); the main unit-test target.
// Lossless: every block keeps its raw lines, so serializeConfig(parseConfig(t)) === t.

export interface Line {
	/** Raw text including the line ending. */
	raw: string;
	/** Lowercased keyword; undefined for blank and comment lines. */
	key?: string;
	/** Keyword as written. */
	keyRaw?: string;
	/** Argument text as written (quotes kept). */
	value?: string;
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

export function parseLine(raw: string): Line {
	const body = raw.replace(/\r?\n$/, "");
	const indent = /^\s*/.exec(body)![0];
	if (/^\s*(#|$)/.test(body)) return { raw, indent };
	const m = LINE_RE.exec(body) ?? BARE_RE.exec(body);
	if (!m) return { raw, indent };
	return { raw, key: m[1].toLowerCase(), keyRaw: m[1], value: m[2] ?? "", indent };
}

/** Split arguments on whitespace, honoring double quotes (quotes removed). */
export function splitArgs(value: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(value))) out.push(m[1] ?? m[2]);
	return out;
}

/** A value with one pair of surrounding double quotes removed. */
export function unquote(value: string): string {
	const v = value.trim();
	return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

export function parseConfig(text: string): Block[] {
	const raws = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const blocks: Block[] = [{ kind: "preamble", patterns: [], lines: [] }];
	for (const raw of raws) {
		const line = parseLine(raw);
		if (line.key === "host" || line.key === "match") {
			blocks.push({
				kind: line.key,
				patterns: line.key === "host" ? splitArgs(line.value ?? "") : [],
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
		(out[l.key] ??= []).push(unquote(l.value ?? ""));
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
		const quoted = rest.map((p) => (/\s/.test(p) ? `"${p}"` : p));
		b.lines[0] = parseLine(`${head.indent}${head.keyRaw ?? "Host"} ${quoted.join(" ")}${eol}`);
		b.patterns = rest;
	}
	return found;
}

/** Distinct IdentityFile values (unquoted, as written). */
export function identityPaths(blocks: Block[]): string[] {
	const out = new Set<string>();
	for (const b of blocks) for (const l of b.lines) if (l.key === "identityfile") out.add(unquote(l.value ?? ""));
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
}

const DISABLED = "# [pi-bw disabled] ";

export function generateConfig(sourceText: string, opts: GenerateOptions): GenerateResult {
	const blocks = parseConfig(sourceText);
	const eol = eolOf(blocks);
	const mapped = new Set<string>();
	const unmatched = new Set<string>();
	const disabled: string[] = [];
	const hasControlMaster = blocks.some((b) => b.lines.some((l) => l.key === "controlmaster"));

	for (const b of blocks) {
		const hasIdOnly = b.lines.some((l) => l.key === "identitiesonly");
		let addedIdOnly = false;
		const out: Line[] = [];
		for (const l of b.lines) {
			const lineEol = /\r?\n$/.exec(l.raw)?.[0] ?? eol;
			const disable = () => {
				const text = l.raw.replace(/\r?\n$/, "");
				disabled.push(text.trim());
				out.push(parseLine(`${l.indent}${DISABLED}${text.trimStart()}${lineEol}`));
			};
			const value = unquote(l.value ?? "");
			if (l.key === "identityfile") {
				const pub = opts.mapIdentity(value);
				if (pub) {
					mapped.add(value);
					out.push(parseLine(`${l.indent}${l.keyRaw} "${pub}"${lineEol}`));
					if (!hasIdOnly && !addedIdOnly) {
						out.push(parseLine(`${l.indent}IdentitiesOnly yes${lineEol}`));
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
			} else if (l.key === "include" && /pi-bitwarden/.test(l.value ?? "")) {
				disable();
			} else {
				out.push(l);
			}
		}
		b.lines = out;
	}

	const header = opts.header
		.split("\n")
		.map((l) => `# ${l}`.trimEnd() + eol)
		.join("");
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
	return { text, mapped: [...mapped], unmatched: [...unmatched], disabled };
}
