# pi-setup

My personal [pi](https://github.com/earendil-works/pi) configuration for an Orca remote
server (headless Linux, used from the Orca ADE desktop app).

Forked from [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config) and
laid out the same way. The upstream extensions and skills were removed from this fork's
tree; they remain in upstream and in this repository's Git history.

This is **not** meant to be installed as one big package. Copy the pieces you want into
`~/.pi/agent`.

No credentials, sessions, or machine state are stored here (`auth.json`, `sessions/`,
`trust.json`, `models-store.json` stay local).

## Copy an extension

```bash
cp extensions/code-fence-hide.ts ~/.pi/agent/extensions/
```

Then restart pi or run `/reload`. Rollback: delete the file and `/reload`.

## Copy a skill

```bash
cp -r skills/branch-flow ~/.pi/agent/skills/
```

Then restart pi or run `/reload`.

## Settings

`settings.json` holds the portable fields of `~/.pi/agent/settings.json` (default
model/provider, thinking levels, markdown, packages). Merge them by hand; do not overwrite
the live file (pi writes runtime fields such as `lastChangelogVersion` into it).
`npm/package.json` mirrors `~/.pi/agent/npm/package.json` for pi packages
(`pi install npm:@indexyz/pi-skill@0.1.44`).

## Do not clone over your config

Avoid cloning this repo into `~/.pi/agent`. Copy individual files instead.

## Contents

### Extensions

- `branch-flow.ts` — `/flow` and `/flow status [project]` panels (output of
  `git flow-help` / `git flow-status`) without calling the model; auto-loads the
  branch-flow skill in repositories with a GitHub remote
- `code-fence-hide.ts` — renders fenced code blocks without the ``` lines (like Claude
  Code); pair with `"markdown": { "codeBlockIndent": "" }`
- `image-paste-markers.ts` — pasted screenshots show as `[Image #N]` and are attached to
  the prompt as images
- `orca-kitty-images.ts` — keeps inline Kitty images intact in Orca's terminal

### Skills

- `branch-flow/` — operating the Orca workspace ↔ GitHub branch flow (publish, ship,
  merge, sync, status…); needs the `orca-branch-flow` tooling from the orca-setup repo.
  **Tightly coupled to Orca**, see [Branch flow and Orca](#branch-flow-and-orca)
- `perplexity-research/` — web research through the Perplexity bridge in Orca's browser
  (adjust the `cli.py` path to your checkout)

### Instructions

- `instructions/AGENTS.md` — Orca server context and branch-flow rules; deployed as
  `~/orca/AGENTS.md`, which pi loads for every project under `~/orca`

### Orca-managed (reference only)

`orca-managed/` holds files that Orca generates and updates itself: the pi extensions
`orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts`
(`~/.pi/agent/extensions/`, marked `@orca-managed-pi-extension`) and the skills
`orca-cli`, `orca-computer-use`, `orchestration` (`~/.agents/skills/`). They are kept for
reference and diffing. **Do not copy them back**; Orca restores its own versions.

## Branch flow and Orca

The branch-flow skill, the `branch-flow.ts` extension and the underlying
`branch_flow.py` tooling are currently **tightly coupled to Orca**: a workspace is an
Orca worktree, and workspaces are created, found, listed and linked to PRs through the
`orca` CLI.

Without Orca only the git/GitHub part works: `git publish`, `git sync-parent`,
`git parent --set`, the `pre-push` guard, automatic PR chains and `git abandon`.
These do not work without Orca: `new-workspace`/`child`/`top`, `ship`, `restore`,
`move`, `rename`, `remove`, `orphans`, the workspace tree in `status`, and the
`reconcile` cron job (it silently does nothing, because it only walks Orca worktrees).

A standalone, Orca-independent workflow (plain `git worktree` backend selected
automatically when Orca is absent) is planned; until then, use this part only on an
Orca server.

## Dependencies

- pi (`@earendil-works/pi-coding-agent`) 1.5+
- Orca ADE with `orca` CLI for the Orca-specific pieces
- `git`, `gh`, Python 3 for branch-flow and perplexity-research
