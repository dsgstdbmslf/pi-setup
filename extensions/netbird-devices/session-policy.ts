// Per-session access state and the decision flow around policy.decide(): mode overrides, "always allow"
// approvals, the classifier verdict cache and the deny streak. Pure: no pi imports; the dialog and the
// classifier call are injected. Unit-tested.

import { classifierSeesWholeAction, type ClassifierVerdict } from "./classifier.ts";
import { type Action, approvalKey, type Decision, decide } from "./policy.ts";
import { MODES, type Mode } from "./settings.ts";
import type { ConfirmChoice } from "./ui-text.ts";

/** Session entry type of mode overrides (`pi.appendEntry(MODE_ENTRY, { device, mode })`). */
export const MODE_ENTRY = "netbird-devices-mode";
/** This many classifier denials in a row send the next question straight to the user. */
export const MAX_DENY_STREAK = 3;

export const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);

/** ro → ask → auto → full → ro. */
export function nextMode(m: Mode): Mode {
	return MODES[(MODES.indexOf(m) + 1) % MODES.length];
}

export interface ClassifierResult {
	decision: ClassifierVerdict;
	reason: string;
	/** Model that answered and its token usage, passed through to the tool result details. */
	model?: string;
	usage?: unknown;
}

export class SessionPolicy {
	private modes = new Map<string, Mode>();
	private approved = new Set<string>();
	private cache = new Map<string, { decision: ClassifierVerdict; reason: string }>();
	private denyStreak = 0;

	/** Forget everything (new session). */
	reset(): void {
		this.modes.clear();
		this.approved.clear();
		this.cache.clear();
		this.denyStreak = 0;
	}

	// --- modes ---------------------------------------------------------------------------------

	modeFor(device: string, base: Mode): Mode {
		return this.modes.get(device) ?? base;
	}
	overridden(device: string): Mode | undefined {
		return this.modes.get(device);
	}
	setMode(device: string, mode: Mode): void {
		this.modes.set(device, mode);
	}

	/** Rebuild the overrides from the active branch (the last entry per device wins). Other state stays. */
	restoreModes(entries: readonly unknown[]): void {
		this.modes.clear();
		for (const e of entries) {
			const x = e as { type?: string; customType?: string; data?: { device?: unknown; mode?: unknown } };
			if (x?.type !== "custom" || x.customType !== MODE_ENTRY) continue;
			if (typeof x.data?.device === "string" && x.data.device && isMode(x.data.mode)) this.modes.set(x.data.device, x.data.mode);
		}
	}

	// --- approvals and classifier cache --------------------------------------------------------

	isApproved(action: Action, device: string, scope = ""): boolean {
		return this.approved.has(JSON.stringify([device, scope, approvalKey(action)]));
	}
	approve(action: Action, device: string, scope = ""): void {
		this.approved.add(JSON.stringify([device, scope, approvalKey(action)]));
	}
	get streak(): number {
		return this.denyStreak;
	}

	/**
	 * Run an action through the policy. Resolves to ok, or to a refusal message for the agent.
	 * `ask` is undefined when there is no UI; `classify` returns undefined when it cannot answer (→ ask).
	 */
	async authorize(i: AuthorizeInput): Promise<Outcome> {
		const { device, action } = i;
		const mode = this.modeFor(device, i.baseMode);
		let d = decide({ mode, action, protectedHit: i.protectedHit, approved: this.isApproved(action, device, i.scope) });
		// Classifier verdicts are cached per action; a write is identified by its exact content too.
		const key = JSON.stringify([device, i.scope ?? "", approvalKey(action), i.cacheSalt ?? ""]);
		const who = i.label ?? device;
		const refuse = (why: string, how: Outcome["how"]): Outcome => ({ ok: false, how, message: `${who}: ${why}` });
		let classified: ClassifierResult | undefined;

		if (d.verdict === "deny") return refuse(`${describe(action)} refused: ${d.reason}.`, "policy");
		if (d.verdict === "allow") return { ok: true, how: d.reason.startsWith("allowed earlier") ? "approved" : "auto" };

		if (d.verdict === "classify" && !classifierSeesWholeAction(action)) {
			d = { verdict: "ask", reason: "action exceeds the classifier preview; user confirmation required" };
		}
		if (d.verdict === "classify") {
			const cached = this.cache.get(key);
			if (cached) classified = { ...cached };
			else if (this.denyStreak >= MAX_DENY_STREAK) {
				d = { verdict: "ask", reason: `the classifier refused ${this.denyStreak} actions in a row`, warning: "classifier refused several actions in a row" };
			} else if (!i.classify) {
				d = { verdict: "ask", reason: "no classifier available" };
			} else {
				try {
					classified = await i.classify();
				} catch {
					classified = undefined;
				}
				if (classified) {
					if (classified.decision !== "ask") this.cache.set(key, { decision: classified.decision, reason: classified.reason });
					if (classified.decision === "allow") this.denyStreak = 0;
					else if (classified.decision === "deny") this.denyStreak++;
				} else d = { verdict: "ask", reason: "classifier unavailable (error, timeout or no model)" };
			}
			if (classified) {
				const why = classified.reason || "no reason given";
				if (classified.decision === "allow") return { ok: true, how: "classifier:allow", classifier: classified };
				if (classified.decision === "deny") return { ...refuse(`${describe(action)} refused by the auto-mode classifier: ${why}. Ask the user if this is really wanted.`, "classifier:deny"), classifier: classified };
				d = { verdict: "ask", reason: `classifier: ${why}`, warning: undefined };
			}
		}

		// Ask the user.
		if (!i.ask) return refuse(`${describe(action)} needs the user's confirmation (${d.reason}), but there is no interactive UI to ask in. Nothing was changed.`, "no-ui");
		let choice: ConfirmChoice | undefined;
		try {
			choice = await i.ask(d);
		} catch {
			choice = undefined;
		}
		if (this.denyStreak >= MAX_DENY_STREAK) this.denyStreak = 0;
		if (!choice || choice === "deny") return { ...refuse(`${describe(action)} denied by user.`, "denied"), classifier: classified };
		if (choice === "always" && !d.danger) this.approve(action, device, i.scope);
		if (choice === "full" && !d.danger) {
			this.setMode(device, "full");
			i.onModeChange?.("full");
		}
		return { ok: true, how: "asked", classifier: classified };
	}
}

export interface AuthorizeInput {
	/** Device name (key of the mode overrides). */
	device: string;
	/** Name shown to the agent in refusals (default: `device`). */
	label?: string;
	/** Mode from settings (default or per device). */
	baseMode: Mode;
	action: Action;
	protectedHit?: string;
	/** Identifies the exact content of a write (hash) for the classifier cache. */
	cacheSalt?: string;
	/** Login/endpoint identity: approvals cannot follow a change of remote account. */
	scope?: string;
	/** Shows the confirm dialog; undefined = no UI. Undefined result = dismissed (counts as deny). */
	ask?: (d: Decision) => Promise<ConfirmChoice | undefined>;
	classify?: () => Promise<ClassifierResult | undefined>;
	/** Called after "switch to full" so the caller can persist the mode and refresh the footer. */
	onModeChange?: (mode: Mode) => void;
}

export type Outcome =
	| { ok: true; how: "auto" | "approved" | "asked" | "classifier:allow"; classifier?: ClassifierResult }
	| { ok: false; how: "policy" | "classifier:deny" | "denied" | "no-ui"; message: string; classifier?: ClassifierResult };

function describe(a: Action): string {
	switch (a.kind) {
		case "read":
			return `read of ${a.path}`;
		case "write":
			return `${a.isNew ? "creating" : "writing"} ${a.path}`;
		case "bash":
			return a.root ? "root command" : "command";
	}
}
