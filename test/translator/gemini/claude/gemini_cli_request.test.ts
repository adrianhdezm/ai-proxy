// Ported from: internal/translator/gemini-cli/claude/gemini-cli_claude_request_test.go (CLIProxyAPI-v7.0.12)
// Skipped cases: none (the v7 ConvertClaudeRequestToCLI is replaced by wrapGeminiCLIRequest over
//   convertClaudeRequestToGemini; the Go assertions run against that composition)
import { expect, test } from "bun:test";
import { convertClaudeRequestToGemini, wrapGeminiCLIRequest } from "../../../../src/translator/gemini/claude/request.ts";
import { exists, getStr, getVal } from "../helpers.ts";

test("ConvertClaudeRequestToCLI_ToolChoice_SpecificTool", () => {
  const input = `{
    "model": "gemini-3-flash-preview",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
    "tools": [{"name": "json", "description": "A JSON tool", "input_schema": {"type": "object", "properties": {}}}],
    "tool_choice": {"type": "tool", "name": "json"}
  }`;
  const output = wrapGeminiCLIRequest("", "gemini-3-flash-preview", convertClaudeRequestToGemini("gemini-3-flash-preview", input, false));
  expect(getStr(output, "request.toolConfig.functionCallingConfig.mode")).toBe("ANY");
  expect(getVal(output, "request.toolConfig.functionCallingConfig.allowedFunctionNames")).toEqual(["json"]);
});

test("wrapGeminiCLIRequest builds the Code Assist envelope", () => {
  const body = convertClaudeRequestToGemini("gemini-2.5-pro", `{"model":"gemini-2.5-pro","system":"sys","messages":[{"role":"user","content":"hi"}]}`, false);
  const output = wrapGeminiCLIRequest("proj-123", "gemini-2.5-pro", body);
  expect(Object.keys(JSON.parse(output) as Record<string, unknown>)).toEqual(["project", "model", "request"]);
  expect(getStr(output, "project")).toBe("proj-123");
  expect(getStr(output, "model")).toBe("gemini-2.5-pro");
  expect(exists(output, "request.model")).toBe(false);
  expect(getStr(output, "request.systemInstruction.parts.0.text")).toBe("sys");
  expect(getStr(output, "request.contents.0.parts.0.text")).toBe("hi");
  expect(exists(output, "request.safetySettings")).toBe(true);

  // countTokens-style envelopes carry no project; the model comes from the body when omitted.
  const noProject = wrapGeminiCLIRequest("", "", body);
  expect(exists(noProject, "project")).toBe(false);
  expect(getStr(noProject, "model")).toBe("gemini-2.5-pro");
});
