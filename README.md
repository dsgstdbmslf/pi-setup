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
(not `web-fetch.ts`, which needs its folder and npm dependencies; see below).
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

- `web-fetch.ts` — `web_fetch` tool: fetches an http(s) URL with browser-like headers and
  returns markdown (Readability + Turndown for HTML, `unpdf` for PDF, text as is). Logic
  lives in `extensions/web-fetch/`; needs the package's npm dependencies, which
  `pi install` installs.
  - Output: the agent gets a preview of at most 400 lines / 12KB (about 3k tokens) plus a
    short truncation note listing the remaining headings (up to 40) with their line numbers
    in the saved file. Only when the preview cuts something is the full *extracted* text saved to a
    private temp dir (`/tmp/pi-web-fetch-*/page.md`) the agent can `read` (for a PDF that
    hit its text cap, this is the capped extract, not the whole PDF). Saved pages older
    than a day are removed at a later session start, not at an exact time. Links and
    images are made absolute, without `utm_*` parameters; links to the same page, heading
    permalinks (`#`, `¶`) and images without alt text are dropped to save tokens; terminal
    escape sequences are stripped.
  - Limits: body 5MB (PDF 20MB), read while streaming. The declared type decides: PDF and
    text types are read, other known types (images, archives...) are refused unread; a
    missing or generic type is sniffed from its first bytes (`%PDF-` gets the PDF budget).
    10 redirects (301/302/303/307/308 only, each target checked like the input URL).
    PDF: text of the first 100 pages, at most 2,000,000 characters of extracted text
    (the short `Pages:` line is extra), no OCR; a scan says "no text layer". HTML deeper
    than 200 levels or with over 60,000 elements is not converted (the DOM is still
    built first).
  - Time and memory: 30s per request, 120s per call, both cooperative. Waiting for HTTP,
    DNS and the model stops at the deadline or on Esc; PDF extraction checks for
    cancellation between PDF.js steps (best effort). Parsing runs synchronously inside
    pi's process, without worker or memory cap: a step already running (HTML parsing, a
    PDF.js call) finishes first, so a hostile page can still cost CPU and memory and
    delay the timeout or Esc. The page and text caps limit what is kept, not PDF.js's
    own memory.
  - Jina fallback: when a page cannot be read directly (JS-rendered, blocked, cut off),
    the URL goes to the public reader `r.jina.ai` only if every URL of the redirect chain
    passes the rules (no credentials, no secret-looking parameters such as
    `token`/`client_secret`/`X-Amz-Signature`, no token-like value or path segment (also
    percent-decoded; malformed escapes refuse), no file-sharing host, a host that resolves
    only to public IPs, no 401/407) and then a model answers exactly "public" (a
    classifier model must give p(private) ≤ 0.2; errors, cut-off or unclear answers
    refuse). The fragment (`#...`) is never sent.
    Jina answers with an upstream error (such as 404) count as failures.
  - Limits of this check: it reduces leaks but does not prove a URL is public. The rules
    and the model can miss a capability link; the model's provider sees the URLs (it can
    be another provider than the session's); DNS is checked by a separate lookup, not
    bound to the connection or to Jina's own resolver, so DNS rebinding or split-horizon
    names can fool it; Jina may follow redirects of its own. A p(private) ≤ 0.2 is a
    model's estimate, not a guarantee. Turn the fallback off with
    `PI_WEB_FETCH_JINA=0` for sensitive work.
  - `/web-fetch-classifier` picks that model in a searchable list like `/model` (type to
    filter; `/web-fetch-classifier haiku` opens it pre-filtered, an exact `provider/id` or
    `auto` is saved directly). `auto` uses the first classifier model with credentials,
    else the session model. The choice is saved in `~/.pi/agent/web-fetch.json` and
    applies to every session (if two saves overlap, the last one to finish wins; a broken
    file is reported, not replaced). `PI_WEB_FETCH_CLASSIFIER=provider/id` overrides it.
    The tokens and cost the provider reports for the model call are added to the tool
    result's usage, also when the call later fails or is cancelled.
  - Manual install without `pi install`: the file needs its `web-fetch/` folder and the
    npm dependencies. Clone this repository to `~/.pi/agent/extensions/pi-setup/` and run
    `npm ci --omit=dev --legacy-peer-deps` there (pi provides its own packages); its
    `package.json` manifest then loads the extensions from `extensions/`.

### Settings

- `settings.json` — default provider/model, thinking levels, markdown, packages
- `npm/package.json` — pi package `@indexyz/pi-skill` (`$skill` mentions)

### Instructions

- `instructions/AGENTS.md` — global git rules: no push, pull request or merge unless
  asked; no force-push or history rewriting; never bypass hooks

## Rollback

`pi remove git:github.com/dsgstdbmslf/pi-setup`, delete `~/.pi/agent/AGENTS.md` (or
restore your previous one), revert the merged settings fields, then `/reload`.

## Development

`npm install` (dev dependencies include pi itself, for the tests), then `npm test`.
`package-lock.json` pins the tree that `pi install` gets (`--omit=dev --legacy-peer-deps`).

## Dependencies

- pi (`@earendil-works/pi-coding-agent`) 1.5+
- `git` (for `pi install git:...`)
