---
name: branch-flow
description: Owner-invoked operations on Orca workspaces, branches and GitHub pull requests (branch flow) - status, ship, merge, sync, child, move, restore, abandon, cleanup, doctor. Called with /skill:branch-flow; in GitHub-backed repositories pi adds it to the agent's context automatically.
disable-model-invocation: true
---

# Branch flow operations

The owner either called this skill (`/skill:branch-flow <request>`), or pi added it to your
context because the repository has a GitHub remote. The owner's own request is the operation
to perform. It authorizes the concrete actions it
names (including merging, closing and deleting), and nothing beyond them; loading this
skill automatically authorizes nothing. Answer in the owner's language.

If the request is empty or unclear, run `git flow-help` and show its output as the menu (one line each, with an
example) and ask which one to run. Do not guess destructive operations.

## Ground rules

- Tools: `git publish`, `git sync-parent`, `git parent`, `git abandon`,
  `git restore-workspace` (all wrap `~/.local/share/orca-branch-flow/branch_flow.py`),
  `gh`, and the Orca CLI (`$ORCA_CLI_COMMAND`, else `orca`; never `/usr/bin/orca`).
  Use `--json` with Orca and `gh` where available.
- Model: a workspace = an Orca worktree with one plain-named branch, the same on GitHub.
  Its draft PR targets the parent workspace's branch; roots target the default branch.
  Children merge into parents by squash, bottom-up; main only through the chain.
  Branches live as long as their workspaces (GitHub auto-delete is off).
- Find a workspace by Orca name, branch, path or PR number:
  `orca worktree list --limit 10000 --json` (fields: path, branch, displayName,
  linkedPR, parentWorktreeId). Run git commands inside that workspace's path.
- Never force-push, `--no-verify`, rename pushed branches, or edit PRs with
  `gh pr edit` (it fails on this account; use `gh api -X PATCH repos/{owner}/{repo}/pulls/N`).
- Before anything that loses work (abandon, removing a workspace), check
  `git status --porcelain` and unpushed commits; if any exist and the owner did not say
  `force`, stop and report them.
- Background push/PR jobs log to `<git common dir>/branch-flow.log`; reconcile (cron,
  every 10 min) logs to `~/.local/state/orca-branch-flow.log`. Read them when something
  did not happen; run `python3 ~/.local/share/orca-branch-flow/branch_flow.py reconcile`
  to apply pending sync/cleanup now instead of waiting.
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
| `status` | `status`, `status JavaMIET` | Run `git flow-status [project]` and show its output as is (one project: the current one, or the named one). Explain the "Требует внимания" items in a few lines and suggest an option for each; change nothing unless the owner asks. Never "fix" a branch by recreating its workspace or opening a second PR for the same work. |
| `publish` | `publish Small fixes`, `publish mcp empty` | In that workspace: `git publish` (`--empty` without changes, `--ready` if asked). |
| `ready` | `ready Pi setup` | `gh pr ready N`. |
| `merge` | `merge Small fixes`, `merge Small fixes to main` | Squash-merge the PR into its parent (`gh pr merge N --squash`; mark ready first). "to main" = merge each PR up the chain, bottom-up, after checking each is mergeable. Then run reconcile so merged branches sync with their parents. Workspaces and branches stay. |
| `sync` | `sync Small fixes` | `git sync-parent` in the workspace (merges and pushes). |
| `sync-main` | `sync-main Small fixes` | Bring the latest default branch down the chain: `git sync-parent` in each ancestor from the top down, then in the target. Stop at a conflict and report it. |
| `child` | `child of Pi setup: Images v2` | `git new-workspace "<name>" --parent "<parent workspace>"` (add `--agent`/`--prompt` if asked). It names the branch plainly and waits for the setup hook; do not inspect or fix the base before it reports. |
| `top` | `top: Docs cleanup in orca-setup` | `git new-workspace "<name>" --top`. |
| `ship` | `ship Fix typo`, `ship Bugs > Bug 1`, `ship only src/api.py as Api retry` | Release uncommitted work of the current workspace in a child workspace: in it run `git ship "<name>" ["<nested name>" ...] -m "<commit message>" [-p <path> ...]`. Several names = a chain (each next one inside the previous; existing children with that name are reused). First run it with `--dry-run`, show the plan (files, workspaces new/existing); if the owner named everything, go on without asking. Write a conventional commit message from the diff unless given. It creates the workspaces, commits there (project hooks run), removes the changes from the current workspace (`--keep` leaves them), and publishes: draft PR chain up to main. Only uncommitted changes move; committed work already belongs to this branch. |
| `move` | `move Images render under mcp` | `orca worktree set --worktree path:<p> --parent-worktree path:<new parent>`, `git parent --set <new parent branch>`, `git sync-parent`, `git publish --retarget`. |
| `rename` | `rename Small fixes to Fixes` | `orca worktree set --worktree path:<p> --display-name "<name>"`; the PR title follows on the next push (or run `git publish`). Branch names never change. |
| `abandon` | `abandon Test child worktree`, `... force` | `git abandon <branch> --yes` (`--force` only if the owner said so). |
| `restore` | `restore deep-task` | `git restore-workspace <branch>` from any checkout of the project. |
| `remove` | `remove merged workspaces` | For workspaces whose PR is merged and that have no new work: `orca worktree rm --worktree path:<p> --delete-branch --json`. List first, then remove. |
| `orphans` | `orphans` | List open PRs marked "Workspace удалён"; for each, ask (or do as told): restore or close. |
| `cleanup` | `cleanup` | Run reconcile and report what it synced, flagged or deleted. |
| `doctor` | `doctor` | Check: hooks (`pre-push`, `post-commit` with marker `orca-branch-flow`) and local `orca.yaml` in every project, cron line (`crontab -l`), `gh auth status`, recent errors in the logs, workspaces without registered parent, branches with `/`. Fix what is safe (`branch_flow.py install-repo <project>`), report the rest. |
| `install` | `install for NewProject` | `python3 ~/.local/share/orca-branch-flow/branch_flow.py install-repo <project root>`; for a shared/team repo ask first whether to disable automation (`git config branchflow.autoPush false`, `branchflow.autoPr false`). |
| `explain` | `explain` | Explain in plain words how the flow works for the given workspace. |

Free-form requests ("finish everything under Pi setup", "why has X no PR?", "выпусти это
как Bug 1 в bugs") are allowed:
map them to these options, list the steps you will take, then do them.

Details: `docs/runbooks/branch-flow.md` in the orca-setup project.
