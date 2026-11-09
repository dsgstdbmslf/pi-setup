import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { call, compact, credits, plain } from "../extensions/tavily/client.ts";
import { cleanupSaved, ensurePrivateDir, plural, sanitize, saveFull } from "../extensions/tavily/output.ts";

async function setup(keys: unknown) {
	const dir = await mkdtemp(join(tmpdir(), "ws-test-"));
	const keysFile = join(dir, "api-keys.json");
	if (keys !== undefined) await writeFile(keysFile, JSON.stringify(keys), { mode: 0o600 });
	const stateFile = join(dir, "api-keys-state.json");
	return { dir, keysFile, stateFile, pool: new KeyPool("tavily", keysFile, stateFile) };
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
	const { pool, stateFile } = await setup({ tavily: [{ key: "tvly-first-000000", label: "a" }, { key: "tvly-second-00000", label: "b" }] });
	const api = fake({ "tvly-first-000000": 432 });
	const notes: string[] = [];
	const r = await withRotation(pool, api.run, { keyless: true, onNote: (n) => notes.push(n) });
	assert.equal(r.value, "via tvly-second-00000");
	assert.equal(r.via, "b");
	assert.deepEqual(api.calls, ["tvly-first-000000", "tvly-second-00000"]);
	assert.match(notes[0], /"a" exhausted \(432\)/);

	const state = await readFile(stateFile, "utf8");
	assert.ok(!state.includes("tvly-"), "state file must not contain keys");
	assert.equal(JSON.parse(state).tavily[fingerprint("tvly-first-000000")].status, "exhausted");
	assert.equal((await stat(stateFile)).mode & 0o777, 0o600);

	const api2 = fake({});
	await withRotation(new KeyPool("tavily", pool.keysFile, stateFile), api2.run, { keyless: true });
	assert.deepEqual(api2.calls, ["tvly-second-00000"], "a fresh pool reads the exhausted mark from disk");
});

test("failover: exhausted mark expires at the next month", async () => {
	const { keysFile, stateFile } = await setup({ tavily: ["tvly-first-000000"] });
	let now = Date.UTC(2026, 4, 20);
	const pool = new KeyPool("tavily", keysFile, stateFile, () => now);
	await withRotation(pool, fake({ "tvly-first-000000": 432 }).run, { keyless: true, now: () => now });
	assert.equal((await pool.snapshot()).available.length, 0);
	now = Date.UTC(2026, 5, 1, 0, 0, 1);
	assert.equal((await pool.snapshot()).available.length, 1);
});

test("failover: invalid key is permanent, rate limit only in memory until Retry-After", async () => {
	const { keysFile, stateFile } = await setup({ tavily: ["tvly-bad-0000000", "tvly-busy-000000", "tvly-ok-00000000"] });
	let now = 1_000_000;
	const pool = new KeyPool("tavily", keysFile, stateFile, () => now);
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
	const disk = JSON.parse(await readFile(stateFile, "utf8")).tavily;
	assert.deepEqual(Object.values(disk).map((m: any) => m.status), ["invalid"]);
	now += 11_000;
	assert.deepEqual((await pool.snapshot()).available.map((e) => e.key), ["tvly-busy-000000", "tvly-ok-00000000"]);
});

test("failover: other errors do not switch keys or mark anything", async () => {
	const { pool, stateFile } = await setup({ tavily: ["tvly-first-000000", "tvly-second-00000"] });
	const api = fake({ "tvly-first-000000": 500 });
	await assert.rejects(withRotation(pool, api.run, { keyless: true }), (err: ApiError) => err.status === 500);
	assert.deepEqual(api.calls, ["tvly-first-000000"]);
	await assert.rejects(readFile(stateFile, "utf8"), { code: "ENOENT" });
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

test("rate-limit marks are shared by pools of the same state file, not of others", async () => {
	// Each pi extension gets its own KeyPool; a 429 seen by one must be skipped by the others.
	const { keysFile, stateFile } = await setup({ tavily: ["tvly-shared-00000", "tvly-other-000000"] });
	const run = async (key: string | null): Promise<Attempt<string>> =>
		key === "tvly-shared-00000" ? { ok: false, status: 429, message: "busy", retryAfter: 60 } : { ok: true, value: String(key) };
	await withRotation(new KeyPool("tavily", keysFile, stateFile), run, { keyless: false });
	const sibling = new KeyPool("tavily", keysFile, stateFile);
	assert.deepEqual((await sibling.snapshot()).available.map((e) => e.key), ["tvly-other-000000"]);
	const elsewhere = await setup({ tavily: ["tvly-shared-00000"] });
	assert.equal((await elsewhere.pool.snapshot()).available.length, 1, "another state file has its own marks");
	await sibling.clear();
	assert.equal((await new KeyPool("tavily", keysFile, stateFile).snapshot()).available.length, 2);
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
	assert.deepEqual((await new KeyPool("tavily", keysFile, join(tmpdir(), "x-state.json")).snapshot()).malformed, malformed);
});

test("call redacts the key from fetch errors and drops the cause", async () => {
	const key = "tvly-dummy-secret-0001";
	const fetchImpl = (async () => {
		throw new TypeError(`Headers.append: "Bearer ${key}" is an invalid header value.`, {
			cause: new Error(`inner ${key}`),
		});
	}) as typeof fetch;
	await assert.rejects(call("/search", key, { timeoutMs: 1000, fetchImpl }), (err: Error) => {
		assert.ok(!err.message.includes(key));
		assert.ok(!err.message.includes("tvly-dummy"));
		assert.match(err.message, /^Tavily \/search: request failed: .*\[redacted\]/);
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

async function leftovers(dir: string) {
	return (await readdir(dir)).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));
}

test("concurrent marks in one pool keep both marks and leave no tmp or lock files", async () => {
	for (let i = 0; i < 20; i++) {
		const { dir, pool, stateFile } = await setup({ tavily: [KEY_A, KEY_B] });
		await Promise.all([pool.mark(entryOf(KEY_A), markOf("exhausted")), pool.mark(entryOf(KEY_B), markOf("invalid"))]);
		const disk = JSON.parse(await readFile(stateFile, "utf8")).tavily;
		assert.deepEqual(Object.keys(disk).sort(), [fingerprint(KEY_A), fingerprint(KEY_B)].sort());
		assert.deepEqual(await leftovers(dir), []);
	}
});

test("concurrent marks from different pools of one state file are both kept", async () => {
	const { dir, keysFile, stateFile } = await setup({ tavily: [KEY_A, KEY_B] });
	const p1 = new KeyPool("tavily", keysFile, stateFile);
	const p2 = new KeyPool("tavily", keysFile, stateFile);
	await Promise.all([p1.mark(entryOf(KEY_A), markOf("exhausted")), p2.mark(entryOf(KEY_B), markOf("invalid"))]);
	assert.equal(Object.keys(JSON.parse(await readFile(stateFile, "utf8")).tavily).length, 2);
	assert.deepEqual(await leftovers(dir), []);
});

test("a mark racing a clear of another key is kept", async () => {
	const { dir, pool, stateFile } = await setup({ tavily: [KEY_A, KEY_B] });
	await pool.mark(entryOf(KEY_B), markOf("invalid"));
	await Promise.all([pool.mark(entryOf(KEY_A), markOf("exhausted")), pool.clear([fingerprint(KEY_B)])]);
	assert.deepEqual(Object.keys(JSON.parse(await readFile(stateFile, "utf8")).tavily), [fingerprint(KEY_A)]);
	assert.deepEqual(await leftovers(dir), []);
});

test("a stale lock file is broken", async () => {
	const { dir, pool, stateFile } = await setup({ tavily: [KEY_A] });
	const lock = `${stateFile}.lock`;
	await writeFile(lock, "");
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	await pool.mark(entryOf(KEY_A), markOf("invalid"));
	assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tavily[fingerprint(KEY_A)].status, "invalid");
	assert.deepEqual(await leftovers(dir), []);
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
	const { keysFile, stateFile } = await setup({ tavily: [KEY_A, KEY_B, "tvly-cccc-0000000"] });
	let now = 1_000_000;
	const pool = new KeyPool("tavily", keysFile, stateFile, () => now);
	const bucket = (globalThis as any)[Symbol.for("pi-setup.tavily.cooling")].get(`${stateFile}\0tavily`) as Map<string, unknown>;
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
