// Pure helpers of the device tools and the operations that run on a device (fake ssh).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDevices } from "../extensions/netbird-devices/devices.ts";
import { parseNetbirdSshConfig } from "../extensions/netbird-devices/discovery.ts";
import { BASH_DEFAULT_TIMEOUT_S, type Conn, createBashOps, createEditOps, createReadOps, createWriteOps } from "../extensions/netbird-devices/remote-ops.ts";
import { parseSettings } from "../extensions/netbird-devices/settings.ts";
import { SshError } from "../extensions/netbird-devices/ssh.ts";
import { deviceListHint, deviceRows, displayArgs, guardReason, imageMimeFromPath, isRemoteArg, osLabel, parseDeviceArg, earlyRefusal, remoteAction } from "../extensions/netbird-devices/tools.ts";
import { fakeSsh } from "./netbird-devices-fake-ssh.ts";

const CONF = `Match host "100.71.171.69,sergeys-macbook-pro.netbird.cloud,sergeys-macbook-pro"
Match host "100.71.201.21,personal-project-nl.netbird.cloud,personal-project-nl"
`;
const devices = (settings: unknown = undefined) => buildDevices(parseSettings(settings).settings, parseNetbirdSshConfig(CONF), ["cloudcli"]);
const LOCAL = new Set(["cloudcli", "old-man", "100.71.73.147"]);

// --- device argument ---------------------------------------------------------------------------

test("parseDeviceArg: local, here, devices by name/alias/peer/ip, errors with hints", () => {
	const ds = devices();
	for (const a of [undefined, null, "", "  ", "local", "This", "localhost", "cloudcli", "OLD-MAN", "100.71.73.147"]) assert.deepEqual(parseDeviceArg(a, ds, LOCAL), { kind: "local" }, String(a));
	assert.deepEqual(parseDeviceArg(" Here ", ds, LOCAL), { kind: "here" });
	for (const a of ["mac", "MAC", "sergeys-macbook-pro", "sergeys-macbook-pro.netbird.cloud", "100.71.171.69"]) {
		const r = parseDeviceArg(a, ds, LOCAL);
		assert.equal(r.kind, "device", a);
		assert.equal((r as any).device.name, "sergeys-macbook-pro");
	}
	const unknown = parseDeviceArg("nosuch", ds, LOCAL);
	assert.equal(unknown.kind, "error");
	assert.match((unknown as any).message, /Unknown device "nosuch".*mac \(sergeys-macbook-pro\), personal-project-nl.*devices tool/);
	assert.equal(parseDeviceArg(5, ds, LOCAL).kind, "error");
	// a peer that NetBird SSH does not list cannot be used
	const noSsh = buildDevices(parseSettings(undefined).settings, [{ name: "work-pc", ips: ["100.71.5.5"], sshEnabled: false }], []);
	const r = parseDeviceArg("work-pc", noSsh, LOCAL);
	assert.equal(r.kind, "error");
	assert.match((r as any).message, /NetBird SSH is not enabled/);
	assert.equal(deviceListHint([]), "none with NetBird SSH enabled");
});

test("isRemoteArg: only a non-empty name that is not this machine", () => {
	assert.equal(isRemoteArg("mac", LOCAL), true);
	assert.equal(isRemoteArg("here", LOCAL), true);
	for (const a of [undefined, null, "", " ", "local", "cloudcli", 5]) assert.equal(isRemoteArg(a, LOCAL), false, String(a));
});

// --- actions and early refusals -------------------------------------------------------------------

const AI = (over: Record<string, unknown>) => ({ tool: "bash", home: "/Users/sergey", globs: ["~/.ssh/**", "**/.env"], ...over }) as any;

test("remoteAction: read/write/bash actions with the protected glob they touch", () => {
	assert.deepEqual(remoteAction(AI({ tool: "read", path: "/Users/sergey/a" })), { action: { kind: "read", path: "/Users/sergey/a" }, protectedHit: undefined });
	assert.equal(remoteAction(AI({ tool: "read", path: "/Users/sergey/.ssh/id_rsa" })).protectedHit, "~/.ssh/**");
	const w = remoteAction(AI({ tool: "edit", path: "/Users/sergey/p/.env", diff: "+x", isNew: false }));
	assert.deepEqual(w.action, { kind: "write", path: "/Users/sergey/p/.env", diff: "+x", isNew: false });
	assert.equal(w.protectedHit, "**/.env");
	const b = remoteAction(AI({ command: "cat $HOME/.ssh/id_rsa" }));
	assert.equal(b.protectedHit, "~/.ssh/**");
	assert.deepEqual(remoteAction(AI({ command: "sudo systemctl restart nginx" })).action, { kind: "bash", command: "systemctl restart nginx", root: true });
});

test("earlyRefusal: ro refuses write/edit/root; the rest goes on to the dialogs", () => {
	assert.match(earlyRefusal(AI({ tool: "write", path: "/Users/sergey/a" }), "ro", "mac")!, /^mac: write refused: device is read-only/);
	assert.match(earlyRefusal(AI({ tool: "edit", path: "/Users/sergey/a" }), "ro", "mac")!, /edit refused/);
	assert.match(earlyRefusal(AI({ command: "sudo ls" }), "ro", "mac")!, /root command refused: .*read-only/);
	assert.equal(earlyRefusal(AI({ command: "sudo ls" }), "ask", "mac"), undefined);
	for (const mode of ["ro", "ask", "auto", "full"] as const) {
		assert.equal(earlyRefusal(AI({ tool: "read", path: "/Users/sergey/.ssh/id_rsa" }), mode, "mac"), undefined);
		assert.equal(earlyRefusal(AI({ command: "ls ~" }), mode, "mac"), undefined);
	}
	assert.equal(earlyRefusal(AI({ tool: "write", path: "/Users/sergey/a" }), "ask", "mac"), undefined);
});

// --- rendering / files -----------------------------------------------------------------------------

test("displayArgs: device prefix for the built-in renderers, edits dropped for edit, local calls untouched", () => {
	const remote = (d: unknown) => isRemoteArg(d, LOCAL);
	assert.deepEqual(displayArgs("read", { path: "~/a.txt", device: "mac", offset: 2 }, remote), { path: "mac:~/a.txt", device: "mac", offset: 2 });
	assert.deepEqual(displayArgs("write", { path: "~/a", content: "x", device: "mac" }, remote), { path: "mac:~/a", content: "x", device: "mac" });
	const e = displayArgs("edit", { path: "~/a", edits: [{ oldText: "a", newText: "b" }], device: "mac" }, remote) as any;
	assert.equal(e.path, "mac:~/a");
	assert.equal(e.edits, undefined);
	assert.deepEqual(displayArgs("bash", { command: "ls", device: "here", timeout: 5 }, remote), { command: "[here] ls", device: "here", timeout: 5 });
	for (const a of [{ path: "/x" }, { path: "/x", device: "local" }, { path: "/x", device: "cloudcli" }, { path: "/x", device: "" }]) {
		assert.equal(displayArgs("read", a, remote), a);
	}
	assert.equal(displayArgs("read", undefined, remote), undefined);
	assert.deepEqual(displayArgs("read", { path: 5, device: "mac" }, remote), { path: 5, device: "mac" });
});

test("imageMimeFromPath and osLabel", () => {
	assert.equal(imageMimeFromPath("/a/Screenshot 1.PNG"), "image/png");
	assert.equal(imageMimeFromPath("/a/b.jpeg"), "image/jpeg");
	assert.equal(imageMimeFromPath("/a/b.jpg"), "image/jpeg");
	assert.equal(imageMimeFromPath("/a/b.webp"), "image/webp");
	assert.equal(imageMimeFromPath("/a/b.gif"), "image/gif");
	assert.equal(imageMimeFromPath("/a/b.bmp"), "image/bmp");
	assert.equal(imageMimeFromPath("/a/b.txt"), null);
	assert.equal(imageMimeFromPath("/a/png"), null);
	assert.equal(osLabel({ os: "Darwin", osver: "macOS 27.0", arch: "arm64" }), "macOS 27.0 arm64");
	assert.equal(osLabel({ os: "Linux", arch: undefined, osver: undefined }), "Linux");
	assert.equal(osLabel(undefined), undefined);
});

test("deviceRows: local row first, short labels, probe data, online", () => {
	const ds = devices();
	const rows = deviceRows({
		devices: ds,
		probes: { "sergeys-macbook-pro": { os: "Darwin", osver: "macOS 27.0", arch: "arm64", user: "sergey", home: "/Users/sergey", sudo: true } },
		users: {},
		online: new Map([["sergeys-macbook-pro", true]]),
		modeOf: () => "ask",
		localName: "cloudcli",
		labelOf: (d) => d.aliases[0] ?? d.name,
	});
	assert.deepEqual(rows[0], { name: "cloudcli", local: true });
	assert.deepEqual(rows[1], { name: "mac", peer: "sergeys-macbook-pro", os: "macOS 27.0 arm64", user: "sergey", online: true, ssh: true, mode: "ask" });
	assert.equal(rows[2].name, "personal-project-nl");
	assert.equal(rows[2].peer, undefined);
	assert.equal(rows[2].online, undefined);
});

test("guardReason names the device alias, or sends unknown NetBird addresses to the devices tool", () => {
	const ds = devices();
	assert.match(guardReason("sergeys-macbook-pro", ds), /device: "mac"/);
	assert.match(guardReason("100.71.171.69", ds), /device: "mac"/);
	assert.match(guardReason("100.71.99.99", ds), /devices tool/);
});

// --- operations on a device (fake ssh) ---------------------------------------------------------------

function conn(over: { path?: string } = {}) {
	const f = fakeSsh({ users: ["sergey"] });
	const home = mkdtempSync(join(tmpdir(), "nbd-home-"));
	const c: Conn = { device: "mac", target: f.target, user: "sergey", home, probe: { os: "Linux", user: "sergey", home, sudo: false, path: over.path } };
	return { f, c, home, cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(f.dir, { recursive: true, force: true }); } };
}

test("read ops: file, missing file, name variants (U+202F before PM) with the check applied to the real name", async () => {
	const { c, home, cleanup } = conn();
	try {
		writeFileSync(join(home, "a.txt"), "hello\n");
		const ops = createReadOps(c);
		await ops.access(join(home, "a.txt"));
		assert.equal((await ops.readFile(join(home, "a.txt"))).toString(), "hello\n");
		await assert.rejects(ops.access(join(home, "nope.txt")), (e: SshError) => e.code === "ENOENT");
		assert.equal(await ops.detectImageMimeType(join(home, "x.PNG")), "image/png");
		assert.equal(await ops.detectImageMimeType(join(home, "a.txt")), null);

		const shot = join(home, "Screenshot at 1.23.45\u202FPM.png");
		writeFileSync(shot, "PNGDATA");
		const asked = join(home, "Screenshot at 1.23.45 PM.png");
		const seen: string[] = [];
		const withCheck = createReadOps(c, (p) => seen.push(p));
		await withCheck.access(asked);
		assert.deepEqual(seen, [asked, shot]);
		assert.equal((await withCheck.readFile(asked)).toString(), "PNGDATA");
		assert.equal(await withCheck.detectImageMimeType(asked), "image/png");

		const pinned = createReadOps(c, undefined, undefined, join(home, "a.txt"));
		await pinned.access(join(home, "local-only-variant.txt"));
		assert.equal((await pinned.readFile(join(home, "local-only-variant.txt"))).toString(), "hello\n", "local fallback cannot change the requested remote filename");

		const refusing = createReadOps(c, () => {
			throw new Error("protected");
		});
		await assert.rejects(refusing.access(asked), /protected/);
	} finally {
		cleanup();
	}
});

test("write ops: parents created only by writeFile (mkdir is a no-op), edit ops: access rw, read, write", async () => {
	const { c, home, cleanup } = conn();
	try {
		const w = createWriteOps(c);
		const file = join(home, "deep", "dir", "x.txt");
		await w.mkdir(join(home, "deep", "dir"));
		assert.equal(existsSync(join(home, "deep")), false, "no directory before the write is confirmed");
		await w.writeFile(file, "päivää\n");
		assert.equal(readFileSync(file, "utf8"), "päivää\n");
		const e = createEditOps(c);
		await e.access(file);
		assert.equal((await e.readFile(file)).toString(), "päivää\n");
		await e.writeFile(file, "changed\n");
		assert.equal(readFileSync(file, "utf8"), "changed\n");
		await assert.rejects(e.access(join(home, "missing")), (er: SshError) => er.code === "ENOENT");
	} finally {
		cleanup();
	}
});

test("bash ops: output streams, exit code, runs in the device home with bash; stdin is empty", async () => {
	const { c, cleanup } = conn({ path: "/usr/bin:/bin" });
	try {
		const ops = createBashOps(c);
		const out: string[] = [];
		const r = await ops.exec("pwd; echo $BASH_VERSION | cut -c1; echo $PATH; echo err >&2; cat; exit 3", "/local/cwd/ignored", { onData: (d) => out.push(d.toString()) });
		assert.equal(r.exitCode, 3);
		const text = out.join("");
		assert.ok(text.startsWith(`${process.env.HOME}\n`), text); // the fake runs on this machine: the "device home" is $HOME
		assert.ok(text.includes("/usr/bin:/bin\n"));
		assert.ok(text.includes("err\n"));
		assert.ok(!text.includes("/local/cwd"), "the local cwd means nothing on the device");
		assert.equal((await ops.exec("true", "/x", { onData() {} })).exitCode, 0);
	} finally {
		cleanup();
	}
});

test("bash ops: timeout, abort, connection errors", async () => {
	const { c, cleanup } = conn();
	try {
		const ops = createBashOps(c);
		await assert.rejects(ops.exec("sleep 5", "/x", { onData() {}, timeout: 1 }), /^Error: timeout:1$/);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 200);
		await assert.rejects(ops.exec("sleep 5", "/x", { onData() {}, signal: ac.signal }), /^Error: aborted$/);
		assert.ok(BASH_DEFAULT_TIMEOUT_S >= 600);
		// a refused login is an SshError with the usual advice
		const bad = createBashOps({ ...c, user: "mallory", target: { ...c.target, user: "mallory" } });
		await assert.rejects(bad.exec("true", "/x", { onData() {} }), (e: SshError) => e.kind === "auth" && /\/nb user mac/.test(e.message));
	} finally {
		cleanup();
	}
});
