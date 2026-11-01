// Ported from: internal/runtime/executor/helps/codex_tool_schema_batch_test.go
// Skipped cases: BenchmarkNormalizeCodexToolSchemas (Go benchmark); in TestNormalizeCodexToolSchemasMatchesSequentialEdits
//   the duplicate-"tools"-key input and the two truncated-JSON inputs (they pin gjson/sjson behaviour on invalid or
//   ambiguous JSON: gjson reads the first duplicate key and edits truncated documents; the port parses strictly
//   and returns such bodies unchanged, which is asserted instead). Adaptation: Go compared the batched output byte
//   for byte with a frozen sequential sjson traversal; the port re-serialises the raw JSON tree, so each tool is
//   compared with the per-tool normalisation result and everything else must be preserved (big-number and exponent
//   literals verbatim; string escapes may be re-encoded); an unchanged payload must be returned as the same string.
import { describe, expect, test } from "bun:test";
import { normalizeCodexToolSchemas } from "../../../src/executor/codex/index.ts";
import { parseRawJSON, stringifyRawJSON } from "../../../src/executor/codex/rawjson.ts";

const codexBatchUnionTool = `{"type":"function","name":"choose","parameters":{"type":"object","properties":{"action":{"oneOf":[{"const":"a"},{"const":"b"},{"const":"c"},{"const":"d"},{"const":"e"},{"const":"f"},{"const":"g"},{"const":"h"}]}}}}`;
const codexBatchSimpleTool = `{"type":"function","name":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}`;
const normalizedUnionTool = `{"type":"function","name":"choose","parameters":{"type":"object","properties":{"action":{"enum":["a","b","c","d","e","f","g","h"]}}}}`;

const namespace = (tools: string) => `{"type":"namespace", "name":"workspace", "tools": [ ${tools} ]}`;
const request = (tools: string) =>
  `{\r\n  "input": "tool_search \\u5de5", "tools": [\n\t${tools}\n  ], "metadata": {"number": 900719925474099312345, "value": 1.00e+9}\r\n}`;

/** The expected body: the sequential traversal's result, with every union tool normalised in place (canonical raw JSON). */
function sequential(input: string): string {
  return stringifyRawJSON(parseRawJSON(input.replaceAll(codexBatchUnionTool, normalizedUnionTool)));
}

describe("TestNormalizeCodexToolSchemasMatchesSequentialEdits", () => {
  const unchanged = ["", `{}`, `{"tools":null}`, `{"tools":[]}`, `{"tools":"unchanged"}`, `{"tools":{}}`, request(codexBatchSimpleTool)];
  for (const [index, input] of unchanged.entries()) {
    test(`unchanged ${index}`, () => {
      expect(normalizeCodexToolSchemas(input)).toBe(input);
    });
  }

  const changed = [
    request(codexBatchUnionTool),
    request(codexBatchSimpleTool + ", \n" + codexBatchUnionTool + ",\t" + codexBatchSimpleTool),
    request(codexBatchUnionTool + ", \n" + codexBatchSimpleTool + ",\t" + codexBatchUnionTool),
    request(namespace(codexBatchUnionTool + ", \n" + codexBatchSimpleTool + ",\t" + codexBatchUnionTool)),
    request(namespace(namespace(codexBatchUnionTool) + ",\t" + codexBatchUnionTool) + ",\n" + codexBatchUnionTool),
    request(`null, 123, {"type":"namespace","tools":[]}, ` + codexBatchUnionTool),
  ];
  for (const [index, input] of changed.entries()) {
    test(`changed ${index}`, () => {
      const out = normalizeCodexToolSchemas(input);
      expect(out).toBe(sequential(input));
      // String escapes are re-encoded (sjson kept "\\u5de5" verbatim); the value is the same.
      expect((JSON.parse(out) as { input: string }).input).toBe("tool_search \u5de5");
      expect(out).toContain("900719925474099312345");
      expect(out).toContain("1.00e+9");
    });
  }

  test("ambiguous or truncated JSON is returned unchanged", () => {
    for (const input of [`{"tools":[${codexBatchUnionTool}],"incomplete":`, `{"tools":[${codexBatchUnionTool},`]) {
      expect(normalizeCodexToolSchemas(input)).toBe(input);
    }
  });
});
