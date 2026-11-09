// Model check: may this URL be sent to a third-party reader (Jina)?
// Runs only after the rule-based guard in logic.ts passed. Fails closed: any doubt,
// error or missing model returns a reason to refuse.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

type Registry = Pick<ModelRegistry, "find" | "findOfType" | "getAvailable" | "getAvailableOfType" | "classify" | "complete">;
type ChatModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

export const AUTO = "auto";
export const ENV_VAR = "PI_WEB_FETCH_CLASSIFIER";

// ── Model choice: env > config file > auto ──────────────────────────

export function configPath(agentDir: string): string {
	return join(agentDir, "web-fetch.json");
}

export async function loadChoice(file: string): Promise<string> {
	try {
		const value = JSON.parse(await readFile(file, "utf8"))?.classifier;
		return typeof value === "string" && value.trim() ? value.trim() : AUTO;
	} catch {
		return AUTO;
	}
}

export async function saveChoice(file: string, choice: string): Promise<void> {
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(await readFile(file, "utf8")) ?? {};
	} catch {}
	if (choice === AUTO) delete config.classifier;
	else config.classifier = choice;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function resolveChoice(file: string, env = process.env[ENV_VAR]): Promise<{ choice: string; from: "env" | "config" | "default" }> {
	if (env?.trim()) return { choice: env.trim(), from: "env" };
	const choice = await loadChoice(file);
	return { choice, from: choice === AUTO ? "default" : "config" };
}

function split(choice: string): [string, string] {
	const slash = choice.indexOf("/");
	return slash > 0 ? [choice.slice(0, slash), choice.slice(slash + 1)] : ["", choice];
}

type Picked = { kind: "classifier"; model: unknown } | { kind: "chat"; model: ChatModel };

/** Look up `provider/id` as a classifier model first, then as a chat model. */
export function findModel(registry: Registry, choice: string): Picked | undefined {
	const [provider, id] = split(choice);
	const classifier = registry.findOfType("classifier", provider, id);
	if (classifier) return { kind: "classifier", model: classifier };
	const chat = registry.find(provider, id);
	return chat ? { kind: "chat", model: chat } : undefined;
}

export interface Choice {
	/** `auto` or `provider/id`. */
	value: string;
	kind: "auto" | "classifier" | "chat";
	/** Human-readable model name, when it differs from the id. */
	name?: string;
}

/** Choices for the picker: auto, then classifier models, then chat models (all with working credentials). */
export async function listChoices(registry: Registry): Promise<Choice[]> {
	const classifiers = await registry.getAvailableOfType("classifier").catch(() => []);
	const named = (m: { id: string; name?: string }) => (m.name && m.name !== m.id ? m.name : undefined);
	return [
		{ value: AUTO, kind: "auto" },
		...classifiers.map((m): Choice => ({ value: `${m.provider}/${m.id}`, kind: "classifier", name: named(m) })),
		...registry.getAvailable().map((m): Choice => ({ value: `${m.provider}/${m.id}`, kind: "chat", name: named(m) })),
	];
}

// ── Classification ──────────────────────────────────────────────────

const INSTRUCTIONS =
	"Decide whether this URL points to content that is public, i.e. anyone on the internet can open it without logging in, " +
	"or whether it is private: a personal or shared document, an account, dashboard or admin page, an internal tool, " +
	"a signed or tokenized link, or anything else whose owner would not want it sent to a third-party service.";

/**
 * `choice` is `provider/id` (classifier or chat model) or `auto`: the first available
 * classifier model, else the session's chat model.
 */
export async function classifyUrl(
	registry: Registry,
	sessionModel: ChatModel | undefined,
	url: string,
	signal?: AbortSignal,
	choice: string = AUTO,
): Promise<string | null> {
	try {
		let picked: Picked | undefined;
		if (choice !== AUTO) {
			picked = findModel(registry, choice);
			if (!picked) return `classifier model ${choice} not found`;
		} else {
			const classifier = (await registry.getAvailableOfType("classifier"))[0];
			picked = classifier ? { kind: "classifier", model: classifier } : sessionModel && { kind: "chat", model: sessionModel };
		}
		if (!picked) return "no model available to classify the URL";

		if (picked.kind === "classifier") {
			const result = await registry.classify(
				picked.model as Parameters<Registry["classify"]>[0],
				{
					state: { url },
					questions: {
						private: {
							type: "bool",
							instructions: INSTRUCTIONS,
							criteria: { true: "Private or sensitive", false: "Public web content" },
						},
					},
				},
				{ signal },
			);
			const answer = result.stopReason === "stop" ? result.answers.private : undefined;
			if (answer?.type !== "bool") return `classifier failed${result.errorMessage ? `: ${result.errorMessage}` : ""}`;
			return answer.probability < 0.5 ? null : "classifier judged the URL private";
		}

		const reply = await registry.complete(
			picked.model,
			{
				systemPrompt: `${INSTRUCTIONS} Reply with exactly one word: PUBLIC or PRIVATE.`,
				messages: [{ role: "user", content: url, timestamp: Date.now() }],
			},
			{ signal, maxTokens: 256 },
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted")
			return `classifier failed${reply.errorMessage ? `: ${reply.errorMessage}` : ""}`;
		const text = reply.content
			.flatMap((b) => (b.type === "text" ? [b.text] : []))
			.join(" ")
			.trim()
			.toUpperCase();
		if (/\bPUBLIC\b/.test(text) && !/\bPRIVATE\b/.test(text)) return null;
		return /\bPRIVATE\b/.test(text) ? "model judged the URL private" : "model gave no clear answer";
	} catch (err) {
		return `classifier failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}
