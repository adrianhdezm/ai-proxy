# Porting conventions

This repository is a TypeScript/Bun port of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
cut down to three upstreams (OpenAI via Codex OAuth or API key, Anthropic Claude via Claude Code OAuth or
API key, Google Gemini via Gemini CLI OAuth or AI Studio API key) behind one Claude Messages-compatible
endpoint. The aim is matching behaviour on the kept paths, not a line-by-line port.

## Reference sources

The Go sources are checked out read-only under the scratchpad:

- `CLIProxyAPI/` — current upstream (`9717e325`, 2026-10-28). Primary reference.
- `CLIProxyAPI-v7.0.12/` — older release that still ships the Gemini CLI OAuth login
  (`internal/auth/gemini/`) and the Gemini CLI executor (`internal/runtime/executor/gemini_cli_executor.go`).

## Layout

```
src/
  translator/            registry + contracts (types.ts, registry.ts)
  translator/common/     shared helpers (port of internal/translator/common)
  translator/codex/claude, gemini/claude, openai/claude   Claude inbound -> upstream translators
  thinking/              thinking pipeline (port of internal/thinking)
  signature/             thinking-signature sanitising (port of internal/signature)
  registry/              model registry + static model definitions
  util/                  schema sanitisers, tool-id helpers (port of internal/util)
  auth/                  Auth record types, OAuth flows per provider (auth/claude, auth/codex, auth/gemini), manager
  store/                 TokenStore contract, file store, Vault store
  executor/              ProviderExecutor contract and the per-provider executors
  config/                YAML config types + loader
  server/                Bun HTTP server, /v1/messages handlers, SSE forwarding
test/                    mirrors src/ ; fixtures under test/fixtures/
docs/upstream-tests.md   inventory of every upstream test and its disposition
```

## Rules

1. **JSON payloads are strings.** Translators and executors take and return JSON `string`s (Go used
   `[]byte` with gjson/sjson). Parse with `JSON.parse`, manipulate plain objects, `JSON.stringify` on the
   way out. Helpers live in `src/util/json.ts`.
2. **Shared contracts are frozen** (`src/translator/types.ts`, `src/translator/registry.ts`,
   `src/auth/types.ts`, `src/executor/types.ts`, `src/store/types.ts`, `src/registry/types.ts`). If you
   truly need a change, make it minimal and additive and call it out in your report.
3. **No runtime dependencies.** Bun built-ins only: `Bun.YAML`, `Bun.serve`, `fetch`, `Bun.file`,
   `crypto.subtle`, `bun:test`. Dev dependencies are limited to `typescript` and `@types/bun`.
4. **Tests first.** Port the Go test to `test/<mirror>/<name>.test.ts` with fixtures copied from the Go
   test, then implement until it passes. Every ported test file starts with a header:
   ```ts
   // Ported from: internal/translator/codex/claude/codex_claude_request_test.go
   // Skipped cases: <name> (<why>), ...
   ```
   Only list Go test *files* that you actually ported (fully or partially). The inventory in
   `docs/upstream-tests.md` is reconciled from these headers.
5. **Deterministic tests.** No wall-clock sleeps for TTL/ordering; inject `now()` functions or clocks.
   Fake upstreams use `Bun.serve({ port: 0 })` on localhost.
6. **Never log secrets.** Use `src/log.ts`.
7. **Naming.** camelCase for functions and fields, PascalCase for types. Keep the Go function names
   recognisable (`convertClaudeRequestToCodex`, `applyThinking`, ...) so the mapping stays obvious.
8. **Finish the slice.** Run `bun test test/<your-area>` and `bunx tsc --noEmit` before reporting.
   Report: files written, Go tests ported (file list), Go tests from your candidate list that you
   skipped and why, and any deviation from upstream behaviour.
