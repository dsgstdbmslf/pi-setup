# Proxy and API gateway (prepared, not enabled)

Nothing here is configured. This page lists what to set once a proxy is chosen. Both
options below need pi 1.5.1 or newer.

## Network proxy

Use this when the server must reach the internet through an HTTP(S) proxy.

- `httpProxy` in `~/.pi/agent/settings.json` (agent-directory settings only; a project
  `.pi/settings.json` cannot set it): pi exports it as `HTTP_PROXY` and `HTTPS_PROXY` for
  its HTTP clients.
- Or set `HTTPS_PROXY` / `HTTP_PROXY` in the environment that starts pi.
- `NO_PROXY` lists hosts that bypass the proxy (for example `localhost,127.0.0.1`). Keep
  local addresses there so Orca and local model servers stay direct.

pi installs undici's `EnvHttpProxyAgent` as the global `fetch` dispatcher
(`dist/core/http-dispatcher.js`), so `fetch` calls from extensions (Tavily, web tools) use
the same proxy and `NO_PROXY` rules. Traffic that does not use global `fetch` (child
processes such as `git`, `npm`) follows the environment variables only.

```json
{ "httpProxy": "http://proxy.example:3128" }
```

## API gateway

Use this to send model requests to a gateway (LiteLLM and similar) instead of the
provider. Define the provider in `~/.pi/agent/models.json` with a `baseUrl` and, where the
gateway needs it, `compat` fields (see pi's `docs/models-configuration.md`). The 1.5.1
fields:

| Field | Set it when |
| --- | --- |
| `supportsMessageThreads` | the gateway forwards the Anthropic thread request field (default: true only for `api.anthropic.com`) |
| `requiresToolsWithToolHistory` | the gateway rejects requests without `tools` when history has tool calls (older LiteLLM in front of Anthropic): sends `"tools": []` |
| `promptCacheKeyMode` | `"enabled"` for gateways that accept `prompt_cache_key`, `"disabled"` for ones that reject it (default `"auto"`) |
| `requiresNonNullAssistantContent` | the gateway rejects `null` content on tool-call-only assistant messages: sends `""` |

Do not store keys in `models.json` in this repository; use `pi auth login` or environment
variables.

## Checks after choosing a proxy

1. `pi --version` is 1.5.1 or newer; the settings file still parses
   (`node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.pi/agent/settings.json"))'`).
2. `pi auth check --provider <provider>` prints `ready`.
3. Start pi, send a short prompt: the model answers through the proxy (check the proxy
   log).
4. Use an extension that calls `fetch` (`web_search`): its request appears in the proxy
   log too.
5. A request to a host in `NO_PROXY` does not appear in the proxy log.
6. With a gateway: a prompt that calls a tool and a follow-up turn both succeed; adjust
   `compat` fields on errors about `tools`, `null` content or `prompt_cache_key`.
7. Roll back by removing `httpProxy` / the `models.json` entry and restarting pi.
