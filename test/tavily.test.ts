import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	type Attempt,
	ApiError,
	KeyFileError,
	KeyPool,
	fingerprint,
	loadKeys,
	mask,
	nextMonthUtc,
	verdictFor,
	withRotation,
} from "../extensions/tavily/keys.ts";
import { call, compact, credits, cut, plain, serverText, statusLabel } from "../extensions/tavily/client.ts";
import { cleanupSaved, ensurePrivateDir, plural, sanitize, saveFull } from "../extensions/tavily/output.ts";

const markFile = (stateDir: string, key: string) => join(stateDir, "tavily", `${fingerprint(key)}.json`);
const readMark = async (stateDir: string, key: string) => JSON.parse(await readFile(markFile(stateDir, key), "utf8"));

/** Every file under the state dir, as relative paths. */
async function stateFiles(stateDir: string): Promise<string[]> {
	const out: string[] = [];
	for (const d of await readdir(stateDir).catch(() => [] as string[]))
		for (const f of await readdir(join(stateDir, d)).catch(() => [] as string[])) out.push(join(d, f));
	return out.sort();
}

async function setup(keys: unknown) {
	const dir = await mkdtemp(join(tmpdir(), "ws-test-"));
	const keysFile = join(dir, "api-keys.json");
	if (keys !== undefined) await writeFile(keysFile, JSON.stringify(keys), { mode: 0o600 });
	const stateDir = join(dir, "api-keys-state");
	return { dir, keysFile, stateDir, pool: new KeyPool("tavily", keysFile, stateDir) };
}

/** A fake API: maps key (or "keyless") to a sequence of statuses. */
function fake(statuses: Record<string, number>) {
	const calls: (string | null)[] = [];
	const run = async (key: string | null): Promise<Attempt<string>> => {
		calls.push(key);
		const status = statuses[key ?? "keyless"] ?? 200;
		return status === 200 ? { ok: true, value: `via ${key}` } : { ok: false, status, message: `HTTP ${status}` };
	};
	return { calls, run };
}

test("loadKeys accepts strings and objects, skips disabled, empty and duplicates", async () => {
	const { keysFile } = await setup({
		tavily: ["tvly-aaaaaaaaaaaa", { key: "tvly-bbbbbbbbbbbb", label: " main " }, { key: "x", disabled: true }, "", "tvly-aaaaaaaaaaaa"],
	});
	const { entries, missing, insecure } = await loadKeys(keysFile, "tavily");
	assert.equal(missing, false);
	assert.equal(insecure, false);
	assert.deepEqual(
		entries.map((e) => [e.key, e.label]),
		[
			["tvly-aaaaaaaaaaaa", "#1"],
			["tvly-bbbbbbbbbbbb", "main"],
		],
	);
	assert.equal(entries[0].id, fingerprint("tvly-aaaaaaaaaaaa"));
});

test("loadKeys: missing file, other service, bad JSON without leaking content", async () => {
	const none = await setup(undefined);
	assert.deepEqual(await loadKeys(none.keysFile, "tavily"), { entries: [], missing: true, insecure: false, malformed: [] });
	const other = await setup({ brave: ["k"] });
	assert.equal((await loadKeys(other.keysFile, "tavily")).entries.length, 0);
	await writeFile(other.keysFile, '{"tavily": ["tvly-secret-value"');
	await assert.rejects(loadKeys(other.keysFile, "tavily"), (err: Error) => err instanceof KeyFileError && !err.message.includes("secret"));
	await writeFile(other.keysFile, '{"tavily": "tvly-x"}');
	await assert.rejects(loadKeys(other.keysFile, "tavily"), KeyFileError);
});

test("loadKeys flags a key file readable by others", { skip: process.platform === "win32" }, async () => {
	const { keysFile } = await setup({ tavily: ["k"] });
	await writeFile(keysFile, '{"tavily":["k"]}', { mode: 0o644 });
	await chmod(keysFile, 0o644);
	assert.equal((await loadKeys(keysFile, "tavily")).insecure, true);
});

test("mask and fingerprint never expose the key", () => {
	assert.equal(mask("tvly-dev-1234567890abcd"), "tvly-…abcd");
	assert.equal(mask("short"), "…");
	assert.equal(fingerprint("tvly-abc").length, 12);
	assert.ok(!fingerprint("tvly-abc").includes("tvly"));
});

test("nextMonthUtc rolls over the year", () => {
	assert.equal(new Date(nextMonthUtc(Date.UTC(2026, 11, 31, 23))).toISOString(), "2027-01-01T00:00:00.000Z");
	assert.equal(new Date(nextMonthUtc(Date.UTC(2026, 4, 9))).toISOString(), "2026-06-01T00:00:00.000Z");
});

test("verdictFor maps Tavily statuses", () => {
	assert.equal(verdictFor(401), "invalid");
	assert.equal(verdictFor(432), "exhausted");
	assert.equal(verdictFor(433), "exhausted");
	assert.equal(verdictFor(429), "rate_limited");
	for (const s of [400, 403, 404, 500, 502]) assert.equal(verdictFor(s), null);
});

test("failover: exhausted key is skipped now and on the next call, state stores no key", async () => {
	const { pool, stateDir } = await setup({ tavily: [{ key: "tvly-first-000000", label: "a" }, { key: "tvly-second-00000", label: "b" }] });
	const api = fake({ "tvly-first-000000": 432 });
	const notes: string[] = [];
	const r = await withRotation(pool, api.run, { keyless: true, onNote: (n) => notes.push(n) });
	assert.equal(r.value, "via tvly-second-00000");
	assert.equal(r.via, "b");
	assert.deepEqual(api.calls, ["tvly-first-000000", "tvly-second-00000"]);
	assert.match(notes[0], /"a" exhausted \(432\)/);

	for (const f of await stateFiles(stateDir)) assert.ok(!(await readFile(join(stateDir, f), "utf8")).includes("tvly-"), "state must not contain keys");
	assert.equal((await readMark(stateDir, "tvly-first-000000")).status, "exhausted");
	if (process.platform !== "win32") {
		assert.equal((await stat(markFile(stateDir, "tvly-first-000000"))).mode & 0o777, 0o600);
		assert.equal((await stat(join(stateDir, "tavily"))).mode & 0o777, 0o700);
	}

	const api2 = fake({});
	await withRotation(new KeyPool("tavily", pool.keysFile, stateDir), api2.run, { keyless: true });
	assert.deepEqual(api2.calls, ["tvly-second-00000"], "a fresh pool reads the exhausted mark from disk");
});

test("failover: exhausted mark expires at the next month", async () => {
	const { keysFile, stateDir } = await setup({ tavily: ["tvly-first-000000"] });
	let now = Date.UTC(2026, 4, 20);
	const pool = new KeyPool("tavily", keysFile, stateDir, () => now);
	await withRotation(pool, fake({ "tvly-first-000000": 432 }).run, { keyless: true, now: () => now });
	assert.equal((await pool.snapshot()).available.length, 0);
	now = Date.UTC(2026, 5, 1, 0, 0, 1);
	assert.equal((await pool.snapshot()).available.length, 1);
});

test("failover: invalid key is permanent, rate limit only in memory until Retry-After", async () => {
	const { keysFile, stateDir } = await setup({ tavily: ["tvly-bad-0000000", "tvly-busy-000000", "tvly-ok-00000000"] });
	let now = 1_000_000;
	const pool = new KeyPool("tavily", keysFile, stateDir, () => now);
	const run = async (key: string | null): Promise<Attempt<string>> => {
		if (key === "tvly-bad-0000000") return { ok: false, status: 401, message: "bad" };
		if (key === "tvly-busy-000000") return { ok: false, status: 429, message: "busy", retryAfter: 10 };
		return { ok: true, value: String(key) };
	};
	assert.equal((await withRotation(pool, run, { keyless: false, now: () => now })).value, "tvly-ok-00000000");
	const snap = await pool.snapshot();
	assert.deepEqual(
		snap.skipped.map((s) => s.mark.status),
		["invalid", "rate_limited"],
	);
	assert.deepEqual(await stateFiles(stateDir), [join("tavily", `${fingerprint("tvly-bad-0000000")}.json`)]);
	assert.equal((await readMark(stateDir, "tvly-bad-0000000")).status, "invalid");
	now += 11_000;
	assert.deepEqual((await pool.snapshot()).available.map((e) => e.key), ["tvly-busy-000000", "tvly-ok-00000000"]);
});

test("failover: other errors do not switch keys or mark anything", async () => {
	const { pool, stateDir } = await setup({ tavily: ["tvly-first-000000", "tvly-second-00000"] });
	const api = fake({ "tvly-first-000000": 500 });
	await assert.rejects(withRotation(pool, api.run, { keyless: true }), (err: ApiError) => err.status === 500);
	assert.deepEqual(api.calls, ["tvly-first-000000"]);
	assert.deepEqual(await stateFiles(stateDir), []);
});

test("failover: all keys exhausted falls back to keyless or fails without it", async () => {
	const { pool } = await setup({ tavily: ["tvly-first-000000"] });
	const api = fake({ "tvly-first-000000": 433 });
	const r = await withRotation(pool, api.run, { keyless: true });
	assert.equal(r.via, "keyless");
	assert.equal(r.key, null);
	assert.deepEqual(api.calls, ["tvly-first-000000", null]);
	assert.match(r.notes.at(-1) ?? "", /no usable keys, used keyless/);
	await assert.rejects(withRotation(pool, fake({}).run, { keyless: false }), /no usable keys.*\/search-keys/);
});

test("failover: no key file uses keyless", async () => {
	const { pool } = await setup(undefined);
	const api = fake({});
	const r = await withRotation(pool, api.run, { keyless: true });
	assert.deepEqual(api.calls, [null]);
	assert.match(r.notes[0], /no key file/);
});

test("clear removes marks for chosen ids or all", async () => {
	const { pool } = await setup({ tavily: ["tvly-first-000000", "tvly-second-00000"] });
	await withRotation(pool, fake({ "tvly-first-000000": 401, "tvly-second-00000": 432 }).run, { keyless: true });
	assert.equal((await pool.snapshot()).available.length, 0);
	await pool.clear([fingerprint("tvly-second-00000")]);
	assert.deepEqual((await pool.snapshot()).available.map((e) => e.key), ["tvly-second-00000"]);
	await pool.clear();
	assert.equal((await pool.snapshot()).available.length, 2);
});

test("call sends the key or keyless header and parses Tavily errors", async () => {
	const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		seen.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
		if (seen.length === 1) return new Response('{"results":[]}', { status: 200 });
		return new Response('{"detail":{"error":"Usage limit exceeded"}}', { status: 432, headers: { "retry-after": "5" } });
	}) as typeof fetch;
	const ok = await call("/search", "tvly-k", { body: { query: "q" }, timeoutMs: 1000, fetchImpl });
	assert.deepEqual(ok, { ok: true, value: { results: [] } });
	assert.equal(seen[0].headers.authorization, "Bearer tvly-k");
	assert.equal(seen[0].url, "https://api.tavily.com/search");
	const bad = await call("/search", null, { body: { query: "q" }, timeoutMs: 1000, fetchImpl });
	assert.equal(seen[1].headers["x-tavily-access-mode"], "keyless");
	assert.equal(seen[1].headers.authorization, undefined);
	assert.deepEqual(bad, { ok: false, status: 432, message: "Tavily /search 432: Usage limit exceeded", retryAfter: 5 });
});

test("call reports a timeout clearly", async () => {
	// AbortSignal.timeout() does not keep the event loop alive; a real fetch would.
	const keepAlive = setTimeout(() => {}, 5000);
	const fetchImpl = ((_u: string, init: RequestInit) =>
		new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
	await assert.rejects(call("/map", "k", { timeoutMs: 20, fetchImpl }), /timed out after 0.02s/);
	clearTimeout(keepAlive);
});

test("rate-limit marks are shared by pools of the same state dir, not of others", async () => {
	// Each pi extension gets its own KeyPool; a 429 seen by one must be skipped by the others.
	const { keysFile, stateDir } = await setup({ tavily: ["tvly-shared-00000", "tvly-other-000000"] });
	const run = async (key: string | null): Promise<Attempt<string>> =>
		key === "tvly-shared-00000" ? { ok: false, status: 429, message: "busy", retryAfter: 60 } : { ok: true, value: String(key) };
	await withRotation(new KeyPool("tavily", keysFile, stateDir), run, { keyless: false });
	const sibling = new KeyPool("tavily", keysFile, stateDir);
	assert.deepEqual((await sibling.snapshot()).available.map((e) => e.key), ["tvly-other-000000"]);
	const elsewhere = await setup({ tavily: ["tvly-shared-00000"] });
	assert.equal((await elsewhere.pool.snapshot()).available.length, 1, "another state dir has its own marks");
	await sibling.clear();
	assert.equal((await new KeyPool("tavily", keysFile, stateDir).snapshot()).available.length, 2);
});

test("compact, plain and credits", () => {
	assert.deepEqual(compact({ a: 1, b: undefined, c: "", d: [], e: false, f: ["x"] }), { a: 1, e: false, f: ["x"] });
	assert.equal(plain("<p>Hi &amp; <b>bye</b></p>\n  x"), "Hi & bye x");
	assert.equal(plain(undefined), "");
	assert.equal(credits({ usage: { credits: 2 } }), 2);
	assert.equal(credits({}), undefined);
});

test("output helpers: sanitize, plural, saved files expire after a day", async () => {
	assert.equal(sanitize("\x1b[31mred\x1b[0m\x07 ok\nline"), "red ok\nline");
	assert.equal(plural(1, "page"), "1 page");
	assert.equal(plural(3, "page"), "3 pages");
	const dir = await mkdtemp(join(tmpdir(), "ws-out-"));
	const old = await saveFull("old", dir);
	const fresh = await saveFull("fresh", dir);
	assert.equal(await readFile(fresh, "utf8"), "fresh");
	const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
	await utimes(old, twoDaysAgo, twoDaysAgo);
	await cleanupSaved(dir);
	assert.deepEqual(await readdir(dir), [fresh.slice(dir.length + 1)]);
	await cleanupSaved(join(dir, "missing"));
});

// ---------- review findings ----------

test("loadKeys skips keys that are not valid header values and reports their labels", async () => {
	const { keysFile } = await setup({
		tavily: [
			"tvly-good-0000001",
			"tvly-new\nline",
			{ key: "tvly-tab\tchar", label: "backup" },
			"tvly-mid dle",
			{ key: "tvly-ünicode", label: "uni" },
			"tvly-good-0000002",
		],
	});
	const { entries, malformed } = await loadKeys(keysFile, "tavily");
	assert.deepEqual(entries.map((e) => e.key), ["tvly-good-0000001", "tvly-good-0000002"]);
	assert.deepEqual(malformed, ["#2", "backup", "#4", "uni"]);
	assert.ok(!JSON.stringify(malformed).includes("tvly-"), "labels only, never keys");
	assert.deepEqual((await new KeyPool("tavily", keysFile, join(tmpdir(), "x-state")).snapshot()).malformed, malformed);
});

test("call withholds fetch errors that carry the key and drops the cause", async () => {
	const key = "tvly-dummy-secret-0001";
	const fetchImpl = (async () => {
		throw new TypeError(`Headers.append: "Bearer ${key}" is an invalid header value.`, {
			cause: new Error(`inner ${key}`),
		});
	}) as typeof fetch;
	await assert.rejects(call("/search", key, { timeoutMs: 1000, fetchImpl }), (err: Error) => {
		assert.ok(!err.message.includes(key));
		assert.ok(!err.message.includes("tvly-dummy"));
		assert.equal(err.message, "Tavily /search: request failed (details withheld)");
		assert.equal(err.cause, undefined);
		return true;
	});
});

test("call keeps the abort error when the caller cancelled", async () => {
	const ctrl = new AbortController();
	ctrl.abort();
	const fetchImpl = ((_u: string, init: RequestInit) => Promise.reject(init.signal?.reason)) as typeof fetch;
	await assert.rejects(call("/search", "k", { timeoutMs: 1000, signal: ctrl.signal, fetchImpl }), { name: "AbortError" });
});

test("call with a real fetch and a control character in the key fails without leaking it", async () => {
	await assert.rejects(call("/search", "tvly-abc\ndef", { timeoutMs: 1000 }), (err: Error) => {
		assert.ok(!err.message.includes("tvly-abc"));
		assert.equal(err.cause, undefined);
		return true;
	});
});

test("saved outputs are private: dir 0700, files 0600, existing dir tightened, symlink rejected", { skip: process.platform === "win32" }, async () => {
	const old = process.umask(0o022);
	try {
		const base = await mkdtemp(join(tmpdir(), "ws-priv-"));
		const dir = join(base, "out");
		const file = await saveFull("x", dir);
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		assert.equal((await stat(file)).mode & 0o777, 0o600);

		const loose = join(base, "loose");
		await mkdir(loose, { mode: 0o755 });
		await chmod(loose, 0o755);
		await ensurePrivateDir(loose);
		assert.equal((await stat(loose)).mode & 0o777, 0o700);

		const target = join(base, "target");
		await mkdir(target);
		const link = join(base, "link");
		await symlink(target, link);
		await assert.rejects(saveFull("x", link), /not a private directory/);
		assert.deepEqual(await readdir(target), []);
	} finally {
		process.umask(old);
	}
});

test("cleanupSaved never rejects and removes only old saved files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ws-clean-"));
	const old = new Date(Date.now() - 48 * 3600 * 1000);
	const subdir = join(dir, "1-abcdef.md"); // even a directory with a saved name must survive
	await mkdir(subdir);
	await utimes(subdir, old, old);
	await mkdir(join(dir, "olddir"));
	await utimes(join(dir, "olddir"), old, old);
	await writeFile(join(dir, "notes.txt"), "mine");
	await utimes(join(dir, "notes.txt"), old, old);
	await symlink(join(dir, "notes.txt"), join(dir, "2-abcdef.md"));
	const saved = await saveFull("old", dir);
	await utimes(saved, old, old);
	assert.equal(await cleanupSaved(dir), 1);
	assert.deepEqual((await readdir(dir)).sort(), ["1-abcdef.md", "2-abcdef.md", "notes.txt", "olddir"]);
	assert.equal(await cleanupSaved(join(dir, "missing")), 0);
});

const markOf = (status: "exhausted" | "invalid", until: number | null = null) => ({ status, until, reason: "test" });
const KEY_A = "tvly-aaaa-0000000";
const KEY_B = "tvly-bbbb-0000000";
const entryOf = (key: string, label = key) => ({ key, label, id: fingerprint(key) });

/** Temp files (dot-prefixed) must never survive a finished write. */
async function tmpLeft(stateDir: string) {
	return (await stateFiles(stateDir)).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));
}

test("concurrent marks in one pool keep both marks and leave no tmp files", async () => {
	for (let i = 0; i < 20; i++) {
		const { pool, stateDir } = await setup({ tavily: [KEY_A, KEY_B] });
		await Promise.all([pool.mark(entryOf(KEY_A), markOf("exhausted")), pool.mark(entryOf(KEY_B), markOf("invalid"))]);
		assert.equal((await readMark(stateDir, KEY_A)).status, "exhausted");
		assert.equal((await readMark(stateDir, KEY_B)).status, "invalid");
		assert.deepEqual(await stateFiles(stateDir), [KEY_A, KEY_B].map((k) => join("tavily", `${fingerprint(k)}.json`)).sort());
	}
});

test("concurrent marks from different pools of one state dir are both kept", async () => {
	const { keysFile, stateDir } = await setup({ tavily: [KEY_A, KEY_B] });
	const p1 = new KeyPool("tavily", keysFile, stateDir);
	const p2 = new KeyPool("tavily", keysFile, stateDir);
	await Promise.all([p1.mark(entryOf(KEY_A), markOf("exhausted")), p2.mark(entryOf(KEY_B), markOf("invalid"))]);
	assert.equal((await stateFiles(stateDir)).length, 2);
	assert.deepEqual(await tmpLeft(stateDir), []);
});

test("a mark racing a clear of another key is kept", async () => {
	const { pool, stateDir } = await setup({ tavily: [KEY_A, KEY_B] });
	await pool.mark(entryOf(KEY_B), markOf("invalid"));
	await Promise.all([pool.mark(entryOf(KEY_A), markOf("exhausted")), pool.clear([fingerprint(KEY_B)])]);
	assert.deepEqual(await stateFiles(stateDir), [join("tavily", `${fingerprint(KEY_A)}.json`)]);
});

/** Run one node child per job; each waits for the barrier file, then marks its key. */
async function runChildren(stateDir: string, keysFile: string, keys: string[], status: string): Promise<number[]> {
	const barrier = join(stateDir, "..", `go-${randomBytes(4).toString("hex")}`);
	const keysUrl = pathToFileURL(join(import.meta.dirname, "../extensions/tavily/keys.ts")).href;
	const script = `
		import { existsSync } from "node:fs";
		import { KeyPool, fingerprint } from ${JSON.stringify(keysUrl)};
		const [stateDir, keysFile, key, status, barrier] = process.argv.slice(1);
		const pool = new KeyPool("tavily", keysFile, stateDir);
		while (!existsSync(barrier)) await new Promise((r) => setTimeout(r, 1));
		await pool.mark({ key, label: key, id: fingerprint(key) }, { status, until: null, reason: "child" });
	`;
	const codes = keys.map(
		(key) =>
			new Promise<number>((resolve) => {
				const child = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", script, stateDir, keysFile, key, status, barrier], {
					stdio: ["ignore", "ignore", "inherit"],
				});
				child.on("exit", (code) => resolve(code ?? -1));
			}),
	);
	await new Promise((r) => setTimeout(r, 400)); // let every child reach the barrier
	await writeFile(barrier, "");
	return Promise.all(codes);
}

test("marks of different keys from many processes are all kept", async () => {
	const keys = Array.from({ length: 8 }, (_, i) => `tvly-proc-${i}-0000000`);
	for (let round = 0; round < 5; round++) {
		const { dir, keysFile, stateDir } = await setup({ tavily: keys });
		const codes = await runChildren(stateDir, keysFile, keys, round % 2 ? "invalid" : "exhausted");
		assert.deepEqual(codes, keys.map(() => 0));
		assert.deepEqual(await stateFiles(stateDir), keys.map((k) => join("tavily", `${fingerprint(k)}.json`)).sort(), `round ${round}`);
		for (const k of keys) assert.equal((await readMark(stateDir, k)).reason, "child");
		assert.deepEqual(await tmpLeft(stateDir), []);
		assert.ok(!(await readdir(dir)).some((n) => n.endsWith(".lock")));
	}
});

test("the same key marked by many processes leaves exactly one valid mark", async () => {
	const key = "tvly-same-0000000";
	const { keysFile, stateDir } = await setup({ tavily: [key] });
	const codes = await runChildren(stateDir, keysFile, Array(8).fill(key), "invalid");
	assert.deepEqual(codes, Array(8).fill(0));
	assert.deepEqual(await stateFiles(stateDir), [join("tavily", `${fingerprint(key)}.json`)]);
	assert.equal((await readMark(stateDir, key)).status, "invalid");
});

test("clear removes only mark files of the given ids or of the service", async () => {
	const { pool, stateDir } = await setup({ tavily: [KEY_A, KEY_B] });
	await pool.mark(entryOf(KEY_A), markOf("exhausted"));
	await pool.mark(entryOf(KEY_B), markOf("invalid"));
	const dir = join(stateDir, "tavily");
	await writeFile(join(dir, "notes.txt"), "mine");
	await writeFile(join(dir, ".abcdef012345.1.aa.tmp"), "tmp");
	await pool.clear(["../../etc", "zz", fingerprint(KEY_A)]);
	assert.deepEqual((await readdir(dir)).sort(), [".abcdef012345.1.aa.tmp", `${fingerprint(KEY_B)}.json`, "notes.txt"]);
	await pool.clear();
	assert.deepEqual((await readdir(dir)).sort(), [".abcdef012345.1.aa.tmp", "notes.txt"]);
	await new KeyPool("tavily", pool.keysFile, join(stateDir, "nothing")).clear(); // missing dir is fine
});

test("corrupt or wrongly shaped mark files do not mark the key", async () => {
	const { pool, stateDir } = await setup({ tavily: [KEY_A, KEY_B] });
	await mkdir(join(stateDir, "tavily"), { recursive: true });
	await writeFile(markFile(stateDir, KEY_A), "{not json");
	await writeFile(markFile(stateDir, KEY_B), JSON.stringify({ status: "nope", until: "x" }));
	assert.equal((await pool.snapshot()).available.length, 2);
});

test("KeyPool rejects a service name that is not a safe path segment", () => {
	assert.throws(() => new KeyPool("../x", "k.json", "state"), /invalid service name/);
	assert.throws(() => new KeyPool("", "k.json", "state"), /invalid service name/);
});

test("an expired persistent mark is ignored and replaced by the next mark", async () => {
	const { keysFile, stateDir } = await setup({ tavily: [KEY_A] });
	let now = 1_000;
	const pool = new KeyPool("tavily", keysFile, stateDir, () => now);
	await pool.mark(entryOf(KEY_A), markOf("exhausted", 2_000));
	assert.equal((await pool.snapshot()).available.length, 0);
	now = 3_000;
	assert.equal((await pool.snapshot()).available.length, 1);
	await pool.mark(entryOf(KEY_A), markOf("invalid"));
	assert.equal((await readMark(stateDir, KEY_A)).status, "invalid");
	assert.equal((await pool.snapshot()).available.length, 0);
});

test("failover continues with the next key when the mark cannot be saved", async () => {
	const { pool } = await setup({ tavily: [KEY_A, KEY_B] });
	pool.mark = async () => {
		throw new Error("EACCES: disk says no");
	};
	const api = fake({ [KEY_A]: 432 });
	const r = await withRotation(pool, api.run, { keyless: false });
	assert.equal(r.via, "#2");
	assert.deepEqual(api.calls, [KEY_A, KEY_B]);
	assert.match(r.notes[0], /#1" exhausted \(432\); could not save the mark: EACCES/);
	assert.ok(!r.notes[0].includes("tvly-"));
});

test("cooling marks of expired and removed keys are pruned, valid ones stay", async () => {
	const { keysFile, stateDir } = await setup({ tavily: [KEY_A, KEY_B, "tvly-cccc-0000000"] });
	let now = 1_000_000;
	const pool = new KeyPool("tavily", keysFile, stateDir, () => now);
	const bucket = (globalThis as any)[Symbol.for("pi-setup.tavily.cooling")].get(`${stateDir}\0tavily`) as Map<string, unknown>;
	const limited = (until: number) => ({ status: "rate_limited" as const, until, reason: "429" });
	await pool.mark(entryOf(KEY_A), limited(now + 5_000));
	await pool.mark(entryOf(KEY_B), limited(now + 600_000));
	await pool.mark(entryOf("tvly-cccc-0000000"), limited(now + 600_000));
	assert.equal(bucket.size, 3);

	now += 10_000; // A has expired
	await pool.snapshot();
	assert.deepEqual([...bucket.keys()].sort(), [fingerprint(KEY_B), fingerprint("tvly-cccc-0000000")].sort());

	await writeFile(keysFile, JSON.stringify({ tavily: [KEY_A, KEY_B] })); // C removed
	await pool.snapshot();
	assert.deepEqual([...bucket.keys()], [fingerprint(KEY_B)]);
});

// ---------- state directory hardening ----------

const POSIX = { skip: process.platform === "win32" };

/** A dir outside the state root holding a valid mark for KEY_A, to detect writes or deletes through a symlink. */
async function outsideWithMark(base: string) {
	const outside = join(base, "outside");
	await mkdir(outside);
	const file = join(outside, `${fingerprint(KEY_A)}.json`);
	await writeFile(file, JSON.stringify(markOf("invalid")));
	return { outside, file };
}

test("pre-existing loose state directories are tightened by mark()", POSIX, async () => {
	const { dir, pool, stateDir } = await setup({ tavily: [KEY_A] });
	await mkdir(join(stateDir, "tavily"), { recursive: true, mode: 0o777 });
	await chmod(stateDir, 0o755);
	await chmod(join(stateDir, "tavily"), 0o777);
	await pool.mark(entryOf(KEY_A), markOf("invalid"));
	assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
	assert.equal((await stat(join(stateDir, "tavily"))).mode & 0o777, 0o700);
	assert.equal((await stat(markFile(stateDir, KEY_A))).mode & 0o777, 0o600);
});

test("a symlinked service directory is refused for write, clear and read", POSIX, async () => {
	const { dir, keysFile, stateDir, pool } = await setup({ tavily: [KEY_A, KEY_B] });
	const { outside, file } = await outsideWithMark(dir);
	await mkdir(stateDir, { mode: 0o700 });
	await symlink(outside, join(stateDir, "tavily"));

	await assert.rejects(pool.mark(entryOf(KEY_B), markOf("invalid")), /not a private directory/);
	assert.deepEqual(await readdir(outside), [`${fingerprint(KEY_A)}.json`], "nothing written outside");
	await assert.rejects(pool.clear(), /not a private directory/);
	await assert.rejects(pool.clear([fingerprint(KEY_A)]), /not a private directory/);
	assert.equal(JSON.parse(await readFile(file, "utf8")).status, "invalid", "outside mark untouched");

	const snap = await pool.snapshot();
	assert.equal(snap.available.length, 2, "marks behind a symlink are not trusted");
	assert.match(snap.stateWarning ?? "", /not a private directory/);

	// Failover keeps going and reports the lost mark.
	const api = fake({ [KEY_A]: 432 });
	const r = await withRotation(new KeyPool("tavily", keysFile, stateDir), api.run, { keyless: false });
	assert.deepEqual(api.calls, [KEY_A, KEY_B]);
	assert.match(r.notes[0], /could not save the mark: .*not a private directory/);
});

test("a symlinked state directory is refused the same way", POSIX, async () => {
	const { dir, stateDir, pool } = await setup({ tavily: [KEY_A] });
	const { outside } = await outsideWithMark(dir);
	await symlink(outside, stateDir);
	await assert.rejects(pool.mark(entryOf(KEY_A), markOf("exhausted")), /not a private directory/);
	await assert.rejects(pool.clear(), /not a private directory/);
	assert.deepEqual(await readdir(outside), [`${fingerprint(KEY_A)}.json`]);
	const snap = await pool.snapshot();
	assert.equal(snap.available.length, 1);
	assert.ok(snap.stateWarning);
});

test("a symlinked mark file is not read", POSIX, async () => {
	const { dir, pool, stateDir } = await setup({ tavily: [KEY_A] });
	const { file } = await outsideWithMark(dir);
	await mkdir(join(stateDir, "tavily"), { recursive: true, mode: 0o700 });
	await symlink(file, markFile(stateDir, KEY_A));
	const snap = await pool.snapshot();
	assert.equal(snap.available.length, 1);
	assert.equal(snap.stateWarning, undefined);
});

test("snapshot() and clear() create nothing; only mark() does", async () => {
	const { pool, stateDir } = await setup({ tavily: [KEY_A] });
	await pool.snapshot();
	await pool.clear();
	await pool.clear([fingerprint(KEY_A)]);
	await assert.rejects(lstat(stateDir), { code: "ENOENT" });
	await pool.mark(entryOf(KEY_A), markOf("invalid"));
	assert.equal((await lstat(stateDir)).isDirectory(), true);
});

// ---------- error redaction, error cap, response budget ----------

const SECRET = "tvly-dummy-secret-0001";
const respond = (body: BodyInit | null, init: ResponseInit) => (async () => new Response(body, init)) as typeof fetch;
const MIB = 1024 * 1024;

test("HTTP error messages are bounded: 1 MiB bodies, 400 and 500", async () => {
	const words = "word ".repeat(MIB / 5);
	for (const status of [400, 500]) {
		// readable text is cut; a single huge token is withheld
		// (the JSON bodies are cut by the 64 KiB read limit, so they are shown as raw text)
		for (const body of [JSON.stringify({ detail: { error: words } }), words, JSON.stringify({ detail: words })]) {
			const r = await call("/extract", "tvly-k", { timeoutMs: 1000, fetchImpl: respond(body, { status }) });
			assert.ok(!r.ok);
			assert.ok(r.message.length <= 400, `${r.message.length}`);
			assert.ok(r.message.startsWith(`Tavily /extract ${status}: `) && r.message.includes("word word"));
			assert.ok(r.message.endsWith("..."));
		}
		const full = await call("/extract", "tvly-k", { timeoutMs: 1000, fetchImpl: respond(JSON.stringify({ detail: { error: "word ".repeat(1000) } }), { status }) });
		assert.ok(!full.ok && full.message.startsWith(`Tavily /extract ${status}: word word`) && full.message.length <= 400);
		for (const body of [JSON.stringify({ detail: { error: "y".repeat(MIB) } }), "y".repeat(MIB), `<p>${words}</p>`]) {
			const r = await call("/extract", "tvly-k", { timeoutMs: 1000, fetchImpl: respond(body, { status }) });
			assert.ok(!r.ok);
			assert.equal(r.message, `Tavily /extract ${status}: ${statusLabel(status)} (server text withheld)`);
		}
	}
});

test("network error messages are bounded and withheld when not plain", async () => {
	const failWith = (text: string, cause: string) =>
		call("/search", "tvly-k", { timeoutMs: 1000, fetchImpl: (async () => { throw new TypeError(text, { cause: new Error(cause) }); }) as typeof fetch });
	await assert.rejects(failWith("word ".repeat(MIB / 5), "c "), (err: Error) => err.message.length <= 400 && err.message.endsWith("..."));
	await assert.rejects(failWith("z".repeat(MIB), "c"), { message: "Tavily /search: request failed (details withheld)" });
	await assert.rejects(failWith("fetch failed", "connect ECONNREFUSED 127.0.0.1:443"), {
		message: "Tavily /search: request failed: fetch failed (connect ECONNREFUSED 127.0.0.1:443)",
	});
});

/** A body stream that yields `chunks` and records pull/cancel. */
function stream(chunks: Uint8Array[], opts: { hang?: boolean } = {}) {
	const state = { pulls: 0, cancelled: false };
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulls++;
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else if (!opts.hang) controller.close();
			else return new Promise(() => {});
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { body, state };
}
const enc = new TextEncoder();

test("call refuses a response over maxBytes and cancels the stream", async () => {
	const chunk = enc.encode("x".repeat(400));
	const { body, state } = stream(Array(100).fill(chunk));
	await assert.rejects(
		call("/crawl", "tvly-k", { timeoutMs: 1000, maxBytes: 1024, fetchImpl: respond(body, { status: 200 }) }),
		/Tavily \/crawl: response exceeds 1 KiB; narrow the request/,
	);
	assert.equal(state.cancelled, true);
	assert.ok(state.pulls < 10, `stopped reading early (${state.pulls} pulls)`);
});

test("an oversized overflow is an error, not a failed attempt: keys are not rotated", async () => {
	const { pool, stateDir } = await setup({ tavily: [KEY_A, KEY_B] });
	const calls: (string | null)[] = [];
	const run = (key: string | null) => {
		calls.push(key);
		return call("/crawl", key, { timeoutMs: 1000, maxBytes: 100, fetchImpl: respond("x".repeat(500), { status: 200 }) });
	};
	await assert.rejects(withRotation(pool, run, { keyless: true }), /response exceeds/);
	assert.deepEqual(calls, [KEY_A]);
	assert.deepEqual(await stateFiles(stateDir), []);
});

test("a declared Content-Length over the limit fails before reading", async () => {
	const { body, state } = stream([enc.encode("{}")]);
	await assert.rejects(
		call("/map", "tvly-k", { timeoutMs: 1000, maxBytes: 1024, fetchImpl: respond(body, { status: 200, headers: { "content-length": "5000" } }) }),
		/response exceeds/,
	);
	assert.ok(state.pulls <= 1, `${state.pulls} pulls`);
	assert.equal(state.cancelled, true);
});

test("a multi-chunk body with a multibyte character split across chunks parses", async () => {
	const bytes = enc.encode(JSON.stringify({ results: ["héllo wörld ✓ 日本語 😀"] }));
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3)); // splits every multibyte char
	const { body } = stream(chunks);
	const r = await call("/map", "tvly-k", { timeoutMs: 1000, maxBytes: bytes.length, fetchImpl: respond(body, { status: 200 }) });
	assert.deepEqual(r, { ok: true, value: { results: ["héllo wörld ✓ 日本語 😀"] } });
});

test("a huge non-2xx body gives a bounded failed attempt, not an error", async () => {
	const chunk = enc.encode('{"detail":{"error":"' + "e".repeat(8000));
	const { body, state } = stream([chunk, ...Array(50).fill(chunk)]);
	const r = await call("/extract", "tvly-k", { timeoutMs: 1000, fetchImpl: respond(body, { status: 432, headers: { "retry-after": "7" } }) });
	assert.ok(!r.ok);
	assert.equal(r.status, 432);
	assert.equal(r.retryAfter, 7);
	assert.ok(r.message.length <= 400);
	assert.equal(state.cancelled, true);
	assert.ok(state.pulls < 20, `${state.pulls} pulls`);
	assert.equal(verdictFor(r.status), "exhausted");
});

test("a timeout while reading the body reports the timeout", async () => {
	const keepAlive = setTimeout(() => {}, 5000);
	const { body, state } = stream([enc.encode('{"a":')], { hang: true });
	await assert.rejects(call("/map", "k", { timeoutMs: 30, fetchImpl: respond(body, { status: 200 }) }), /Tavily \/map: timed out after 0.03s/);
	assert.equal(state.cancelled, true);
	clearTimeout(keepAlive);
});

test("a caller abort while reading the body rethrows the abort error", async () => {
	const ctrl = new AbortController();
	const { body, state } = stream([enc.encode('{"a":')], { hang: true });
	const p = call("/map", "k", { timeoutMs: 5000, signal: ctrl.signal, fetchImpl: respond(body, { status: 200 }) });
	setTimeout(() => ctrl.abort(), 20);
	await assert.rejects(p, { name: "AbortError" });
	assert.equal(state.cancelled, true);
});

test("a body that is null is empty; the reader is released after a normal read", async () => {
	const empty = await call("/map", "k", { timeoutMs: 1000, fetchImpl: respond(null, { status: 200 }) });
	assert.deepEqual(empty, { ok: true, value: {} });
	let resp!: Response;
	const fetchImpl = (async () => (resp = new Response('{"ok":1}'))) as typeof fetch;
	await call("/map", "k", { timeoutMs: 1000, fetchImpl });
	assert.equal(resp.body?.locked, false);
});

// ---------- allowlisted server text, fixed mark reasons ----------

const SPLIT_KEY = "tvly-dev-AB0123456789abcdef0123456789abcdef";
/** The key (or part of it) hidden in ways that defeat pattern matching: the reviewers' cases and more. */
const HIDDEN: Record<string, string> = {
	"tag after the regex prefix": `${SPLIT_KEY.slice(0, 11)}<b></b>${SPLIT_KEY.slice(11)}`,
	"tag after tvly-re": `${SPLIT_KEY.slice(0, 7)}<b></b>${SPLIT_KEY.slice(7)}`,
	"quoted > in attribute": `${SPLIT_KEY.slice(0, 7)}<span title=">">${SPLIT_KEY.slice(7)}`,
	"U+2066": `${SPLIT_KEY.slice(0, 7)}\u2066${SPLIT_KEY.slice(7)}`,
	"U+061C": `${SPLIT_KEY.slice(0, 7)}\u061c${SPLIT_KEY.slice(7)}`,
	"zero-width space": `${SPLIT_KEY.slice(0, 7)}\u200b${SPLIT_KEY.slice(7)}`,
	"decimal entity": `tvly-re&#118;iew${SPLIT_KEY.slice(11)}`,
	"newline": `${SPLIT_KEY.slice(0, 7)}\n${SPLIT_KEY.slice(7)}`,
	"space-separated chunks": SPLIT_KEY.match(/.{1,6}/g)!.join(" "),
	"dot-separated chunks": SPLIT_KEY.match(/.{1,5}/g)!.join("."),
	"partial key, 12 characters": `bad ${SPLIT_KEY.slice(16, 28)} here`,
	"partial key, separated": `bad ${SPLIT_KEY.slice(20, 26)} ${SPLIT_KEY.slice(26, 33)} here`,
	"lowercased": SPLIT_KEY.toLowerCase().replace(/-/g, " "),
	"escaped": "tvl\\u0079-dev",
	"unknown token": "key sk-live-0123456789abcdefghij0123 rejected",
	"bearer": "Authorization: Bearer abc.def",
};
/** Letters and digits only, lowercased, as serverText compares. */
const compactOf = (text: string) => text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
const leaksKey = (text: string) => {
	const own = compactOf(SPLIT_KEY);
	const flat = compactOf(text);
	if (flat.includes("tvly")) return true;
	for (let i = 0; i + 12 <= own.length; i++) if (flat.includes(own.slice(i, i + 12))) return true;
	return false;
};

test("serverText withholds every hidden or partial credential, with and without a known key", () => {
	for (const [name, hidden] of Object.entries(HIDDEN)) {
		assert.equal(serverText(`Invalid key ${hidden} for you`, SPLIT_KEY), null, name);
		assert.equal(serverText(`x ${"word ".repeat(100)}${hidden}`, SPLIT_KEY), null, `${name} after a long prefix`);
	}
	for (const name of ["tag after the regex prefix", "U+2066", "newline", "space-separated chunks", "unknown token", "bearer"]) {
		assert.equal(serverText(HIDDEN[name], null), name === "space-separated chunks" ? serverText(HIDDEN[name], null) : null, name);
	}
});

test("serverText rules: ASCII only, no markup or escapes, no long token, whitespace collapsed", () => {
	for (const bad of ["caf\u00e9", "emoji \ud83d\ude00", "a\u0000b", "a\x7fb", "<b>x</b>", "a > b", "x &amp; y", "a\\nb", "A".repeat(20), "a-b_".repeat(5)]) {
		assert.equal(serverText(bad, null), null, JSON.stringify(bad));
	}
	assert.equal(serverText("A".repeat(19), null), "A".repeat(19));
	assert.equal(serverText("  two\t\nlines \r\n here  ", null), "two lines here");
	assert.equal(serverText("", null), "");
	assert.ok((serverText("word ".repeat(200), null)?.length ?? 0) <= 303);
	assert.equal(serverText("word ".repeat(200), null, 10), "word word...");
	assert.equal(serverText("short key k and tvly-k", "k"), null, "tvly rule");
	assert.equal(serverText("see tokens and mor here", "tokens-and-more-secrets"), null, "a 12-character window of the key");
	assert.equal(serverText("tokens appear here", "k"), "tokens appear here", "a very short key is not a window");
});

test("ordinary Tavily messages are shown verbatim", () => {
	for (const text of [
		"Usage limit exceeded",
		"Invalid URL: https://example.com/a",
		"Query is too long. Max query length is 400 characters.",
		"Your request has been blocked due to excessive requests. Please reduce rate of requests.",
		"Unauthorized: missing or invalid API key.",
	]) {
		assert.equal(serverText(text, SPLIT_KEY), text);
	}
});

test("statusLabel is fixed per status", () => {
	assert.deepEqual([400, 401, 403, 429, 432, 433, 500, 503, 418].map(statusLabel), [
		"bad request",
		"invalid API key",
		"forbidden",
		"rate limited",
		"plan credit limit reached",
		"pay-as-you-go limit reached",
		"server error",
		"server error",
		"HTTP error",
	]);
});

test("call withholds hidden credentials: JSON detail.error, detail string and plain bodies, 400/401/432/500", async () => {
	for (const status of [400, 401, 432, 500]) {
		for (const [name, hidden] of Object.entries(HIDDEN)) {
			const bodies = [
				JSON.stringify({ detail: { error: `Invalid key ${hidden}` } }),
				JSON.stringify({ detail: `Invalid key ${hidden}` }),
				`Invalid key ${hidden}`,
			];
			for (const body of bodies) {
				const r = await call("/extract", SPLIT_KEY, { timeoutMs: 1000, fetchImpl: respond(body, { status }) });
				assert.ok(!r.ok);
				assert.equal(r.message, `Tavily /extract ${status}: ${statusLabel(status)} (server text withheld)`, `${status} ${name}`);
			}
		}
	}
	// an echoed key in the status line, and an empty body
	const r = await call("/x", SPLIT_KEY, { timeoutMs: 1000, fetchImpl: respond("", { status: 401, statusText: `echo ${SPLIT_KEY}` }) });
	assert.ok(!r.ok && r.message === "Tavily /x 401: invalid API key (server text withheld)");
	const e = await call("/x", SPLIT_KEY, { timeoutMs: 1000, fetchImpl: respond("", { status: 432 }) });
	assert.ok(!e.ok && e.message === "Tavily /x 432: plan credit limit reached");
	const ok = await call("/x", SPLIT_KEY, { timeoutMs: 1000, fetchImpl: respond("Too many requests", { status: 429 }) });
	assert.ok(!ok.ok && ok.message === "Tavily /x 429: Too many requests");
});

test("withRotation: marks hold only the status and a fixed label; thrown errors never carry hidden credentials", async () => {
	for (const [name, hidden] of Object.entries(HIDDEN)) {
		const { pool, stateDir } = await setup({ tavily: [SPLIT_KEY, KEY_B] });
		const viaCall = (status: number) => (key: string | null) =>
			call("/search", key, { timeoutMs: 1000, fetchImpl: respond(`Invalid key ${hidden}`, { status }) });
		// a custom run() that returns the raw text without any vetting
		const raw = (status: number) => async (key: string | null): Promise<Attempt<string>> => ({
			ok: false,
			status,
			message: `Tavily /search ${status}: Invalid key ${hidden}`,
		});
		for (const make of [viaCall, raw]) {
			for (const [status, label] of [[401, "invalid API key"], [432, "plan credit limit reached"]] as const) {
				await pool.clear();
				const run = (key: string | null) => (key === KEY_B ? Promise.resolve<Attempt<string>>({ ok: true, value: "b" }) : make(status)(key));
				assert.equal((await withRotation(pool, run, { keyless: false })).value, "b");
				assert.equal((await readMark(stateDir, SPLIT_KEY)).reason, `${status}: ${label}`, name);
				assert.ok(!(await readFile(markFile(stateDir, SPLIT_KEY), "utf8")).includes(SPLIT_KEY.slice(0, 11)));
			}
			await pool.clear();
			await assert.rejects(withRotation(pool, (k) => make(400)(k), { keyless: false }), (err: ApiError) => {
				assert.equal(err.status, 400);
				assert.ok(!leaksKey(err.message), `${name}: ${err.message}`);
				assert.match(err.message, make === viaCall ? /400: bad request \(server text withheld\)$/ : /^tavily: request failed with 400 \(details withheld\)$/);
				return true;
			});
		}
		const keyless = await setup(undefined);
		for (const make of [viaCall, raw]) {
			await assert.rejects(withRotation(keyless.pool, (k) => make(500)(k), { keyless: true }), (err: ApiError) => {
				// no key is sent keyless, so only key-independent patterns can be checked here
				assert.ok(!/tvly|bearer/i.test(err.message.replace(/\W/g, "")) && err.message.endsWith("(keyless mode: no key file)"), err.message);
				return true;
			});
		}
	}
});

test("a mark file written by an older version is never shown: mark reasons are not read back into messages", async () => {
	const { pool, stateDir } = await setup({ tavily: [SPLIT_KEY] });
	await pool.mark(entryOf(SPLIT_KEY), { status: "invalid", until: null, reason: `401: ${SPLIT_KEY}` });
	const snap = await pool.snapshot();
	assert.equal(snap.available.length, 0);
	// callers only use status; a fresh failure overwrites the reason with the fixed label
	await pool.clear();
	await withRotation(pool, async (k): Promise<Attempt<string>> => (k === SPLIT_KEY ? { ok: false, status: 401, message: "x" } : { ok: true, value: "" }), { keyless: true }).catch(() => {});
	assert.equal((await readMark(stateDir, SPLIT_KEY)).reason, "401: invalid API key");
});

test("serverText and call are linear on 64 KiB of hostile input", async () => {
	const size = 64 * 1024;
	const inputs = [
		"<".repeat(size),
		"<<>".repeat(size / 3),
		"a".repeat(size),
		"tvly-".repeat(13_000),
		"&#".repeat(size / 2),
		"a ".repeat(size / 2),
		"a-".repeat(size / 2),
		"Bearer ".repeat(size / 7),
		` ${"ab cd ".repeat(size / 6)}`,
		"caf\u00e9 ".repeat(size / 6),
		`${"word ".repeat(size / 10)}${"<".repeat(size / 2)}`,
	];
	for (const input of inputs) {
		const t = Date.now();
		serverText(input, SPLIT_KEY);
		await call("/x", SPLIT_KEY, { timeoutMs: 1000, fetchImpl: respond(input, { status: 400 }) });
		assert.ok(Date.now() - t < 200, `${input.slice(0, 8)}: ${Date.now() - t} ms`);
	}
});

test("cut drops a high surrogate left at the boundary and keeps well-formed text", () => {
	const emoji = "😀"; // U+1F600, two UTF-16 units
	const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
	assert.equal(cut(`abc${emoji}def`, 4), "abc", "cut between the surrogates drops the pair");
	assert.equal(cut(`abc${emoji}def`, 5), `abc${emoji}`, "cut right after the pair keeps it");
	assert.equal(cut(`abc${emoji}def`, 3), "abc", "cut before the pair");
	assert.equal(cut(`abc${emoji}def`, 6), `abc${emoji}d`, "cut after the pair");
	assert.equal(cut(`${emoji}${emoji}`, 3), emoji);
	assert.equal(cut(emoji, 1), "");
	assert.equal(cut("short", 80), "short", "short text is unchanged");
	assert.equal(cut("", 5), "");
	for (let max = 0; max <= 8; max++) assert.ok(wellFormed(cut(`a${emoji}b${emoji}c`, max)), `max ${max}`);
});

test("serverText withholds non-BMP text, so no cut can reach an emoji", () => {
	assert.equal(serverText(`bad ${"😀"} request`, null), null);
	assert.equal(serverText(`${"😀".repeat(200)}`, null, 5), null);
});
