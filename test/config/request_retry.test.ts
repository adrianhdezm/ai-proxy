// Ported from: internal/config/request_retry_test.go
// Skipped cases: interactions-api-key, xai-api-key, openai-compatibility and vertex-api-key assertions (families not carried).
import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";

test("ParseConfigBytes request-retry", () => {
  const cfg = parseConfig(`
gemini-api-key:
  - api-key: "gemini-zero"
    request-retry: 0
  - api-key: "gemini-unset"
codex-api-key:
  - api-key: "codex-neg"
    base-url: "https://codex.example.com"
    request-retry: -1
claude-api-key:
  - api-key: "claude-three"
    request-retry: 3
openai-api-key:
  - api-key: "openai-two"
    request-retry: 2
`);
  expect(cfg.geminiApiKeys.length).toBe(2);
  expect(cfg.geminiApiKeys[0]!.requestRetry).toBe(0);
  expect(cfg.geminiApiKeys[1]!.requestRetry).toBeUndefined();
  expect(cfg.codexApiKeys.length).toBe(1);
  expect(cfg.codexApiKeys[0]!.requestRetry).toBe(-1);
  expect(cfg.claudeApiKeys.length).toBe(1);
  expect(cfg.claudeApiKeys[0]!.requestRetry).toBe(3);
  expect(cfg.openaiApiKeys.length).toBe(1);
  expect(cfg.openaiApiKeys[0]!.requestRetry).toBe(2);
});
