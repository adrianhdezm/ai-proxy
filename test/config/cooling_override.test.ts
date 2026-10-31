// Ported from: internal/config/cooling_override_test.go
// Skipped cases: the interactions-api-key, xai-api-key, openai-compatibility and vertex-api-key entries
//   (families not carried; openai-api-key stands in for openai-compatibility).
import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";

test("TestParseConfigBytesPreservesCoolingOverridePresence", () => {
  const cfg = parseConfig(
    `
disable-cooling: true
gemini-api-key:
  - api-key: gemini-key
    disable-cooling: false
claude-api-key:
  - api-key: claude-key
    disable-cooling: false
codex-api-key:
  - api-key: codex-key
    base-url: https://codex.example.com
    disable-cooling: false
openai-api-key:
  - api-key: compat-key
    base-url: https://compat.example.com
    disable-cooling: false
`,
    { env: {}, home: "/home/tester", warn: () => {} },
  );
  expect(cfg.routing.cooldown.disabled).toBe(true);
  const overrides: Record<string, boolean | undefined> = {
    gemini: cfg.geminiApiKeys[0]!.disableCooling,
    claude: cfg.claudeApiKeys[0]!.disableCooling,
    codex: cfg.codexApiKeys[0]!.disableCooling,
    openai: cfg.openaiApiKeys[0]!.disableCooling,
  };
  for (const [name, override] of Object.entries(overrides)) {
    expect(override, `${name} disable-cooling`).toBe(false);
  }
});
