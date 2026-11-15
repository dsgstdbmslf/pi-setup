import "./isolated-env.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isReadOnlyCommand } from "../extensions/netbird-devices/policy.ts";
import { isSafeReadOnlyGit, rewriteReadOnlyGit } from "../extensions/netbird-devices/safe-git.ts";
import { createBashOps, type Conn } from "../extensions/netbird-devices/remote-ops.ts";
import { shq } from "../extensions/netbird-devices/remote.ts";
import { runRoot } from "../extensions/netbird-devices/root.ts";
import { stripSshNoise } from "../extensions/netbird-devices/ssh.ts";
import { confirmBody, confirmTitle } from "../extensions/netbird-devices/ui-text.ts";
import { fakeSsh } from "./netbird-devices-fake-ssh.ts";

const SAFE = [
	"git status", "git status --short --branch", "git status --porcelain=v2 -uno",
	"git log", "git log --oneline -5", "git log -n 2 --since 'yesterday'", "git log --graph --all --stat",
	"git diff", "git diff --cached --name-only", "git diff HEAD~1 -- file.txt", "git diff -U3 --no-ext-diff --no-textconv",
	"git show HEAD", "git show HEAD:file.txt", "git show --pretty=fuller --stat HEAD",
	"git branch", "git branch --list", "git branch -a -r -v", "git branch -av", "git branch --show-current",
	"git rev-parse --show-toplevel", "git rev-parse --verify HEAD", "git ls-files --stage --cached",
	"git -C '/repo with spaces' status", "git -C ~/proj -C nested diff", "/usr/bin/git -C /repo log -2",
];
const UNSAFE = [
	"git status | head", "git status && echo done", "git status; touch x", "git status\ntrue", "git status > out",
	"git -c core.fsmonitor=evil status", "git --config-env=core.pager=X log", "git --exec-path=/tmp log", "git -C /repo -c x=y status",
	"git diff --output=x", "git diff --out=x", "git diff --output x", "git diff --ext-diff", "git diff --textconv", "git diff --no-index a b",
	"git log --show-signature", "git log --format=%G?", "git show --pretty=format:%G?", "git show --output=x", "git log --upload-pack=evil",
	"git branch new", "git branch -a new", "git branch -d old", "git branch -D old", "git branch -m x", "git branch -l new", "git branch --edit-description",
	"git tag", "git config --get core.pager", "git fetch", "git checkout main", "git -C $(touch marker) status", "git -C ~other status", "git -C '$HOME' status",
	"PATH=/tmp git status", "/tmp/git status", "command git status", "git status # comment", "git diff -- *.ts", "git status \\\ntrue", "git diff -- ~/file",
];

test("safe Git: one narrow parser drives read-only policy and the execution rewrite", () => {
	for (const command of SAFE) {
		assert.equal(isSafeReadOnlyGit(command), true, command);
		assert.equal(isReadOnlyCommand(command), true, command);
		const rewritten = rewriteReadOnlyGit(command, "/Users/s");
		assert.ok(rewritten?.includes("core.fsmonitor=false"), command);
		assert.ok(rewritten?.includes("GIT_CONFIG_NOSYSTEM=1"), command);
	}
	for (const command of UNSAFE) {
		assert.equal(isSafeReadOnlyGit(command), false, command);
		assert.equal(isReadOnlyCommand(command), false, command);
		assert.equal(rewriteReadOnlyGit(command, "/Users/s"), undefined, command);
	}
});

test("safe Git: real repository helpers, filters, hostile env and writable PATH never run", async () => {
	const dir = mkdtempSync(join(tmpdir(), "nbd-git-safe-"));
	const f = fakeSsh();
	try {
		const home = join(dir, "home"), repo = join(dir, "repo"), bin = join(dir, "bin");
		mkdirSync(home); mkdirSync(bin);
		const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git("init", "-q", repo);
		git("-C", repo, "config", "user.name", "test"); git("-C", repo, "config", "user.email", "test@example.invalid");
		writeFileSync(join(repo, "file.txt"), "original\n");
		writeFileSync(join(repo, ".gitattributes"), "file.txt diff=evil filter=evil\n");
		git("-C", repo, "add", "."); git("-C", repo, "commit", "-qm", "initial");
		writeFileSync(join(repo, "file.txt"), "changed\n");
		const noFilters = spawnSync("/bin/bash", ["-c", rewriteReadOnlyGit(`git -C ${shq(repo)} status --short`, home)!], { env, encoding: "utf8" });
		assert.equal(noFilters.status, 0, noFilters.stderr); // config --get-regexp exits 1 when no filter keys exist
		const marker = join(dir, "helper-ran");
		const helper = join(dir, "evil-helper");
		writeFileSync(helper, `#!/bin/sh\nprintf 'helper\\n' >> ${shq(marker)}\nexit 0\n`, { mode: 0o755 });
		writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'PATH git\\n' >> ${shq(marker)}\nexit 99\n`, { mode: 0o755 });
		for (const key of ["core.pager", "core.fsmonitor", "diff.external", "diff.evil.command", "diff.evil.textconv", "credential.helper", "filter.evil.clean", "filter.evil.smudge", "filter.evil.process", "gpg.program"]) git("-C", repo, "config", key, helper);
		git("-C", repo, "config", "filter.evil.required", "true");
		git("-C", repo, "config", "pager.status", "true"); git("-C", repo, "config", "log.showSignature", "true");
		// Positive control: this is a real executable fsmonitor configuration,
		// not merely inert strings in a test fixture.
		spawnSync("/usr/bin/git", ["-C", repo, "status", "--short"], { env, encoding: "utf8", timeout: 5000 });
		assert.equal(existsSync(marker), true, "unsafe Git invoked a configured helper");
		rmSync(marker);
		const index = join(repo, ".git/index"), oldIndex = readFileSync(index), oldTime = statSync(index).mtimeMs;
		const trace = join(dir, "trace");
		for (const tail of ["status --short", "log --oneline -2", "diff", "show HEAD", "show HEAD:file.txt", "branch --list", "branch -a -r -v", "branch --show-current", "rev-parse --show-toplevel", "ls-files --stage"]) {
			const rewrite = rewriteReadOnlyGit(`git -C ${shq(repo)} ${tail}`, home)!;
			const r = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", rewrite], { encoding: "utf8", timeout: 5000, env: {
				...env, PATH: `${bin}:/usr/bin:/bin`, GIT_EXTERNAL_DIFF: helper, GIT_PAGER: helper, PAGER: helper,
				GIT_TRACE: trace, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: helper,
			} });
			assert.equal(r.status, 0, `${tail}: ${r.stderr}`);
			if (tail === "diff") assert.match(r.stdout, /\+changed/);
			if (tail === "show HEAD:file.txt") assert.equal(r.stdout, "original\n");
			if (tail.startsWith("log")) assert.match(r.stdout, /initial/);
			assert.equal(existsSync(marker), false, tail);
			assert.equal(existsSync(trace), false, "Git tracing env removed");
		}
		assert.deepEqual(readFileSync(index), oldIndex); assert.equal(statSync(index).mtimeMs, oldTime, "no optional index refresh writes");
		// Verify the remote operations actually use the rewrite, not just policy recognition.
		const c = { device: "test", target: f.target, home, user: "s", probe: { os: "Linux", home, user: "s", sudo: false, path: `${bin}:/usr/bin:/bin` } } as Conn;
		const output: string[] = [];
		assert.equal((await createBashOps(c).exec(`git -C ${shq(repo)} diff`, "/ignored", { onData: (b) => output.push(b.toString()) })).exitCode, 0);
		assert.match(output.join(""), /\+changed/); assert.equal(existsSync(marker), false);
		// Tilde -C is expanded from the device home, quoted ~ stays literal.
		const tilde = rewriteReadOnlyGit("git -C ~/../repo rev-parse --show-toplevel", home)!;
		assert.equal(spawnSync("/bin/bash", ["-c", tilde], { env, encoding: "utf8" }).stdout.trim(), repo);
		// A partial clone must not launch a transport/credential helper to fetch
		// missing data implicitly, nor create FETCH_HEAD as a side effect.
		const blob = git("-C", repo, "rev-parse", "HEAD:file.txt").trim();
		git("-C", repo, "config", "core.repositoryformatversion", "1");
		git("-C", repo, "config", "extensions.partialClone", "origin");
		git("-C", repo, "config", "remote.origin.promisor", "true");
		git("-C", repo, "config", "remote.origin.url", `ext::${helper}`);
		git("-C", repo, "config", "protocol.ext.allow", "always");
		rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
		const missing = spawnSync("/bin/bash", ["-c", rewriteReadOnlyGit(`git -C ${shq(repo)} show HEAD:file.txt`, home)!], { env, encoding: "utf8", timeout: 5000 });
		assert.notEqual(missing.status, 0); assert.equal(existsSync(marker), false, missing.stderr);
		assert.equal(existsSync(join(repo, ".git/FETCH_HEAD")), false, "no implicit fetch writes");
	} finally { rmSync(dir, { recursive: true, force: true }); rmSync(f.dir, { recursive: true, force: true }); }
});

test("root confirmation explicitly says sudo/as root; streamed mux noise is removed", async () => {
	const action = { kind: "bash" as const, command: "systemctl restart demo", root: true };
	const decision = { verdict: "ask" as const, reason: "root command" };
	assert.match(confirmTitle(action, "mac", decision), /as root/);
	assert.match(confirmBody(action, "mac", decision), /^\$ \[mac\] sudo systemctl restart demo/);
	const noise = "mux_client_request_session: read from master failed: Broken pipe\nmux_client_request_alive: read from master failed: Broken pipe\n";
	assert.equal(stripSshNoise(noise + "real error\n"), "real error\n");
	const out: string[] = [];
	const c = { device: "mac", home: "/tmp", user: "s", target: {}, probe: { os: "Linux" } } as Conn;
	await runRoot(c, { command: "true", pref: "pi", userIsAtDevice: false, from: "vm", askPassword: async () => "test-only", timeoutMs: 1000,
		onData: (b) => out.push(b.toString()), run: async (_t, _script, opts) => {
			opts.onData?.(Buffer.from(noise), "stderr"); opts.onData?.(Buffer.from("done\n"), "stdout");
			return { code: 0, stdout: Buffer.alloc(0), stderr: noise };
		} });
	assert.equal(out.join(""), "done\n");
	await runRoot(c, { command: "git status", pref: "pi", userIsAtDevice: false, from: "vm", askPassword: async () => "test-only", timeoutMs: 1000,
		onData() {}, run: async (_t, script) => {
			assert.match(script, /core\.fsmonitor=false/); assert.match(script, /--no-optional-locks/);
			return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
		} });
});
