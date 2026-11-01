// Ported from: internal/config/weight_test.go
// Skipped cases: the SaveConfigPreserveComments half of TestAPIKeyWeightParsingAndZeroPersistence (config writing not
//   carried); xai-api-key replaced by codex-api-key.
import { describe, expect, test } from "bun:test";
import { parseConfig, validateCredentialWeights } from "../../src/config/load.ts";

describe("API key weight validation", () => {
  const cases = [
    { name: "negative excludes", weight: "-1", valid: true },
    { name: "maximum", weight: "1000000", valid: true },
    { name: "fraction", weight: "1.5", valid: false },
    { name: "above maximum", weight: "1000001", valid: false },
    { name: "integer overflow", weight: "9223372036854775808", valid: false },
    { name: "string", weight: '"3"', valid: false },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const parse = () => parseConfig(`gemini-api-key:\n  - api-key: key\n    weight: ${tt.weight}\n`);
      if (tt.valid) expect(parse).not.toThrow();
      else expect(parse).toThrow(/gemini-api-key\[0\]\.weight: weight must/);
    });
  }
});

test("API key weight parsing keeps explicit zero", () => {
  const cfg = parseConfig(`codex-api-key:
  - api-key: key
    base-url: https://api.x.ai/v1
    weight: 0
  - api-key: other
    base-url: https://api.x.ai/v1
`);
  expect(cfg.codexApiKeys.length).toBe(2);
  expect(cfg.codexApiKeys[0]!.weight).toBe(0);
  expect(cfg.codexApiKeys[1]!.weight).toBeUndefined();
  expect(() => validateCredentialWeights(cfg)).not.toThrow();
  cfg.codexApiKeys[1]!.weight = 2_000_000;
  expect(() => validateCredentialWeights(cfg)).toThrow("codex-api-key[1].weight: weight must not exceed 1000000");
});
