// Ported from: internal/translator/openai/claude/openai_claude_response_test.go
// Skipped cases: BenchmarkConvertOpenAIResponseToClaude_LargeOriginalRequest (benchmark, not a test)
import { describe, expect, test } from "bun:test";
import { emptyContext, type TranslatorState } from "../../../src/translator/types.ts";
import { convertOpenAIResponseToClaude, convertOpenAIResponseToClaudeNonStream, extractOpenAIUsage } from "../../../src/translator/openai/claude/index.ts";
import { tryParse } from "../../../src/util/json.ts";
import {
  assertSequentialContentBlocks,
  blockIndices,
  countByType,
  exists,
  firstMessageDelta,
  getInt,
  getString,
  getValue,
  inputJSONDeltas,
  lastStopReason,
  runStream,
  streamReq,
  thinkingDeltas,
  toolUseStarts,
  type SSEEvent,
} from "./helpers.ts";

function stream(originalReq: string, rawJSON: string, state: TranslatorState, model = ""): string[] {
  return convertOpenAIResponseToClaude(emptyContext, model, originalReq, "", rawJSON, state);
}

function nonStream(originalReq: string, rawJSON: string): string {
  return convertOpenAIResponseToClaudeNonStream(emptyContext, "", originalReq, originalReq, rawJSON, {});
}

test("Streaming_LateUsageOnlyDoesNotEmitAfterMessageStop", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
    `{"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
  );
  expect(countByType(events, "message_delta")).toBe(1);
  expect(countByType(events, "message_stop")).toBe(1);
  expect(events[events.length - 1]!.type).toBe("message_stop");
});

describe("Streaming_SplitUsageFinishReasonThenTrailingUsageChunk_PreservesCachedTokens", () => {
  const tests = [
    {
      name: "text content with stop finish_reason",
      firstChunks: [`{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}`],
      finishChunk: `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":140025,"completion_tokens":741,"total_tokens":140766,"prompt_tokens_details":{}}}`,
      wantStopType: "end_turn",
    },
    {
      name: "tool call with tool_calls finish_reason",
      firstChunks: [`{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":null}]}`],
      finishChunk: `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":140025,"completion_tokens":741,"total_tokens":140766,"prompt_tokens_details":{}}}`,
      wantStopType: "tool_use",
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const trailingUsageChunk = `{"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":140025,"completion_tokens":741,"total_tokens":140766,"prompt_tokens_details":{"cached_tokens":139136}}}`;
      const events = runStream(streamReq, ...tt.firstChunks, tt.finishChunk, trailingUsageChunk);
      expect(countByType(events, "message_delta")).toBe(1);
      expect(countByType(events, "message_stop")).toBe(1);
      expect(events[events.length - 1]!.type).toBe("message_stop");
      const delta = firstMessageDelta(events);
      expect(delta).toBeDefined();
      expect(getString(delta!.payload, "delta.stop_reason")).toBe(tt.wantStopType);
      expect(getInt(delta!.payload, "usage.cache_read_input_tokens")).toBe(139136);
      expect(getInt(delta!.payload, "usage.input_tokens")).toBe(889);
      expect(getInt(delta!.payload, "usage.output_tokens")).toBe(741);
    });
  }
});

test("ConvertOpenAIResponseToClaude_StreamIgnoresNullToolNameDelta", () => {
  const state: TranslatorState = {};
  const first = stream(streamReq, `data: {"id":"chatcmpl_1","model":"test-model","created":1,"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}`, state, "test-model").join("");
  expect(first).toContain(`"name":"read_file"`);
  const second = stream(streamReq, `data: {"id":"chatcmpl_1","model":"test-model","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":null,"arguments":"{\\"path\\":\\"/tmp/a\\"}"}}]},"finish_reason":null}]}`, state, "test-model").join("");
  expect(second).not.toContain("content_block_start");
  expect(second).not.toContain(`"name":""`);
});

test("StreamingTool_EmptyNameThroughout", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","function":{"name":"","arguments":""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"x\\":1}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("tool_0");
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_a");
  expect(countByType(events, "content_block_delta")).toBe(1);
  expect(countByType(events, "content_block_stop")).toBe(1);
  expect(lastStopReason(events)).toBe("tool_use");
});

test("StreamingTool_NullName", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","function":{"name":null,"arguments":""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("tool_0");
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_a");
  expect(countByType(events, "content_block_stop")).toBe(1);
  expect(lastStopReason(events)).toBe("tool_use");
});

test("StreamingTool_NonStringName", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","function":{"name":123,"arguments":""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("tool_0");
});

test("StreamingTool_RepeatedName", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","function":{"name":"do_it","arguments":""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"do_it","arguments":"{\\"x\\""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"do_it","arguments":":1}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("do_it");
  expect(countByType(events, "content_block_stop")).toBe(1);
});

test("StreamingTool_MixedEmptyNameAndValid", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_empty","function":{"name":"","arguments":""}},{"index":1,"id":"call_real","function":{"name":"do_it","arguments":""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(2);
  // Valid name+id is emitted mid-stream first; empty-name is belated at finish.
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("do_it");
  expect(getString(starts[1]!.payload, "content_block.name")).toBe("tool_0");
  expect(countByType(events, "content_block_stop")).toBe(2);
  const indices = blockIndices(events);
  expect(indices.slice(0, 2)).toEqual([0, 1]);
});

test("StreamingTool_EmptyNameWithoutSignalIsSuppressed", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"name":"","arguments":""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  expect(toolUseStarts(events).length).toBe(0);
  expect(lastStopReason(events)).not.toBe("tool_use");
});

test("StreamingTool_EmptyIDDeferStart", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"","function":{"name":"do_it","arguments":""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_real","function":{"arguments":"{}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_real");
});

test("StreamingTool_IDInDeltaWithoutFunction", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"name":"do_it"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_real"}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_real");
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("do_it");
  expect(countByType(events, "content_block_stop")).toBe(1);
});

test("StreamingTool_StopReasonWithEmittedTool", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","function":{"name":"do_it","arguments":"{}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
  );
  expect(lastStopReason(events)).toBe("tool_use");
});

test("StreamingTool_StopReasonWhenIDNeverArrives", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"name":"do_it","arguments":""}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.id").startsWith("toolu_")).toBe(true);
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("do_it");
  expect(lastStopReason(events)).toBe("tool_use");
});

test("StreamingTool_BelatedStartsUseOpenAIToolIndexOrder", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":2,"function":{"name":"third_tool","arguments":"{}"}},{"index":0,"function":{"name":"first_tool","arguments":"{}"}},{"index":1,"function":{"name":"second_tool","arguments":"{}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(3);
  ["first_tool", "second_tool", "third_tool"].forEach((wantName, i) => {
    expect(getString(starts[i]!.payload, "content_block.name")).toBe(wantName);
    expect(getInt(starts[i]!.payload, "index")).toBe(i);
  });
});

test("StreamingTool_LateIDAfterFinalization", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"name":"do_it"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_late"}]}}]}`,
  );
  expect(toolUseStarts(events).length).toBe(1);
  let sawMessageStop = false;
  for (const e of events) {
    if (e.type === "message_stop") {
      sawMessageStop = true;
      continue;
    }
    if (sawMessageStop) expect(["content_block_start", "content_block_delta", "content_block_stop"]).not.toContain(e.type);
  }
});

test("StreamingTool_StopReasonMixedEmptyNameAndValid", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_empty","function":{"name":"","arguments":""}},{"index":1,"id":"call_real","function":{"name":"do_it","arguments":"{}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  expect(lastStopReason(events)).toBe("tool_use");
  expect(toolUseStarts(events).length).toBe(2);
});

test("StreamingTool_EmptyNameArgsOnlyNoID", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("tool_0");
  expect(getString(starts[0]!.payload, "content_block.id").startsWith("toolu_")).toBe(true);
  expect(lastStopReason(events)).toBe("tool_use");
});

test("StreamingTool_OmittedFinishReasonEmitsMessageDeltaOnDone", () => {
  const events = runStream(streamReq, `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"loc\\":\\"Paris\\"}"}}]},"finish_reason":null}]}`);
  expect(countByType(events, "message_delta")).toBe(1);
  expect(lastStopReason(events)).toBe("tool_use");
  expect(countByType(events, "message_stop")).toBe(1);
  expect(events[events.length - 2]!.type).toBe("message_delta");
  expect(events[events.length - 1]!.type).toBe("message_stop");
});

test("StreamingText_OmittedFinishReasonEmitsEndTurnOnDone", () => {
  const events = runStream(streamReq, `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hello world"},"finish_reason":null}]}`);
  expect(countByType(events, "message_delta")).toBe(1);
  expect(lastStopReason(events)).toBe("end_turn");
  expect(countByType(events, "message_stop")).toBe(1);
});

test("StreamingTool_UsageWithoutFinishReasonEmitsMessageDelta", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"loc\\":\\"Paris\\"}"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
  );
  expect(countByType(events, "message_delta")).toBe(1);
  expect(lastStopReason(events)).toBe("tool_use");
  const delta = firstMessageDelta(events)!;
  expect(getInt(delta.payload, "usage.input_tokens")).toBe(10);
  expect(getInt(delta.payload, "usage.output_tokens")).toBe(5);
  expect(countByType(events, "message_stop")).toBe(1);
});

function mergedArgs(events: SSEEvent[]): string {
  return inputJSONDeltas(events)
    .map((d) => getString(d.payload, "delta.partial_json"))
    .join("");
}

test("StreamingTool_PerChunkUsagePreservesToolArguments", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Skill","arguments":""}}]},"finish_reason":null}],"usage":{"prompt_tokens":191,"completion_tokens":5}}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"arguments":"{\\"skill\\": \\"stop-s"}}]},"finish_reason":null}],"usage":{"prompt_tokens":191,"completion_tokens":10}}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"arguments":"lop\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":191,"completion_tokens":15}}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("Skill");
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_1");
  expect(inputJSONDeltas(events).length).toBeGreaterThan(0);
  expect(mergedArgs(events)).toBe(`{"skill": "stop-slop"}`);
  expect(countByType(events, "message_delta")).toBe(1);
  expect(lastStopReason(events)).toBe("tool_use");
  expect(countByType(events, "message_stop")).toBe(1);
  const delta = firstMessageDelta(events)!;
  expect(getInt(delta.payload, "usage.input_tokens")).toBe(191);
  expect(getInt(delta.payload, "usage.output_tokens")).toBe(15);
});

test("StreamingTool_PerChunkUsageOmittedFinishReasonPreservesToolArguments", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Skill","arguments":""}}]},"finish_reason":null}],"usage":{"prompt_tokens":191,"completion_tokens":5}}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"arguments":"{\\"skill\\": \\"stop-s"}}]},"finish_reason":null}],"usage":{"prompt_tokens":191,"completion_tokens":10}}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"arguments":"lop\\"}"}}]},"finish_reason":null}],"usage":{"prompt_tokens":191,"completion_tokens":15}}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(1);
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("Skill");
  expect(inputJSONDeltas(events).length).toBeGreaterThan(0);
  expect(mergedArgs(events)).toBe(`{"skill": "stop-slop"}`);
  expect(countByType(events, "message_delta")).toBe(1);
  expect(lastStopReason(events)).toBe("tool_use");
  expect(countByType(events, "message_stop")).toBe(1);
  const delta = firstMessageDelta(events)!;
  expect(getInt(delta.payload, "usage.input_tokens")).toBe(191);
  expect(getInt(delta.payload, "usage.output_tokens")).toBe(15);
});

test("StreamingTool_OmittedToolCallIndexPreservesParallelCalls", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}},{"id":"call_time","type":"function","function":{"name":"get_time","arguments":"{\\"tz\\":\\"UTC\\"}"}}]},"finish_reason":"tool_calls"}]}`,
  );
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(2);
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_weather");
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("get_weather");
  expect(getString(starts[1]!.payload, "content_block.id")).toBe("call_time");
  expect(getString(starts[1]!.payload, "content_block.name")).toBe("get_time");
  const deltas = inputJSONDeltas(events);
  expect(deltas.length).toBe(2);
  const firstJSON = getString(deltas[0]!.payload, "delta.partial_json");
  const secondJSON = getString(deltas[1]!.payload, "delta.partial_json");
  expect(tryParse(firstJSON)).toBeDefined();
  expect(tryParse(secondJSON)).toBeDefined();
  expect(getString(firstJSON, "city")).toBe("Paris");
  expect(getString(secondJSON, "tz")).toBe("UTC");
  expect(countByType(events, "content_block_stop")).toBe(2);
  expect(lastStopReason(events)).toBe("tool_use");
});

const cacheUsageCases = [
  { name: "cache_write_tokens field", usageJSON: `{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":800,"cache_write_tokens":150}}`, wantInputTokens: 50, wantOutputTokens: 200, wantCacheReadTokens: 800, wantCacheWriteTokens: 150 },
  { name: "cache_creation_tokens alias", usageJSON: `{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":800,"cache_creation_tokens":150}}`, wantInputTokens: 50, wantOutputTokens: 200, wantCacheReadTokens: 800, wantCacheWriteTokens: 150 },
  { name: "cached_tokens greater than prompt_tokens clamps input_tokens to zero", usageJSON: `{"prompt_tokens":500,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":800,"cache_write_tokens":50}}`, wantInputTokens: 0, wantOutputTokens: 100, wantCacheReadTokens: 800, wantCacheWriteTokens: 50 },
  { name: "zero cache_write_tokens does not emit cache_creation_input_tokens", usageJSON: `{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":800,"cache_write_tokens":0}}`, wantInputTokens: 200, wantOutputTokens: 200, wantCacheReadTokens: 800, wantCacheWriteTokens: 0 },
  { name: "cache_write_tokens only deducts from input_tokens", usageJSON: `{"prompt_tokens":4022,"completion_tokens":462,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":4019}}`, wantInputTokens: 3, wantOutputTokens: 462, wantCacheReadTokens: 0, wantCacheWriteTokens: 4019 },
  { name: "combined cached and cache_write greater than prompt_tokens clamps to zero", usageJSON: `{"prompt_tokens":500,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":300,"cache_write_tokens":300}}`, wantInputTokens: 0, wantOutputTokens: 100, wantCacheReadTokens: 300, wantCacheWriteTokens: 300 },
];

describe("StreamingUsage_PreservesCacheWriteTokens", () => {
  for (const tt of cacheUsageCases) {
    test(tt.name, () => {
      const events = runStream(
        streamReq,
        `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"}}]}`,
        `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
        `{"id":"c1","model":"m","choices":[],"usage":${tt.usageJSON}}`,
      );
      const delta = firstMessageDelta(events);
      expect(delta).toBeDefined();
      expect(getInt(delta!.payload, "usage.input_tokens")).toBe(tt.wantInputTokens);
      expect(getInt(delta!.payload, "usage.output_tokens")).toBe(tt.wantOutputTokens);
      expect(getInt(delta!.payload, "usage.cache_read_input_tokens")).toBe(tt.wantCacheReadTokens);
      if (tt.wantCacheWriteTokens === 0) expect(exists(delta!.payload, "usage.cache_creation_input_tokens")).toBe(false);
      else expect(getInt(delta!.payload, "usage.cache_creation_input_tokens")).toBe(tt.wantCacheWriteTokens);
    });
  }
});

describe("NonStreamingUsage_PreservesCacheWriteTokens", () => {
  for (const tt of cacheUsageCases) {
    test(tt.name, () => {
      const rawJSON = `{"id":"chatcmpl-123","object":"chat.completion","created":1677652288,"model":"gpt-5.4","choices":[{"index":0,"message":{"role":"assistant","content":"Hello world"},"finish_reason":"stop"}],"usage":${tt.usageJSON}}`;
      const reqJSON = `{"model":"claude-3-5-sonnet-20241022","messages":[{"role":"user","content":"Hello"}]}`;
      const out = nonStream(reqJSON, rawJSON);
      expect(getInt(out, "usage.input_tokens")).toBe(tt.wantInputTokens);
      expect(getInt(out, "usage.output_tokens")).toBe(tt.wantOutputTokens);
      expect(getInt(out, "usage.cache_read_input_tokens")).toBe(tt.wantCacheReadTokens);
      if (tt.wantCacheWriteTokens === 0) expect(exists(out, "usage.cache_creation_input_tokens")).toBe(false);
      else expect(getInt(out, "usage.cache_creation_input_tokens")).toBe(tt.wantCacheWriteTokens);
    });
  }
});

test("Streaming_InterleavedContentAndToolUse_StrictSequentialBlocks", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"\\n"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  assertSequentialContentBlocks(events);
  const toolDeltas = inputJSONDeltas(events);
  expect(toolDeltas.length).toBe(1);
  expect(getString(getString(toolDeltas[0]!.payload, "delta.partial_json"), "command")).toBe("ls");
});

test("Streaming_ParallelToolCalls_StrictSequentialBlocks", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"/tmp\\"}"}}]},"finish_reason":"tool_calls"}]}`,
  );
  assertSequentialContentBlocks(events);
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(2);
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_1");
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("Bash");
  expect(getString(starts[1]!.payload, "content_block.id")).toBe("call_2");
  expect(getString(starts[1]!.payload, "content_block.name")).toBe("Read");
  const toolDeltas = inputJSONDeltas(events);
  expect(toolDeltas.length).toBe(2);
  expect(getString(getString(toolDeltas[0]!.payload, "delta.partial_json"), "command")).toBe("ls");
  expect(getString(getString(toolDeltas[1]!.payload, "delta.partial_json"), "path")).toBe("/tmp");
});

test("Streaming_InterleavedTextAndThinkingPreservesOrder", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Note A: "},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"running check"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"reasoning_content":"Thinking about safety"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Note B: done"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"pwd\\"}"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  );
  assertSequentialContentBlocks(events);
  const blockStarts = events.filter((e) => e.type === "content_block_start").map((e) => getString(e.payload, "content_block.type"));
  expect(blockStarts).toEqual(["tool_use", "text", "thinking", "text"]);
  const textDeltas: string[] = [];
  const thinking: string[] = [];
  let toolDelta = "";
  for (const e of events) {
    if (e.type !== "content_block_delta") continue;
    switch (getString(e.payload, "delta.type")) {
      case "text_delta":
        textDeltas.push(getString(e.payload, "delta.text"));
        break;
      case "thinking_delta":
        thinking.push(getString(e.payload, "delta.thinking"));
        break;
      case "input_json_delta":
        toolDelta = getString(e.payload, "delta.partial_json");
        break;
    }
  }
  expect(getString(toolDelta, "command")).toBe("pwd");
  expect(textDeltas).toEqual(["Note A: running check", "Note B: done"]);
  expect(thinking).toEqual(["Thinking about safety"]);
});

test("StreamingTool_FinishReasonLengthEmitsMaxTokensStopReason", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/test.txt\\",\\"content\\":\\"hello"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":400}}`,
  );
  expect(lastStopReason(events)).toBe("max_tokens");
});

test("StreamingTool_TruncatedArgumentsWithoutFinishReasonEmitsMaxTokens", () => {
  const events = runStream(streamReq, `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/test.txt\\",\\"content\\":\\"hello"}}]},"finish_reason":null}]}`);
  expect(lastStopReason(events)).toBe("max_tokens");
});

test("StreamingTool_ValidArgumentsWithStopReasonEmitsToolUse", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/test.txt\\"}"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}`,
  );
  expect(lastStopReason(events)).toBe("tool_use");
});

test("StreamingTool_TruncatedArgumentsWithStopReasonEmitsMaxTokens", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/test.txt\\""}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}`,
  );
  expect(lastStopReason(events)).toBe("max_tokens");
});

test("StreamingTool_EmptyArgumentsWithToolCallsEmitsToolUse", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_time","arguments":""}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":10}}`,
  );
  expect(lastStopReason(events)).toBe("tool_use");
});

test("StreamingTool_WhitespaceOnlyArgumentsWithoutFinishReasonEmitsMaxTokens", () => {
  const events = runStream(streamReq, `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":" \\n\\t"}}]},"finish_reason":null}]}`);
  expect(lastStopReason(events)).toBe("max_tokens");
});

test("StreamingTool_ContentFilterWithToolCallEmitsEndTurn", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/test.txt\\"}"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}`,
  );
  expect(lastStopReason(events)).toBe("end_turn");
});

test("StreamingTool_ParallelCallsOneTruncatedEmitsMaxTokens", () => {
  const events = runStream(streamReq, `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/a\\"}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/b"}}]},"finish_reason":null}]}`);
  expect(lastStopReason(events)).toBe("max_tokens");
});

test("StreamingTool_MultiChunkTruncatedWithTrailingUsageEmitsMaxTokens", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/a\\","}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"arguments":"\\"content\\":\\"incompl"}}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":400}}`,
  );
  expect(lastStopReason(events)).toBe("max_tokens");
});

test("Streaming_ReasoningFieldEmitsThinkingDelta", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"reasoning":"I am thinking","reasoning_details":[{"type":"reasoning.text","text":"I am thinking"}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  );
  expect(thinkingDeltas(events)).toEqual(["I am thinking"]);
});

test("Streaming_ReasoningContentStillPreferred", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"reasoning_content":"primary reasoning","reasoning":"fallback reasoning"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  );
  expect(thinkingDeltas(events)).toEqual(["primary reasoning"]);
});

test("Streaming_ReasoningDetailsOnlyEmitsThinkingDelta", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.text","text":"Only details thinking"}]},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  );
  expect(thinkingDeltas(events)).toEqual(["Only details thinking"]);
});

test("Streaming_EmptyReasoningContentFallsBackToReasoning", () => {
  const events = runStream(
    streamReq,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"reasoning_content":"","reasoning":"fallback from empty"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"reasoning_content":null,"reasoning":"fallback from null"},"finish_reason":null}]}`,
    `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  );
  expect(thinkingDeltas(events)).toEqual(["fallback from empty", "fallback from null"]);
});

function thinkingTexts(body: string): string[] {
  const content = getValue(body, "content");
  if (!Array.isArray(content)) return [];
  return content.filter((b) => getString(JSON.stringify(b), "type") === "thinking").map((b) => getString(JSON.stringify(b), "thinking"));
}

test("NonStream_ReasoningFieldEmitsThinkingBlock", () => {
  const rawJSON = `{"id":"chatcmpl-1","object":"chat.completion","model":"deepseek","choices":[{"index":0,"message":{"role":"assistant","content":"Done","reasoning":"Thought process"},"finish_reason":"stop"}]}`;
  const out = convertOpenAIResponseToClaudeNonStream(emptyContext, "", "", "", rawJSON, {});
  expect(thinkingTexts(out)).toEqual(["Thought process"]);

  // Via the stream entry point with a non-streaming request
  const emitted = stream(`{"stream":false}`, "data: " + rawJSON, {});
  expect(emitted.length).toBeGreaterThan(0);
  expect(thinkingTexts(emitted[0]!)).toEqual(["Thought process"]);
});

describe("ExtractOpenAIUsage", () => {
  const tests = [
    { name: "nil / absent usage", rawUsage: "", wantInputTokens: 0, wantOutputTokens: 0, wantCachedTokens: 0, wantCacheWriteTokens: 0 },
    { name: "null usage", rawUsage: "null", wantInputTokens: 0, wantOutputTokens: 0, wantCachedTokens: 0, wantCacheWriteTokens: 0 },
    { name: "only prompt and completion tokens without cache details", rawUsage: `{"prompt_tokens":100,"completion_tokens":50}`, wantInputTokens: 100, wantOutputTokens: 50, wantCachedTokens: 0, wantCacheWriteTokens: 0 },
    { name: "deducts cache_read_tokens only", rawUsage: `{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":30}}`, wantInputTokens: 70, wantOutputTokens: 50, wantCachedTokens: 30, wantCacheWriteTokens: 0 },
    { name: "deducts cache_write_tokens only (issue 5956)", rawUsage: `{"prompt_tokens":4022,"completion_tokens":462,"prompt_tokens_details":{"cache_write_tokens":4019}}`, wantInputTokens: 3, wantOutputTokens: 462, wantCachedTokens: 0, wantCacheWriteTokens: 4019 },
    { name: "deducts cache_creation_tokens alias only", rawUsage: `{"prompt_tokens":4022,"completion_tokens":462,"prompt_tokens_details":{"cache_creation_tokens":4019}}`, wantInputTokens: 3, wantOutputTokens: 462, wantCachedTokens: 0, wantCacheWriteTokens: 4019 },
    { name: "deducts both cached_tokens and cache_write_tokens", rawUsage: `{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":800,"cache_write_tokens":150}}`, wantInputTokens: 50, wantOutputTokens: 200, wantCachedTokens: 800, wantCacheWriteTokens: 150 },
    { name: "clamps input_tokens to zero when cache exceeds prompt", rawUsage: `{"prompt_tokens":500,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":300,"cache_write_tokens":300}}`, wantInputTokens: 0, wantOutputTokens: 100, wantCachedTokens: 300, wantCacheWriteTokens: 300 },
    { name: "handles negative cache numbers safely without corrupting input", rawUsage: `{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":-10,"cache_write_tokens":-5}}`, wantInputTokens: 100, wantOutputTokens: 50, wantCachedTokens: -10, wantCacheWriteTokens: 0 },
    { name: "clamps raw negative prompt_tokens to zero", rawUsage: `{"prompt_tokens":-10,"completion_tokens":50}`, wantInputTokens: 0, wantOutputTokens: 50, wantCachedTokens: 0, wantCacheWriteTokens: 0 },
    { name: "negative cache_write_tokens falls back to cache_creation_tokens alias", rawUsage: `{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cache_write_tokens":-1,"cache_creation_tokens":40}}`, wantInputTokens: 60, wantOutputTokens: 50, wantCachedTokens: 0, wantCacheWriteTokens: 40 },
    { name: "prevents int64 overflow when cached_tokens and cache_write_tokens are huge", rawUsage: `{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":9223372036854775800,"cache_write_tokens":100}}`, wantInputTokens: 0, wantOutputTokens: 50, wantCachedTokens: 9223372036854775800, wantCacheWriteTokens: 100 },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const usage = tt.rawUsage === "" ? undefined : JSON.parse(tt.rawUsage);
      const got = extractOpenAIUsage(usage);
      expect(got.inputTokens).toBe(tt.wantInputTokens);
      expect(got.outputTokens).toBe(tt.wantOutputTokens);
      expect(got.cachedTokens).toBe(tt.wantCachedTokens);
      expect(got.cacheWriteTokens).toBe(tt.wantCacheWriteTokens);
    });
  }
});

const streamFlagTestChunk = `data: {"id":"chatcmpl_1","model":"test-model","created":1,"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}`;

test("ConvertOpenAIResponseToClaude_StreamFlagResolvedOncePerStream", () => {
  const state: TranslatorState = {};
  const first = stream(`{"model":"m","stream":true}`, streamFlagTestChunk, state, "test-model").join("");
  expect(first).toContain("content_block_delta");
  // An empty original request on subsequent chunks would parse as non-streaming if re-read.
  const second = stream("", streamFlagTestChunk, state, "test-model").join("");
  expect(second).toContain("content_block_delta");
});

test("ConvertOpenAIResponseToClaude_ToolNameMapResolvedOnceWhenNoTools", () => {
  const state: TranslatorState = {};
  const first = stream(`{"model":"m","stream":true}`, streamFlagTestChunk, state, "test-model").join("");
  expect(first).toContain("content_block_delta");
  // Even when the first chunk resolved the tool name map to nothing (no tools in request),
  // later chunks must not re-parse originalRequestRawJSON to rebuild it.
  const toolChunk = `data: {"id":"chatcmpl_1","model":"test-model","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":null}]}`;
  const second = stream(`{"model":"m","stream":true,"tools":[{"name":"Bash"}]}`, toolChunk, state, "test-model").join("");
  expect(second).toContain(`"name":"bash"`);
});

test("ConvertOpenAIResponseToClaude_NonStreamingRequestStaysNonStreaming", () => {
  for (const original of [`{"model":"m"}`, `{"model":"m","stream":false}`]) {
    const state: TranslatorState = {};
    const out = stream(original, streamFlagTestChunk, state, "test-model");
    expect(out.length).toBe(1);
    expect(getString(out[0]!, "type")).toBe("message");
    expect(out.join("")).not.toContain("content_block_delta");
    // Subsequent call with stream:true must still use the cached non-streaming decision.
    const second = stream(`{"model":"m","stream":true}`, streamFlagTestChunk, state, "test-model");
    expect(second.length).toBe(1);
    expect(getString(second[0]!, "type")).toBe("message");
    expect(second.join("")).not.toContain("content_block_delta");
  }
});

describe("NonStreamingTool_StopReasonWithFinishReason", () => {
  const tests = [
    { name: "tool_calls with finish_reason stop maps to tool_use", payload: `{"id":"c1","model":"gemini-3.5-flash","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}`, wantStopType: "tool_use" },
    { name: "tool_calls with finish_reason null maps to tool_use", payload: `{"id":"c1","model":"gemini-3.5-flash","choices":[{"index":0,"finish_reason":null,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}`, wantStopType: "tool_use" },
    { name: "tool_calls with omitted finish_reason maps to tool_use", payload: `{"id":"c1","model":"gemini-3.5-flash","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}`, wantStopType: "tool_use" },
    { name: "tool_calls with finish_reason length stays max_tokens", payload: `{"id":"c1","model":"gemini-3.5-flash","choices":[{"index":0,"finish_reason":"length","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}`, wantStopType: "max_tokens" },
    { name: "tool_calls with finish_reason content_filter stays end_turn", payload: `{"id":"c1","model":"gemini-3.5-flash","choices":[{"index":0,"finish_reason":"content_filter","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}`, wantStopType: "end_turn" },
    { name: "empty tool_calls array with finish_reason stop stays end_turn", payload: `{"id":"c1","model":"gemini-3.5-flash","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"Done","tool_calls":[]}}]}`, wantStopType: "end_turn" },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const out = convertOpenAIResponseToClaudeNonStream(emptyContext, "", "", "", tt.payload, {});
      expect(getString(out, "stop_reason")).toBe(tt.wantStopType);
      const emitted = stream(`{"stream":false}`, "data: " + tt.payload, {});
      expect(emitted.length).toBe(1);
      expect(getString(emitted[0]!, "stop_reason")).toBe(tt.wantStopType);
    });
  }
});

test("StreamingTool_OmittedToolCallIndexSeparateChunksPreservesParallelCalls", () => {
  const events = runStream(
    streamReq,
    `{"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"id":"call_paris","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"id":"call_tokyo","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}]}`,
  );
  assertSequentialContentBlocks(events);
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(2);
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_paris");
  expect(getString(starts[0]!.payload, "content_block.name")).toBe("get_weather");
  expect(getString(starts[1]!.payload, "content_block.id")).toBe("call_tokyo");
  expect(getString(starts[1]!.payload, "content_block.name")).toBe("get_weather");
  const deltas = inputJSONDeltas(events);
  expect(deltas.length).toBe(2);
  expect(getString(getString(deltas[0]!.payload, "delta.partial_json"), "city")).toBe("Paris");
  expect(getString(getString(deltas[1]!.payload, "delta.partial_json"), "city")).toBe("Tokyo");
  expect(countByType(events, "content_block_stop")).toBe(2);
  expect(lastStopReason(events)).toBe("tool_use");
});

test("StreamingTool_OmittedToolCallIndexSeparateChunksWithFragmentedArgs", () => {
  const events = runStream(
    streamReq,
    `{"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"id":"call_paris","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"\\"Paris\\"}"}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_tokyo","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"\\"Tokyo\\"}"}}]}}]}`,
    `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  );
  assertSequentialContentBlocks(events);
  const starts = toolUseStarts(events);
  expect(starts.length).toBe(2);
  expect(getString(starts[0]!.payload, "content_block.id")).toBe("call_paris");
  expect(getString(starts[1]!.payload, "content_block.id")).toBe("call_tokyo");
  const deltas = inputJSONDeltas(events);
  expect(deltas.length).toBe(2);
  expect(getString(getString(deltas[0]!.payload, "delta.partial_json"), "city")).toBe("Paris");
  expect(getString(getString(deltas[1]!.payload, "delta.partial_json"), "city")).toBe("Tokyo");
  expect(lastStopReason(events)).toBe("tool_use");
});
