# Stacked PRs for Orca workspaces (branch flow, on request)

Purpose: when the owner asks, push a workspace's branch and keep a stack of draft pull
requests (child → parent → main) that mirrors Orca's parent/child workspaces. Nothing
runs by itself: Orca works as it does out of the box, and no commit is pushed and no PR is
opened unless the owner (or an agent on the owner's request) runs a command below.

## What Orca does (unchanged Orca behaviour)

- You name the workspace and, if you want, the branch; otherwise Orca names the branch
  from the workspace name according to its own settings.
- A new workspace starts from the base you pick when creating it (default: the
  repository's default base, usually `main`). A child workspace in Orca's tree is not
  moved onto its parent's branch.
- Committing only commits. Pushing and opening PRs are separate, deliberate steps.

## Model of a stack

- The parent of a branch is, in order:
  1. the recorded one (`branch.<name>.orcaParent`, written by `git parent --set`,
     `git publish --base`, `git new-workspace`, `git ship`, or by the first `git publish`);
  2. the branch of the Orca parent workspace, if the branch was started from it;
  3. the default branch.
  So a workspace created from `main` under an Orca parent gets a PR into `main`.
- A branch's draft PR targets its parent. With `branchflow.stackPrs` (default on)
  `git publish` also opens the PRs of all ancestors, so a grandchild yields
  grandchild → child → parent → main. GitHub refuses PRs without commits, so an ancestor
  without own commits gets one empty commit (`chore: open stack PR for …`, same tree,
  dropped by the squash merge).
- Children are merged into their parent (squash), bottom-up; changes reach main through
  the chain. After merges, `reconcile` (on request) merges the parent back into a merged
  branch and refreshes the PR texts.
- Branch names are free. Names like `a/b` and `a/b/c` cannot coexist in git; Orca or git
  reports that when it happens.

```
main
 └─ small-fixes          PR -> main
     ├─ images-render    PR -> small-fixes
     │   └─ captions     PR -> images-render
     └─ tables           PR -> small-fixes
```

## Pre-push guard

`install-repo` adds one git hook, `.git/hooks/pre-push`. It refuses only:

- force-pushes (replacing commits that are on the GitHub branch);
- deleting a GitHub branch with `git push` (`--delete`, `:branch`);
- pushing over a GitHub commit this checkout has never fetched (fetch and merge first).

Branch names, new branches and pushes under another name are not checked, and the hook
starts nothing. The owner may bypass it once with `git push --no-verify`; agents stop and
report. `git abandon` deletes branches through the GitHub API, so it is not affected.

## Commands

| Command | Effect |
|---|---|
| `git publish [--base B] [--ready] [--retarget] [--empty]` | Push the current branch under its own name and open/update its draft PR into the parent, plus the ancestor PRs. `--base`: set the parent. `--empty`: open the PR without changes (placeholder commit). Pushes a parent that is not on GitHub yet (no PR for it unless stacked). Links the PR to the Orca workspace. |
| `git parent [--set B]` | Show or record the parent (the PR base). |
| `git sync-parent [--no-push]` | Fetch and merge the latest parent (local and GitHub) into the current branch; push it if the branch is on GitHub. |
| `git new-workspace N [--parent W \| --top] [--branch B] [--base B] [--agent A --prompt P]` | Create an Orca workspace for a stacked child: starts from the parent workspace's branch (or `--base`), records the parent. `--branch` names the branch; without it Orca names it. Pushes nothing. |
| `git ship N [N2 ...] [-m MSG] [-p PATH]... [-b BRANCH]... [--keep] [--ready] [--no-publish] [--dry-run]` | Move the current workspace's uncommitted changes into a child workspace N (N2 nested inside N; existing children with that name or branch are reused), commit there and publish. See below. |
| `git flow-status [project]` | Read-only tree of one project: Orca workspaces, branches, PR state, unpushed/behind, uncommitted, recorded stack parents. |
| `git flow-help` | List these commands and the pi skill options. |
| `git restore-workspace <branch> [--name N] [--parent P]` | Recreate a deleted Orca workspace on its existing branch (same PR). |
| `git abandon [B] [--yes] [--force]` | Close the PR, delete the GitHub branch, remove the worktree. |
| `branch_flow.py reconcile [project] [--delete-branches]` | After merges on GitHub: for stacked branches only, fast-forward clean worktrees, merge the parent back into merged branches, refresh the managed PR blocks, mark PRs of deleted workspaces. `--delete-branches` also deletes GitHub branches whose worktree is gone and whose newest PR is finished at the same tip. |

## Shipping a small fix from the current workspace

Working in `perplexity-research` you notice a small bug and fix it in place. Release it
separately:

```sh
git ship "Fix retry" -m "fix: retry on 429"                 # perplexity-research → Fix retry
git ship Bugs "Bug 1" -m "fix: …" -p src/client.py          # perplexity-research → Bugs → Bug 1
git ship "Fix retry" -b fix/retry-429 -m "fix: retry"       # choose the branch name
git ship Bugs "Bug 2" --dry-run                              # plan only; Bugs is reused
```

In pi ask the agent ("выпусти это как Bug 1 в Bugs"); it runs `git ship`.

Steps: snapshot the uncommitted changes (staged, unstaged and untracked, not ignored;
only `-p` paths if given) through a private index; create every missing workspace of the
chain (each a child of the previous one, started from its branch); commit the snapshot in
the last one with the normal `git commit` (project hooks run), via a three-way
`git merge-tree` if a reused workspace has moved on; remove exactly those changes from the
source (skipped with a warning if it changed meanwhile; `--keep` leaves them); then
`git publish` in the target (`--no-publish` skips it).

Safety: nothing leaves the source until the target commit exists; a conflict or a failed
commit hook stops before that and resets the (clean) target. A reused target must be
clean. Only uncommitted work moves.

## Deleting a workspace

- Work done: merge its PR, then delete the workspace in Orca. The GitHub branch stays until
  you delete it (GitHub's button, `git abandon`, or `reconcile --delete-branches`).
- Work not wanted: `git abandon` (closes the PR, deletes both branches and the worktree).
- Deleted in Orca with an open stacked PR: `reconcile` marks it draft and adds a note; close
  it on GitHub or bring the workspace back with `git restore-workspace <branch>`.
- Workspaces that the tool created or published are remembered in
  `orcaworkspace.<branch>.path`.

## Pull request text

- Title: the Orca workspace name, or the humanized branch name outside Orca. Renaming the
  workspace renames the PR on the next `git publish`, unless the title was edited on GitHub.
- Body: the workspace comment (Orca "Note") on creation, then a block between
  `<!-- branch-flow:start -->` and `<!-- branch-flow:end -->` rewritten by `git publish` and
  `reconcile`: the ancestor chain, the parent, child PRs as a checklist, earlier PRs of the
  same branch, the commit list. Text outside the block is never changed; PRs without the
  block are never edited by `reconcile`.

## Closed PRs

| Situation | Result of `git publish` |
|---|---|
| PR closed without merge, worktree still there | that PR is reopened (`branch.<name>.orcaPr`) |
| PR merged, work continues on the same branch | new PR; the block lists the merged one under earlier PRs |
| Old PR cannot be reopened | new PR, old one listed as earlier |

To undo a pushed commit use `git revert`; the guard blocks rewriting pushed history.

## Files (this repository)

- `tools/branch-flow/branch_flow.py` — the tool (installed as `~/.local/share/orca-branch-flow/branch_flow.py`
  plus the `git-*` commands in `~/.local/bin`); its `menu` text is what `git flow-help` and `/flow` show.
- `tests/test_branch_flow.py` — `python3 -m unittest discover -s tests`.
- `extensions/branch-flow.ts` — the pi `/flow` panels (they only run `git flow-help` / `git flow-status`).
- `skills/branch-flow/SKILL.md` — the `/skill:branch-flow` procedures, used only when the owner calls it.

The install paths and the `orca-branch-flow` marker keep their names, so hooks installed
before the move keep working.

## Install, activate, roll back

```sh
python3 tools/branch-flow/branch_flow.py install                    # ~/.local/share + git commands
python3 ~/.local/share/orca-branch-flow/branch_flow.py install-repo /path/to/repo   # pre-push guard
python3 ~/.local/share/orca-branch-flow/branch_flow.py uninstall-repo /path/to/repo
python3 ~/.local/share/orca-branch-flow/branch_flow.py uninstall
```

Upgrading from the automatic version: `install` removes the reconcile crontab line, and
`install-repo` removes the Orca setup hook (`orca.yaml` and its copies in every worktree,
`.worktreeinclude`), the `post-commit` auto-push hook, their `.git/info/exclude` lines,
`push.autoSetupRemote` and the `branchflow.autoPush/autoPr/cleanup` toggles. Only
untracked files carrying the `orca-branch-flow` marker are removed. Recorded
`branch.*.orcaParent` keys stay: they keep existing stacks working.

Compatibility: Python 3.11+, git 2.38+, `gh` authenticated for publishing, Orca CLI for
workspace commands. Repositories without a GitHub remote get only the guard;
`git publish` refuses there.

Never rename a branch that is the head of an open PR: GitHub closes the PR.
