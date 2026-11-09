---
name: branch-flow
description: Owner-invoked stacked pull requests for Orca workspaces - publish, ship, merge, sync, child, move, status, restore, abandon, cleanup, doctor. Called with /skill:branch-flow; nothing runs automatically.
disable-model-invocation: true
---

# Stacked PRs (branch flow), on request

The owner called this skill (`/skill:branch-flow <request>`). The request is the operation
to perform. It authorizes the concrete actions it names (including merging, closing and
deleting), and nothing beyond them. Answer in the owner's language.

If the request is empty or unclear, run `git flow-help` and show its output as the menu (one line each, with an
example) and ask which one to run. Do not guess destructive operations.

## Ground rules

- Nothing is automatic: Orca names workspaces and branches as the owner chooses, commits
  are not pushed, PRs are not opened, and nothing syncs in the background. Do only what
  the request asks.
- Tools: `git publish`, `git sync-parent`, `git parent`, `git new-workspace`, `git ship`,
  `git abandon`, `git restore-workspace`, `git flow-status`, `git flow-help` (all wrap
  `~/.local/share/orca-branch-flow/branch_flow.py`), `gh`, and the Orca CLI
  (`$ORCA_CLI_COMMAND`, else `orca`; never `/usr/bin/orca`). Use `--json` with Orca and
  `gh` where available.
- Model: a workspace = an Orca worktree with its branch (any name). A stacked branch's
  draft PR targets its parent: the recorded parent (`git parent`), else the Orca parent
  workspace's branch if the branch was started from it, else the default branch.
  Children merge into parents by squash, bottom-up; main only through the chain.
- Find a workspace by Orca name, branch, path or PR number:
  `orca worktree list --limit 10000 --json` (fields: path, branch, displayName,
  linkedPR, parentWorktreeId). Run git commands inside that workspace's path.
- Never force-push, `--no-verify`, rename pushed branches, or edit PRs with
  `gh pr edit` (it fails on this account; use `gh api -X PATCH repos/{owner}/{repo}/pulls/N`).
  The pre-push guard refuses force-pushes and branch deletions; if it does, stop and report.
- Before anything that loses work (abandon, removing a workspace), check
  `git status --porcelain` and unpushed commits; if any exist and the owner did not say
  `force`, stop and report them.
- Finish with a short report: what changed (PR links, branches, workspaces), what was
  skipped and why, and anything that needs the owner.

## Without the agent

Information alone does not need this skill: in pi, `/flow status [project]` and `/flow`
(menu) show a panel without calling the model; in a terminal, `git flow-status` and
`git flow-help`. When the owner only asks for status or the menu, run `git flow-status` /
`git flow-help`, show the output, and mention `/flow` for next time.

## Options

| Option | Example | Do |
|---|---|---|
| `status` | `status`, `status JavaMIET` | Run `git flow-status [project]` and show its output as is. Explain the "Требует внимания" items in a few lines and suggest an option for each; change nothing unless the owner asks. |
| `publish` | `publish Small fixes`, `publish mcp into pi-setup`, `publish mcp empty` | In that workspace: `git publish` (`--base <branch>` when the owner names the parent, `--empty` without changes, `--ready` if asked). It pushes the branch and opens/updates the draft PR stack. |
| `ready` | `ready Pi setup` | `gh pr ready N`. |
| `merge` | `merge Small fixes`, `merge Small fixes to main` | Squash-merge the PR into its parent (`gh pr merge N --squash`; mark ready first). "to main" = merge each PR up the chain, bottom-up, after checking each is mergeable. Then run `cleanup` so merged branches sync with their parents. Workspaces and branches stay. |
| `sync` | `sync Small fixes` | `git sync-parent` in the workspace (merges, and pushes if the branch is on GitHub). |
| `sync-main` | `sync-main Small fixes` | Bring the latest default branch down the chain: `git sync-parent` in each ancestor from the top down, then in the target. Stop at a conflict and report it. |
| `child` | `child of Pi setup: Images v2`, `... branch images-v2` | `git new-workspace "<name>" --parent "<parent workspace>"` (`--branch` if the owner names the branch, else Orca names it; `--agent`/`--prompt` if asked). It starts from the parent's branch and records the parent. |
| `top` | `top: Docs cleanup in orca-setup` | `git new-workspace "<name>" --top` (`--branch`, `--base` if given). |
| `ship` | `ship Fix typo`, `ship Bugs > Bug 1`, `ship only src/api.py as Api retry` | Release uncommitted work of the current workspace in a child workspace: in it run `git ship "<name>" ["<nested name>" ...] -m "<commit message>" [-p <path> ...] [-b <branch> ...]`. Several names = a chain (each next one inside the previous; existing children with that name are reused). First run it with `--dry-run`, show the plan (files, workspaces new/existing); if the owner named everything, go on without asking. Write a conventional commit message from the diff unless given. It creates the workspaces, commits there (project hooks run), removes the changes from the current workspace (`--keep` leaves them), and publishes the draft PR chain (`--no-publish` if the owner only wants the commit). |
| `move` | `move Images render under mcp` | `orca worktree set --worktree path:<p> --parent-worktree path:<new parent>`, `git parent --set <new parent branch>`, `git sync-parent`, `git publish --retarget`. |
| `rename` | `rename Small fixes to Fixes` | `orca worktree set --worktree path:<p> --display-name "<name>"`; the PR title follows on the next `git publish`. Branch names never change. |
| `abandon` | `abandon Test child worktree`, `... force` | `git abandon <branch> --yes` (`--force` only if the owner said so). |
| `restore` | `restore deep-task` | `git restore-workspace <branch>` from any checkout of the project. |
| `remove` | `remove merged workspaces` | For workspaces whose PR is merged and that have no new work: `orca worktree rm --worktree path:<p> --delete-branch --json`. List first, then remove. |
| `orphans` | `orphans` | List open PRs marked "Workspace удалён"; for each, ask (or do as told): restore or close. |
| `cleanup` | `cleanup`, `cleanup JavaMIET`, `cleanup delete branches` | `python3 ~/.local/share/orca-branch-flow/branch_flow.py reconcile [project]` (`--delete-branches` only if the owner asked to delete finished GitHub branches). Report what it synced, flagged or deleted. |
| `doctor` | `doctor` | Check: the `pre-push` hook (marker `orca-branch-flow`) in every project, leftovers of the old automation (local `orca.yaml`/`.worktreeinclude` with the marker, `post-commit` hook, crontab line), `gh auth status`. Fix what is safe (`branch_flow.py install-repo <project>`, `branch_flow.py uninstall-cron`), report the rest. |
| `install` | `install for NewProject` | `python3 ~/.local/share/orca-branch-flow/branch_flow.py install-repo <project root>` (adds only the pre-push guard). |
| `explain` | `explain` | Explain in plain words how stacked PRs work for the given workspace. |

Free-form requests ("finish everything under Pi setup", "why has X no PR?", "выпусти это
как Bug 1 в bugs") are allowed:
map them to these options, list the steps you will take, then do them.

Details: `docs/branch-flow.md` in the pi-setup repository (with the tool, `tools/branch-flow/branch_flow.py`).
