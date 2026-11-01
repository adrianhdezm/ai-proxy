// Ported from: internal/util/claude_schema_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { hasUnsupportedUnicodePropertyEscape, normalizeClaudeToolInputSchema } from "../../src/util/claude_schema.ts";

function compareJSON(expected: string, actual: string): void {
  expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
}

describe("normalizeClaudeToolInputSchema", () => {
  const tests = [
    {
      name: "root anyOf without type",
      input: `{"anyOf":[{"type":"object","properties":{"a":{"type":"string"}}},{"type":"object","properties":{"b":{"type":"integer"}}}]}`,
      expected: `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"integer"}}}`,
    },
    {
      name: "root oneOf keeps nested union",
      input: `{"type":"object","properties":{"nested":{"oneOf":[{"type":"string"},{"type":"number"}]}},"oneOf":[{"properties":{"a":{"type":"string"}},"required":["a"]},{"properties":{"b":{"type":"string"}},"required":["b"]}]}`,
      expected: `{"type":"object","properties":{"nested":{"oneOf":[{"type":"string"},{"type":"number"}]},"a":{"type":"string"},"b":{"type":"string"}}}`,
    },
    {
      name: "root anyOf drops alternative required fields",
      input: `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"anyOf":[{"required":["a"]},{"required":["b"]}]}`,
      expected: `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}}}`,
    },
    {
      name: "root allOf merges properties and required fields",
      input: `{"type":"object","properties":{"base":{"type":"boolean"}},"required":["base"],"allOf":[{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]},{"properties":{"b":{"type":"integer"}},"required":["a","b"]}]}`,
      expected: `{"type":"object","properties":{"base":{"type":"boolean"},"a":{"type":"string"},"b":{"type":"integer"}},"required":["base","a","b"]}`,
    },
    {
      name: "ordinary object schema",
      input: `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}`,
      expected: `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}`,
    },
    { name: "invalid schema", input: `{"type":`, expected: `{"type":"object","properties":{}}` },
    { name: "boolean schema", input: `true`, expected: `{"type":"object","properties":{}}` },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      compareJSON(tt.expected, normalizeClaudeToolInputSchema(tt.input));
    });
  }
});

describe("hasUnsupportedUnicodePropertyEscape", () => {
  const tests: [string, string, boolean][] = [
    ["Artifact regex with multiple \\p escapes", String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\./[\]]{1,200}$`, true],
    ["Uppercase \\P property escape", String.raw`^\P{L}+$`, true],
    ["Escaped backslash before p is literal and safe", String.raw`^\\p{Cc}$`, false],
    ["Three backslashes means literal backslash plus real \\p escape", String.raw`^\\\p{Cc}$`, true],
    ["Four backslashes means two literal backslashes", String.raw`^\\\\p{Cc}$`, false],
    ["Standard hex character pattern", String.raw`^[0-9a-f]{32}$`, false],
    ["Negative lookahead without unicode properties", String.raw`^(?!__.*__$).{1,200}$`, false],
    ["Backreference safe in Python re", String.raw`^(a)\1$`, false],
    ["Octal NUL escape rejected by strict validators", String.raw`^[^\0]*$`, true],
    ["Hex NUL escape is the accepted spelling", String.raw`^[^\x00]*$`, false],
    ["Escaped backslash before zero is literal and safe", String.raw`^\\0$`, false],
    ["Trailing single backslash", "abc\\", false],
    ["Backslash followed by p without brace", String.raw`\p`, false],
    ["Backslash followed by p and brace without close", String.raw`\p{`, true],
    ["Empty string", "", false],
  ];
  for (const [name, pattern, want] of tests) {
    test(name, () => {
      expect(hasUnsupportedUnicodePropertyEscape(pattern)).toBe(want);
    });
  }
});
