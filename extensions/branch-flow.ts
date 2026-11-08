/**
 * Branch flow panels for pi: show `git flow-status` / `git flow-help` output in the chat
 * without calling the model (like /context). The output is stored as a custom entry, which
 * pi never sends to the LLM.
 *
 *   /flow                 menu (same as /flow help)
 *   /flow status [proj]   status of the current project, or of the named Orca project
 *
 * Read-only: it only runs `git flow-status` and `git flow-help` (orca-branch-flow).
 *
 * Skill auto-load: the branch-flow skill ships with `disable-model-invocation: true`, so it
 * is reachable everywhere through /skill:branch-flow but never listed for the agent. Before
 * each run this extension checks whether the working directory is a git repository with a
 * GitHub remote; only then it adds the skill's instructions (SKILL.md without frontmatter)
 * to the system prompt as the <branch_flow_skill> section. Local repositories (no GitHub
 * remote) and non-git folders do not get the section.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

interface Panel {
	title: string;
	body: string;
	failed: boolean;
}

const ENTRY = "branch-flow-panel";
const SKILL = "branch-flow";
const SECTION = "branch_flow_skill";
const GITHUB_URL = /(^|[@/.])github\.com[:/]/i;

function skillBody(filePath: string): string | undefined {
	try {
		const text = readFileSync(filePath, "utf-8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
		if (!text) return undefined;
		return [
			`This repository has a GitHub remote, so pi loaded the ${SKILL} skill (${filePath}) automatically.`,
			"Follow it for branch flow questions and operations; loading it authorizes no action by itself.",
			"",
			text,
		].join("\n");
	} catch {
		return undefined;
	}
}

async function hasGitHubRemote(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	try {
		const res = await pi.exec("git", ["config", "--get-regexp", "^remote\\..*\\.(push)?url$"], { cwd, timeout: 5000 });
		if (res.code !== 0) return false;
		return res.stdout.split("\n").some((line) => GITHUB_URL.test(line.split(/\s+/)[1] ?? ""));
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const { sections, skills } = event.systemPromptOptions;
		delete sections[SECTION];
		const skill = skills?.find((s) => s.name === SKILL);
		if (!skill) return;
		if (!(await hasGitHubRemote(pi, event.systemPromptOptions.cwd || ctx.cwd))) return;
		const body = skillBody(skill.filePath);
		if (body) sections[SECTION] = body;
	});

	pi.registerEntryRenderer<Panel>(ENTRY, (entry, _options, theme) => {
		const data = entry.data ?? { title: "branch flow", body: "", failed: true };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg(data.failed ? "error" : "accent", theme.bold(data.title)), 0, 0));
		const lines = data.body.split("\n").map((line) => {
			if (/^(Требует внимания|С агентом|Журналы|Branch flow)/.test(line)) return theme.bold(line);
			if (/^- /.test(line)) return theme.fg("warning", line);
			return line;
		});
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	pi.registerCommand("flow", {
		description: "Branch flow: status of this project or menu (no model call)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "status", label: "status", description: "дерево workspace, веток и PR текущего проекта (status <проект> — другого)" },
				{ value: "help", label: "help", description: "все команды branch flow и операции /skill:branch-flow с описанием" },
			].filter((x) => x.value.startsWith(prefix));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const status = sub === "status";
			const gitArgs = status ? ["flow-status", ...rest] : ["flow-help"];
			const res = await pi.exec("git", gitArgs, { cwd: ctx.cwd, timeout: 60000 });
			const body = (res.stdout || res.stderr || "(no output)").replace(/`/g, "").trimEnd();
			const title = status ? `/flow status ${rest.join(" ")}`.trim() : "/flow";
			const panel: Panel = { title, body, failed: res.code !== 0 };
			if (ctx.mode === "tui") {
				pi.appendEntry<Panel>(ENTRY, panel);
			} else if (ctx.hasUI) {
				ctx.ui.notify(`${title}\n${body}`, panel.failed ? "error" : "info");
			}
		},
	});
}
