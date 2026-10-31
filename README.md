# ai-proxy

A Claude Messages-compatible proxy, written in TypeScript for Bun, that serves three upstreams through one endpoint:

- **OpenAI**, through Codex OAuth (a ChatGPT subscription) or an OpenAI API key.
- **Anthropic Claude**, through Claude Code OAuth or an Anthropic API key.
- **Google Gemini**, through Gemini CLI OAuth or an AI Studio API key.

Claude Code and similar clients point at the proxy and can then use any model from any of these backends. Requests are translated to each upstream's API and the answers are translated back, including streaming, tool calls and thinking.

It is a reduced port of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). OAuth tokens are stored in HashiCorp Vault (KV v2) or, for development, in local JSON files.

## Quick start

```bash
bun install
```

```bash
cp config.example.yaml config.yaml
```

```bash
bun run src/index.ts login claude
```

```bash
bun run src/index.ts serve
```

Then point Claude Code at it:

```bash
ANTHROPIC_BASE_URL=http://localhost:8317 ANTHROPIC_API_KEY=your-api-key-1 claude
```

The API key is one of the values under `access.api-keys` in `config.yaml`. With no keys configured, the proxy accepts every request.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /v1/messages` | Claude Messages, streaming (Anthropic SSE) or not |
| `POST /v1/messages/count_tokens` | Token counting |
| `GET /v1/models`, `GET /v1/models/:id` | Models served by the loaded credentials |
| `GET /health` | Health check |

Inbound keys are accepted as `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`.

A model name may carry a thinking suffix such as `gpt-5.4(high)` or `gemini-2.5-pro(8192)`. The suffix overrides the thinking settings in the request body.

## Credentials

**OAuth logins** run a browser flow with a local callback server. A pasted callback URL works when no browser is available.

```bash
bun run src/index.ts login claude
```

```bash
bun run src/index.ts login codex
```

```bash
GEMINI_OAUTH_CLIENT_ID=... GEMINI_OAUTH_CLIENT_SECRET=... bun run src/index.ts login gemini-cli --project my-gcp-project
```

The Gemini CLI OAuth client id and secret are not stored in this repository. Set them from the values published in the Gemini CLI source, in `packages/core/src/code_assist/oauth2.ts`. The proxy needs them at login and whenever it refreshes a Gemini CLI token.

**API keys** go in `config.yaml` under `claude-api-key`, `openai-api-key`, `codex-api-key` and `gemini-api-key`. See `config.example.yaml` for the fields: base URL, model aliases, prefix, proxy and headers.

**Listing and moving credentials:**

```bash
bun run src/index.ts auth list
```

```bash
bun run src/index.ts auth migrate --from file --to vault
```

## Token storage

`auth.store` selects the backend. Both backends store the same JSON document per credential, so `auth migrate` copies records unchanged.

- **`vault`**: KV v2 at `<mount>/data/<path-prefix>/<id>`. It authenticates with a static token or AppRole, re-logging in once on a 403. `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_NAMESPACE`, `VAULT_ROLE_ID` and `VAULT_SECRET_ID` override the config file.
- **`file`**: one JSON file per credential in `auth.auth-dir` (default `~/.ai-proxy`). It reads the auth files written by the Go CLIProxyAPI.

## Routing and failover

Each request goes to a credential that serves the requested model. Credentials in a higher `priority` tier are used first, and within a tier the proxy rotates round-robin, or fill-first if configured.

On failure the proxy moves to the next credential and cools the failed one down:

- **429:** the credential cools until the upstream reset time. An account-wide usage limit cools every model on that credential.
- **401:** the token is refreshed and the request retried on the same credential.
- **5xx and transport errors:** a short cooldown.
- **Bad requests:** returned to the client with no failover.

A stream fails over only until its first byte reaches the client. After that, an upstream failure ends the stream with an Anthropic `event: error` frame.

OAuth tokens refresh in the background before they expire.

## Development

```bash
bun test
```

```bash
bunx tsc --noEmit
```

The tests are ported from the Go project's tests, with fixtures copied from them. `docs/upstream-tests.md` lists every upstream test file, with what was ported and why the rest was skipped. Regenerate it after changing test headers:

```bash
bun run scripts/reconcile-tests.ts <path-to-CLIProxyAPI> <path-to-CLIProxyAPI-v7.0.12>
```

`docs/PORTING.md` describes the layout and the porting conventions.

## Not included

The following are not included:

- **Other providers:** Kimi, xAI/Grok, Meta, Devin, Antigravity, Vertex.
- **Other inbound APIs:** the OpenAI- and Gemini-compatible inbound endpoints.
- **Server extras:** the Management API, plugins and the Go SDK.
- **Transports:** websocket transports.
- **Packaging:** Docker and cluster packaging.
