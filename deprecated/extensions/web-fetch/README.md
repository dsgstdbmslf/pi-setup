# web-fetch (deprecated)

`web_fetch` tool: fetches an http(s) URL with browser-like headers and returns markdown
(Readability + Turndown for HTML, `unpdf` for PDF, text as is).

Deprecated: reading pages moves to Tavily (`web_extract`). Kept for reference; it still
works, but pi does not load it from this repository.

## Install

Copy the folder and install its dependencies (pi provides its own packages):

```bash
cp -r deprecated/extensions/web-fetch ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions/web-fetch
npm ci --omit=dev --legacy-peer-deps
```

Then restart pi or run `/reload`.

## Details

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

## Development

`npm install --legacy-peer-deps` (dev dependencies include pi itself, for the tests), then
`npm test`.
