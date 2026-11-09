# Orca server agents

## Where you run

Unless the user says otherwise, you run on a headless Orca remote server and the user works
from the Orca ADE desktop app connected to it. Everything you see (paths, processes, ports,
`localhost`, files under `/tmp`) is on the server, not on the user's computer.
- Refer to files by their server or workspace path; the user opens them in Orca.
- `localhost` URLs are server-local: open or check them in Orca's browser (`orca-cli`)
  instead of asking the user to open them on their computer.
- The server has no display: Computer Use has nothing to drive here and does not see the
  user's desktop; ask before trying GUI control.
- Images the user pastes arrive as server files such as `/tmp/orca-paste-*.png`.
- Use the Orca CLI that Orca exports (`$ORCA_CLI_COMMAND`, else `orca` in Orca terminals);
  `/usr/bin/orca` is a screen reader.

## Orca agents

- For subagent/delegation requests, default to visible Orca-managed agents. Internal subagents create no Orca tabs; use only when explicitly requested and explain their invisibility.
- Follow `orca-cli` and its version-matched guide. Use `agent launch` in existing workspaces or `worktree create --agent` for separate checkouts; reuse suitable idle agents. Respect chat/terminal preferences.
- Give a concrete brief and verify prompt delivery. Report the workspace and handle; distinguish acceptance, execution, and completion. Never resend on silence or claim focus when `navigated: false`.
- End full handoffs after delivery. Use `orchestration` for requested supervision. When asked to check results, read the agent's output and verify independently where practical.

## Git and GitHub

The project's own instructions win where they define a git workflow.
- Work on the branch your workspace was created on. Create, switch or rename branches
  only when the owner asks.
- Commit when the task calls for it. Pushing, opening or editing PRs, merging, closing
  PRs, deleting branches and removing workspaces happen only when the owner asks.
- Never force-push or rewrite pushed history; undo pushed commits with `git revert`. The
  pre-push guard refuses force-pushes and branch deletions: if it does, stop and report;
  never use `--no-verify`.
- New workspaces: only on request (`orca-cli`). Orca names the branch and picks the base
  unless the owner gives them (`--branch`, `--base-branch`).
- Workers sharing your workspace (`--worktree current`) must not commit concurrently; give
  each committing worker its own child workspace. Review workspaces (`--pr N`) do not commit.
- Stacked PRs (child → parent → main), only when the owner asks: use the branch-flow
  commands instead of doing the steps by hand: `git publish` (push, draft PR into the
  parent and the ancestor PRs), `git ship "<Name>" -m "<message>"` (move uncommitted
  changes into a child workspace and publish; `--dry-run` first), `git sync-parent`,
  `git new-workspace`, `git parent`. Overview: `git flow-help`; procedures:
  `/skill:branch-flow`.
