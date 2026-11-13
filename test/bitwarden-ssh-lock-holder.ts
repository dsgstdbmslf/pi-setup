// Helper process for the lock tests (not a test file): takes withFileLock(LOCK_PATH) with LOCK_BACKEND,
// prints "acquired" and holds the lock until a "release" line arrives on stdin; prints "released" after.
// A waiter that times out prints "timeout: <message>".

import { createInterface } from "node:readline";
import { type LockBackend, withFileLock } from "../extensions/bitwarden-ssh/lock.ts";

const path = process.env.LOCK_PATH!;
const backend = process.env.LOCK_BACKEND as LockBackend;
const timeoutMs = Number(process.env.LOCK_TIMEOUT_MS || 30_000);
const lines = createInterface({ input: process.stdin });
const release = new Promise<void>((res) => lines.on("line", (l) => l.trim() === "release" && res()));

try {
	await withFileLock(
		path,
		async () => {
			process.stdout.write(`acquired ${Date.now()}\n`);
			await release;
		},
		{ backend, timeoutMs },
	);
	process.stdout.write("released\n");
} catch (err) {
	process.stdout.write(`timeout: ${err instanceof Error ? err.message : String(err)}\n`);
}
lines.close();
