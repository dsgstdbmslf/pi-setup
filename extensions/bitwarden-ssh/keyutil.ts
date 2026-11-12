// Small pure helpers on public keys and names. Unit-tested.

import { createHash } from "node:crypto";

/** OpenSSH SHA256 fingerprint ("SHA256:<base64 without padding>") of a public key line, or undefined. */
export function fingerprintOf(publicKey: string): string | undefined {
	const blob = publicKey.trim().split(/\s+/)[1];
	if (!blob || !/^[A-Za-z0-9+/]+=*$/.test(blob)) return undefined;
	const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
	return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** Fingerprint of a cached key: computed from the public key, else Bitwarden's value. */
export function keyFingerprint(k: { publicKey: string; fingerprint: string }): string {
	return fingerprintOf(k.publicKey) ?? k.fingerprint;
}

/** Keys whose name equals `name` (case-insensitive). */
export function findByName<T extends { name: string }>(keys: T[], name: string): T[] {
	const n = name.trim().toLowerCase();
	return keys.filter((k) => k.name.trim().toLowerCase() === n);
}
