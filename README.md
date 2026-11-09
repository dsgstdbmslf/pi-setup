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

Every item is tagged with how much it depends on Orca:

- **[Orca-only]** — does nothing useful without Orca
- **[Orca-partial]** — works without Orca, but some features need it
- **[Independent]** — plain pi, works anywhere

### Extensions

- `branch-flow.ts` **[Orca-partial]** — `/flow` and `/flow status [project]` panels
  (output of `git flow-help` / `git flow-status`) without calling the model. Needs the
  branch-flow tooling (see [Branch flow and Orca](#branch-flow-and-orca)); it does not
  load the skill into the agent's context
- `code-fence-hide.ts` **[Independent]** — renders fenced code blocks without the ```
  lines (like Claude Code); pair with `"markdown": { "codeBlockIndent": "" }`
- `image-paste-markers.ts` **[Orca-partial]** — pasted screenshots show as `[Image #N]`
  and are attached to the prompt as images. Recognizes Orca's `/tmp/orca-paste-*` files
  and pi's own `pi-clipboard-*` files, so pi's native paste works without Orca
- `orca-kitty-images.ts` **[Orca-only]** — keeps inline Kitty images intact in Orca's
  terminal; a no-op unless `TERM_PROGRAM=orca`

### Skills

- `branch-flow/` **[Orca-only]** — stacked PRs for Orca workspaces on request
  (publish, ship, merge, sync, status…), called only with `/skill:branch-flow`; needs the
  branch-flow tool from `tools/branch-flow/`. See [Branch flow and Orca](#branch-flow-and-orca)
- `perplexity-research/` **[Orca-only]** — web research through Perplexity, driven in
  Orca's embedded browser by the Perplexity bridge from the orca-setup repo
  (`mcp/servers/perplexity`). The `cli.py` path points to an Orca workspace of that
  repo; adjust it to your checkout

### Tools

- `tools/branch-flow/branch_flow.py` **[Orca-partial]** — the branch-flow tool behind the
  skill and `/flow`: `git publish`, `git ship`, `git sync-parent`, `git flow-status`,
  `git flow-help` and the other `git-*` commands, plus the `pre-push` guard. Tests:
  `tests/test_branch_flow.py`; runbook: [docs/branch-flow.md](docs/branch-flow.md).
  Install: `python3 tools/branch-flow/branch_flow.py install`, then
  `python3 ~/.local/share/orca-branch-flow/branch_flow.py install-repo <project>` per repository

### Instructions

- `instructions/AGENTS.md` **[Orca-only]** — Orca server context (headless server, Orca
  browser and CLI, pasted images) and git rules (no push/PR without the owner's request,
  stacked PRs through the branch-flow commands); deployed as `~/orca/AGENTS.md`,
  which pi loads for every project under `~/orca`

### Settings

- `settings.json` **[Independent]** — default provider/model, thinking levels, markdown,
  packages
- `npm/package.json` **[Independent]** — pi package `@indexyz/pi-skill` (`$skill` mentions)

### Orca-managed (reference only) **[Orca-only]**

`orca-managed/` holds files that Orca generates and updates itself: the pi extensions
`orca-agent-status.ts` (agent status for Orca), `orca-prefill.ts` (editor prefill on
launch from Orca), `orca-titlebar-spinner.ts` (tab title spinner)
(`~/.pi/agent/extensions/`, marked `@orca-managed-pi-extension`) and the skills
`orca-cli`, `orca-computer-use`, `orchestration` (`~/.agents/skills/`). They are kept for
reference and diffing. **Do not copy them back**; Orca restores its own versions.

## Branch flow and Orca

Branch flow no longer changes how Orca works: Orca names workspaces and branches and picks
the base as usual, and nothing is pushed or PR'd automatically. The skill, the
`branch-flow.ts` panels and the `tools/branch-flow/branch_flow.py` tool (all in this
repository) only build stacked draft PRs
(child → parent → main) when the owner asks. A `pre-push` guard refuses force-pushes and
branch deletion.

Without Orca only the git/GitHub part works: `git publish`, `git sync-parent`,
`git parent --set`, the `pre-push` guard and `git abandon`. These need Orca:
`new-workspace`/`child`/`top`, `ship`, `restore`, `move`, `rename`, `remove`, `orphans`,
the workspace tree in `status`, and `reconcile` (it walks Orca worktrees).

## Dependencies

- pi (`@earendil-works/pi-coding-agent`) 1.5+
- Orca ADE with `orca` CLI for the Orca-specific pieces
- `git`, `gh`, Python 3 for branch-flow and perplexity-research
