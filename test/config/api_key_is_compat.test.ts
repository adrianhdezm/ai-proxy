// Ported from: internal/config/api_key_is_compat_test.go
// Skipped cases: interactions-api-key, xai-api-key and openai-compatibility sub-assertions (families not carried).
import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";

test("API key model is-compat config decoding", () => {
  const yamlConfig = `gemini-api-key:
  - api-key: g
    models:
      - name: gemini-upstream
        alias: gemini-alias
        is-compat: true
      - name: gemini-native
        alias: gemini-native
claude-api-key:
  - api-key: c
    models:
      - name: claude-upstream
        alias: claude-alias
        is-compat: true
codex-api-key:
  - api-key: x
    models:
      - name: codex-upstream
        alias: codex-alias
        is-compat: true
openai-api-key:
  - api-key: o
    models:
      - name: openai-upstream
        alias: openai-alias
        is-compat: true
`;
  const cfg = parseConfig(yamlConfig);
  expect(cfg.geminiApiKeys.length).toBe(1);
  expect(cfg.geminiApiKeys[0]!.models[0]!.isCompat).toBe(true);
  expect(cfg.geminiApiKeys[0]!.models[1]!.isCompat).toBe(false);
  expect(cfg.claudeApiKeys.length).toBe(1);
  expect(cfg.claudeApiKeys[0]!.models[0]!.isCompat).toBe(true);
  expect(cfg.codexApiKeys.length).toBe(1);
  expect(cfg.codexApiKeys[0]!.models[0]!.isCompat).toBe(true);
  expect(cfg.openaiApiKeys.length).toBe(1);
  expect(cfg.openaiApiKeys[0]!.models[0]!.isCompat).toBe(true);
});
