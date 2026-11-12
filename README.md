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

Sign in to a provider with `pi auth login <provider>` (sign out with `pi auth logout
<provider>`). On a headless server add `--no-browser`: pi then uses the provider's other
sign-in method, such as a device code, instead of opening a browser. It cannot be combined
with `--api-key`.

If a session's working directory no longer exists (for example after a folder rename),
interactive pi asks how to open it: `Continue` runs it in the current directory and asks
again next time; `Fork` copies it into the current directory with a new ID, so later
resumes no longer ask; `Cancel` leaves things as they are. Other modes exit with an error.

Single files work too: `cp extensions/code-fence-hide.ts ~/.pi/agent/extensions/`.
Do not install both ways at once, or the extension loads twice.

## Contents

### Extensions

- `code-fence-hide.ts` — renders fenced code blocks without the ``` lines (like Claude
  Code) on every Markdown surface, changelog included; pair with
  `"markdown": { "codeBlockIndent": "" }` from `settings.json`. Tests:
  `test/code-fence-hide.test.ts` (fails if the pi-tui API it patches moves)
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
  Responses over 8 MiB (after decompression) are refused and the read is cancelled; a very
  long page is cut at 200,000 characters. Server error texts are shown (up to 300 characters)
  only when plain and token-free, otherwise a fixed status label; marks store no server text.

  Proxy: pi sets one for all its HTTP traffic from its `httpProxy` setting (or
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`), and Tavily follows it by default. To connect to
  Tavily directly instead, set `"tavily": { "proxy": false }` in `~/.pi/agent/settings.json` (or
  the project settings); `true` (default) follows pi. Edit, then `/reload`. A value that is not a
  boolean is reported (also in tool results and `/search-keys`) and treated as `true`.
  `NO_PROXY=api.tavily.com` in the environment also bypasses the proxy while `tavily.proxy` is
  left at its default. The direct connection uses pi's `httpIdleTimeoutMs`. `/search-keys` shows
  the route on its `network:` line (`via proxy host:port`, never credentials, or `direct`). Proxy
  error pages and texts with credentials in a URL are withheld like any server text; a 407 reads
  "proxy authentication required". `false` needs pi's bundled `undici`; if it cannot be found,
  Tavily requests fail with a message instead of silently using the proxy. The agent and the
  warnings are shared by all web extensions of one pi process.

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

- `bitwarden-ssh.ts` — SSH from a headless server with keys and config kept in
  [Bitwarden](https://bitwarden.com): Bitwarden CLI login, SSH keys from the vault loaded
  into a shared `ssh-agent`, masked pi dialogs for password prompts of ssh, sudo and git,
  and `~/.ssh/config` synced through a Bitwarden Secure Note. Needs the `bw` CLI and the
  OpenSSH client; logic lives in `extensions/bitwarden-ssh/` (copy it too when installing
  single files). Tests: `node --test test/bitwarden-ssh*.test.ts`

  Commands (with completions):
  - `/bw` (`/bw status`): vault state, account, server, last sync, agent socket, loaded
    keys, auto-lock time. `/bw login` (API key, recommended, or email + master password
    with two-step code), `/bw unlock` (masked dialog, 3 attempts), `/bw lock` (also empties
    the agent), `/bw sync`, `/bw logout` (asks first), `/bw server <url>` (logged out only).
    `!bw login|unlock|lock|status` run these handlers too, since bw cannot prompt there.
  - `/ssh list` (vault SSH keys, ● loaded / ○ not; from a cache while locked),
    `/ssh add [name|all|host]` (a host loads the keys its config uses), `/ssh rm [name]`,
    `/ssh clear`, `/ssh test [host]` (`ssh -T`, 10 s connect timeout), `/ssh hosts`.
  - `/ssh config pull` (note -> local config, maps keys, regenerates, adds the Include;
    the exact generated config that would be installed is checked with `ssh -G` first, and
    a note with unterminated quotes, an `IdentityFile` with extra arguments or any error
    `ssh -G` reports is refused with the local and generated config kept; edits too),
    `/ssh config push` (local -> note, asks first), `/ssh config edit`, `/ssh config show`,
    `/ssh config map` (choose the Bitwarden key for each `IdentityFile`).
  - Footer: `🔐 unlocked · N keys`, `🔒 locked · N keys`, `bw: logged out` or
    `bw: not installed`.

  Tools for the agent: `ssh_keys` (status, list, load, unload) and `ssh_config` (list,
  get, add, update, remove, pull, push). Loading a key, changing or removing a host, pull
  and push open a confirm dialog; adding a host does not. Two pi processes share the
  config: a change confirmed in one while another already wrote the file is refused with
  "SSH config changed in another pi session; retry" (writes, state and regeneration run
  under an OS advisory lock on `config.lock`, held by a small `flock`/`lockf`/`perl` child
  process; the kernel drops it when pi exits or crashes, a stopped pi keeps it and others
  give up after 30 s with "another pi session holds config.lock; try again"; lock files
  are kept, never deleted). Results carry names and
  fingerprints, never key material. When a `bash` command or a `!` command names a
  configured host whose key is not loaded (`ssh web`, `git clone ssh://git@web/x`,
  `rsync f web:`), pi offers to load it first; declining runs the command anyway.

  Settings, in `~/.pi/agent/settings.json` (then `/reload`); invalid values are reported
  and replaced by the default:

  ```json
  "bitwardenSsh": { "keyTtl": "8h", "autoLockMinutes": 30, "configNote": "ssh-config", "controlPersist": "10m" }
  ```

  `keyTtl` is the `ssh-add -t` lifetime (`"0"` = none), `autoLockMinutes` forgets the
  vault session after that much idle time (`0` = never), `configNote` names the Secure
  Note, `controlPersist` (`false` = off) is used by the generated connection-sharing block.

  Lifetimes: one `ssh-agent` per user at `~/.pi/agent/bitwarden-ssh/run/ssh-agent.sock`
  (or `/tmp/pi-bw-<uid>/` when that path is too long for a socket: 104 bytes on macOS, 108 on
  Linux; `/tmp`, not macOS's long `$TMPDIR`), shared by all pi
  processes and kept after pi quits; pi sets `SSH_AUTH_SOCK` to it, so an agent that was
  set before (such as a forwarded one) is not used inside pi (`/bw status` shows it). Keys
  expire by `keyTtl`. The Bitwarden session key lives only in the memory of each pi process
  (it survives `/new`, `/resume`, `/fork` and `/reload`), is forgotten after the idle time
  and on quit, and is never put into pi's environment, so the agent's `bw` calls stay
  locked. `bw unlock` in one process ends the session of the others (bw keeps one
  session-protected key per account): the other pi then reports the vault locked and asks
  again.

  Password prompts: `SSH_ASKPASS`, `SUDO_ASKPASS` and `GIT_ASKPASS` point to a small node
  client (`run/askpass`, with `SSH_ASKPASS_REQUIRE=force`) that asks pi over a private
  Unix socket; pi shows a masked dialog (host key questions as yes/no, `Username` prompts
  visible) with "Requested by (unverified): <command line>" and the warning "the program
  that asked will receive what you type", and the answer goes straight back to the client
  that asked. Plain `sudo` runs `sudo -A` through a shim in `run/bin`, first in `PATH`.
  Without a UI (print mode) prompts fail instead of hanging. Dialogs of a session that
  ends (`/reload`, `/new`, `/resume`, `/fork`, quit) are cancelled.

  Secret input (master password, API client secret, passphrases and passwords asked through
  askpass) needs the interactive TUI: in RPC mode pi only has an unmasked input, so these
  prompts fail closed ("secret input needs the interactive TUI"): unlock and login are
  refused, tools return that error and askpass prompts are cancelled. Visible prompts
  (`Username`, emails, confirmations) still work there.

  Files: `~/.pi/agent/bitwarden-ssh/` holds `state.json` (identity mapping and a cache of
  key names, fingerprints and public keys) and `config` (the synced config as on your
  computer). `~/.ssh/pi-bitwarden/` holds the generated `config`, public keys in `keys/`
  (private keys only go into the agent) and ControlMaster sockets in `cm/` (in
  `/tmp/pi-bw-<uid>/cm/` when the home path is too long for a socket path). Files are
  mode 600, directories 700. `~/.ssh/config` gets one line at the top,
  `Include ~/.ssh/pi-bitwarden/config` (absolute path), created if missing; only such an
  Include before the first `Host`/`Match` counts (a copy inside a block is left alone and
  the line is still added); nothing else in it changes. The config is read like OpenSSH
  does: `# comments` after values and single or double quotes are understood. When generating, `IdentityFile` paths mapped to a Bitwarden key become the
  key's `.pub` file plus `IdentitiesOnly yes`; macOS-only `UseKeychain`, an `IdentityAgent`
  path missing here, and an `Include` of the generated file are commented out; unless the
  config sets `ControlMaster`, a `Host *` block with `ControlMaster auto`, `ControlPath
  ~/.ssh/pi-bitwarden/cm/%C` and `ControlPersist` is appended. Edit with `/ssh config
  edit` or `ssh_config`, not the generated file. ssh uses the first value it finds, and the
  Include comes first, so for the same option the synced config wins over the rest of
  `~/.ssh/config`.

  Setup on your computer: store each SSH key as a Bitwarden item of type "SSH key", named
  like the key file (`id_ed25519`, `github` for `~/.ssh/github`; spaces may stand for `_`
  or `-`); other names can be mapped with `/ssh config map`. Put `~/.ssh/config` into a
  Secure Note named `ssh-config`, with the Bitwarden app or the CLI:

  ```bash
  bw get template item | jq --rawfile cfg ~/.ssh/config \
    '.type=2 | .secureNote={type:0} | .login=null | .name="ssh-config" | .notes=$cfg' \
    | bw encode | bw create item
  ```

  Then on the server: `/bw login`, `/ssh config pull`, `/ssh add <host>`.

  Threat model: secrets stay out of the LLM context, out of files and out of logs; they
  exist only in local variables and in the stdin or environment of the one child that
  needs them (`bw`, `ssh-add`). Not covered: a process of the same user can read a `bw`
  child's environment while it runs (well under a second) and can use the shared agent
  socket like any ssh-agent. The askpass socket is just as open: any process of the same
  user, including commands the agent runs in its `bash` tool, can connect and ask, and it
  receives what you type. The requester shown in the dialog is what the client claims (a
  pid and its command line, which the starter of a process chooses), so it is labelled
  unverified and the warning is always shown; "not started from this pi session" is added
  when the claimed process does not descend from this pi, but its absence proves nothing.
  Only answer prompts you expect. A two-step login code is passed to `bw` as an argument (bw has no other way);
  it is single-use.

  Limitations: one bw session per account across processes (see above); ControlPersist
  keeps a connection (and its key's use) open up to 10 minutes after the last session;
  Bitwarden notes hold at most 10,000 characters (pull and push warn above 9,000);
  `ssh -G` reads the passwd home directory, not `$HOME`.

### Settings

- `settings.json` — default provider/model, thinking levels, markdown, packages
- Prompt cache warming: the 1.5.1 default `"cacheWarming": "idle"` is kept, so
  `settings.json` has no such key. Set `"cacheWarming": "streaming"` to restore the
  pre-1.5.1 behavior
- Proxy and API gateway: not enabled; see [docs/proxy.md](docs/proxy.md)
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
- `deprecated/extensions/orca-kitty-images/` — set `WEZTERM_PANE` in Orca so fullscreen
  drew Kitty images after text. pi 1.5.1 does this itself; see its
  [README](deprecated/extensions/orca-kitty-images/README.md)

## Rollback

`pi remove git:github.com/dsgstdbmslf/pi-setup`, delete `~/.pi/agent/AGENTS.md` (or
restore your previous one), revert the merged settings fields, then `/reload`.

## Dependencies

- pi (`@earendil-works/pi-coding-agent`) 1.5+; tested on 1.5.2
- `git` (for `pi install git:...`)
- `bitwarden-ssh.ts`: Linux and macOS. The Bitwarden CLI `bw` (tested with 2026.10.1), the
  OpenSSH client (`ssh`, `ssh-add`, `ssh-agent`; 8.4+ for `SSH_ASKPASS_REQUIRE`; tested
  with 9.6) and, for the cross-process lock, `flock` (Linux, util-linux), `/usr/bin/lockf`
  (macOS, built in) or `perl` (fallback on either); without one of them config changes and
  agent startup fail with a clear error. `ps` is used on macOS for the askpass requester
  hint (`/proc` on Linux). Tested on Linux only; macOS paths are covered by unit tests
