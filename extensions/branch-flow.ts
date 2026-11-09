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
 * The branch-flow skill is not loaded into the agent's context: the owner calls it with
 * /skill:branch-flow when stacked PRs are wanted.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

interface Panel {
	title: string;
	body: string;
	failed: boolean;
}

const ENTRY = "branch-flow-panel";

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<Panel>(ENTRY, (entry, _options, theme) => {
		const data = entry.data ?? { title: "branch flow", body: "", failed: true };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg(data.failed ? "error" : "accent", theme.bold(data.title)), 0, 0));
		const lines = data.body.split("\n").map((line) => {
			if (/^(Требует внимания|С агентом|Stacked PRs)/.test(line)) return theme.bold(line);
			if (/^- /.test(line)) return theme.fg("warning", line);
			return line;
		});
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	pi.registerCommand("flow", {
		description: "Stacked PRs: status of this project or menu (no model call)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "status", label: "status", description: "дерево workspace, веток и PR текущего проекта (status <проект> — другого)" },
				{ value: "help", label: "help", description: "команды stacked PRs и операции /skill:branch-flow с описанием" },
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
