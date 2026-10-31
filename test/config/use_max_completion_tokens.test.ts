// Ported from: internal/config/use_max_completion_tokens_test.go
// Skipped cases: TestOpenAICompatibilityUseMaxCompletionTokensJSONDecoding (JSON config decoding not carried).
// Adapted: openai-compatibility models are expressed as openai-api-key models in this port.
import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";
import { modelOptionsFromOverrides } from "../../src/executor/openai/helpers.ts";

test("TestOpenAICompatibilityUseMaxCompletionTokensYAMLDecoding", () => {
  const cfg = parseConfig(
    `
openai-api-key:
  - api-key: test-provider-key
    models:
      - name: new-reasoning-model
        alias: new-alias
        use-max-completion-tokens: true
      - name: legacy-model
        alias: legacy-alias
`,
    { env: {}, home: "/home/tester", warn: () => {} },
  );
  expect(cfg.openaiApiKeys).toHaveLength(1);
  const models = cfg.openaiApiKeys[0]!.models;
  expect(models).toHaveLength(2);
  expect(models[0]!.useMaxCompletionTokens).toBe(true);
  expect(models[1]!.useMaxCompletionTokens ?? false).toBe(false);
  // The executor reads the flag off the parsed overrides.
  const options = modelOptionsFromOverrides(models);
  expect(options[0]!.useMaxCompletionTokens).toBe(true);
  expect(options[1]!.useMaxCompletionTokens ?? false).toBe(false);
});
