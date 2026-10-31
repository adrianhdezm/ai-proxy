// Ported from: internal/client/codex/apply-patch/tool_test.go
// Skipped cases: TestApplyPatchToolParametersAreIndependent (the schema is an immutable JS string)
import { describe, expect, test } from "bun:test";
import {
  applyPatchDescription,
  applyPatchParameters,
  escapeApplyPatchInputFragment,
  isApplyPatchCustomTool,
  unwrapApplyPatchInput,
  wrapApplyPatchInput,
} from "../../../src/translator/common/apply_patch_tool.ts";

const parse = (raw: string): unknown => (raw === "" ? undefined : JSON.parse(raw));

test("tool contract", () => {
  const tool = parse(
    `{"type":"custom","name":"apply_patch","description":"This is a FREEFORM tool, so do not wrap the patch in JSON.","format":{"type":"grammar","syntax":"lark","definition":"start: begin_patch hunk+ end_patch"}}`,
  );
  expect(isApplyPatchCustomTool(tool)).toBe(true);
  const params = JSON.parse(applyPatchParameters());
  expect(params.properties.input.type).toBe("string");
  expect(params.additionalProperties).toBe(false);
  const description = applyPatchDescription(tool);
  for (const token of ["*** Begin Patch", "*** End Patch", "*** Add File:", "*** Delete File:", "*** Update File:", "@@", "input", "start: begin_patch hunk+ end_patch"]) {
    expect(description).toContain(token);
  }
  expect(description).not.toContain("do not wrap the patch in JSON");
  const patch = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n";
  expect(unwrapApplyPatchInput(wrapApplyPatchInput(patch))).toEqual([patch, undefined]);
});

describe("tool recognition", () => {
  const cases: [string, string, boolean][] = [
    ["custom", `{"type":"custom","name":"apply_patch"}`, true],
    ["trimmed_name", `{"type":"custom","name":" \\tapply_patch\\n"}`, true],
    ["ordinary_function", `{"type":"function","name":"apply_patch"}`, false],
    ["nested_function", `{"type":"function","function":{"name":"apply_patch"}}`, false],
    ["other_custom_tool", `{"type":"custom","name":"shell"}`, false],
    ["case_sensitive_name", `{"type":"custom","name":"APPLY_PATCH"}`, false],
    ["qualified_name", `{"type":"custom","name":"functions.apply_patch"}`, false],
    ["exact_type", `{"type":" custom ","name":"apply_patch"}`, false],
    ["missing_type", `{"name":"apply_patch"}`, false],
    ["missing_name", `{"type":"custom"}`, false],
    ["non_string_type", `{"type":true,"name":"apply_patch"}`, false],
    ["non_string_name", `{"type":"custom","name":42}`, false],
    ["null_name", `{"type":"custom","name":null}`, false],
    ["empty_object", `{}`, false],
    ["missing_tool", ``, false],
  ];
  for (const [name, tool, want] of cases) test(name, () => expect(isApplyPatchCustomTool(parse(tool))).toBe(want));
});

test("tool parameters", () => {
  const schema = JSON.parse(applyPatchParameters());
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties)).toEqual(["input"]);
  expect(schema.properties.input.type).toBe("string");
  expect(schema.properties.input.description).toBe("The complete apply_patch patch text.");
  expect(schema.required).toEqual(["input"]);
  expect(schema.additionalProperties).toBe(false);
});

describe("description rules", () => {
  const cases: [string, string][] = [
    ["no_description_or_grammar", `{"type":"custom","name":"apply_patch"}`],
    ["empty_description_and_grammar", `{"description":"","format":{"definition":""}}`],
    ["format_without_definition", `{"description":"Edit files.","format":{"type":"grammar","syntax":"lark"}}`],
    ["grammar_without_environment", `{"format":{"definition":"start: begin_patch hunk+ end_patch"}}`],
  ];
  for (const [name, tool] of cases) {
    test(name, () => {
      const description = applyPatchDescription(parse(tool));
      for (const instruction of [
        "Call this function with a JSON object whose input field contains the complete patch text.",
        "Use the Codex apply_patch format, not a conventional git unified diff.",
        "Start with *** Begin Patch and end with *** End Patch.",
        "Use *** Add File: path, *** Delete File: path, or *** Update File: path.",
        "Every added-file content line starts with +.",
        "For updates, use @@; context lines start with one space, removed lines with -, and added lines with +.",
        "Use *** Move to: path for a rename and *** End of File when required by the patch grammar.",
        "Example input:\n*** Begin Patch\n*** Update File: src/main.go\n@@\n-old\n+new\n*** End Patch",
      ]) {
        expect(description).toContain(instruction);
      }
      expect(description).not.toContain("*** Environment ID:");
    });
  }
});

describe("description preserves non-wrapper instructions", () => {
  const cases: [string, string, string[]][] = [
    [
      "non_wrapper_description",
      `{"description":"Use apply_patch to edit files.\\n  Keep context lines intact.\\nDo not run the patch on the proxy."}`,
      ["Use apply_patch to edit files.\n  Keep context lines intact.\nDo not run the patch on the proxy."],
    ],
    [
      "wrapper_between_instructions",
      `{"description":"Edit files only. This is a FREEFORM tool, so do not wrap the patch in JSON. Preserve line endings.\\n  Keep indentation."}`,
      ["Edit files only.", "Preserve line endings.\n  Keep indentation."],
    ],
    ["wrapper_only", `{"description":"This is a FREEFORM tool, so do not wrap the patch in JSON."}`, []],
  ];
  for (const [name, raw, retained] of cases) {
    test(name, () => {
      const tool = parse(raw);
      const description = applyPatchDescription(tool);
      expect(description).not.toContain("This is a FREEFORM tool");
      expect(description).not.toContain("do not wrap the patch in JSON");
      for (const r of retained) expect(description).toContain(r);
      expect(JSON.stringify(tool)).toBe(JSON.stringify(parse(raw)));
    });
  }
});

describe("description preserves grammar", () => {
  const cases: [string, string, string][] = [
    [
      "whitespace_and_line_endings",
      `{"format":{"definition":" \\nstart: begin_patch hunk+ end_patch\\r\\n  begin_patch: \\"*** Begin Patch\\"\\n\\n"}}`,
      ' \nstart: begin_patch hunk+ end_patch\r\n  begin_patch: "*** Begin Patch"\n\n',
    ],
    [
      "wrapper_text_inside_grammar_is_not_rewritten",
      `{"description":"This is a FREEFORM tool, so do not wrap the patch in JSON.","format":{"definition":"// This is a FREEFORM tool, so do not wrap the patch in JSON.\\nstart: begin_patch hunk+ end_patch"}}`,
      "// This is a FREEFORM tool, so do not wrap the patch in JSON.\nstart: begin_patch hunk+ end_patch",
    ],
  ];
  for (const [name, tool, wantGrammar] of cases) {
    test(name, () => {
      const description = applyPatchDescription(parse(tool));
      expect(description.endsWith(wantGrammar)).toBe(true);
      expect(description.slice(0, description.length - wantGrammar.length)).not.toContain("do not wrap the patch in JSON");
    });
  }
});

test("description environment grammar", () => {
  const grammar = 'start: begin_patch environment_id? hunk+ end_patch\nenvironment_id: "*** Environment ID:" /[^\\n]+/\n';
  const description = applyPatchDescription({ format: { definition: grammar } });
  expect(description.endsWith(grammar)).toBe(true);
  expect(description.slice(0, description.length - grammar.length)).toContain("*** Environment ID:");
});

describe("input encoding", () => {
  const cases: [string, string, string, string][] = [
    ["empty", "", `{"input":""}`, ``],
    ["plain", "patch", `{"input":"patch"}`, `patch`],
    ["newlines_and_leading_spaces", "  context\n+added\r\n\tline\n ", `{"input":"  context\\n+added\\r\\n\\tline\\n "}`, `  context\\n+added\\r\\n\\tline\\n `],
    ["quotes_and_backslashes", '"C:\\file"', `{"input":"\\"C:\\\\file\\""}`, `\\"C:\\\\file\\"`],
    ["control_characters", "\x00\b\f\r\t", `{"input":"\\u0000\\b\\f\\r\\t"}`, `\\u0000\\b\\f\\r\\t`],
    ["unicode", "补丁🙂", `{"input":"补丁🙂"}`, `补丁🙂`],
    ["json_sensitive_characters", "<>&\u2028\u2029", `{"input":"\\u003c\\u003e\\u0026\\u2028\\u2029"}`, `\\u003c\\u003e\\u0026\\u2028\\u2029`],
  ];
  for (const [name, input, wantJSON, wantEscaped] of cases) {
    test(name, () => {
      expect(wrapApplyPatchInput(input)).toBe(wantJSON);
      expect(escapeApplyPatchInputFragment(input)).toBe(wantEscaped);
      expect(unwrapApplyPatchInput(wrapApplyPatchInput(input))).toEqual([input, undefined]);
    });
  }
});

test("escaped fragments compose", () => {
  const fragments = ["*** Begin Patch\n", "  context\n", '-"old"\r\n', "+C:\\new\n", "+补丁🙂\n", "*** End Patch\n"];
  const encoded = fragments.map(escapeApplyPatchInputFragment).join("");
  expect(JSON.parse(`{"input":"${encoded}"}`).input).toBe(fragments.join(""));
});

describe("unwrap input", () => {
  const ok: [string, string, string][] = [
    ["empty_input", `{"input":""}`, ""],
    ["plain_input", `{"input":"patch"}`, "patch"],
    ["whitespace_in_input", `{"input":"  context\\n\\tline\\r\\n\\n "}`, "  context\n\tline\r\n\n "],
    ["json_whitespace", ' \n\t{ "input" : "patch" }\r\n ', "patch"],
    ["escaped_field_name", `{"\\u0069nput":"patch"}`, "patch"],
    ["unicode_input", `{"input":"补丁🙂"}`, "补丁🙂"],
  ];
  for (const [name, args, want] of ok) test(name, () => expect(unwrapApplyPatchInput(args)).toEqual([want, undefined]));
  const bad: [string, string][] = [
    ["empty_arguments", ""],
    ["whitespace_arguments", " \r\n\t "],
    ["missing_input", `{}`],
    ["wrong_field", `{"patch":"text"}`],
    ["case_sensitive_field", `{"Input":"text"}`],
    ["null_input", `{"input":null}`],
    ["boolean_input", `{"input":true}`],
    ["number_input", `{"input":1}`],
    ["array_input", `{"input":[]}`],
    ["object_input", `{"input":{}}`],
    ["extra_field_after_input", `{"input":"patch","other":"value"}`],
    ["extra_field_before_input", `{"other":"value","input":"patch"}`],
    ["duplicate_input", `{"input":"first","input":"second"}`],
    ["duplicate_identical_input", `{"input":"patch","input":"patch"}`],
    ["duplicate_escaped_input", `{"input":"first","\\u0069nput":"second"}`],
    ["trailing_object", `{"input":"patch"}{"input":"second"}`],
    ["trailing_array", `{"input":"patch"} []`],
    ["trailing_null", `{"input":"patch"} null`],
    ["trailing_boolean", `{"input":"patch"} true`],
    ["trailing_garbage", `{"input":"patch"} invalid`],
    ["top_level_array", `["patch"]`],
    ["top_level_string", `"patch"`],
    ["top_level_null", `null`],
    ["top_level_number", `1`],
    ["top_level_boolean", `false`],
    ["raw_patch", "*** Begin Patch\n*** End Patch\n"],
    ["missing_closing_brace", `{"input":"patch"`],
    ["missing_colon", `{"input" "patch"}`],
    ["missing_value", `{"input":}`],
    ["unterminated_string", `{"input":"patch}`],
    ["trailing_comma", `{"input":"patch",}`],
    ["unquoted_field", `{input:"patch"}`],
    ["unescaped_newline", '{"input":"line\nline"}'],
    ["invalid_escape", `{"input":"\\x"}`],
  ];
  for (const [name, args] of bad) {
    test(name, () => {
      const [got, err] = unwrapApplyPatchInput(args);
      expect(err).toBeDefined();
      expect(got).toBe("");
    });
  }
});
