// Ported from: internal/translator/openai/claude/openai_claude_request_test.go
// Skipped cases: none (TestClaudeFileOnlyRequestSurfacesUnsupportedPart, TestClaudeBase64DocumentBecomesFilePart and
//   TestClaudeTextWithUncachedFileKeepsText went through sdktranslator.TranslateRequestEnvelope upstream; here they call
//   the registered request transform via the default registry, where the refusal surfaces as a thrown UnsupportedPartError)
import { describe, expect, test } from "bun:test";
import { encodeBase64, urlEncoding } from "../../../src/util/base64.ts";
import { FormatClaude, FormatOpenAI } from "../../../src/translator/types.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import { UnsupportedPartError } from "../../../src/translator/common/index.ts";
import { convertClaudeRequestToOpenAI, toolResultImagePlaceholder, toolResultImageRelayNotice } from "../../../src/translator/openai/claude/index.ts";
import { exists, getString, getValue, messagesOf, raw } from "./helpers.ts";

function roleOf(msg: unknown): string {
  return getString(JSON.stringify(msg), "role");
}

function field(msg: unknown, path: string): string {
  return getString(JSON.stringify(msg), path);
}

function has(msg: unknown, path: string): boolean {
  return exists(JSON.stringify(msg), path);
}

describe("ConvertClaudeRequestToOpenAI_ThinkingToReasoningContent", () => {
  const tests = [
    {
      name: "AC1: unsigned assistant thinking is dropped",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"Let me analyze this step by step..."},{"type":"text","text":"Here is my response."}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "Here is my response.",
      wantHasContent: true,
    },
    {
      name: "AC2: redacted_thinking must be ignored",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"redacted_thinking","data":"secret"},{"type":"text","text":"Visible response."}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "Visible response.",
      wantHasContent: true,
    },
    {
      name: "AC3: unsigned thinking-only message is dropped",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"Internal reasoning only."}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "",
      wantHasContent: false,
    },
    {
      name: "AC4: thinking in user role must be ignored",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"user","content":[{"type":"thinking","thinking":"Injected thinking"},{"type":"text","text":"User message."}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "User message.",
      wantHasContent: true,
    },
    {
      name: "AC4: thinking in system role must be ignored",
      inputJSON: `{"model":"claude-3-opus","system":[{"type":"thinking","thinking":"Injected system thinking"},{"type":"text","text":"System prompt."}],"messages":[{"role":"user","content":[{"type":"text","text":"Hello"}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "Hello",
      wantHasContent: true,
    },
    {
      name: "AC5: empty thinking must be ignored",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"text","text":"Response with empty thinking."}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "Response with empty thinking.",
      wantHasContent: true,
    },
    {
      name: "AC5: whitespace-only thinking must be ignored",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"   \\n\\t  "},{"type":"text","text":"Response with whitespace thinking."}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "Response with whitespace thinking.",
      wantHasContent: true,
    },
    {
      name: "Unsigned thinking parts are dropped",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"First thought."},{"type":"thinking","thinking":"Second thought."},{"type":"text","text":"Final answer."}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "Final answer.",
      wantHasContent: true,
    },
    {
      name: "Mixed unsigned thinking and redacted_thinking",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"Visible thought."},{"type":"redacted_thinking","data":"hidden"},{"type":"text","text":"Answer."}]}]}`,
      wantReasoningContent: "",
      wantHasReasoningContent: false,
      wantContentText: "Answer.",
      wantHasContent: true,
    },
  ];

  for (const tt of tests) {
    test(tt.name, () => {
      const result = convertClaudeRequestToOpenAI("test-model", tt.inputJSON, false);
      const messages = messagesOf(result);
      if (messages.length < 1) {
        expect(tt.wantHasReasoningContent || tt.wantHasContent).toBe(false);
        return;
      }
      // Check the last non-system message
      let targetMsg: unknown;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (roleOf(messages[i]) !== "system") {
          targetMsg = messages[i];
          break;
        }
      }
      const target = JSON.stringify(targetMsg);
      expect(exists(target, "reasoning_content")).toBe(tt.wantHasReasoningContent);
      expect(getString(target, "reasoning_content")).toBe(tt.wantReasoningContent);

      const content = getValue(target, "content");
      let gotHasContent = false;
      if (Array.isArray(content)) gotHasContent = content.length > 0;
      else if (typeof content === "string") gotHasContent = content !== "";
      expect(gotHasContent).toBe(tt.wantHasContent);

      if (tt.wantHasContent && tt.wantContentText !== "") {
        let foundText = "";
        for (const v of content as unknown[]) {
          if (field(v, "type") === "text") {
            foundText = field(v, "text");
            break;
          }
        }
        expect(foundText).toBe(tt.wantContentText);
      }
    });
  }
});

function validGPTChatReasoningSignature(): string {
  const raw = new Uint8Array(1 + 8 + 16 + 16 + 32);
  raw[0] = 0x80;
  raw[8] = 1;
  for (let i = 9; i < raw.length; i++) raw[i] = i;
  return encodeBase64(raw, urlEncoding);
}

describe("ConvertClaudeRequestToOpenAI_SignedThinkingCompatibility", () => {
  const tests = [
    { name: "GPT-compatible signature keeps reasoning_content", signature: validGPTChatReasoningSignature(), wantReasoningContent: "provider state", wantHasReasoningContent: true },
    { name: "Claude signature drops reasoning_content", signature: "claude#EjQ=", wantReasoningContent: "", wantHasReasoningContent: false },
    { name: "Gemini signature drops reasoning_content", signature: "gemini#EjQKMgEMOdbHO0Gd+c9Mxk4ELwPGbpCEcp2mFfYYLix2UVtBH3fL8GECc4+JITVnHF4qZDsA", wantReasoningContent: "", wantHasReasoningContent: false },
    { name: "Unknown signature drops reasoning_content", signature: "not-a-provider-signature", wantReasoningContent: "", wantHasReasoningContent: false },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"provider state","signature":"${tt.signature}"},{"type":"text","text":"visible answer"}]}]}`;
      const result = convertClaudeRequestToOpenAI("gpt-5", inputJSON, false);
      expect(exists(result, "messages.0.reasoning_content")).toBe(tt.wantHasReasoningContent);
      expect(getString(result, "messages.0.reasoning_content")).toBe(tt.wantReasoningContent);
      expect(getString(result, "messages.0.content.0.text")).toBe("visible answer");
    });
  }
});

test("ConvertClaudeRequestToOpenAI_UnsignedThinkingOnlyMessageDropped", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"user","content":[{"type":"text","text":"What is 2+2?"}]},{"role":"assistant","content":[{"type":"thinking","thinking":"Let me calculate: 2+2=4"}]},{"role":"user","content":[{"type":"text","text":"Thanks"}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(2);
  for (const message of messages) expect(has(message, "reasoning_content")).toBe(false);
});

test("ConvertClaudeRequestToOpenAI_MessageSystemRoleWrapsAsUserReminder", () => {
  const inputJSON = `{"model":"claude-sonnet-4-5","system":[{"type":"text","text":"Top-level rules"}],"messages":[{"role":"user","content":[{"type":"text","text":"Hello"}]},{"role":"system","content":"String mid-conversation rule"},{"role":"assistant","content":[{"type":"text","text":"Hi there"}]},{"role":"system","content":[{"type":"text","text":"Array mid-conversation rule"}]},{"role":"user","content":[{"type":"text","text":"Follow up"}]}]}`;
  const result = convertClaudeRequestToOpenAI("gpt-5", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(6);
  expect(messages.map(roleOf)).toEqual(["system", "user", "user", "assistant", "user", "user"]);
  const systemContent = getValue(result, "messages.0.content") as unknown[];
  expect(systemContent.length).toBe(1);
  expect(field(systemContent[0], "text")).toBe("Top-level rules");
  expect(getString(result, "messages.2.content.0.text")).toBe("<system-reminder>\nString mid-conversation rule\n</system-reminder>");
  expect(getString(result, "messages.4.content.0.text")).toBe("<system-reminder>\nArray mid-conversation rule\n</system-reminder>");
});

test("ConvertClaudeRequestToOpenAI_PreservesToolAdjacencyWithInterveningSystemMessage", () => {
  const inputJSON = `{"model":"gpt-5","messages":[{"role":"user","content":[{"type":"text","text":"Execute tools"}]},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"tool_one","input":{"a":1}},{"type":"tool_use","id":"call_2","name":"tool_two","input":{"b":2}}]},{"role":"system","content":"Context update between tool call and tool result"},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_2","content":"result 2"},{"type":"tool_result","tool_use_id":"call_1","content":"result 1"},{"type":"text","text":"Now summarize"}]}]}`;
  const result = convertClaudeRequestToOpenAI("gpt-5", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.map(roleOf)).toEqual(["user", "assistant", "tool", "tool", "user", "user"]);
  expect(field(messages[2], "tool_call_id")).toBe("call_1");
  expect(field(messages[3], "tool_call_id")).toBe("call_2");
  expect(field(messages[4], "content.0.text")).toBe("<system-reminder>\nContext update between tool call and tool result\n</system-reminder>");
  expect(field(messages[5], "content.0.text")).toBe("Now summarize");
});

describe("ConvertClaudeRequestToOpenAI_SystemMessageScenarios", () => {
  const tests = [
    { name: "No system field", inputJSON: `{"model":"claude-3-opus","messages":[{"role":"user","content":"hello"}]}`, wantHasSys: false, wantSysText: "" },
    { name: "Empty string system field", inputJSON: `{"model":"claude-3-opus","system":"","messages":[{"role":"user","content":"hello"}]}`, wantHasSys: false, wantSysText: "" },
    { name: "String system field", inputJSON: `{"model":"claude-3-opus","system":"Be helpful","messages":[{"role":"user","content":"hello"}]}`, wantHasSys: true, wantSysText: "Be helpful" },
    { name: "Array system field with text", inputJSON: `{"model":"claude-3-opus","system":[{"type":"text","text":"Array system"}],"messages":[{"role":"user","content":"hello"}]}`, wantHasSys: true, wantSysText: "Array system" },
    { name: "Array system field with multiple text blocks", inputJSON: `{"model":"claude-3-opus","system":[{"type":"text","text":"Block 1"},{"type":"text","text":"Block 2"}],"messages":[{"role":"user","content":"hello"}]}`, wantHasSys: true, wantSysText: "Block 2" },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const result = convertClaudeRequestToOpenAI("test-model", tt.inputJSON, false);
      const messages = messagesOf(result);
      const hasSys = messages.length > 0 && roleOf(messages[0]) === "system";
      expect(hasSys).toBe(tt.wantHasSys);
      if (tt.wantHasSys) {
        const content = getValue(JSON.stringify(messages[0]), "content");
        let gotText: string;
        if (Array.isArray(content)) gotText = content.length > 0 ? field(content[content.length - 1], "text") : "";
        else gotText = String(content);
        if (tt.wantSysText !== "") expect(gotText).toBe(tt.wantSysText);
      }
    });
  }
});

test("ConvertClaudeRequestToOpenAI_ToolSchemaAddsMissingObjectProperties", () => {
  const inputJSON = `{"model":"claude-3-opus","tools":[{"name":"empty_params","description":"No args","input_schema":{"type":"object"}},{"name":"nested_params","description":"Nested args","input_schema":{"type":"object","properties":{"nested":{"type":"object"},"items":{"type":"array","items":{"type":"object"}}}}}],"messages":[{"role":"user","content":"hello"}]}`;
  const output = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  expect(getValue(output, "tools.0.function.parameters.properties")).toEqual({});
  expect(getValue(output, "tools.1.function.parameters.properties.nested.properties")).toEqual({});
  expect(getValue(output, "tools.1.function.parameters.properties.items.items.properties")).toEqual({});
});

test("ConvertClaudeRequestToOpenAI_ToolResultOrderAndContent", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"do_work","input":{"a":1}}]},{"role":"user","content":[{"type":"text","text":"before"},{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"tool ok"}]},{"type":"text","text":"after"}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(3);
  expect(roleOf(messages[0])).toBe("assistant");
  expect(has(messages[0], "tool_calls")).toBe(true);
  expect(roleOf(messages[1])).toBe("tool");
  expect(field(messages[1], "tool_call_id")).toBe("call_1");
  expect(field(messages[1], "content")).toBe("tool ok");
  expect(roleOf(messages[2])).toBe("user");
  expect(field(messages[2], "content.0.text")).toBe("before");
  expect(field(messages[2], "content.1.text")).toBe("after");
});

test("ConvertClaudeRequestToOpenAI_ToolResultObjectContent", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"do_work","input":{"a":1}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":{"foo":"bar"}}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(2);
  expect(roleOf(messages[1])).toBe("tool");
  const toolContent = field(messages[1], "content");
  expect(getString(toolContent, "foo")).toBe("bar");
});

test("ConvertClaudeRequestToOpenAI_ToolResultTextAndImageContent", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"do_work","input":{"a":1}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"tool ok"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUg=="}}]}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(3);
  expect(roleOf(messages[1])).toBe("tool");
  expect(Array.isArray(getValue(JSON.stringify(messages[1]), "content"))).toBe(false);
  expect(field(messages[1], "content")).toBe("tool ok");
  const relay = messages[2];
  expect(roleOf(relay)).toBe("user");
  expect(Array.isArray(getValue(JSON.stringify(relay), "content"))).toBe(true);
  expect(field(relay, "content.0.text")).toBe(toolResultImageRelayNotice);
  expect(field(relay, "content.1.type")).toBe("image_url");
  expect(field(relay, "content.1.image_url.url")).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
});

test("ConvertClaudeRequestToOpenAI_ToolResultURLImageOnly", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"do_work","input":{"a":1}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":{"type":"image","source":{"type":"url","url":"https://example.com/tool.png"}}}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(3);
  expect(field(messages[1], "content")).toBe(toolResultImagePlaceholder);
  expect(roleOf(messages[2])).toBe("user");
  expect(field(messages[2], "content.1.type")).toBe("image_url");
  expect(field(messages[2], "content.1.image_url.url")).toBe("https://example.com/tool.png");
});

test("ConvertClaudeRequestToOpenAI_ToolResultImageMergesIntoUserText", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"screenshot","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUg=="}}]},{"type":"text","text":"What color?"}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(3);
  expect(roleOf(messages[2])).toBe("user");
  const content = getValue(JSON.stringify(messages[2]), "content") as unknown[];
  expect(content.length).toBe(3);
  expect(field(content[0], "text")).toBe(toolResultImageRelayNotice);
  expect(field(content[1], "type")).toBe("image_url");
  expect(field(content[2], "text")).toBe("What color?");
});

test("ConvertClaudeRequestToOpenAI_MultipleToolResultsWithImages", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"shot1","input":{}},{"type":"tool_use","id":"call_2","name":"shot2","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"result 1"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"img1"}}]},{"type":"tool_result","tool_use_id":"call_2","content":{"type":"image","source":{"type":"url","url":"https://example.com/2.png"}}}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(4);
  expect(roleOf(messages[1])).toBe("tool");
  expect(field(messages[1], "tool_call_id")).toBe("call_1");
  expect(field(messages[1], "content")).toBe("result 1");
  expect(roleOf(messages[2])).toBe("tool");
  expect(field(messages[2], "tool_call_id")).toBe("call_2");
  expect(field(messages[2], "content")).toBe(toolResultImagePlaceholder);
  expect(roleOf(messages[3])).toBe("user");
  const relayContent = getValue(JSON.stringify(messages[3]), "content") as unknown[];
  expect(relayContent.length).toBe(3);
  expect(field(relayContent[0], "text")).toBe(toolResultImageRelayNotice);
  expect(field(relayContent[1], "image_url.url")).toBe("data:image/png;base64,img1");
  expect(field(relayContent[2], "image_url.url")).toBe("https://example.com/2.png");
});

test("ConvertClaudeRequestToOpenAI_AssistantTextToolUseTextOrder", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"text","text":"pre"},{"type":"tool_use","id":"call_1","name":"do_work","input":{"a":1}},{"type":"text","text":"post"}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(1);
  const assistantMsg = messages[0];
  expect(roleOf(assistantMsg)).toBe("assistant");
  expect(has(assistantMsg, "tool_calls")).toBe(true);
  expect(field(assistantMsg, "tool_calls.0.id")).toBe("call_1");
  expect(field(assistantMsg, "tool_calls.0.function.name")).toBe("do_work");
  expect(field(assistantMsg, "content.0.text")).toBe("pre");
  expect(field(assistantMsg, "content.1.text")).toBe("post");
});

test("ConvertClaudeRequestToOpenAI_AssistantThinkingToolUseThinkingSplit", () => {
  const inputJSON = `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"t1"},{"type":"text","text":"pre"},{"type":"tool_use","id":"call_1","name":"do_work","input":{"a":1}},{"type":"thinking","thinking":"t2"},{"type":"text","text":"post"}]}]}`;
  const result = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(1);
  const assistantMsg = messages[0];
  expect(roleOf(assistantMsg)).toBe("assistant");
  expect(field(assistantMsg, "content.0.text")).toBe("pre");
  expect(field(assistantMsg, "content.1.text")).toBe("post");
  expect(has(assistantMsg, "tool_calls")).toBe(true);
  expect(has(assistantMsg, "reasoning_content")).toBe(false);
});

test("ConvertClaudeRequestToOpenAI_StripsClaudeCodeAttribution", () => {
  const inputJSON = `{"model":"claude-sonnet-4-5","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.63.abc; cc_entrypoint=cli; cch=12345;"},{"type":"text","text":"User system prompt"}],"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`;
  const output = convertClaudeRequestToOpenAI("gpt-5", inputJSON, false);
  const messages = messagesOf(output);
  expect(messages.length).toBeGreaterThan(0);
  expect(roleOf(messages[0])).toBe("system");
  const content = getValue(JSON.stringify(messages[0]), "content") as unknown[];
  expect(content.length).toBe(1);
  expect(field(content[0], "text")).toBe("User system prompt");
});

describe("ConvertClaudeRequestToOpenAI_StopSequences", () => {
  const tests = [
    { name: "single stop sequence is emitted as array", inputJSON: `{"model":"claude-3-opus","stop_sequences":["</block>"],"messages":[{"role":"user","content":"hi"}]}`, wantStop: ["</block>"] },
    { name: "multiple stop sequences are emitted as array", inputJSON: `{"model":"claude-3-opus","stop_sequences":["stop1","stop2"],"messages":[{"role":"user","content":"hi"}]}`, wantStop: ["stop1", "stop2"] },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const output = convertClaudeRequestToOpenAI("gpt-4o", tt.inputJSON, false);
      const stop = getValue(output, "stop");
      expect(Array.isArray(stop)).toBe(true);
      expect(stop).toEqual(tt.wantStop);
    });
  }
});

test("ConvertClaudeRequestToOpenAI_ToolWithoutInputSchemaDefaultsParameters", () => {
  const inputJSON = `{"model":"claude-opus-5","tools":[{"type":"web_search_20250305","name":"web_search","max_uses":8},{"name":"no_schema_custom"},{"name":"null_schema_custom","input_schema":null}],"messages":[{"role":"user","content":"hello"}]}`;
  const output = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  ["web_search", "no_schema_custom", "null_schema_custom"].forEach((toolName, i) => {
    const path = `tools.${i}.function`;
    expect(getString(output, path + ".name")).toBe(toolName);
    expect(exists(output, path + ".parameters")).toBe(true);
    expect(getString(output, path + ".parameters.type")).toBe("object");
    expect(getValue(output, path + ".parameters.properties")).toEqual({});
  });
});

test("ConvertClaudeRequestToOpenAI_StripsUnsupportedUnicodePropertyEscapePatterns", () => {
  const inputJSON = String.raw`{"model":"gpt-5.6","messages":[{"role":"user","content":"hello"}],"tools":[{"name":"Artifact","description":"Render an HTML file to an Artifact","input_schema":{"type":"object","properties":{"field":{"type":"string","description":"field to replace","pattern":"^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$"},"asset_id":{"type":"string","pattern":"^[0-9a-f]{32}$"},"lookahead_safe":{"type":"string","pattern":"^(?!__.*__$).{1,200}$"}}}}]}`;
  const output = convertClaudeRequestToOpenAI("gpt-5.6", inputJSON, false);
  const params = raw(output, "tools.0.function.parameters");
  expect(params).not.toBe("");
  expect(exists(params, "properties.field.pattern")).toBe(false);
  expect(getString(params, "properties.field.type")).toBe("string");
  expect(getString(params, "properties.asset_id.pattern")).toBe("^[0-9a-f]{32}$");
  expect(getString(params, "properties.lookahead_safe.pattern")).toBe("^(?!__.*__$).{1,200}$");
});

test("ConvertClaudeRequestToOpenAI_PreservesNonSchemaPatternKeys", () => {
  const inputJSON = String.raw`{"model":"gpt-5.6","messages":[{"role":"user","content":"hello"}],"tools":[{"name":"config_tool","input_schema":{"type":"object","properties":{"regex_config":{"type":"object","default":{"pattern":"\\p{L}+"},"enum":[{"pattern":"\\p{N}+"}]},"real_schema":{"type":"string","pattern":"\\p{L}+"}}}}]}`;
  const output = convertClaudeRequestToOpenAI("gpt-5.6", inputJSON, false);
  const params = raw(output, "tools.0.function.parameters");
  expect(params).not.toBe("");
  expect(exists(params, "properties.real_schema.pattern")).toBe(false);
  expect(getString(params, "properties.regex_config.default.pattern")).toBe(String.raw`\p{L}+`);
  expect(getString(params, "properties.regex_config.enum.0.pattern")).toBe(String.raw`\p{N}+`);
});

test("ConvertClaudeRequestToOpenAI_StripsPatternPropertiesIncompatibleKeys", () => {
  const inputJSON = String.raw`{"model":"gpt-5.6","messages":[{"role":"user","content":"hello"}],"tools":[{"name":"pattern_tool","input_schema":{"type":"object","patternProperties":{"^\\\\p{L}+$":{"type":"string"},"^[a-z]+$":{"type":"number"}}}}]}`;
  const output = convertClaudeRequestToOpenAI("gpt-5.6", inputJSON, false);
  const patternProps = getValue(output, "tools.0.function.parameters.patternProperties") as Record<string, unknown>;
  expect(patternProps).toBeDefined();
  // Go looked up the single-backslash key `^\p{L}+$`; the JSON key actually decodes to `^\\p{L}+$`
  // (an escaped backslash followed by a literal p), which is not a Unicode property escape and is kept.
  expect(String.raw`^\p{L}+$` in patternProps).toBe(false);
  expect(String.raw`^\\p{L}+$` in patternProps).toBe(true);
  expect("^[a-z]+$" in patternProps).toBe(true);
});

test("ConvertClaudeRequestToOpenAI_ToolResultPreservesFunctionName", () => {
  const inputJSON = `{"model":"gemini-3.8-flash","max_tokens":64,"tools":[{"name":"get_weather","description":"Get weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}},{"name":"get_time","description":"Get time","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"messages":[{"role":"user","content":"What's the weather and time in Jakarta?"},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01ABC","name":"get_weather","input":{"city":"Jakarta"}},{"type":"tool_use","id":"toolu_02DEF","name":"get_time","input":{"city":"Jakarta"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"32C, humid"},{"type":"tool_result","tool_use_id":"toolu_02DEF","content":"12:00 PM"}]}]}`;
  const result = convertClaudeRequestToOpenAI("gemini-3.8-flash", inputJSON, false);
  const toolMessages = messagesOf(result).filter((m) => roleOf(m) === "tool");
  expect(toolMessages.length).toBe(2);
  expect(field(toolMessages[0], "tool_call_id")).toBe("toolu_01ABC");
  expect(field(toolMessages[0], "name")).toBe("get_weather");
  expect(field(toolMessages[0], "content")).toBe("32C, humid");
  expect(field(toolMessages[1], "tool_call_id")).toBe("toolu_02DEF");
  expect(field(toolMessages[1], "name")).toBe("get_time");
  expect(field(toolMessages[1], "content")).toBe("12:00 PM");
});

test("ConvertClaudeRequestToOpenAI_ToolResultUnknownIDNoName", () => {
  const inputJSON = `{"model":"gemini-3.8-flash","messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"orphan_call_1","content":"result"}]}]}`;
  const result = convertClaudeRequestToOpenAI("gemini-3.8-flash", inputJSON, false);
  expect(getString(result, "messages.0.role")).toBe("tool");
  expect(getString(result, "messages.0.tool_call_id")).toBe("orphan_call_1");
  expect(exists(result, "messages.0.name")).toBe(false);
});

test("ConvertClaudeRequestToOpenAI_ToolCallPairingByID", () => {
  const inputJSON = `{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":[{"type":"text","text":"Run analysis"}]},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"fetch_data","input":{"id":123}},{"type":"tool_use","id":"call_2","name":"calc_metric","input":{"scale":1.5}}]},{"role":"assistant","content":[{"type":"text","text":"Waiting for results to continue"},{"type":"thinking","thinking":"Thinking about next steps","signature":"sig_abc"}]},{"role":"user","content":[{"type":"text","text":"Reminder: keep timeout short"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_2","content":"metric_ok"},{"type":"tool_result","tool_use_id":"call_1","content":"data_ok"}]}]}`;
  const result = convertClaudeRequestToOpenAI("deepseek-v4.1-flash", inputJSON, false);
  const messages = messagesOf(result);
  const roles = messages.map(roleOf);
  expect(messages.length).toBe(6);
  expect(roles[1]).toBe("assistant");
  expect(has(messages[1], "tool_calls")).toBe(true);
  expect(roles[2]).toBe("tool");
  expect(roles[3]).toBe("tool");
  expect([field(messages[2], "tool_call_id"), field(messages[3], "tool_call_id")]).toEqual(["call_2", "call_1"]);
});

test("ConvertClaudeRequestToOpenAI_ToolCallPairing_OrphanAndIncompletePreserved", () => {
  const inputJSON = `{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":[{"type":"text","text":"Start"}]},{"role":"assistant","content":[{"type":"tool_use","id":"call_alpha","name":"do_a","input":{}},{"type":"tool_use","id":"call_beta","name":"do_b","input":{}}]},{"role":"user","content":[{"type":"text","text":"Waiting on results"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_unmatched","content":"orphan_result"}]}]}`;
  const result = convertClaudeRequestToOpenAI("deepseek-v4.1-flash", inputJSON, false);
  const messages = messagesOf(result);
  expect(messages.length).toBe(4);
  expect(messages.map(roleOf)).toEqual(["user", "assistant", "user", "tool"]);
});

describe("ConvertClaudeRequestToOpenAI_ToolChoice", () => {
  test("none does not become auto", () => {
    const inputJSON = `{"model":"gpt-5.4","max_tokens":64,"messages":[{"role":"user","content":"Answer without calling tools."}],"tool_choice":{"type":"none"},"tools":[{"name":"tool_a","description":"test","input_schema":{"type":"object","properties":{}}},{"name":"tool_b","description":"test","input_schema":{"type":"object","properties":{}}}]}`;
    const result = convertClaudeRequestToOpenAI("gpt-5.4", inputJSON, false);
    expect(getString(result, "tool_choice")).toBe("none");
  });

  test("disable_parallel_tool_use maps to parallel_tool_calls false", () => {
    const inputJSON = `{"model":"gpt-5.4","max_tokens":64,"messages":[{"role":"user","content":"test"}],"tool_choice":{"type":"auto","disable_parallel_tool_use":true},"tools":[{"name":"tool_a","description":"test","input_schema":{"type":"object","properties":{}}}]}`;
    const result = convertClaudeRequestToOpenAI("gpt-5.4", inputJSON, false);
    expect(getValue(result, "parallel_tool_calls")).toBe(false);
  });

  test("unknown tool_choice type fails closed to none", () => {
    const inputJSON = `{"model":"gpt-5.4","max_tokens":64,"messages":[{"role":"user","content":"test"}],"tool_choice":{"type":"unknown_future_restriction"},"tools":[{"name":"tool_a","description":"test","input_schema":{"type":"object","properties":{}}}]}`;
    const result = convertClaudeRequestToOpenAI("gpt-5.4", inputJSON, false);
    expect(getString(result, "tool_choice")).toBe("none");
  });

  test("tool choice with empty name fails closed to none", () => {
    const inputJSON = `{"model":"gpt-5.4","max_tokens":64,"messages":[{"role":"user","content":"test"}],"tool_choice":{"type":"tool","name":""},"tools":[{"name":"tool_a","description":"test","input_schema":{"type":"object","properties":{}}}]}`;
    const result = convertClaudeRequestToOpenAI("gpt-5.4", inputJSON, false);
    expect(getString(result, "tool_choice")).toBe("none");
  });

  test("tool_choice null does not set tool_choice", () => {
    const inputJSON = `{"model":"gpt-5.4","max_tokens":64,"messages":[{"role":"user","content":"test"}],"tool_choice":null,"tools":[{"name":"tool_a","description":"test","input_schema":{"type":"object","properties":{}}}]}`;
    const result = convertClaudeRequestToOpenAI("gpt-5.4", inputJSON, false);
    expect(exists(result, "tool_choice")).toBe(false);
  });
});

describe("ConvertClaudeRequestToOpenAI_EnabledThinkingEffort", () => {
  const tests = [
    { name: "explicit output_config effort is preserved without budget", inputJSON: `{"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`, wantEffort: "high" },
    { name: "legacy budget remains authoritative when both are present", inputJSON: `{"thinking":{"type":"enabled","budget_tokens":8192},"output_config":{"effort":"high"}}`, wantEffort: "medium" },
    { name: "enabled without budget or effort keeps auto default", inputJSON: `{"thinking":{"type":"enabled"}}`, wantEffort: "auto" },
    { name: "enabled with empty effort string falls back to auto", inputJSON: `{"thinking":{"type":"enabled"},"output_config":{"effort":""}}`, wantEffort: "auto" },
    { name: "enabled with whitespace-only effort falls back to auto", inputJSON: `{"thinking":{"type":"enabled"},"output_config":{"effort":"   "}}`, wantEffort: "auto" },
    { name: "enabled with non-string effort falls back to auto", inputJSON: `{"thinking":{"type":"enabled"},"output_config":{"effort":123}}`, wantEffort: "auto" },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const out = convertClaudeRequestToOpenAI("test-model", tt.inputJSON, false);
      expect(getString(out, "reasoning_effort")).toBe(tt.wantEffort);
    });
  }
});

test("ConvertClaudeRequestToOpenAI_NormalizesBooleanSubschemas", () => {
  const inputJSON = `{"model":"claude-3-opus","tools":[{"name":"patch_tool","description":"Applies a JSON patch","input_schema":{"type":"object","properties":{"patch":{"type":"array","items":true},"anything":true,"disabled":false,"enabled_flag":{"type":"boolean","default":true,"enum":[true,false]},"either":{"anyOf":[true,{"type":"string"}]},"nested_obj":{"type":"object","properties":{"foo":{"type":"string"}},"additionalProperties":true}},"additionalProperties":false,"$defs":{"wildcard":true}}}],"messages":[{"role":"user","content":"hello"}]}`;
  const output = convertClaudeRequestToOpenAI("test-model", inputJSON, false);
  const params = raw(output, "tools.0.function.parameters");
  expect(params).not.toBe("");
  expect(raw(params, "properties.patch.items")).toBe("{}");
  expect(raw(params, "properties.anything")).toBe("{}");
  expect(raw(params, "properties.either.anyOf.0")).toBe("{}");
  expect(raw(params, "$defs.wildcard")).toBe("{}");
  expect(getValue(params, "additionalProperties")).toBe(false);
  expect(getValue(params, "properties.nested_obj.additionalProperties")).toBe(true);
  expect(getValue(params, "properties.disabled")).toBe(false);
  expect(getValue(params, "properties.enabled_flag.default")).toBe(true);
  expect(getValue(params, "properties.enabled_flag.enum.0")).toBe(true);
  expect(getValue(params, "properties.enabled_flag.enum.1")).toBe(false);
});

test("ConvertClaudeRequestToOpenAI_UncachedFileKeepsOldDrop", () => {
  const input = `{"model":"gpt-5","messages":[{"role":"user","content":[{"type":"text","text":"read"},{"type":"container_upload","file_id":"file-absent"}]}]}`;
  const output = convertClaudeRequestToOpenAI("gpt-5", input, false);
  expect(output.includes("file_data")).toBe(false);
  expect(output.includes(`"text":"read"`)).toBe(true);
});

/** Go: claudeToOpenAIEnvelope — translation through the registered Claude -> OpenAI request transform. */
function claudeToOpenAI(model: string, input: string): string {
  return defaultRegistry.translateRequest(FormatClaude, FormatOpenAI, model, input, false);
}

test("ClaudeFileOnlyRequestSurfacesUnsupportedPart", () => {
  const input = `{"model":"gpt-5","messages":[{"role":"user","content":[{"type":"container_upload","file_id":"file-absent"}]}]}`;
  let caught: unknown;
  try {
    claudeToOpenAI("gpt-5", input);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UnsupportedPartError);
  expect((caught as Error).message).toContain("container_upload");
});

test("ClaudeBase64DocumentBecomesFilePart", () => {
  const input = `{"model":"gpt-5","messages":[{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQK"}}]}]}`;
  const body = claudeToOpenAI("gpt-5", input);
  expect(getString(body, "messages.0.content.0.type")).toBe("file");
  expect(getString(body, "messages.0.content.0.file.file_data")).toBe("data:application/pdf;base64,JVBERi0xLjQK");
});

test("ClaudeTextWithUncachedFileKeepsText", () => {
  const input = `{"model":"gpt-5","messages":[{"role":"user","content":[{"type":"text","text":"read"},{"type":"container_upload","file_id":"file-absent"}]}]}`;
  const body = claudeToOpenAI("gpt-5", input);
  expect(body.includes(`"text":"read"`)).toBe(true);
});
