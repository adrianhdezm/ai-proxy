// Ported from: internal/config/max_context_length_test.go
// Skipped cases: interactions-api-key, xai-api-key and openai-compatibility assertions (families not carried); JSON decode variant.
import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";

test("max-context-length config decoding", () => {
  const want = 1048576;
  const cfg = parseConfig(`codex-api-key:
  - api-key: x
    models:
      - name: codex-upstream
        alias: codex-alias
        max-context-length: 1048576
claude-api-key:
  - api-key: c
    models:
      - name: claude-upstream
        alias: claude-alias
        max-context-length: 1048576
gemini-api-key:
  - api-key: g
    models:
      - name: gemini-upstream
        alias: gemini-alias
        max-context-length: 1048576
openai-api-key:
  - api-key: o
    models:
      - name: openai-upstream
        alias: openai-alias
        max-context-length: 1048576
`);
  expect(cfg.codexApiKeys[0]!.models[0]!.maxContextLength).toBe(want);
  expect(cfg.claudeApiKeys[0]!.models[0]!.maxContextLength).toBe(want);
  expect(cfg.geminiApiKeys[0]!.models[0]!.maxContextLength).toBe(want);
  expect(cfg.openaiApiKeys[0]!.models[0]!.maxContextLength).toBe(want);
});
