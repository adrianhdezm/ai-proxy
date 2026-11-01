// Ported from: test/gemini_ref_sibling_test.go
// Skipped cases: TestIssue6897_GeminiToolParametersPreserveRefSiblingConstraints/chat_completions,
//   /responses (OpenAI-inbound formats are out of scope for this port)
import { expect, test } from "bun:test";
import "../../../src/translator/gemini/claude/index.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import { FormatClaude, FormatGemini } from "../../../src/translator/types.ts";
import { exists, getInt } from "./helpers.ts";

test("Issue6897_GeminiToolParametersPreserveRefSiblingConstraints/claude", () => {
  const schema = `{"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":{"A":{"type":"string","minLength":5}},"type":"object","properties":{"x":{"$ref":"#/$defs/A","minLength":1}}}`;
  const body = `{"messages":[{"role":"user","content":"test"}],"tools":[{"name":"check","input_schema":${schema}}]}`;
  const out = defaultRegistry.translateRequest(FormatClaude, FormatGemini, "gemini-3-flash", body, false);
  const parameters = "tools.0.functionDeclarations.0.parametersJsonSchema";
  expect(getInt(out, `${parameters}.properties.x.allOf.0.minLength`)).toBe(5);
  expect(getInt(out, `${parameters}.properties.x.minLength`)).toBe(1);
  expect(exists(out, `${parameters}.$defs`)).toBe(false);
  expect(exists(out, `${parameters}.properties.x.$ref`)).toBe(false);
});
