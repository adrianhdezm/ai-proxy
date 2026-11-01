// Ported from: internal/translator/codex/openai/responses/codex_openai-responses_request_test.go
// Skipped cases: BenchmarkConvertSystemRoleToDeveloperLargeInput, BenchmarkConvertOpenAIResponsesRequestToCodexNormalizedPayload
//   (benchmarks; the large-input shape is exercised once as a correctness check instead)
import { describe, expect, test } from "bun:test";
import { getAt, gint, gstr } from "../../../../../src/util/gpath.ts";
import { FormatCodex, FormatOpenAIResponse } from "../../../../../src/translator/types.ts";
import { defaultRegistry } from "../../../../../src/translator/registry.ts";
import { convertOpenAIResponsesRequestToCodex } from "../../../../../src/translator/codex/openai/responses/index.ts";

function get(body: string, path: string): unknown {
  return getAt(JSON.parse(body), path);
}
function str(body: string, path: string): string {
  return gstr(get(body, path));
}
function has(body: string, path: string): boolean {
  return get(body, path) !== undefined;
}
function convert(input: string, stream = false): string {
  return convertOpenAIResponsesRequestToCodex("gpt-5.2", input, stream);
}

test("registered on the default registry", () => {
  expect(defaultRegistry.hasRequestTransformer(FormatOpenAIResponse, FormatCodex)).toBe(true);
  expect(defaultRegistry.hasStreamResponseTransformer(FormatOpenAIResponse, FormatCodex)).toBe(true);
  expect(defaultRegistry.hasNonStreamResponseTransformer(FormatOpenAIResponse, FormatCodex)).toBe(true);
});

test("ConvertSystemRoleToDeveloper_BasicConversion", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [
      {"type": "message", "role": "system", "content": [{"type": "input_text", "text": "You are a pirate."}]},
      {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Say hello."}]}
    ]
  }`);
  expect(str(out, "input.0.role")).toBe("developer");
  expect(str(out, "input.1.role")).toBe("user");
  expect(str(out, "input.0.content.0.text")).toBe("You are a pirate.");
});

test("ConvertSystemRoleToDeveloper_MultipleSystemMessages", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [
      {"type": "message", "role": "system", "content": [{"type": "input_text", "text": "You are helpful."}]},
      {"type": "message", "role": "system", "content": [{"type": "input_text", "text": "Be concise."}]},
      {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello"}]}
    ]
  }`);
  expect(str(out, "input.0.role")).toBe("developer");
  expect(str(out, "input.1.role")).toBe("developer");
  expect(str(out, "input.2.role")).toBe("user");
});

test("ConvertSystemRoleToDeveloper_NoSystemMessages", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [
      {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello"}]},
      {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hi there!"}]}
    ]
  }`);
  expect(str(out, "input.0.role")).toBe("user");
  expect(str(out, "input.1.role")).toBe("assistant");
});

test("ConvertSystemRoleToDeveloper_EmptyInput", () => {
  const out = convert(`{"model": "gpt-5.2", "input": []}`);
  const input = get(out, "input");
  expect(Array.isArray(input)).toBe(true);
  expect((input as unknown[]).length).toBe(0);
});

test("ConvertSystemRoleToDeveloper_NoInputField", () => {
  const out = convert(`{"model": "gpt-5.2", "stream": false}`);
  expect(get(out, "stream")).toBe(true);
  expect(get(out, "store")).toBe(false);
});

test("ConvertOpenAIResponsesRequestToCodex_OriginalIssue", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [
      {"type": "message", "role": "system", "content": "You are a pirate. Always respond in pirate speak."},
      {"type": "message", "role": "user", "content": "Say hello."}
    ],
    "stream": false
  }`);
  expect(str(out, "input.0.role")).toBe("developer");
  expect(get(out, "stream")).toBe(true);
  expect(get(out, "store")).toBe(false);
  expect(get(out, "parallel_tool_calls")).toBe(true);
  expect(get(out, "include")).toEqual(["reasoning.encrypted_content"]);
});

test("ConvertOpenAIResponsesRequestToCodexReusesNormalizedPayload", () => {
  const input = `{"model":"gpt-5.6","stream":true,"store":false,"parallel_tool_calls":true,"include":["reasoning.encrypted_content"],"service_tier":"priority","input":[{"type":"message","role":"user","content":"hello"}]}`;
  expect(convertOpenAIResponsesRequestToCodex("gpt-5.6", input, true)).toBe(input);
});

test("ConvertOpenAIResponsesRequestToCodexNormalizesRequiredFields", () => {
  const out = convertOpenAIResponsesRequestToCodex(
    "gpt-5.6",
    `{
    "model":"gpt-5.6",
    "stream":"true",
    "store":true,
    "parallel_tool_calls":null,
    "include":["file_search_call.results","reasoning.encrypted_content"],
    "max_output_tokens":4096,
    "max_completion_tokens":4096,
    "temperature":0.2,
    "top_p":0.9,
    "service_tier":"standard",
    "truncation":"auto",
    "prompt_cache_options":{"mode":"implicit"},
    "prompt_cache_retention":"24h",
    "user":"request-owner",
    "input":[{"type":"message","role":"system","content":"hello"}]
  }`,
    true,
  );
  expect(get(out, "stream")).toBe(true);
  expect(get(out, "store")).toBe(false);
  expect(get(out, "parallel_tool_calls")).toBe(true);
  expect(get(out, "include")).toEqual(["reasoning.encrypted_content"]);
  expect(str(out, "input.0.role")).toBe("developer");
  for (const path of [
    "max_output_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "service_tier",
    "truncation",
    "prompt_cache_options",
    "prompt_cache_retention",
    "user",
  ]) {
    expect(has(out, path)).toBe(false);
  }
});

describe("ConvertOpenAIResponsesRequestToCodex_PreservesWebSearchSourcesInclude", () => {
  const reasoningOnly = ["reasoning.encrypted_content"];
  const reasoningAndSources = ["reasoning.encrypted_content", "web_search_call.action.sources"];
  const tests: { name: string; includeJSON: string; want: string[] }[] = [
    { name: "missing include", includeJSON: "", want: reasoningOnly },
    { name: "null include", includeJSON: "null", want: reasoningOnly },
    { name: "string include", includeJSON: `"web_search_call.action.sources"`, want: reasoningOnly },
    { name: "object include", includeJSON: `{"web_search_call.action.sources":true}`, want: reasoningOnly },
    { name: "non-string entries", includeJSON: `[42,true]`, want: reasoningOnly },
    { name: "empty array", includeJSON: `[]`, want: reasoningOnly },
    { name: "sources alone", includeJSON: `["web_search_call.action.sources"]`, want: reasoningAndSources },
    { name: "reasoning then sources", includeJSON: `["reasoning.encrypted_content","web_search_call.action.sources"]`, want: reasoningAndSources },
    { name: "sources before reasoning", includeJSON: `["web_search_call.action.sources","reasoning.encrypted_content"]`, want: reasoningAndSources },
    { name: "duplicate sources", includeJSON: `["web_search_call.action.sources","web_search_call.action.sources"]`, want: reasoningAndSources },
    {
      name: "unsupported entries filtered",
      includeJSON: `["file_search_call.results","web_search_call.action.sources","code_interpreter_call.outputs"]`,
      want: reasoningAndSources,
    },
    { name: "non-string entries alongside sources", includeJSON: `[42,"web_search_call.action.sources",null]`, want: reasoningAndSources },
  ];
  for (const stream of [false, true]) {
    for (const tt of tests) {
      test(`stream_${stream}/${tt.name}`, () => {
        const base = `{"model":"gpt-5.6","input":[{"type":"message","role":"user","content":"hi"}]`;
        const input = tt.includeJSON !== "" ? `${base},"include":${tt.includeJSON}}` : `${base}}`;
        const out = convertOpenAIResponsesRequestToCodex("gpt-5.6", input, stream);
        expect(get(out, "include")).toEqual(tt.want);
      });
    }
  }
});

test("ConvertOpenAIResponsesRequestToCodex_WebSearchToolDoesNotOptIntoSources", () => {
  const out = convertOpenAIResponsesRequestToCodex(
    "gpt-5.6",
    `{"model":"gpt-5.6","input":"find python asyncio docs","tools":[{"type":"web_search"}],"tool_choice":"required"}`,
    true,
  );
  expect(get(out, "include")).toEqual(["reasoning.encrypted_content"]);
});

test("ConvertOpenAIResponsesRequestToCodexReusesNormalizedPayloadWithSources", () => {
  for (const includeJSON of [
    `["reasoning.encrypted_content","web_search_call.action.sources"]`,
    `[ "reasoning.encrypted_content" , "web_search_call.action.sources" ]`,
    `[ "reasoning.encrypted_content" ]`,
  ]) {
    const input = `{"model":"gpt-5.6","stream":true,"store":false,"parallel_tool_calls":true,"include":${includeJSON},"service_tier":"priority","input":[{"type":"message","role":"user","content":"hello"}]}`;
    expect(convertOpenAIResponsesRequestToCodex("gpt-5.6", input, true)).toBe(input);
  }
});

test("ConvertOpenAIResponsesRequestToCodex_FiltersPromptCacheRetention", () => {
  const out = convertOpenAIResponsesRequestToCodex(
    "gpt-5.6-terra",
    `{"model": "gpt-5.6-terra", "prompt_cache_retention": "24h", "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}]}`,
    true,
  );
  expect(has(out, "prompt_cache_retention")).toBe(false);
});

test("ConvertSystemRoleToDeveloper_AssistantRole", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [
      {"type": "message", "role": "system", "content": [{"type": "input_text", "text": "You are helpful."}]},
      {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello"}]},
      {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hi!"}]}
    ]
  }`);
  expect(str(out, "input.0.role")).toBe("developer");
  expect(str(out, "input.1.role")).toBe("user");
  expect(str(out, "input.2.role")).toBe("assistant");
});

test("ConvertOpenAIResponsesRequestToCodex_NormalizesWebSearchPreview", () => {
  const out = convertOpenAIResponsesRequestToCodex(
    "gpt-5.4-mini",
    `{
    "model": "gpt-5.4-mini",
    "input": "find latest OpenAI model news",
    "tools": [{"type": "web_search_preview_2025_03_11"}],
    "tool_choice": {"type": "allowed_tools", "tools": [{"type": "web_search_preview"}, {"type": "web_search_preview_2025_03_11"}]}
  }`,
    false,
  );
  expect(str(out, "tools.0.type")).toBe("web_search");
  expect(str(out, "tool_choice.type")).toBe("allowed_tools");
  expect(str(out, "tool_choice.tools.0.type")).toBe("web_search");
  expect(str(out, "tool_choice.tools.1.type")).toBe("web_search");
  // A string input becomes one user message.
  expect(get(out, "input")).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "find latest OpenAI model news" }] }]);
});

test("ConvertOpenAIResponsesRequestToCodex_NormalizesTopLevelToolChoicePreviewAlias", () => {
  const out = convertOpenAIResponsesRequestToCodex(
    "gpt-5.4-mini",
    `{"model": "gpt-5.4-mini", "input": "find latest OpenAI model news", "tool_choice": {"type": "web_search_preview_2025_03_11"}}`,
    false,
  );
  expect(str(out, "tool_choice.type")).toBe("web_search");
});

test("UserFieldDeletion", () => {
  const out = convert(`{"model": "gpt-5.2", "user": "test-user", "input": [{"role": "user", "content": "Hello"}]}`);
  expect(has(out, "user")).toBe(false);
});

test("ContextManagementCompactionCompatibility", () => {
  const out = convert(`{"model": "gpt-5.2", "context_management": [{"type": "compaction", "compact_threshold": 12000}], "input": [{"role":"user","content":"hello"}]}`);
  expect(has(out, "context_management")).toBe(false);
  expect(has(out, "truncation")).toBe(false);
});

test("TruncationRemovedForCodexCompatibility", () => {
  const out = convert(`{"model": "gpt-5.2", "truncation": "disabled", "input": [{"role":"user","content":"hello"}]}`);
  expect(has(out, "truncation")).toBe(false);
});

test("StripCodexResponsesCacheBreakpoints", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [{"type": "message", "role": "user", "content": [
      {"type": "input_text", "text": "Hello world", "prompt_cache_breakpoint": {"mode": "explicit"}},
      {"type": "input_text", "text": "Second part"}
    ]}]
  }`);
  expect(out.includes("prompt_cache_breakpoint")).toBe(false);
  expect(str(out, "input.0.content.0.text")).toBe("Hello world");
  expect(str(out, "input.0.content.1.text")).toBe("Second part");
});

test("StripCodexResponsesCacheBreakpoints_FunctionCallOutputParts", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [
      {"type": "function_call", "name": "shell", "call_id": "call_abc", "arguments": "{}"},
      {"type": "function_call_output", "call_id": "call_abc", "output": [{"type": "input_text", "text": "tool output", "prompt_cache_breakpoint": {"mode": "explicit"}}]}
    ]
  }`);
  expect(out.includes("prompt_cache_breakpoint")).toBe(false);
  expect(str(out, "input.1.output.0.text")).toBe("tool output");
});

test("StripCodexResponsesCacheBreakpoints_ItemLevel", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [
      {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}], "prompt_cache_breakpoint": {"mode": "explicit"}},
      {"type": "function_call_output", "call_id": "call_abc", "output": "plain string output", "prompt_cache_breakpoint": {"mode": "explicit"}}
    ]
  }`);
  expect(out.includes("prompt_cache_breakpoint")).toBe(false);
  expect(str(out, "input.0.content.0.text")).toBe("hi");
  expect(str(out, "input.1.output")).toBe("plain string output");
});

test("StripCodexResponsesCacheBreakpoints_CombinedItemAndPartLevel", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [{
      "type": "function_call_output",
      "call_id": "call_123",
      "prompt_cache_breakpoint": {"mode": "explicit"},
      "output": [
        {"type": "input_text", "text": "result part 1", "prompt_cache_breakpoint": {"mode": "explicit"}},
        {"type": "input_text", "text": "result part 2"}
      ]
    }]
  }`);
  expect(out.includes("prompt_cache_breakpoint")).toBe(false);
  expect((get(out, "input") as unknown[]).length).toBe(1);
  expect(str(out, "input.0.call_id")).toBe("call_123");
  expect(str(out, "input.0.output.0.text")).toBe("result part 1");
  expect(str(out, "input.0.output.1.text")).toBe("result part 2");
});

test("StripCodexResponsesCacheBreakpoints_WithSystemRole", () => {
  const out = convert(`{
    "model": "gpt-5.2",
    "input": [
      {"type": "message", "role": "system", "content": [{"type": "input_text", "text": "System prompt", "prompt_cache_breakpoint": {"mode": "explicit"}}]},
      {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "User query", "prompt_cache_breakpoint": {"mode": "explicit"}}]}
    ]
  }`);
  expect(str(out, "input.0.role")).toBe("developer");
  expect(out.includes("prompt_cache_breakpoint")).toBe(false);
  expect(str(out, "input.0.content.0.text")).toBe("System prompt");
  expect(str(out, "input.1.content.0.text")).toBe("User query");
});

test("ConvertSystemRoleToDeveloper large input (benchmark shape)", () => {
  const items: string[] = [];
  for (let i = 0; i < 200; i++) {
    const role = i % 100 === 0 ? "system" : "user";
    items.push(`{"type":"message","role":"${role}","content":[{"type":"input_text","text":"message ${i}"}]}`);
  }
  const out = convert(`{"model":"gpt-5.2","input":[${items.join(",")}]}`);
  expect(str(out, "input.0.role")).toBe("developer");
  expect(str(out, "input.1.role")).toBe("user");
  expect(str(out, "input.100.role")).toBe("developer");
});

describe("ConvertOpenAIResponsesRequestToCodex_ServiceTier", () => {
  const tests: { name: string; tierJSON: string; wantExists: boolean; wantTier?: string }[] = [
    { name: "priority preserved", tierJSON: `"priority"`, wantExists: true, wantTier: "priority" },
    { name: "priority case insensitive and trimmed", tierJSON: `" Priority "`, wantExists: true, wantTier: "priority" },
    { name: "fast normalized to priority", tierJSON: `"fast"`, wantExists: true, wantTier: "priority" },
    { name: "ultrafast preserved", tierJSON: `"ultrafast"`, wantExists: true, wantTier: "ultrafast" },
    { name: "ultrafast case insensitive and trimmed", tierJSON: `" UltraFast "`, wantExists: true, wantTier: "ultrafast" },
    { name: "standard stripped", tierJSON: `"standard"`, wantExists: false },
    { name: "default stripped", tierJSON: `"default"`, wantExists: false },
    { name: "flex stripped", tierJSON: `"flex"`, wantExists: false },
    { name: "non-string stripped", tierJSON: `123`, wantExists: false },
    { name: "null stripped", tierJSON: `null`, wantExists: false },
    { name: "bool stripped", tierJSON: `true`, wantExists: false },
    { name: "empty string stripped", tierJSON: `""`, wantExists: false },
    { name: "whitespace string stripped", tierJSON: `"   "`, wantExists: false },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const input = `{"model":"gpt-5.6","service_tier":${tt.tierJSON},"input":[{"type":"message","role":"user","content":"hello"}]}`;
      const out = convertOpenAIResponsesRequestToCodex("gpt-5.6", input, true);
      expect(has(out, "service_tier")).toBe(tt.wantExists);
      if (tt.wantExists) expect(str(out, "service_tier")).toBe(tt.wantTier!);
    });
  }
});

test("ConvertOpenAIResponsesRequestToCodex_NormalizesEmptyFunctionCallArguments", () => {
  const out = convertOpenAIResponsesRequestToCodex(
    "gpt-5.6",
    `{"model":"gpt-5.6","input":[
    {"type":"function_call","id":"fc_empty","call_id":"call_empty","name":"create_worktree","arguments":""},
    {"type":"function_call","id":"fc_blank","call_id":"call_blank","name":"list_artifacts","arguments":"   \\t\\n"},
    {"type":"function_call","id":"fc_kept","call_id":"call_kept","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"},
    {"type":"function_call","id":"fc_broken","call_id":"call_broken","name":"exec_command","arguments":"not-json"},
    {"type":"function_call","id":"fc_missing","call_id":"call_missing","name":"no_args"},
    {"type":"function_call","id":"fc_null","call_id":"call_null","name":"null_args","arguments":null},
    {"type":"function_call","id":"fc_num","call_id":"call_num","name":"num_args","arguments":123},
    {"type":"function_call_output","call_id":"call_empty","output":"worktree created"},
    {"type":"custom_tool_call","id":"ctc_1","call_id":"call_custom","name":"apply_patch","input":"exact patch"},
    {"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}
  ]}`,
    true,
  );
  ["{}", "{}", `{"cmd":"pwd"}`, "not-json"].forEach((want, index) => {
    expect(str(out, `input.${index}.arguments`)).toBe(want);
  });
  expect(has(out, "input.4.arguments")).toBe(false);
  expect(get(out, "input.5.arguments")).toBeNull();
  expect(gint(get(out, "input.6.arguments"))).toBe(123);
  expect(str(out, "input.7.type")).toBe("function_call_output");
  expect(str(out, "input.7.output")).toBe("worktree created");
  expect(str(out, "input.8.type")).toBe("custom_tool_call");
  expect(str(out, "input.8.input")).toBe("exact patch");
  expect(has(out, "input.8.arguments")).toBe(false);
  expect(str(out, "input.9.type")).toBe("message");
});

describe("ConvertOpenAIResponsesRequestToCodexParallelToolCalls", () => {
  const tests = [
    { name: "false preserved", field: `"parallel_tool_calls":false,`, want: false },
    { name: "true preserved", field: `"parallel_tool_calls":true,`, want: true },
    { name: "null defaults to true", field: `"parallel_tool_calls":null,`, want: true },
    { name: "omitted defaults to true", field: "", want: true },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const input = `{"model":"gpt-5.6","stream":true,"store":false,${tt.field}"include":["reasoning.encrypted_content"],"input":[{"type":"message","role":"user","content":"hello"}]}`;
      const out = convertOpenAIResponsesRequestToCodex("gpt-5.6", input, true);
      expect(get(out, "parallel_tool_calls")).toBe(tt.want);
    });
  }

  test("reuses normalized payload with parallel_tool_calls false", () => {
    const input = `{"model":"gpt-5.6","stream":true,"store":false,"parallel_tool_calls":false,"include":["reasoning.encrypted_content"],"service_tier":"priority","input":[{"type":"message","role":"user","content":"hello"}]}`;
    expect(convertOpenAIResponsesRequestToCodex("gpt-5.6", input, true)).toBe(input);
  });
});
