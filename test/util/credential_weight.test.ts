// Ported from: internal/credentialweight/weight_test.go
// Skipped cases: none (json.Number values are passed as the numeric strings an auth file would carry; the
// helper is parseWeightValue in src/store/record.ts).
import { expect, test } from "bun:test";
import { DefaultCredentialWeight, MaxCredentialWeight, parseWeightValue } from "../../src/store/record.ts";

test("TestParseValueValidation", () => {
  const cases: [string, unknown, number | "error"][] = [
    ["default string", "", DefaultCredentialWeight],
    ["negative excluded", "-5", 0],
    ["fraction rejected", "1.5", "error"],
    ["maximum", "1000000", MaxCredentialWeight],
    ["above maximum", "1000001", "error"],
    ["int64 overflow", "9223372036854775808", "error"],
    ["numeric negative excluded", -5, 0],
    ["numeric fraction rejected", 1.5, "error"],
  ];
  for (const [name, value, want] of cases) {
    if (want === "error") expect([name, () => parseWeightValue(value)][1] as () => number).toThrow();
    else expect([name, parseWeightValue(value)]).toEqual([name, want]);
  }
});
