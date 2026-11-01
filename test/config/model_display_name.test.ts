// Ported from: internal/config/model_display_name_test.go
// Skipped cases: xai-api-key, vertex-api-key and openai-compatibility assertions (families not carried); JSON decode variant.
import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";

test("model display-name config decoding", () => {
  const cfg = parseConfig(`codex-api-key:
  - api-key: x
    models:
      - name: codex-upstream
        alias: codex-alias
        display-name: Codex Name
claude-api-key:
  - api-key: c
    models:
      - name: claude-upstream
        alias: claude-alias
        display-name: Claude Name
gemini-api-key:
  - api-key: g
    models:
      - name: gemini-upstream
        alias: gemini-alias
        display-name: Gemini Name
openai-api-key:
  - api-key: o
    models:
      - name: openai-upstream
        alias: openai-alias
        display-name: OpenAI Name
`);
  expect(cfg.codexApiKeys[0]!.models[0]!.displayName).toBe("Codex Name");
  expect(cfg.claudeApiKeys[0]!.models[0]!.displayName).toBe("Claude Name");
  expect(cfg.geminiApiKeys[0]!.models[0]!.displayName).toBe("Gemini Name");
  expect(cfg.openaiApiKeys[0]!.models[0]!.displayName).toBe("OpenAI Name");
});
