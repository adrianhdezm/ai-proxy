// Ported from: internal/runtime/executor/helps/claude_input_tokens_test.go
// Skipped cases: TestClaudeInputTokenizerConcurrentCount (tiktoken codec singleton; this port has no
//   tokenizer). Adapted: the estimate is ceil(chars / 4) over the same collected segments instead of an
//   o200k_base count, so the tests assert "positive"/"equal" rather than exact token numbers, as upstream did.
import { describe, expect, test } from "bun:test";
import {
  ClaudeInputTokenState,
  collectClaudeInputTokenSegments,
  countClaudeInputTokens,
  newClaudeInputTokenState,
  translateStreamWithClaudeInputTokens,
} from "../../../src/executor/openai/index.ts";
import { register, unregister } from "../../../src/translator/registry.ts";
import { FormatClaude, FormatGemini, FormatOpenAI, emptyContext, type TranslatorState } from "../../../src/translator/types.ts";
import { setLogLevel } from "../../../src/log.ts";
import { getInt, getString } from "./helpers.ts";

function messageStartInputTokens(chunks: string[]): number {
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (getString(payload, "type") === "message_start") return getInt(payload, "message.usage.input_tokens");
    }
  }
  return 0;
}

test("collectClaudeInputTokenSegments", () => {
  const payload = `{
    "model":"claude-test",
    "system":[
      {"type":"text","text":"Follow repository rules.","cache_control":{"type":"ephemeral"}},
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"ignored-system-image"}}
    ],
    "messages":[
      {"role":"user","content":[
        {"type":"text","text":"Review the implementation."},
        {"type":"document","source":{"type":"text","data":"Reference document text."}},
        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"ignored-image"}}
      ]},
      {"role":"assistant","content":[
        {"type":"thinking","thinking":"Inspect the relevant files.","signature":"ignored-signature"},
        {"type":"tool_use","id":"toolu_1","name":"read_file","input":{"path":"main.go"}}
      ]},
      {"role":"user","content":[
        {"type":"tool_result","tool_use_id":"toolu_1","content":[
          {"type":"text","text":"package main"},
          {"type":"image","source":{"type":"base64","data":"ignored-tool-image"}}
        ]}
      ]}
    ],
    "tools":[{
      "name":"read_file",
      "description":"Reads a repository file.",
      "input_schema":{"type":"object","properties":{"path":{"type":"string"}}},
      "cache_control":{"type":"ephemeral"}
    }],
    "tool_choice":{"type":"tool","name":"read_file"},
    "metadata":{"user_id":"ignored-metadata"},
    "max_tokens":4096,
    "stream":true
  }`;
  expect(collectClaudeInputTokenSegments(payload)).toEqual([
    "Follow repository rules.",
    "user",
    "Review the implementation.",
    "Reference document text.",
    "assistant",
    "Inspect the relevant files.",
    "toolu_1",
    "read_file",
    `{"path":"main.go"}`,
    "user",
    "toolu_1",
    "package main",
    "read_file",
    "Reads a repository file.",
    `{"type":"object","properties":{"path":{"type":"string"}}}`,
    "tool",
    "read_file",
  ]);
});

test("collectClaudeInputTokenSegments includes known tool results", () => {
  const payload = `{
    "messages":[{"role":"user","content":[
      {"type":"web_search_tool_result","tool_use_id":"ws_tool_1","content":[
        {"type":"web_search_result","source":"Search source","title":"Search result title","url":"https://search.example/result","page_age":"1 day","encrypted_content":"ignored-secret"}
      ]},
      {"type":"web_fetch_tool_result","tool_use_id":"fetch_tool_1","content":{
        "type":"web_fetch_result","url":"https://docs.example/page","retrieved_at":"2026-07-22T00:00:00Z","content":{
          "type":"document","title":"Fetched document","source":{"type":"text","data":"Fetched body"}
        }
      }},
      {"type":"bash_code_execution_tool_result","tool_use_id":"bash_tool_1","content":{
        "type":"bash_code_execution_result","stdout":"command output","stderr":"command error","return_code":1,
        "content":[{"type":"text","text":"additional output"}]
      }},
      {"type":"tool_result","tool_use_id":"toolu_1","content":[
        {"type":"tool_reference","tool_name":"proxy_mcp__nia__manage_resource"}
      ]}
    ]}]
  }`;
  const segments = collectClaudeInputTokenSegments(payload);
  const joined = "\n" + segments.join("\n") + "\n";
  for (const want of [
    "ws_tool_1",
    "Search source",
    "Search result title",
    "https://search.example/result",
    "1 day",
    "fetch_tool_1",
    "https://docs.example/page",
    "2026-07-22T00:00:00Z",
    "Fetched document",
    "Fetched body",
    "bash_tool_1",
    "command output",
    "command error",
    "1",
    "additional output",
    "toolu_1",
    "proxy_mcp__nia__manage_resource",
  ]) {
    expect(joined).toContain("\n" + want + "\n");
  }
  expect(joined).not.toContain("ignored-secret");
});

test("countClaudeInputTokens excludes multimedia and control fields", () => {
  const base = `{
    "system":"System text.",
    "messages":[{"role":"user","content":[{"type":"text","text":"User text."}]}],
    "tools":[{"name":"lookup","description":"Looks up data.","input_schema":{"type":"object"}}]
  }`;
  const withExcludedFields = `{
    "model":"claude-test",
    "system":"System text.",
    "messages":[{"role":"user","content":[
      {"type":"text","text":"User text."},
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"very-large-image-data"}},
      {"type":"input_audio","source":{"type":"base64","data":"very-large-audio-data"}},
      {"type":"video","source":{"type":"url","url":"https://example.com/video.mp4"}},
      {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"very-large-pdf-data"}}
    ]}],
    "tools":[{"name":"lookup","description":"Looks up data.","input_schema":{"type":"object"},"cache_control":{"type":"ephemeral"}}],
    "metadata":{"large_wrapper":"ignored"},
    "max_tokens":8192,
    "temperature":0.8,
    "top_p":0.9,
    "thinking":{"type":"enabled","budget_tokens":4096},
    "stream":true
  }`;
  const baseCount = countClaudeInputTokens(base);
  expect(baseCount).toBeGreaterThan(0);
  expect(countClaudeInputTokens(withExcludedFields)).toBe(baseCount);
});

test("translateStreamWithClaudeInputTokens patches message_start once", () => {
  const upstreamFormat = "claude-input-token-test-upstream";
  register(FormatClaude, upstreamFormat, undefined, { stream: (_ctx, _model, _orig, _req, rawJSON) => [rawJSON] });
  try {
    const originalRequest = `{"system":"System text.","messages":[{"role":"user","content":"Hello."}]}`;
    const state = newClaudeInputTokenState(FormatClaude, upstreamFormat, FormatClaude, originalRequest);
    const param: TranslatorState = {};
    const combined =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' + 'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n';
    const got = translateStreamWithClaudeInputTokens(emptyContext, upstreamFormat, FormatClaude, "claude-test", originalRequest, "", combined, param, state);
    expect(messageStartInputTokens(got)).toBeGreaterThan(0);
    expect(state.handled).toBe(true);
    expect(got.join("")).toContain(`"type":"content_block_start"`);

    const secondStart = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n';
    const gotSecond = translateStreamWithClaudeInputTokens(emptyContext, upstreamFormat, FormatClaude, "claude-test", originalRequest, "", secondStart, param, state);
    expect(messageStartInputTokens(gotSecond)).toBe(0);
  } finally {
    unregister(FormatClaude, upstreamFormat);
  }
});

test("ClaudeInputTokenState preserves CRLF and non-target events", () => {
  const originalRequest = `{"messages":[{"role":"user","content":"Hello."}]}`;
  const state = newClaudeInputTokenState(FormatClaude, FormatOpenAI, FormatClaude, originalRequest);
  const chunk =
    'event: message_start\r\ndata:  {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}  \r\n\r\n' + 'event: ping\r\ndata: {"type":"ping","value":"keep"}\r\n\r\n';
  const got = state.apply([chunk]);
  const tokens = messageStartInputTokens(got);
  expect(tokens).toBeGreaterThan(0);
  const want =
    `event: message_start\r\ndata:  {"type":"message_start","message":{"usage":{"input_tokens":${tokens},"output_tokens":0}}}  \r\n\r\n` + 'event: ping\r\ndata: {"type":"ping","value":"keep"}\r\n\r\n';
  expect(got.join("")).toBe(want);
});

describe("ClaudeInputTokenState patches missing and preserves non-zero", () => {
  const originalRequest = `{"messages":[{"role":"user","content":"Hello."}]}`;

  test("missing", () => {
    const state = newClaudeInputTokenState(FormatClaude, FormatOpenAI, FormatClaude, originalRequest);
    const got = state.apply(['data: {"type":"message_start","message":{"usage":{"output_tokens":0}}}\n\n']);
    expect(messageStartInputTokens(got)).toBeGreaterThan(0);
  });

  test("non-zero", () => {
    const state = newClaudeInputTokenState(FormatClaude, FormatOpenAI, FormatClaude, "not valid json");
    const got = state.apply(['data: {"type":"message_start","message":{"usage":{"input_tokens":73}}}\n\n']);
    expect(messageStartInputTokens(got)).toBe(73);
    expect(state.handled).toBe(true);
  });
});

describe("ClaudeInputTokenState skips unsupported flows", () => {
  const originalRequest = `{"messages":[{"role":"user","content":"Hello."}]}`;
  const cases = [
    { name: "non-Claude source", sourceFormat: FormatOpenAI, upstreamFormat: FormatGemini, responseFormat: FormatClaude },
    { name: "Claude passthrough", sourceFormat: FormatClaude, upstreamFormat: FormatClaude, responseFormat: FormatClaude },
    { name: "non-Claude response", sourceFormat: FormatClaude, upstreamFormat: FormatOpenAI, responseFormat: FormatOpenAI },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const state = newClaudeInputTokenState(tc.sourceFormat, tc.upstreamFormat, tc.responseFormat, originalRequest);
      const got = state.apply(['data: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n']);
      expect(messageStartInputTokens(got)).toBe(0);
      expect(state.handled).toBe(true);
    });
  }
});

test("ClaudeInputTokenState count error keeps zero", () => {
  setLogLevel("error");
  try {
    const state = new ClaudeInputTokenState(FormatClaude, FormatOpenAI, FormatClaude, `{"messages":[{"role":"user","content":"Hello."}]}`);
    state.counter = () => {
      throw new Error("count failed");
    };
    const got = state.apply(['data: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n']);
    expect(messageStartInputTokens(got)).toBe(0);
    expect(state.handled).toBe(true);
  } finally {
    setLogLevel("info");
  }
});

test("ClaudeInputTokenState invalid JSON keeps zero without logging the request", () => {
  const sensitiveRequest = `{"messages":["sensitive-original-request"`;
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const state = newClaudeInputTokenState(FormatClaude, FormatOpenAI, FormatClaude, sensitiveRequest);
    const got = state.apply(['data: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n']);
    expect(messageStartInputTokens(got)).toBe(0);
    expect(state.handled).toBe(true);
  } finally {
    console.warn = originalWarn;
  }
  const output = logged.join("\n");
  expect(output).toContain("failed to estimate Claude input tokens");
  expect(output).not.toContain("sensitive-original-request");
});
