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

## Git and GitHub (branch flow)

In a project with a GitHub remote follow branch flow strictly; the project's own
instructions win only where they define another git workflow. The Orca skills do not
override these rules.
- Work only on the branch Orca created for your workspace. Never create, switch, rename,
  delete, or force-push branches, and never push under another name.
- Placement: work belonging to the current task goes to a child workspace, an unrelated
  task to a top-level one (PR into main). Create them with
  `git new-workspace "<Name>" [--parent <workspace> | --top] [--agent A --prompt P]`: it
  gives the branch a plain name and waits for the setup hook. With `orca worktree create`
  pass `--branch <plain-name>`; orchestration `--worktree new-child` is fine (the hook
  renames the branch). `worktree create` returns before setup finishes: never fix a new
  workspace's base or branch by hand. Workers sharing your workspace
  (`--worktree current`) must not commit concurrently; give each committing worker its
  own child workspace. Review workspaces (`--pr N`) do not commit.
- When the owner asks to release (ship) current changes "as <Name>", possibly nested
  ("in Bugs as Bug 1"), run `git ship "<Name>" ["<Nested>" ...] -m "<message>" [-p <path>]`
  in the current workspace: `--dry-run` first, then without it. It moves the uncommitted
  changes into new (or same-named existing) child workspaces, commits, pushes and opens
  the PRs; do not do these steps by hand.
- Never "repair" existing branches (names, bases, duplicates) by recreating workspaces,
  cherry-picking, or opening a second PR for the same work; report it to the owner.
- Just commit: push and a draft PR into the parent workspace's branch are automatic
  (ancestor PRs too). `git sync-parent` pulls the parent in; undo pushed commits with
  `git revert`.
- If a branch-flow hook refuses or warns, stop and report it; never use `--no-verify`.
- Opening PRs by hand, merging, closing, `git abandon`, and removing workspaces with
  pushed work are the owner's decisions.
