import "./isolated-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../extensions/netbird-devices/hub.ts";
import { buildDevices } from "../extensions/netbird-devices/devices.ts";
import { parseSettings } from "../extensions/netbird-devices/settings.ts";
import { fakeSsh } from "./netbird-devices-fake-ssh.ts";

const available = (() => { try { import.meta.resolve("@earendil-works/pi-coding-agent"); import.meta.resolve("typebox"); return true; } catch { return false; } })();

test("review: entry gates here/aliases/IP/symlinks, keeps local execution, journals failures and shuts down on reload", { skip: !available }, async () => {
	const f = fakeSsh();
	const dir = mkdtempSync(join(tmpdir(), "nbd-entry-review-"));
	const saved = process.env.PI_CODING_AGENT_DIR;
	const methods = ["refresh", "devices", "localNames", "connect", "resolveHere", "closeAll"] as const;
	const original = new Map(methods.map((key) => [key, Hub.prototype[key]]));
	try {
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		const home = join(dir, "home"); mkdirSync(join(home, ".ssh"), { recursive: true });
		writeFileSync(join(home, ".ssh/key"), "DO-NOT-LEAK");
		symlinkSync(".ssh/key", join(home, "ordinary"));
		const settings = parseSettings({ devices: { mac: { peer: "100.64.0.1", aliases: ["мак"], mode: "ask" }, linux: { peer: "100.64.0.2", mode: "ro" } } }).settings;
		const devices = buildDevices(settings, []);
		let closed = 0;
		Hub.prototype.refresh = async () => {};
		Hub.prototype.devices = () => devices;
		Hub.prototype.localNames = () => new Set(["vm"]);
		Hub.prototype.connect = async (d) => ({ device: d.name, target: f.target, user: "s", home, probe: { os: "Linux", user: "s", home, sudo: true } });
		Hub.prototype.resolveHere = async () => ({ kind: "found", device: "mac", why: "test" });
		Hub.prototype.closeAll = async () => { closed++; };
		const tools = new Map<string, any>(); const handlers = new Map<string, any>();
		const pi: any = { registerTool: (t: any) => tools.set(t.name, t), registerCommand() {}, registerShortcut() {}, on: (e: string, h: any) => handlers.set(e, h), appendEntry() {} };
		let userMessage = "create the file";
		const ctx: any = { hasUI: false, mode: "print", cwd: dir, ui: { notify() {} }, sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: userMessage } }], getSessionId: () => "review", getSessionFile: () => undefined } };
		const { default: extension } = await import("../extensions/netbird-devices.ts");
		const core = await import("@earendil-works/pi-coding-agent");
		extension(pi);
		// The guard must already work before session_start initialized discovery.
		assert.equal((await handlers.get("tool_call")({ toolName: "bash", input: { command: "ssh mac true" } }, ctx)).block, true);
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		const run = (tool: string, args: any) => tools.get(tool).execute("id", args, undefined, undefined, ctx);
		for (const device of ["mac", "мак", "100.64.0.1", "here"]) {
			await assert.rejects(run("read", { device, path: "~/ordinary" }), /confirmation.*no interactive UI/);
			await assert.rejects(run("bash", { device, command: "cat ~/ordinary" }), /confirmation.*no interactive UI/);
			await assert.rejects(run("read", { device, path: "~/.SSH/../.ssh/key\nname" }), /confirmation.*no interactive UI/);
			await assert.rejects(run("write", { device, path: "~/new/file", content: "change" }), /confirmation.*no interactive UI/);
			await assert.rejects(run("edit", { device, path: "~/ordinary", edits: [{ oldText: "DO-NOT-LEAK", newText: "x" }] }), /confirmation.*no interactive UI/);
			await assert.rejects(run("bash", { device, command: "sed -n '1e touch marker' file" }), /confirmation.*no interactive UI/);
		}
		await assert.rejects(run("write", { device: "linux", path: "~/new/file", content: "change" }), /read-only/);
		await assert.rejects(run("bash", { device: "unknown", command: "touch marker" }), /Unknown device/);
		const odd = "it's $(touch marker)\nfile"; writeFileSync(join(home, odd), "safe");
		assert.equal((await run("read", { device: "mac", path: `~/${odd}`, command: "touch marker" })).content[0].text, "safe");
		// No native/system dialog or command can run without UI, even in full.
		devices[0].settings.mode = "full";
		const before = f.calls().length;
		await assert.rejects(run("bash", { device: "mac", command: "sudo true" }), /requires an interactive UI/);
		assert.equal(f.calls().length, before);
		const failed = await run("bash", { device: "mac", command: "exit 3" });
		assert.equal(failed.isError, true);
		const log = readFileSync(join(dir, "agent/netbird-devices/log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(log.at(-1).ok, false); assert.equal(log.at(-1).detail, "exit 3");
		assert.ok(!JSON.stringify(log).includes("DO-NOT-LEAK"));
		// Cached auto approval must not survive a new, contradictory user message.
		devices[0].settings.mode = "auto";
		let classifications = 0;
		ctx.modelRegistry = { find: () => ({}), streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ decision: ++classifications === 1 ? "allow" : "deny", reason: "user intent" }) }] }) }) };
		const change = { device: "mac", command: `touch '${join(dir, "approved")}'` };
		await run("bash", change);
		userMessage = "do not touch that file";
		await assert.rejects(run("bash", change), /refused by the auto-mode classifier/);
		assert.equal(classifications, 2);
		const localFile = join(dir, "local.txt"); writeFileSync(localFile, "local\n");
		for (const device of [undefined, "local", "vm"]) {
			assert.deepEqual(await run("read", { path: localFile, device }), await core.createReadToolDefinition(dir).execute("id", { path: localFile }, undefined, undefined, ctx));
		}
		const edit = { path: localFile, edits: [{ oldText: "local", newText: "LOCAL" }] };
		const expected = await core.createEditToolDefinition(dir).execute("id", edit, undefined, undefined, ctx);
		writeFileSync(localFile, "local\n");
		assert.deepEqual(await run("edit", edit), expected);
		const write = { path: localFile, content: "new" };
		assert.deepEqual(await run("write", write), await core.createWriteToolDefinition(dir).execute("id", write, undefined, undefined, ctx));
		const localBash = await core.createBashToolDefinition(dir).execute("id", { command: "printf local" }, undefined, undefined, ctx);
		const wrappedBash = await run("bash", { command: "printf local" });
		assert.deepEqual(wrappedBash.content, localBash.content);
		// RPC confirmation is cancellable too; shutdown must settle the dialog and
		// must not let the write continue after confirmation was abandoned.
		devices[0].settings.mode = "ask"; ctx.hasUI = true; ctx.mode = "rpc";
		let shown!: () => void; const opened = new Promise<void>((resolve) => { shown = resolve; });
		let dialogSignal: AbortSignal | undefined;
		ctx.ui.select = (_title: string, _choices: string[], { signal }: { signal: AbortSignal }) => new Promise((resolve) => {
			dialogSignal = signal; shown(); signal.addEventListener("abort", () => resolve(undefined), { once: true });
		});
		const pending = assert.rejects(run("write", { device: "mac", path: join(dir, "denied"), content: "x" }), /denied by user|Operation aborted/);
		await opened;
		await handlers.get("session_shutdown")({ reason: "reload" }, ctx);
		await pending;
		assert.equal(dialogSignal?.aborted, true);
		assert.throws(() => readFileSync(join(dir, "denied")), /ENOENT/);
		ctx.hasUI = false; ctx.mode = "print";
		await handlers.get("session_start")({ reason: "reload" }, ctx);
		for (const reason of ["reload", "new", "quit"]) {
			await handlers.get("session_shutdown")({ reason }, ctx);
			assert.equal((globalThis as any).__piNetbirdDevicesGuard, undefined);
			if (reason !== "quit") await handlers.get("session_start")({ reason }, ctx);
		}
		assert.equal(closed, 4);
	} finally {
		for (const [key, value] of original) (Hub.prototype as any)[key] = value;
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
		delete (globalThis as any).__piNetbirdDevicesGuard;
		rmSync(f.dir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
	}
});
