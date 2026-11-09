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

Single files work too: `cp extensions/code-fence-hide.ts ~/.pi/agent/extensions/`.
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

- `tavily-keys.ts` — `/search-keys` command for the [Tavily](https://tavily.com) API
  keys used by the web extensions: `/search-keys` (status) checks each key and its
  remaining credits and clears marks of keys that have credits again, `reset` forgets
  all marks, `init` creates the key file. Shared code for the web extensions lives in
  `extensions/tavily/` (pi loads only `extensions/*.ts`, so it is not an extension by
  itself; copy the folder too when installing single files): key pool with failover,
  REST client, output capped at 32 KB with the full text saved to a temp file.

  API keys live in `~/.pi/agent/api-keys.json`, outside the package, so `pi update`
  never touches them. The file is shared by services (`{ "tavily": [...] }`); see
  `api-keys.example.json`. Create it with `/search-keys init` (mode 600), then add
  your keys from <https://app.tavily.com>. Never commit the real file: `.gitignore`
  excludes `api-keys.json`.

  Keys are used in file order. A key that runs out of credits (HTTP 432/433) is
  skipped until the 1st of next month (UTC), an invalid key (401) until it changes,
  a rate-limited key (429) until `Retry-After`; the request is retried at once with
  the next key. Other errors fail without switching. Marks are kept in
  `~/.pi/agent/api-keys-state/` (one file per marked key, named by its fingerprint,
  never the key); rate-limit marks stay in memory and are shared by all web
  extensions of one pi process.
  Tools that allow it fall back to Tavily's rate-limited keyless mode when no key works.

- `web-search.ts` — `web_search` tool on Tavily: title, date, URL and the most
  relevant excerpts of each result, with filters by domain, date (`time_range`), topic
  (general, news, finance) and exact phrases. Defaults are economical: 5 results,
  `basic` depth (1 credit; `advanced` costs 2). Works without a key in Tavily's
  rate-limited keyless mode. Needs `tavily-keys.ts` for `/search-keys` and the shared
  `extensions/tavily/`; logic lives in `extensions/web-search/`

- `web-fetch.ts` — page reading tools on Tavily: `web_extract` (clean markdown of 1-20
  URLs, JavaScript-heavy pages included; with `query` only the passages relevant to it),
  `web_map` (URLs of a site, no content) and `web_crawl` (markdown of the pages of a site
  section). Defaults are small: `basic` depth, map 50 URLs, crawl 10 pages, one link level,
  same domain only. `web_extract` works keyless; map and crawl need a key. Replaces the
  deprecated `web_fetch`. Needs `tavily-keys.ts` and `extensions/tavily/`; logic lives in
  `extensions/web-fetch/`

### Settings

- `settings.json` — default provider/model, thinking levels, markdown, packages
- `npm/package.json` — pi package `@indexyz/pi-skill` (`$skill` mentions)

### Instructions

- `instructions/AGENTS.md` — global git rules: no push, pull request or merge unless
  asked; no force-push or history rewriting; never bypass hooks

### Deprecated

`deprecated/` holds extensions that are no longer in active use, like upstream's. They
still work, but pi does not load them from this repository (only `extensions/*.ts`);
copy one by hand to use it. Kept for reference.

- `deprecated/extensions/web-fetch/` — `web_fetch` tool: URL to markdown (HTML, PDF,
  text) with a 12KB preview and a privacy-checked Jina fallback. Replaced by Tavily;
  see its [README](deprecated/extensions/web-fetch/README.md) for install and details

## Rollback

`pi remove git:github.com/dsgstdbmslf/pi-setup`, delete `~/.pi/agent/AGENTS.md` (or
restore your previous one), revert the merged settings fields, then `/reload`.

## Dependencies

- pi (`@earendil-works/pi-coding-agent`) 1.5+
- `git` (for `pi install git:...`)
