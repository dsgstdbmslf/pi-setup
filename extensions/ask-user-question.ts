import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type Question,
	type QuestionResult,
	buildResultText,
	fillDefaults,
	formatAnswer,
	getStrings,
	normalizeOptions,
} from "./ask-user-question/logic.ts";
import { askQuestions } from "./ask-user-question/ui.ts";

interface Details {
	status: "answered" | "cancelled" | "unavailable";
	results: QuestionResult[];
	message?: string;
}

const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user." }),
	details: Type.Optional(Type.String({ description: "Optional extra context shown under the question." })),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({
					description: 'Display label. If you recommend an option, put it first and append "(Recommended)".',
				}),
				value: Type.Optional(Type.String({ description: "Value returned for the option. Defaults to the label." })),
				description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
			}),
			{
				description:
					'Multiple-choice options. Omit for free-form text input. With options, the user can always pick "Other" and type a custom answer.',
			},
		),
	),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow several options to be selected." })),
	defaultAnswer: Type.Optional(
		Type.String({
			description:
				"Answer used only when no UI is available (non-interactive run). Option label/value, or free text.",
		}),
	),
});

const Params = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 6,
		description: "One or more questions, shown as tabs. Use one question unless several are closely related.",
	}),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Stop waiting after this many seconds. On timeout the question is dropped and the agent run stops.",
		}),
	),
});

// ctx.ui.custom() handles one dialog at a time. The lock lives on globalThis so other
// popup extensions can share it without importing this file.
const LOCK_KEY = "__piSharedUiLock";
function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	const g = globalThis as any;
	g[LOCK_KEY] ??= {
		chain: Promise.resolve(),
		withLock(f: () => Promise<any>) {
			const run = this.chain.then(f);
			this.chain = run.then(() => {}, () => {});
			return run;
		},
	};
	return g[LOCK_KEY].withLock(fn);
}

function result(status: Details["status"], results: QuestionResult[], text: string) {
	return { content: [{ type: "text" as const, text }], details: { status, results, message: text } as Details };
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a question and pause until they answer. Use when requirements are ambiguous, a preference is needed, a decision materially affects the implementation, or you need confirmation. Pass one question normally; pass several (shown as tabs) only when they are closely related.",
		promptSnippet:
			"Use this tool to ask the user a clarifying, preference or decision question before continuing.",
		promptGuidelines: [
			"Prefer ask_user_question over guessing when requirements, preferences or implementation choices are unclear.",
			'With options, the user can always choose "Other" and type a custom answer; do not add an "Other" option yourself.',
			"Use multiSelect: true only when several answers to the same question make sense.",
			'If you recommend an option, make it first and append "(Recommended)" to its label.',
			"Set defaultAnswer only for non-interactive runs; set timeoutSeconds only if the run should stop when nobody answers.",
		],
		parameters: Params,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const S = getStrings();
			const questions = params.questions as Question[];
			const empty: QuestionResult[] = [];

			if (signal?.aborted) return result("cancelled", empty, S.cancelled);

			if (!ctx.hasUI) {
				const defaults = fillDefaults(questions, []);
				if (!defaults) return result("unavailable", empty, S.noUI);
				return result("answered", defaults, `${S.usedDefaults}.\n${buildResultText(defaults)}`);
			}

			const outcome = await withUILock(() => askQuestions(ctx, questions, S, params.timeoutSeconds));
			if (outcome.status === "timeout") {
				// Nobody answered: stop the run instead of guessing a default.
				return { ...result("cancelled", empty, S.timedOut), terminate: true };
			}
			if (outcome.status === "cancelled") return result("cancelled", empty, S.cancelled);

			const results = fillDefaults(questions, outcome.answers);
			if (!results) return result("cancelled", empty, S.cancelled);
			return result("answered", results, buildResultText(results));
		},

		renderCall(args, theme) {
			const qs = ((args as any).questions ?? []) as Question[];
			const lines = qs.map((q) => {
				let line = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", q.question ?? "");
				if (q.multiSelect) line += theme.fg("dim", " [multi-select]");
				const labels = normalizeOptions(q.options).map((o) => o.label);
				if (labels.length > 0) line += `\n${theme.fg("dim", `  Options: ${labels.join(", ")}`)}`;
				return line;
			});
			return new Text(lines.join("\n") || theme.fg("toolTitle", theme.bold("ask_user_question")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as Details | undefined;
			if (!d || d.status !== "answered") {
				const first = result.content[0];
				return new Text(theme.fg("warning", d?.message || (first?.type === "text" ? first.text : "")), 0, 0);
			}
			const S = getStrings();
			const lines = d.results.flatMap((r) => {
				const head = d.results.length > 1 ? [theme.fg("muted", r.question)] : [];
				const tail = r.usedDefault ? theme.fg("dim", " (default)") : "";
				const answers = r.answers.map(
					(a) =>
						`${theme.fg("success", "✓ ")}${a.type === "other" ? theme.fg("muted", `${S.other}: `) : ""}${theme.fg("accent", a.type === "option" ? formatAnswer(a) : a.label || S.empty)}${tail}`,
				);
				return [...head, ...answers];
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
