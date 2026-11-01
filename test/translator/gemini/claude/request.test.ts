// Ported from: internal/translator/gemini/claude/gemini_claude_request_test.go
// Skipped cases: none (TestConvertClaudeRequestToGemini_UnsendableFileNamesTheDroppedPart: the Go test also
//   checks the body returned alongside the error; the TS contract throws instead, so only the error is asserted)
import { describe, expect, test } from "bun:test";
import { UnsupportedPartError } from "../../../../src/translator/common/parts.ts";
import { convertClaudeRequestToGemini, convertClaudeRequestToGeminiWithCompat } from "../../../../src/translator/gemini/claude/request.ts";
import { validateGeminiFunctionCallPairing } from "../../../../src/signature/index.ts";
import { getAt, gstr } from "../../../../src/util/gpath.ts";
import { exists, getArr, getStr, getVal, raw } from "../helpers.ts";

const part = (p: unknown, path: string): string => gstr(getAt(p, path));

test("ToolChoice_SpecificTool", () => {
  const input = `{
    "model": "gemini-3-flash-preview",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
    "tools": [{"name": "json", "description": "A JSON tool", "input_schema": {"type": "object", "properties": {}}}],
    "tool_choice": {"type": "tool", "name": "json"}
  }`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  expect(getStr(output, "toolConfig.functionCallingConfig.mode")).toBe("ANY");
  expect(getVal(output, "toolConfig.functionCallingConfig.allowedFunctionNames")).toEqual(["json"]);
});

test("StringSystemInstruction", () => {
  const input = `{"model": "gemini-3-flash-preview", "system": "Be concise", "messages": [{"role": "user", "content": "Hello"}]}`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  expect(getStr(output, "systemInstruction.parts.0.text")).toBe("Be concise");
  expect(exists(output, "systemInstruction.role")).toBe(false);
  expect(exists(output, "system_instruction")).toBe(false);
});

test("ImageContent", () => {
  const input = `{
    "model": "gemini-3-flash-preview",
    "messages": [{"role": "user", "content": [
      {"type": "text", "text": "describe this image"},
      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}}
    ]}]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  const parts = getArr(output, "contents.0.parts");
  expect(parts.length).toBe(2);
  expect(part(parts[0], "text")).toBe("describe this image");
  expect(part(parts[1], "inline_data.mime_type")).toBe("image/png");
  expect(part(parts[1], "inline_data.data")).toBe("aGVsbG8=");
});

test("StripsClaudeCodeAttribution", () => {
  const input = `{
    "model": "claude-sonnet-4-5",
    "system": [
      {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.63.abc; cc_entrypoint=cli; cch=12345;"},
      {"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."},
      {"type": "text", "text": "User system prompt"}
    ],
    "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  const parts = getArr(output, "systemInstruction.parts");
  expect(parts.length).toBe(2);
  expect(part(parts[0], "text")).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  expect(part(parts[1], "text")).toBe("User system prompt");
  expect(parts.some((p) => part(p, "text").startsWith("x-anthropic-billing-header:"))).toBe(false);
});

test("ConvertsMessageSystemRoleToUserContent", () => {
  const input = `{
    "model": "gemini-3-flash-preview",
    "system": [{"type": "text", "text": "Top-level rules"}],
    "messages": [
      {"role": "user", "content": [{"type": "text", "text": "Hello"}]},
      {"role": "system", "content": "String mid-conversation rule"},
      {"role": "system", "content": [{"type": "text", "text": "Array mid-conversation rule"}]}
    ]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  const contents = getArr(output, "contents");
  expect(contents.some((c) => part(c, "role") === "system")).toBe(false);
  expect(contents.length).toBe(1);
  expect(part(contents[0], "role")).toBe("user");
  const parts = getArr(output, "contents.0.parts");
  expect(parts.length).toBe(3);
  expect(part(parts[0], "text")).toBe("Hello");
  expect(part(parts[1], "text")).toBe("<system-reminder>\nString mid-conversation rule\n</system-reminder>");
  expect(part(parts[2], "text")).toBe("<system-reminder>\nArray mid-conversation rule\n</system-reminder>");
  const systemParts = getArr(output, "systemInstruction.parts");
  expect(systemParts.length).toBe(1);
  expect(part(systemParts[0], "text")).toBe("Top-level rules");
});

test("MessageLevelDeveloperInstructionsBecomeMergedUserReminder", () => {
  const input = `{
    "model": "gemini-3-flash-preview",
    "system": "Top-level rules",
    "messages": [
      {"role": "user", "content": [{"type": "text", "text": "Hello"}]},
      {"role": "developer", "content": "String mid-conversation developer rule"},
      {"role": "developer", "content": [{"type": "text", "text": "Array mid-conversation developer rule"}]}
    ]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  const contents = getArr(output, "contents");
  expect(contents.some((c) => part(c, "role") === "developer")).toBe(false);
  expect(contents.length).toBe(1);
  expect(part(contents[0], "role")).toBe("user");
  const parts = getArr(output, "contents.0.parts");
  expect(parts.length).toBe(3);
  expect(part(parts[0], "text")).toBe("Hello");
  expect(part(parts[1], "text")).toBe("<system-reminder>\nString mid-conversation developer rule\n</system-reminder>");
  expect(part(parts[2], "text")).toBe("<system-reminder>\nArray mid-conversation developer rule\n</system-reminder>");
  const systemParts = getArr(output, "systemInstruction.parts");
  expect(systemParts.length).toBe(1);
  expect(part(systemParts[0], "text")).toBe("Top-level rules");
});

test("PreservesToolPairingWithInterveningSystemMessage", () => {
  const input = `{
    "model": "gemini-3-flash-preview",
    "messages": [
      {"role": "user", "content": [{"type": "text", "text": "Run two tools"}]},
      {"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_1", "name": "tool_one", "input": {"a": 1}},
        {"type": "tool_use", "id": "toolu_2", "name": "tool_two", "input": {"b": 2}}
      ]},
      {"role": "system", "content": "Context reminder between tool_use and tool_result"},
      {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_2", "content": "result 2"},
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "result 1"}
      ]}
    ]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  const contents = getArr(output, "contents");
  expect(contents.length).toBe(3);
  expect(part(contents[0], "role")).toBe("user");
  expect(part(contents[1], "role")).toBe("model");
  expect(part(contents[2], "role")).toBe("user");
  const respIDs = getArr(output, "contents.2.parts")
    .map((p) => part(p, "functionResponse.id"))
    .filter((id) => id !== "");
  expect(respIDs).toEqual(["toolu_1", "toolu_2"]);
});

test("SkipsEmptyTextParts", () => {
  const input = `{"model": "claude-3-5-sonnet", "messages": [{"role": "assistant", "content": [
    {"type": "text", "text": ""}, {"type": "text", "text": "hello"}, {"type": "text", "text": ""}
  ]}]}`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  const parts = getArr(output, "contents.0.parts");
  expect(parts.length).toBe(1);
  expect(part(parts[0], "text")).toBe("hello");
});

test("StructuredToolResult", () => {
  const input = `{
    "model": "gemini-3-flash-preview",
    "messages": [
      {"role": "assistant", "content": [{"type": "tool_use", "id": "json-call-1", "name": "json", "input": {"ok": true}}]},
      {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "json-call-1", "content": [
        {"type": "text", "text": "alpha"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}}
      ]}]}
    ]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  expect(exists(output, "contents.1.parts.0.functionResponse")).toBe(true);
  // The text block must remain structured JSON, not a double-encoded string blob.
  expect(getStr(output, "contents.1.parts.0.functionResponse.response.result.text")).toBe("alpha");
  // The image block must be emitted as a separate inline_data part, not embedded in result.
  expect(getStr(output, "contents.1.parts.1.inline_data.mime_type")).toBe("image/png");
  expect(getStr(output, "contents.1.parts.1.inline_data.data")).toBe("aGVsbG8=");
});

test("AlignsPermutedParallelToolResultsWithMixedText", () => {
  const input = `{
    "model":"gemini-3.7-flash-high",
    "messages":[
      {"role":"assistant","content":[
        {"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"/tmp/1"}},
        {"type":"tool_use","id":"call_2","name":"Read","input":{"file_path":"/tmp/2"}},
        {"type":"tool_use","id":"call_3","name":"Read","input":{"file_path":"/tmp/3"}}
      ]},
      {"role":"user","content":[
        {"type":"text","text":"Results arrived."},
        {"type":"tool_result","tool_use_id":"call_3","content":"three"},
        {"type":"tool_result","tool_use_id":"call_1","content":"one"},
        {"type":"tool_result","tool_use_id":"call_2","content":"two"},
        {"type":"text","text":"Continue."}
      ]}
    ]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3.7-flash-high", input, false);
  const callParts = getArr(output, "contents.0.parts");
  const responseParts = getArr(output, "contents.1.parts");
  expect(callParts.length).toBe(3);
  expect(responseParts.length).toBe(5);
  ["call_1", "call_2", "call_3"].forEach((wantID, index) => {
    expect(part(callParts[index], "functionCall.id")).toBe(wantID);
  });
  expect(part(responseParts[0], "text")).toBe("Results arrived.");
  expect(part(responseParts[1], "text")).toBe("Continue.");
  ["call_1", "call_2", "call_3"].forEach((wantID, index) => {
    expect(part(responseParts[index + 2], "functionResponse.id")).toBe(wantID);
    expect(part(responseParts[index + 2], "functionResponse.name")).toBe("Read");
  });
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
});

test("StringToolResult", () => {
  const input = `{
    "model": "gemini-3-flash-preview",
    "messages": [
      {"role": "assistant", "content": [{"type": "tool_use", "id": "json-call-1", "name": "json", "input": {"ok": true}}]},
      {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "json-call-1", "content": "alpha"}]}
    ]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  expect(exists(output, "contents.1.parts.0.functionResponse")).toBe(true);
  expect(getVal(output, "contents.1.parts.0.functionResponse.response.result")).toBe("alpha");
});

test("ToolResultWithTrailingSystemReminderReordersParts", () => {
  const input = `{
    "model": "gemini-3.8-flash",
    "messages": [
      {"role": "user", "content": [{"type": "text", "text": "Read the file"}]},
      {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_01_read", "name": "Read", "input": {"path": "main.go"}}]},
      {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_01_read", "content": "package main"},
        {"type": "text", "text": "<system-reminder>\\n<total_tokens>1234</total_tokens>\\n</system-reminder>"}
      ]}
    ]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3.8-flash", input, false);
  const contents = getArr(output, "contents");
  expect(contents.length).toBe(3);
  const userParts = getArr(output, "contents.2.parts");
  expect(userParts.length).toBe(2);
  // Text part must precede functionResponse part to prevent Vertex AI 400.
  expect(getAt(userParts[0], "text")).toBeDefined();
  expect(part(userParts[0], "text")).toBe("<system-reminder>\n<total_tokens>1234</total_tokens>\n</system-reminder>");
  expect(getAt(userParts[1], "functionResponse")).toBeDefined();
  expect(part(userParts[1], "functionResponse.id")).toBe("toolu_01_read");
});

describe("ToolStrictMapsToValidatedMode", () => {
  const cases: Array<{ name: string; toolChoice: string; expectedMode: string; allowedNames?: string[] }> = [
    { name: "absent tool_choice maps to VALIDATED", toolChoice: "", expectedMode: "VALIDATED" },
    { name: "explicit auto tool_choice maps to VALIDATED", toolChoice: `"tool_choice": {"type": "auto"},`, expectedMode: "VALIDATED" },
    { name: "null tool_choice maps to VALIDATED", toolChoice: `"tool_choice": null,`, expectedMode: "VALIDATED" },
    { name: "none tool_choice maps to NONE", toolChoice: `"tool_choice": {"type": "none"},`, expectedMode: "NONE" },
    { name: "any tool_choice maps to ANY", toolChoice: `"tool_choice": {"type": "any"},`, expectedMode: "ANY" },
    { name: "specific tool maps to ANY with allowedFunctionNames", toolChoice: `"tool_choice": {"type": "tool", "name": "tool_a"},`, expectedMode: "ANY", allowedNames: ["tool_a"] },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const input = `{
        "model": "gemini-3.8-flash",
        "messages": [{"role": "user", "content": "hi"}],
        ${tc.toolChoice}
        "tools": [{"name": "tool_a", "description": "Controlled tool.", "strict": true, "input_schema": {"type": "object", "properties": {}}}]
      }`;
      const result = convertClaudeRequestToGemini("gemini-3.8-flash", input, false);
      expect(exists(result, "tools.0.functionDeclarations.0.strict")).toBe(false);
      expect(getStr(result, "toolConfig.functionCallingConfig.mode")).toBe(tc.expectedMode);
      if (tc.allowedNames) expect(getVal(result, "toolConfig.functionCallingConfig.allowedFunctionNames")).toEqual(tc.allowedNames);
    });
  }

  test("mixed tools where one is strict maps to VALIDATED", () => {
    const input = `{
      "model": "gemini-3.8-flash",
      "messages": [{"role": "user", "content": "hi"}],
      "tools": [
        {"name": "tool_a", "description": "Loose tool.", "strict": false, "input_schema": {"type": "object", "properties": {}}},
        {"name": "tool_b", "description": "Strict tool.", "strict": true, "input_schema": {"type": "object", "properties": {}}}
      ]
    }`;
    const result = convertClaudeRequestToGemini("gemini-3.8-flash", input, false);
    expect(getStr(result, "toolConfig.functionCallingConfig.mode")).toBe("VALIDATED");
  });

  test("non-strict tools omit toolConfig mode", () => {
    const input = `{
      "model": "gemini-3.8-flash",
      "messages": [{"role": "user", "content": "hi"}],
      "tools": [
        {"name": "tool_a", "description": "Loose tool.", "strict": false, "input_schema": {"type": "object", "properties": {}}},
        {"name": "tool_b", "description": "Unspecified tool.", "input_schema": {"type": "object", "properties": {}}}
      ]
    }`;
    const result = convertClaudeRequestToGemini("gemini-3.8-flash", input, false);
    expect(exists(result, "toolConfig")).toBe(false);
  });
});

test("ParametersJsonSchema_PreservesAdditionalPropertiesAndPattern_Issue5959", () => {
  const input = `{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Use the submit tool."}],
    "tools": [{
      "name": "submit",
      "description": "Submit a bounded schema test value.",
      "input_schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": false,
        "properties": {"recipient": {"type": "string", "pattern": "^(alice|bob)$"}, "amount": {"type": "number"}},
        "required": ["recipient", "amount"]
      }
    }]
  }`;
  const output = convertClaudeRequestToGemini("gemini-2.5-flash", input, false);
  const schema = getVal(output, "tools.0.functionDeclarations.0.parametersJsonSchema");
  expect(schema).toBeDefined();
  expect(getAt(schema, "additionalProperties")).toBe(false);
  expect(getAt(schema, "properties.recipient.pattern")).toBe("^(alice|bob)$");
  expect(getAt(schema, "description")).not.toBe("No extra properties allowed");
  const recipientDesc = getAt(schema, "properties.recipient.description");
  expect(recipientDesc === undefined || !gstr(recipientDesc).includes("pattern:")).toBe(true);
});

test("FunctionResponseJSONRef", () => {
  const input = `{
    "model": "gemini-3.8-flash",
    "messages": [
      {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_schema_1", "name": "get_schema", "input": {}}]},
      {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_schema_1", "content": {"schema": {"$ref": "#/components/schemas/ErrorModel"}}}]}
    ]
  }`;
  const output = convertClaudeRequestToGemini("gemini-3.8-flash", input, false);
  const result = getVal(output, "contents.1.parts.0.functionResponse.response.result");
  expect(typeof result).toBe("string");
  expect(result as string).toContain("#/components/schemas/ErrorModel");
});

test("Issue5960_DocumentPreservation", () => {
  const pdfInput = `{"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": [
    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBERi0xLjQK"}}
  ]}]}`;
  const pdfOut = convertClaudeRequestToGemini("gemini-2.5-pro", pdfInput, false);
  expect(getArr(pdfOut, "contents.0.parts").length).toBeGreaterThan(0);
  expect(getStr(pdfOut, "contents.0.parts.0.inline_data.mime_type")).toBe("application/pdf");
  expect(getStr(pdfOut, "contents.0.parts.0.inline_data.data")).toBe("JVBERi0xLjQK");

  const mixedInput = `{"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": [
    {"type": "text", "text": "Please summarize this document:"},
    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBERi0xLjQK"}}
  ]}]}`;
  const mixedOut = convertClaudeRequestToGemini("gemini-2.5-pro", mixedInput, false);
  const mixedParts = getArr(mixedOut, "contents.0.parts");
  expect(mixedParts.length).toBe(2);
  expect(part(mixedParts[0], "text")).toBe("Please summarize this document:");
  expect(part(mixedParts[1], "inline_data.mime_type")).toBe("application/pdf");

  const interleavedInput = `{"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": [
    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "PDF_ONE"}},
    {"type": "text", "text": "compare with"},
    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "PDF_TWO"}}
  ]}]}`;
  const interleavedOut = convertClaudeRequestToGemini("gemini-2.5-pro", interleavedInput, false);
  const interleavedParts = getArr(interleavedOut, "contents.0.parts");
  expect(interleavedParts.length).toBe(3);
  expect(part(interleavedParts[0], "inline_data.data")).toBe("PDF_ONE");
  expect(part(interleavedParts[2], "inline_data.data")).toBe("PDF_TWO");

  const unsupportedInput = `{"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": [{"type": "unsupported_unknown_block", "foo": "bar"}]}]}`;
  const unsupportedOut = convertClaudeRequestToGemini("gemini-2.5-pro", unsupportedInput, false);
  expect(getArr(unsupportedOut, "contents").length).toBe(0);
});

test("ContainerUploadKeepsOtherText", () => {
  const input = `{"model": "gemini-3-flash-preview", "messages": [{"role": "user", "content": [
    {"type": "text", "text": "keep me"},
    {"type": "container_upload", "file_id": "file-example"}
  ]}]}`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  const parts = getArr(output, "contents.0.parts");
  expect(parts.length).toBe(1);
  expect(part(parts[0], "text")).toBe("keep me");
});

test("UnsendableFileNamesTheDroppedPart", () => {
  const blocks: Record<string, string> = {
    container_upload: `{"type": "container_upload", "file_id": "file-example"}`,
    document: `{"type": "document", "source": {"type": "file", "file_id": "file-example"}}`,
  };
  for (const [partType, block] of Object.entries(blocks)) {
    const input = `{"model": "gemini-3-flash-preview", "messages": [{"role": "user", "content": [${block}]}]}`;
    let caught: unknown;
    try {
      convertClaudeRequestToGeminiWithCompat("gemini-3-flash-preview", input, false);
    } catch (err) {
      caught = err;
    }
    expect(caught, partType).toBeInstanceOf(UnsupportedPartError);
    const unsupported = caught as UnsupportedPartError;
    expect(unsupported.message).toBe("unsupported content part: " + partType);
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.isRequestScoped()).toBe(true);
  }
});

test("ImageURLAndRedactedThinkingStaySkipped", () => {
  const input = `{"model": "gemini-3-flash-preview", "messages": [{"role": "user", "content": [
    {"type": "text", "text": "keep me"},
    {"type": "image", "source": {"type": "url", "url": "https://example.test/a.png"}},
    {"type": "redacted_thinking", "data": "abc"}
  ]}]}`;
  const output = convertClaudeRequestToGemini("gemini-3-flash-preview", input, false);
  const parts = getArr(output, "contents.0.parts");
  expect(parts.length).toBe(1);
  expect(part(parts[0], "text")).toBe("keep me");
  expect(raw(output, "contents.0.parts.0")).toBe('{"text":"keep me"}');
});
