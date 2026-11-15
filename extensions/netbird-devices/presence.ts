// "Where is the user?": which device is connected to this machine and was used last.
// Pure: no pi imports, unit-tested.

export interface Candidate {
	device: string;
	/** Has an inbound NetBird connection to this machine (e.g. a terminal or IDE session). */
	connected: boolean;
	/** Seconds since the last keyboard/mouse input on the device; undefined = unknown. */
	idleSec?: number;
}

export type HereResult =
	| { kind: "found"; device: string; why: string }
	| { kind: "ambiguous"; candidates: Candidate[]; why: string }
	| { kind: "none"; why: string };

export const ACTIVE_SEC = 120;
export const AWAY_SEC = 600;

export function resolveHere(cands: Candidate[], pinned?: string, recent?: { device: string; at: number }, now = Date.now()): HereResult {
	if (pinned) return { kind: "found", device: pinned, why: "pinned with /nb here" };
	const connected = cands.filter((c) => c.connected);
	const pool = connected.length ? connected : cands.filter((c) => c.idleSec !== undefined && c.idleSec < ACTIVE_SEC);
	if (!pool.length) return { kind: "none", why: "no device of yours is connected to this machine" };
	if (pool.length === 1) {
		const c = pool[0];
		return { kind: "found", device: c.device, why: c.connected ? "the only device connected to this machine" : "the only recently active device" };
	}
	const known = pool.filter((c) => c.idleSec !== undefined).sort((a, b) => a.idleSec! - b.idleSec!);
	if (known.length) {
		const best = known[0];
		const second = known[1];
		const unknownOthers = pool.length - known.length;
		if (best.idleSec! < ACTIVE_SEC && unknownOthers === 0 && (!second || second.idleSec! >= AWAY_SEC)) {
			return { kind: "found", device: best.device, why: `input ${fmtIdle(best.idleSec!)} ago${second ? `, ${second.device} idle ${fmtIdle(second.idleSec!)}` : ""}` };
		}
	}
	if (recent && now - recent.at < 30 * 60_000 && pool.some((c) => c.device === recent.device)) {
		return { kind: "found", device: recent.device, why: "you chose it in the last 30 minutes" };
	}
	return { kind: "ambiguous", candidates: pool, why: "several devices are connected and recently used" };
}

export function fmtIdle(sec: number): string {
	if (sec < 60) return `${Math.round(sec)}s`;
	if (sec < 3600) return `${Math.round(sec / 60)}m`;
	if (sec < 86400) return `${Math.round(sec / 3600)}h`;
	return `${Math.round(sec / 86400)}d`;
}

/**
 * Shell snippet printing seconds since the last input of the logged-in GUI user, or nothing.
 * macOS: HIDIdleTime (ns). Linux: logind IdleSinceHint (realtime clock, microseconds) of the user's
 * graphical session against `date +%s` (the monotonic hint would be compared with the wrong clock
 * after a suspend), xprintidle as fallback.
 */
export const IDLE_PROBE = [
	'if [ "$(uname -s)" = Darwin ]; then',
	"  ioreg -c IOHIDSystem -d 4 2>/dev/null | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'",
	"else",
	"  s=''",
	"  for id in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do",
	"    L_Type=''; L_Active=''; L_IdleHint=''; L_IdleSinceHint=''",
	"    eval \"$(loginctl show-session \"$id\" -p Type -p Active -p IdleHint -p IdleSinceHint 2>/dev/null | sed 's/^/L_/')\"",
	'    case "$L_Type" in x11|wayland) if [ "$L_Active" = yes ]; then s="$L_IdleHint $L_IdleSinceHint"; break; fi;; esac',
	"  done",
	'  if [ -n "$s" ]; then set -- $s; if [ "$1" = no ]; then echo 0; elif [ "${2:-0}" -gt 0 ]; then',
	"      now=$(date +%s); echo $(( now - $2 / 1000000 )); fi",
	"  elif command -v xprintidle >/dev/null 2>&1; then echo $(( $(DISPLAY=${DISPLAY:-:0} xprintidle 2>/dev/null || echo 0) / 1000 )); fi",
	"fi",
].join("\n");

export function parseIdle(out: string): number | undefined {
	const m = /^\s*(\d+)\s*$/m.exec(out);
	return m ? Number(m[1]) : undefined;
}
