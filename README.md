# pi-setup

My personal [pi](https://github.com/earendil-works/pi) configuration: extensions,
settings and global instructions. It installs on a clean pi and needs nothing else.

Forked from [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config) and
laid out the same way. The upstream extensions and skills were removed from this fork's
tree; they remain in upstream and in this repository's Git history.

No credentials, sessions, or machine state are stored here (`auth.json`, `sessions/`,
`trust.json`, `models-store.json` stay local).

## Install

1. Extensions, as a pi package:

   ```bash
   pi install git:github.com/dsgstdbmslf/pi-setup
   ```

   Pi clones the repository and loads every extension in `extensions/` (see
   `package.json`). Update with `pi update`, remove with
   `pi remove git:github.com/dsgstdbmslf/pi-setup`. To load only some extensions, use
   the object form in settings (`"extensions": ["extensions/code-fence-hide.ts"]`) or
   `pi config`.

2. Settings: merge the fields of `settings.json` into `~/.pi/agent/settings.json` by hand.
   Do not overwrite the live file: pi writes runtime fields (such as
   `lastChangelogVersion`) and the package list into it. The `packages` entry installs
   `npm:@indexyz/pi-skill` on the next start; `npm/package.json` mirrors
   `~/.pi/agent/npm/package.json` for reference.

3. Global instructions:

   ```bash
   cp instructions/AGENTS.md ~/.pi/agent/AGENTS.md
   ```

   Pi loads them in every session. Merge by hand if the file already exists.

Then restart pi or run `/reload`.

Single files work too: `cp extensions/code-fence-hide.ts ~/.pi/agent/extensions/`
(not `web-fetch.ts`, which needs its folder and npm dependencies).
Do not install both ways at once, or the extension loads twice.

## Contents

### Extensions

- `code-fence-hide.ts` — renders fenced code blocks without the ``` lines (like Claude
  Code); pair with `"markdown": { "codeBlockIndent": "" }` from `settings.json`
- `image-paste-markers.ts` — pasted screenshots show as `[Image #N]` and are attached to
  the prompt as images. Recognizes pi's own `pi-clipboard-*` files and `<app>-paste-*`
  files that terminal apps save for pasted images

- `ask-user-question.ts` — `ask_user_question` tool: the agent pauses and asks you one or
  several questions (tabs + review step). Each is free text, single choice or multi-select,
  with an "Other" custom answer (multi-line). Keys: ↑↓, Enter, Space, 1-9, ←/→, Esc;
  Tab adds a comment to the highlighted option. Optional `defaultAnswer` per question
  (used only without a UI) and `timeoutSeconds` (on timeout the run stops); the UI is English or Russian (system locale, or `PI_ASK_LANG=en|ru`).
  Logic lives in `extensions/ask-user-question/`; tests: `npm test`

- `web-fetch.ts` — `web_fetch` tool: fetches a URL with browser-like headers and returns
  markdown (Readability + Turndown for HTML, `unpdf` for PDF, text as is). Output to the
  agent is capped at 32KB; the full text is saved to a temp file the agent can `read`.
  Body size is limited while streaming (5MB, PDF 20MB). When a page cannot be read
  directly (JS-rendered, blocked), it falls back to the public reader `r.jina.ai`, but only
  if the URL looks public: http(s), no credentials or token-like query parameters, a host
  that resolves to public IPs, no 401, and a model agrees the URL is public (a classifier
  model if one is available, otherwise the session model; any doubt means no Jina).
  `/web-fetch-classifier` picks that model in a searchable list like `/model` (type to
  filter; `/web-fetch-classifier haiku` opens it pre-filtered, an exact `provider/id` or
  `auto` is saved directly). The choice is saved in `~/.pi/agent/web-fetch.json` and
  applies to every session. `PI_WEB_FETCH_CLASSIFIER=provider/id` overrides it, and
  `PI_WEB_FETCH_JINA=0` turns the fallback off. Logic lives in `extensions/web-fetch/`. Needs the package's npm
  dependencies (`pi install` installs them; for a single-file copy run `npm install`)

### Settings

- `settings.json` — default provider/model, thinking levels, markdown, packages
- `npm/package.json` — pi package `@indexyz/pi-skill` (`$skill` mentions)

### Instructions

- `instructions/AGENTS.md` — global git rules: no push, pull request or merge unless
  asked; no force-push or history rewriting; never bypass hooks

## Rollback

`pi remove git:github.com/dsgstdbmslf/pi-setup`, delete `~/.pi/agent/AGENTS.md` (or
restore your previous one), revert the merged settings fields, then `/reload`.

## Dependencies

- pi (`@earendil-works/pi-coding-agent`) 1.5+
- `git` (for `pi install git:...`)
