// Ported from: internal/translator/codex/claude/codex_claude_request_test.go
// Skipped cases: TestConvertClaudeRequestToCodex_ResolvesReplayTargetModelOncePerRequest (Go allocation budget; no TS equivalent)
import { describe, expect, test } from "bun:test";
import { convertClaudeRequestToCodex, normalizeToolParameters } from "../../../src/translator/codex/claude/index.ts";
import { getAt } from "../../../src/util/gpath.ts";
import { countRequestInputItemsByType, get, testMetaClaudeSignature, validCodexReasoningSignature } from "./helpers.ts";

describe("ConvertClaudeRequestToCodex system message scenarios", () => {
  const tests: { name: string; inputJSON: string; wantHasDeveloper: boolean; wantTexts?: string[] }[] = [
    { name: "No system field", inputJSON: `{"model":"claude-3-opus","messages":[{"role":"user","content":"hello"}]}`, wantHasDeveloper: false },
    { name: "Empty string system field", inputJSON: `{"model":"claude-3-opus","system":"","messages":[{"role":"user","content":"hello"}]}`, wantHasDeveloper: false },
    { name: "String system field", inputJSON: `{"model":"claude-3-opus","system":"Be helpful","messages":[{"role":"user","content":"hello"}]}`, wantHasDeveloper: true, wantTexts: ["Be helpful"] },
    {
      name: "Message system role does not become developer",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"system","content":"Follow the project instructions"},{"role":"user","content":"hello"}]}`,
      wantHasDeveloper: false,
    },
    {
      name: "Array system field with filtered billing header",
      inputJSON: `{"model":"claude-3-opus","system":[{"type":"text","text":"x-anthropic-billing-header: tenant-123"},{"type":"text","text":"Block 1"},{"type":"text","text":"Block 2"}],"messages":[{"role":"user","content":"hello"}]}`,
      wantHasDeveloper: true,
      wantTexts: ["Block 1", "Block 2"],
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const result = convertClaudeRequestToCodex("test-model", tt.inputJSON, false);
      const inputs = get(result, "input") as unknown[];
      const hasDeveloper = inputs.length > 0 && getAt(inputs[0], "role") === "developer";
      expect(hasDeveloper).toBe(tt.wantHasDeveloper);
      if (!tt.wantHasDeveloper) return;
      const content = getAt(inputs[0], "content") as unknown[];
      expect(content.length).toBe(tt.wantTexts!.length);
      tt.wantTexts!.forEach((wantText, i) => {
        expect(getAt(content[i], "type")).toBe("input_text");
        expect(getAt(content[i], "text")).toBe(wantText);
      });
    });
  }
});

test("ConvertClaudeRequestToCodex message system role wraps as user reminder", () => {
  const inputJSON = `{"model":"claude-3-opus","system":[{"type":"text","text":"Top-level rules"}],"messages":[
    {"role":"user","content":"hello"},
    {"role":"system","content":"Follow the project instructions"},
    {"role":"assistant","content":[{"type":"text","text":"ok"}]},
    {"role":"system","content":[{"type":"text","text":"Use the current repo"}]}
  ]}`;
  const result = convertClaudeRequestToCodex("test-model", inputJSON, false);
  const inputs = get(result, "input") as unknown[];
  expect(inputs.length).toBe(5);
  expect(getAt(inputs[0], "role")).toBe("developer");
  expect(getAt(inputs[2], "role")).toBe("user");
  expect(getAt(inputs[2], "content.0.text")).toBe("<system-reminder>\nFollow the project instructions\n</system-reminder>");
  expect(getAt(inputs[4], "role")).toBe("user");
  expect(getAt(inputs[4], "content.0.text")).toBe("<system-reminder>\nUse the current repo\n</system-reminder>");
});

test("ConvertClaudeRequestToCodex preserves tool adjacency with intervening system message", () => {
  const inputJSON = `{"model":"gpt-5.4","messages":[
    {"role":"user","content":[{"type":"text","text":"Execute tools"}]},
    {"role":"assistant","content":[
      {"type":"tool_use","id":"call_1","name":"tool_one","input":{"a":1}},
      {"type":"tool_use","id":"call_2","name":"tool_two","input":{"b":2}}
    ]},
    {"role":"system","content":"Context update between tool call and tool result"},
    {"role":"user","content":[
      {"type":"tool_result","tool_use_id":"call_2","content":"result 2"},
      {"type":"tool_result","tool_use_id":"call_1","content":"result 1"},
      {"type":"text","text":"Now summarize"}
    ]}
  ]}`;
  const result = convertClaudeRequestToCodex("gpt-5.4", inputJSON, false);
  const inputs = get(result, "input") as unknown[];
  const types = inputs.map((item) => getAt(item, "type"));
  expect(types).toEqual(["message", "function_call", "function_call", "function_call_output", "function_call_output", "message", "message"]);
  expect(getAt(inputs[3], "call_id")).toBe("call_1");
  expect(getAt(inputs[4], "call_id")).toBe("call_2");
  expect(getAt(inputs[5], "content.0.text")).toBe("<system-reminder>\nContext update between tool call and tool result\n</system-reminder>");
  expect(getAt(inputs[6], "content.0.text")).toBe("Now summarize");
});

describe("ConvertClaudeRequestToCodex parallel tool calls", () => {
  const tests: { name: string; inputJSON: string; want: boolean }[] = [
    { name: "Default to true when tool_choice.disable_parallel_tool_use is absent", inputJSON: `{"model":"claude-3-opus","messages":[{"role":"user","content":"hello"}]}`, want: true },
    { name: "Disable parallel tool calls when client opts out", inputJSON: `{"model":"claude-3-opus","tool_choice":{"disable_parallel_tool_use":true},"messages":[{"role":"user","content":"hello"}]}`, want: false },
    { name: "Keep parallel tool calls enabled when client explicitly allows them", inputJSON: `{"model":"claude-3-opus","tool_choice":{"disable_parallel_tool_use":false},"messages":[{"role":"user","content":"hello"}]}`, want: true },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const result = convertClaudeRequestToCodex("test-model", tt.inputJSON, false);
      expect(get(result, "parallel_tool_calls")).toBe(tt.want);
    });
  }
});

describe("ConvertClaudeRequestToCodex service tier", () => {
  const tests: { name: string; serviceTierJSON?: string; speedJSON?: string; want?: string; wantExists: boolean }[] = [
    { name: "Priority passes through", serviceTierJSON: `"priority"`, want: "priority", wantExists: true },
    { name: "Fast tier normalizes to priority", serviceTierJSON: `"fast"`, want: "priority", wantExists: true },
    { name: "Unsupported tier is omitted", serviceTierJSON: `"default"`, wantExists: false },
    { name: "Non-string tier is omitted", serviceTierJSON: `true`, wantExists: false },
    { name: "Fast speed maps to priority", speedJSON: `"fast"`, want: "priority", wantExists: true },
    { name: "Standard speed is omitted", speedJSON: `"standard"`, wantExists: false },
    { name: "Non-string speed is omitted", speedJSON: `true`, wantExists: false },
    { name: "Fast speed overrides unsupported Anthropic tier", serviceTierJSON: `"auto"`, speedJSON: `"fast"`, want: "priority", wantExists: true },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const input: Record<string, unknown> = { model: "gpt-5.4", messages: [{ role: "user", content: "Reply with OK" }] };
      if (tt.serviceTierJSON) input.service_tier = JSON.parse(tt.serviceTierJSON);
      if (tt.speedJSON) input.speed = JSON.parse(tt.speedJSON);
      const result = convertClaudeRequestToCodex("gpt-5.4", JSON.stringify(input), false);
      const serviceTier = get(result, "service_tier");
      expect(serviceTier !== undefined).toBe(tt.wantExists);
      if (tt.wantExists) expect(serviceTier).toBe(tt.want);
    });
  }
});

test("ConvertClaudeRequestToCodex shortens long tool_use IDs", () => {
  const longID = "toolu_" + "a".repeat(62);
  expect(longID.length).toBeGreaterThan(64);
  const inputJSON = `{"model":"claude-3-opus","messages":[
    {"role":"user","content":[{"type":"text","text":"run pwd"}]},
    {"role":"assistant","content":[{"type":"tool_use","id":"${longID}","name":"Bash","input":{"cmd":"pwd"}}]},
    {"role":"user","content":[{"type":"tool_result","tool_use_id":"${longID}","content":"ok"}]}
  ]}`;
  const result = convertClaudeRequestToCodex("test-model", inputJSON, false);
  const inputs = get(result, "input") as unknown[];
  let callID = "";
  let outputCallID = "";
  for (const item of inputs) {
    if (getAt(item, "type") === "function_call") callID = getAt(item, "call_id") as string;
    if (getAt(item, "type") === "function_call_output") outputCallID = getAt(item, "call_id") as string;
  }
  expect(callID).not.toBe("");
  expect(outputCallID).not.toBe("");
  expect(callID).toBe(outputCallID);
  expect(callID.length).toBeLessThanOrEqual(64);
  expect(callID).not.toBe(longID);
});

describe("ConvertClaudeRequestToCodex tool_choice mode mapping", () => {
  const tests: { name: string; claudeToolChoice: string; want: string }[] = [
    { name: "Any requires at least one tool", claudeToolChoice: `{"type":"any"}`, want: "required" },
    { name: "None disables tools", claudeToolChoice: `{"type":"none"}`, want: "none" },
    { name: "Auto stays auto", claudeToolChoice: `{"type":"auto"}`, want: "auto" },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const inputJSON = `{"model":"claude-3-opus","tools":[{"name":"lookup","description":"Lookup","input_schema":{"type":"object","properties":{}}}],"tool_choice":${tt.claudeToolChoice},"messages":[{"role":"user","content":"hello"}]}`;
      const result = convertClaudeRequestToCodex("test-model", inputJSON, false);
      expect(get(result, "tool_choice")).toBe(tt.want);
    });
  }
});

test("ConvertClaudeRequestToCodex tool_choice specific function uses converted name", () => {
  const longName = "mcp__server_with_a_very_long_name_that_exceeds_sixty_four_characters__search";
  const inputJSON = `{"model":"claude-3-opus","tools":[{"name":"${longName}","description":"Search","input_schema":{"type":"object","properties":{}}}],"tool_choice":{"type":"tool","name":"${longName}"},"messages":[{"role":"user","content":"hello"}]}`;
  const result = convertClaudeRequestToCodex("test-model", inputJSON, false);
  expect(get(result, "tool_choice.type")).toBe("function");
  const toolName = get(result, "tools.0.name");
  const choiceName = get(result, "tool_choice.name");
  expect(choiceName).toBe(toolName);
  expect(choiceName).not.toBe(longName);
});

describe("ConvertClaudeRequestToCodex web search sources include", () => {
  const tests: { name: string; tools?: string; wantSources?: boolean }[] = [
    { name: "no tools" },
    { name: "empty tools", tools: `[]` },
    { name: "ordinary function", tools: `[{"name":"lookup","input_schema":{"type":"object"}}]` },
    { name: "same name function", tools: `[{"name":"web_search","input_schema":{"type":"object"}}]` },
    { name: "unsupported type", tools: `[{"type":"web_search_20990101","name":"web_search"}]` },
    { name: "20250305", tools: `[{"type":"web_search_20250305","name":"web_search"}]`, wantSources: true },
    { name: "20260209", tools: `[{"type":"web_search_20260209","name":"web_search"}]`, wantSources: true },
    { name: "custom name", tools: `[{"type":"web_search_20250305","name":"browser_search"}]`, wantSources: true },
    { name: "nameless search", tools: `[{"type":"web_search_20250305"}]`, wantSources: true },
    {
      name: "multiple searches and function",
      tools: `[{"type":"web_search_20250305","name":"search_one"},{"type":"web_search_20260209","name":"search_two"},{"name":"lookup","input_schema":{"type":"object"}}]`,
      wantSources: true,
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      for (const stream of [false, true]) {
        let inputJSON = `{"model":"claude-opus-4-7","messages":[{"role":"user","content":"hello"}]`;
        if (tt.tools) inputJSON += `,"tools":${tt.tools}`;
        inputJSON += `}`;
        const result = convertClaudeRequestToCodex("test-model", inputJSON, stream);
        const wantInclude = tt.wantSources ? ["reasoning.encrypted_content", "web_search_call.action.sources"] : ["reasoning.encrypted_content"];
        expect(get(result, "include")).toEqual(wantInclude);
      }
    });
  }
});

test("ConvertClaudeRequestToCodex web search tool mapping", () => {
  const inputJSON = `{"model":"claude-3-opus","tools":[{"type":"web_search_20260209","name":"web_search","allowed_domains":["example.com"],"blocked_domains":["blocked.example"],"user_location":{"type":"approximate","city":"Beijing","country":"CN","timezone":"Asia/Shanghai"}}],"tool_choice":{"type":"tool","name":"web_search"},"messages":[{"role":"user","content":"hello"}]}`;
  const result = convertClaudeRequestToCodex("test-model", inputJSON, false);
  expect(get(result, "tools.0.type")).toBe("web_search");
  expect(get(result, "tools.0.filters.allowed_domains.0")).toBe("example.com");
  expect(get(result, "tools.0.blocked_domains")).toBeUndefined();
  expect(get(result, "tools.0.user_location.city")).toBe("Beijing");
  expect(get(result, "tool_choice.type")).toBe("web_search");
});

test("ConvertClaudeRequestToCodex web search tool_choice uses declared typed tool name", () => {
  const inputJSON = `{"model":"claude-opus-4-7","tools":[{"type":"web_search_20250305","name":"browser_search"},{"name":"web_search","description":"Local search","input_schema":{"type":"object","properties":{}}}],"tool_choice":{"type":"tool","name":"web_search"},"messages":[{"role":"user","content":"hello"}]}`;
  const result = convertClaudeRequestToCodex("test-model", inputJSON, false);
  expect(get(result, "tool_choice.type")).toBe("function");
  expect(get(result, "tool_choice.name")).toBe("web_search");
});

test("ConvertClaudeRequestToCodex assistant thinking signature to reasoning item", () => {
  const signature = validCodexReasoningSignature();
  const inputJSON = `{"model":"claude-3-opus","messages":[
    {"role":"assistant","content":[{"type":"thinking","thinking":"visible summary must not be replayed","signature":"${signature}"},{"type":"text","text":"visible answer"}]},
    {"role":"user","content":"continue"}
  ]}`;
  const result = convertClaudeRequestToCodex("test-model", inputJSON, false);
  const inputs = get(result, "input") as unknown[];
  expect(inputs.length).toBe(3);
  const reasoning = inputs[0];
  expect(getAt(reasoning, "type")).toBe("reasoning");
  expect(getAt(reasoning, "encrypted_content")).toBe(signature);
  expect(getAt(reasoning, "summary")).toEqual([]);
  expect(getAt(reasoning, "content")).toBeNull();
  const assistantMessage = inputs[1];
  expect(getAt(assistantMessage, "role")).toBe("assistant");
  expect(getAt(assistantMessage, "content.0.type")).toBe("output_text");
  expect(getAt(assistantMessage, "content.0.text")).toBe("visible answer");
  expect(result).not.toContain("visible summary must not be replayed");
});

test("ConvertClaudeRequestToCodex preserves base64 PDF document content", () => {
  const inputJSON = `{"messages":[{"role":"user","content":[
    {"type":"text","text":"before"},
    {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQK"}},
    {"type":"text","text":"after"}
  ]}]}`;
  const result = convertClaudeRequestToCodex("gpt-5.6-sol", inputJSON, false);
  const content = get(result, "input.0.content") as unknown[];
  expect(content.length).toBe(3);
  expect(content.map((c) => getAt(c, "type"))).toEqual(["input_text", "input_file", "input_text"]);
  expect(getAt(content[0], "text")).toBe("before");
  expect(getAt(content[1], "file_data")).toBe("data:application/pdf;base64,JVBERi0xLjQK");
  expect(getAt(content[1], "filename")).toBe("document.pdf");
  expect(getAt(content[2], "text")).toBe("after");
});

test("ConvertClaudeRequestToCodex preserves content order across tool and reasoning items", () => {
  const signature = validCodexReasoningSignature();
  const inputJSON = `{"system":"system rules","messages":[
    {"role":"assistant","content":[
      {"type":"text","text":"before reasoning"},
      {"type":"thinking","signature":"${signature}"},
      {"type":"text","text":"before tool"},
      {"type":"tool_use","id":"toolu_1","name":"lookup","input":{"query":"test"}},
      {"type":"text","text":"after tool"}
    ]},
    {"role":"user","content":[
      {"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"tool output"},{"type":"image","source":{"media_type":"image/png","data":"aW1hZ2U="}}]},
      {"type":"text","text":"continue"}
    ]}
  ],"tools":[{"name":"lookup","input_schema":{"type":"object"}}]}`;
  const result = convertClaudeRequestToCodex("gpt-5.4", inputJSON, false);
  const inputs = get(result, "input") as unknown[];
  expect(inputs.length).toBe(8);
  expect(inputs.map((i) => getAt(i, "type"))).toEqual(["message", "message", "reasoning", "message", "function_call", "message", "function_call_output", "message"]);
  expect(getAt(inputs[1], "content.0.text")).toBe("before reasoning");
  expect(getAt(inputs[3], "content.0.text")).toBe("before tool");
  expect(getAt(inputs[5], "content.0.text")).toBe("after tool");
  expect(getAt(inputs[6], "output.0.type")).toBe("input_text");
  expect(getAt(inputs[6], "output.1.image_url")).toBe("data:image/png;base64,aW1hZ2U=");
  expect(getAt(inputs[7], "content.0.text")).toBe("continue");
});

const grokSignature =
  "HmlYdr2aCAqCYP/m9mr8PS6KOsdMs72FGDigmydR+Jsmuv8KX97yWPlbOwmXJgWn0CbHaCacdQD3+n5EvpgLfPNmafS3kdICBjRuDf4bzHy7uBiUhNVhqPtp/ee1y9q4imPE4LYgD1VZ4J+bp9mTeqA1+nC9Oue58CiNEMV9SVaGenCD+aBnVuSTzQhD32Y+68i6HLJW0Dx6ifaRfb8hxYtA/sPM+/FTvAMW11nRho5a2BBSkpnzfqqAz/e/vGJ77/bygpXM823QA9wL9i0X";

function thinkingReplayPayload(model: string | undefined, signature: string): string {
  const payload: Record<string, unknown> = {
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "summary", signature }, { type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ],
  };
  if (model !== undefined) payload.model = model;
  return JSON.stringify(payload);
}

test("ConvertClaudeRequestToCodex assistant Grok signature to reasoning item", () => {
  const out = convertClaudeRequestToCodex("grok-4.5", thinkingReplayPayload("grok-4.5", grokSignature), false);
  expect(get(out, "input.0.type")).toBe("reasoning");
  expect(get(out, "input.0.encrypted_content")).toBe(grokSignature);
});

test("ConvertClaudeRequestToCodex assistant Meta signature to reasoning item", () => {
  const signature = testMetaClaudeSignature();
  const out = convertClaudeRequestToCodex("muse-spark-1.3", thinkingReplayPayload("muse-spark-1.3", signature), false);
  expect(get(out, "input.0.type")).toBe("reasoning");
  expect(get(out, "input.0.encrypted_content")).toBe(signature);
});

describe("ConvertClaudeRequestToCodex ignores Meta signature for non-Meta targets", () => {
  const payload = thinkingReplayPayload(undefined, testMetaClaudeSignature());
  for (const modelName of ["gpt-5.4", "claude-sonnet-4-6", "grok-4.5"]) {
    test(modelName, () => {
      const out = convertClaudeRequestToCodex(modelName, payload, false);
      expect(countRequestInputItemsByType(out, "reasoning")).toBe(0);
    });
  }
});

test("ConvertClaudeRequestToCodex assistant routed Meta signature to reasoning item", () => {
  // OpenRouter serves Meta Muse models and appends a dot-delimited alphanumeric
  // suffix to the native envelope; the full value must replay verbatim.
  const signature = testMetaClaudeSignature() + "." + "Ab3".repeat(23).slice(0, 67);
  const payload = thinkingReplayPayload("meta/muse-wonder", signature);
  let out = convertClaudeRequestToCodex("meta/muse-wonder", payload, false);
  expect(get(out, "input.0.type")).toBe("reasoning");
  expect(get(out, "input.0.encrypted_content")).toBe(signature);

  out = convertClaudeRequestToCodex("gpt-5.4", payload, false);
  expect(countRequestInputItemsByType(out, "reasoning")).toBe(0);

  // A foreign GPT signature must not be replayed when the target is a Meta Muse model.
  const gptPayload = thinkingReplayPayload("muse-spark-1.3", validCodexReasoningSignature());
  out = convertClaudeRequestToCodex("muse-spark-1.3", gptPayload, false);
  expect(countRequestInputItemsByType(out, "reasoning")).toBe(0);

  // When modelName is an unmapped upstream deployment alias, the client-requested
  // Meta Muse model in the payload preserves Meta signatures.
  const aliasOut = convertClaudeRequestToCodex("deployment-123", payload, false);
  expect(countRequestInputItemsByType(aliasOut, "reasoning")).toBe(1);
});

describe("ConvertClaudeRequestToCodex ignores Grok signature for non-Grok targets", () => {
  const payload = thinkingReplayPayload(undefined, grokSignature);
  for (const modelName of ["gpt-5.4", "claude-sonnet-4-6"]) {
    test(modelName, () => {
      const out = convertClaudeRequestToCodex(modelName, payload, false);
      expect(countRequestInputItemsByType(out, "reasoning")).toBe(0);
    });
  }
});

describe("ConvertClaudeRequestToCodex ignores non-Codex thinking signatures", () => {
  const tests: { name: string; inputJSON: string }[] = [
    {
      name: "Ignore user thinking even with Codex-shaped signature",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"user","content":[{"type":"thinking","thinking":"user supplied thinking","signature":"${validCodexReasoningSignature()}"},{"type":"text","text":"hello"}]}]}`,
    },
    {
      name: "Ignore Anthropic native signature",
      inputJSON: `{"model":"claude-3-opus","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"anthropic thinking","signature":"Eo8Canthropic-state"},{"type":"text","text":"visible answer"}]}]}`,
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const result = convertClaudeRequestToCodex("test-model", tt.inputJSON, false);
      expect(countRequestInputItemsByType(result, "reasoning")).toBe(0);
    });
  }
});

describe("ConvertClaudeRequestToCodex output_config format", () => {
  test("Valid json_schema format", () => {
    const payload = `{"model":"gpt-5.4","max_tokens":128,"messages":[{"role":"user","content":"Return an object with one string field named answer."}],"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}}}}`;
    const translated = convertClaudeRequestToCodex("gpt-5.4", payload, false);
    expect(get(translated, "text.format")).toBeDefined();
    expect(get(translated, "text.format.type")).toBe("json_schema");
    expect(get(translated, "text.format.name")).toBe("cli_proxy_structured_output");
    expect(get(translated, "text.format.strict")).toBe(true);
    expect(get(translated, "text.format.schema.properties.answer.type")).toBe("string");
  });

  test("Valid json_schema format with custom name and strict false", () => {
    const payload = `{"model":"gpt-5.4","messages":[{"role":"user","content":"hello"}],"output_config":{"format":{"type":"json_schema","name":"custom_schema","strict":false,"schema":{"type":"object"}}}}`;
    const translated = convertClaudeRequestToCodex("gpt-5.4", payload, false);
    expect(get(translated, "text.format.name")).toBe("custom_schema");
    expect(get(translated, "text.format.strict")).toBe(false);
  });

  test("No output_config.format", () => {
    const translated = convertClaudeRequestToCodex("gpt-5.4", `{"model":"gpt-5.4","messages":[{"role":"user","content":"hello"}]}`, false);
    expect(get(translated, "text.format")).toBeUndefined();
  });

  test("output_config with effort only", () => {
    const translated = convertClaudeRequestToCodex("gpt-5.4", `{"model":"gpt-5.4","output_config":{"effort":"high"},"messages":[{"role":"user","content":"hello"}]}`, false);
    expect(get(translated, "text.format")).toBeUndefined();
    expect(get(translated, "reasoning.effort")).toBe("high");
  });

  test("json_schema with optional property downgrades strict", () => {
    const payload = `{"model":"gpt-5.4","messages":[{"role":"user","content":"hello"}],"output_config":{"format":{"type":"json_schema","name":"cli_proxy_structured_output","strict":true,"schema":{"type":"object","properties":{"answer":{"type":"string"},"impossible":{"type":"string"}},"required":["answer"],"additionalProperties":false}}}}`;
    const translated = convertClaudeRequestToCodex("gpt-5.4", payload, false);
    expect(get(translated, "text.format.strict")).toBe(false);
    expect(get(translated, "text.format.name")).toBe("cli_proxy_structured_output");
  });

  test("json_schema fully required keeps strict", () => {
    const payload = `{"model":"gpt-5.4","messages":[{"role":"user","content":"hello"}],"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}}}}`;
    const translated = convertClaudeRequestToCodex("gpt-5.4", payload, false);
    expect(get(translated, "text.format.strict")).toBe(true);
  });
});

test("NormalizeToolParameters strips nested $schema and $id", () => {
  const input = `{
    "type":"object",
    "$schema":"http://json-schema.org/draft-07/schema#",
    "$id":"https://example.invalid/root",
    "properties":{
      "q":{"type":"string","$schema":"http://json-schema.org/draft-07/schema#","$id":"https://example.invalid/q"},
      "tags":{"type":"array","items":{"type":"string","$id":"https://example.invalid/tag"}},
      "mode":{"anyOf":[{"type":"string","$schema":"http://json-schema.org/draft-07/schema#"},{"type":"null"}]},
      "refField":{"$ref":"#/$defs/hint"}
    },
    "$defs":{"hint":{"type":"string","$id":"https://example.invalid/hint"}},
    "required":["q"]
  }`;
  const got = normalizeToolParameters(input);
  expect(get(got, "$schema")).toBeUndefined();
  expect(get(got, "$id")).toBeUndefined();
  expect(get(got, "properties.q.$schema")).toBeUndefined();
  expect(get(got, "properties.q.$id")).toBeUndefined();
  expect(get(got, "properties.tags.items.$id")).toBeUndefined();
  expect(get(got, "properties.mode.anyOf.0.$schema")).toBeUndefined();
  expect(get(got, "$defs.hint.$id")).toBeUndefined();
  expect(get(got, "properties.refField.$ref")).toBe("#/$defs/hint");
  expect(get(got, "properties.q.type")).toBe("string");
});

test("NormalizeToolParameters preserves property names and literal data", () => {
  const input = `{"type":"object","properties":{
    "$schema":{"type":"string","$schema":"http://json-schema.org/draft-07/schema#","$id":"https://example.invalid/sub-schema"},
    "$id":{"type":"string"},
    "config":{"type":"object","default":{"$id":"default-id-123"}}
  }}`;
  const got = normalizeToolParameters(input);
  expect(get(got, "properties.$schema")).toBeDefined();
  expect(get(got, "properties.$schema.$schema")).toBeUndefined();
  expect(get(got, "properties.$schema.$id")).toBeUndefined();
  expect(get(got, "properties.$id")).toBeDefined();
  expect(get(got, "properties.config.default.$id")).toBe("default-id-123");

  // Empty / null / invalid fallback
  expect(normalizeToolParameters("")).toBe(`{"type":"object","properties":{}}`);
  expect(normalizeToolParameters("null")).toBe(`{"type":"object","properties":{}}`);

  // Array union type preservation (e.g. ["object", "null"])
  const unionGot = normalizeToolParameters(`{"type": ["object", "null"]}`);
  expect(get(unionGot, "type")).toEqual(["object", "null"]);
  expect(get(unionGot, "properties")).toBeDefined();
});

test("ConvertClaudeRequestToCodex strips nested tool schema meta", () => {
  const inputJSON = `{"model":"gpt-5","messages":[{"role":"user","content":"hi"}],"tools":[{"name":"lookup","description":"Lookup","input_schema":{
    "type":"object","$schema":"http://json-schema.org/draft-07/schema#",
    "properties":{
      "q":{"type":"string","$schema":"http://json-schema.org/draft-07/schema#","$id":"https://example.invalid/q"},
      "tags":{"type":"array","items":{"type":"string","$id":"https://example.invalid/tag"}},
      "mode":{"anyOf":[{"type":"string","$schema":"http://json-schema.org/draft-07/schema#"},{"type":"null"}]}
    },
    "$defs":{"hint":{"type":"string","$id":"https://example.invalid/hint"}},
    "required":["q"]
  }}]}`;
  const translated = convertClaudeRequestToCodex("gpt-5", inputJSON, false);
  const tools = get(translated, "tools") as unknown[];
  expect(tools.length).toBeGreaterThan(0);
  const params = getAt(tools[0], "parameters");
  expect(getAt(params, "$schema")).toBeUndefined();
  expect(getAt(params, "properties.q.$schema")).toBeUndefined();
  expect(getAt(params, "properties.q.$id")).toBeUndefined();
  expect(getAt(params, "properties.tags.items.$id")).toBeUndefined();
  expect(getAt(params, "properties.mode.anyOf.0.$schema")).toBeUndefined();
  expect(getAt(params, "$defs.hint.$id")).toBeUndefined();
});

test("ConvertClaudeRequestToCodex strips unsupported Unicode property escape patterns", () => {
  const inputJSON = `{"model":"gpt-5.6","messages":[{"role":"user","content":"hello"}],"tools":[{"name":"Artifact","description":"Render an HTML file to an Artifact","input_schema":{
    "type":"object",
    "properties":{
      "field":{"type":"string","description":"field to replace","pattern":"^(?!__.*__$)[^\\\\p{Cc}\\\\p{Cf}\\\\p{Zl}\\\\p{Zp}\\"\\\\\\\\./[\\\\]]{1,200}$"},
      "asset_id":{"type":"string","pattern":"^[0-9a-f]{32}$"},
      "lookahead_safe":{"type":"string","pattern":"^(?!__.*__$).{1,200}$"},
      "literal_p":{"type":"string","pattern":"^\\\\\\\\p{Cc}$"},
      "nested":{"type":"object","properties":{"inner_field":{"type":"string","pattern":"\\\\P{L}+"}}},
      "union_field":{"anyOf":[{"type":"string","pattern":"\\\\p{N}+"},{"type":"null"}]}
    },
    "required":["field"]
  }}]}`;
  const translated = convertClaudeRequestToCodex("gpt-5.6", inputJSON, false);
  const tools = get(translated, "tools") as unknown[];
  expect(tools.length).toBeGreaterThan(0);
  const params = getAt(tools[0], "parameters");

  // The \p{...} pattern on field must be removed to avoid Python re failure upstream
  expect(getAt(params, "properties.field.pattern")).toBeUndefined();
  expect(getAt(params, "properties.field.type")).toBe("string");
  expect(getAt(params, "properties.field.description")).toBe("field to replace");

  // Valid patterns without unescaped \p must be preserved
  expect(getAt(params, "properties.asset_id.pattern")).toBe("^[0-9a-f]{32}$");
  expect(getAt(params, "properties.lookahead_safe.pattern")).toBe("^(?!__.*__$).{1,200}$");
  expect(getAt(params, "properties.literal_p.pattern")).toBe("^\\\\p{Cc}$");

  // Nested object with \P{L}+ must have its pattern removed
  expect(getAt(params, "properties.nested.properties.inner_field.pattern")).toBeUndefined();
  expect(getAt(params, "properties.nested.properties.inner_field.type")).toBe("string");

  // Union anyOf with \p{N}+ must have its pattern removed
  expect(getAt(params, "properties.union_field.anyOf.0.pattern")).toBeUndefined();

  expect(getAt(params, "required.0")).toBe("field");
});

test("ConvertClaudeRequestToCodex strips patternProperties incompatible keys", () => {
  const inputJSON = `{"model":"gpt-5.6","messages":[{"role":"user","content":"hello"}],"tools":[{"name":"pattern_tool","input_schema":{"type":"object","patternProperties":{"^\\\\p{L}+$":{"type":"string"},"^[a-z]+$":{"type":"number"}}}}]}`;
  const translated = convertClaudeRequestToCodex("gpt-5.6", inputJSON, false);
  const tools = get(translated, "tools") as unknown[];
  expect(tools.length).toBeGreaterThan(0);
  const patternProps = getAt(tools[0], "parameters.patternProperties") as Record<string, unknown>;
  expect(Object.prototype.hasOwnProperty.call(patternProps, "^\\p{L}+$")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(patternProps, "^[a-z]+$")).toBe(true);
});
