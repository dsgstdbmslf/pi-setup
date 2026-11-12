// Child processes without a shell: arguments never pass through bash, secrets travel by stdin or by
// the child's own environment, never by argv (argv is world-readable in /proc).

import { spawn } from "node:child_process";

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Set when the program could not be started (ENOENT and the like) or timed out. */
	error?: string;
}

export interface RunOptions {
	env?: NodeJS.ProcessEnv;
	input?: string;
	timeoutMs?: number;
	cwd?: string;
	signal?: AbortSignal;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (r: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve(r);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, {
				env: opts.env ?? process.env,
				cwd: opts.cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			resolve({ code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: null, stdout, stderr, error: `${cmd} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s` });
		}, opts.timeoutMs ?? 60_000);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish({ code: null, stdout, stderr, error: "cancelled" });
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout!.on("data", (d: Buffer) => {
			if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
		});
		child.stderr!.on("data", (d: Buffer) => {
			if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
		});
		child.on("error", (err: NodeJS.ErrnoException) =>
			finish({ code: null, stdout, stderr, error: err.code === "ENOENT" ? `${cmd}: command not found` : err.message }),
		);
		child.on("close", (code) => finish({ code, stdout, stderr }));
		child.stdin!.on("error", () => {}); // EPIPE when the child exits before reading
		child.stdin!.end(opts.input ?? "");
	});
}

/** First meaningful line of a failed command, for user messages. Never includes stdout (may hold secrets). */
export function failure(r: RunResult, what: string): string {
	if (r.error) return `${what}: ${r.error}`;
	const line = r.stderr
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
	return `${what} failed${r.code != null ? ` (exit ${r.code})` : ""}${line ? `: ${line.slice(0, 300)}` : ""}`;
}
