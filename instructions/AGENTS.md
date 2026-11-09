# Global instructions

## Git and GitHub

The project's own instructions win where they define a git workflow.
- Work on the current branch. Create, switch or rename branches only when the user asks.
- Commit when the task calls for it. Pushing, opening or editing pull requests, merging,
  closing pull requests and deleting branches happen only when the user asks.
- Never force-push or rewrite pushed history; undo pushed commits with `git revert`.
- Never bypass git hooks (`--no-verify`). If a hook refuses or warns, stop and report it.
