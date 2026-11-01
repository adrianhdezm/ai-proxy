// Ported from: internal/runtime/executor/helps/usage_helpers_test.go
// Skipped cases: every non-Claude case (OpenAI, Codex, Gemini, Interactions, Antigravity parsers are not ported:
//   the server only sees Claude-shaped responses), UsageReporter cases (latency/TTFT/session hierarchy/
//   response-model substitution live in executors upstream; the port records at the HTTP layer)
import { expect, test } from "bun:test";
import { tokenBreakdownValid } from "../../src/usage/accounting.ts";
import { ClaudeStreamUsageObserver, parseClaudeStreamUsage, parseClaudeUsage } from "../../src/usage/claude.ts";
import { UsageStatistics } from "../../src/usage/statistics.ts";

test("ParseClaudeUsageIncludesCacheTokensInTotal", () => {
  const d = parseClaudeUsage(`{"usage":{"input_tokens":3085,"output_tokens":253,"cache_read_input_tokens":7,"cache_creation_input_tokens":19514}}`);
  expect(d.inputTokens).toBe(3085);
  expect(d.outputTokens).toBe(253);
  expect(d.cacheReadTokens).toBe(7);
  expect(d.cacheCreationTokens).toBe(19514);
  expect(d.cachedTokens).toBe(7);
  expect(d.totalTokens).toBe(22859);
  expect(d.tokenBreakdown.input.totalTokens).toBe(22606);
  expect(d.tokenBreakdown.input.uncachedTokens).toBe(3085);
});

test("ParseClaudeUsageFallsBackCachedTokensToCacheCreation", () => {
  const d = parseClaudeUsage(`{"usage":{"input_tokens":3085,"output_tokens":253,"cache_creation_input_tokens":19514}}`);
  expect(d.cachedTokens).toBe(19514);
  expect(d.totalTokens).toBe(22852);
});

test("ParseClaudeUsagePreservesThinkingTokensAsReasoningSubset", () => {
  const d = parseClaudeUsage(`{"usage":{"input_tokens":2,"cache_creation_input_tokens":831,"cache_read_input_tokens":44225,"output_tokens":244,"output_tokens_details":{"thinking_tokens":40}}}`);
  expect(d.outputTokens).toBe(244);
  expect(d.reasoningTokens).toBe(40);
  expect(d.totalTokens).toBe(45302);
  expect(tokenBreakdownValid(d.tokenBreakdown)).toBe(true);
  expect(d.tokenBreakdown.output.totalTokens).toBe(244);
  expect(d.tokenBreakdown.output.nonReasoningTokens).toBe(204);
  expect(d.tokenBreakdown.output.reasoningTokens).toBe(40);
});

test("ParseClaudeStreamUsagePreservesThinkingTokensAsReasoningSubset", () => {
  const d = parseClaudeStreamUsage(
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":2,"cache_creation_input_tokens":831,"cache_read_input_tokens":44225,"output_tokens":244,"output_tokens_details":{"thinking_tokens":40}}}`,
  );
  expect(d).toBeDefined();
  expect(d!.outputTokens).toBe(244);
  expect(d!.reasoningTokens).toBe(40);
  expect(d!.totalTokens).toBe(45302);
  expect(tokenBreakdownValid(d!.tokenBreakdown)).toBe(true);
  expect(d!.tokenBreakdown.output.nonReasoningTokens).toBe(204);
});

test("ParseClaudeStreamUsage_MessageStart", () => {
  const d = parseClaudeStreamUsage(
    `data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2095,"cache_creation_input_tokens":7185,"cache_read_input_tokens":355598,"output_tokens":1}}}`,
  );
  expect(d).toBeDefined();
  expect(d!.inputTokens).toBe(2095);
  expect(d!.cacheReadTokens).toBe(355598);
  expect(d!.cacheCreationTokens).toBe(7185);
  expect(d!.cachedTokens).toBe(355598);
});

test("ParseClaudeStreamUsage ignores event lines, [DONE] and frames without usage", () => {
  expect(parseClaudeStreamUsage("event: message_start")).toBeUndefined();
  expect(parseClaudeStreamUsage("data: [DONE]")).toBeUndefined();
  expect(parseClaudeStreamUsage(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`)).toBeUndefined();
});

test("ParseClaudeUsageReportsSpeedAsResponseServiceTier", () => {
  const cases = [
    { body: `{"usage":{"input_tokens":10,"output_tokens":5,"speed":"fast"}}`, want: "fast" },
    { body: `{"usage":{"input_tokens":10,"output_tokens":5,"speed":"standard"}}`, want: "standard" },
    { body: `{"usage":{"input_tokens":10,"output_tokens":5}}`, want: "" },
  ];
  for (const tc of cases) expect(parseClaudeUsage(tc.body).responseServiceTier).toBe(tc.want);
});

test("StreamUsageBufferObserveClaudeStream_KeepsSpeedAcrossDelta", () => {
  const cases = [
    { start: `"speed":"fast"`, delta: ``, want: "fast" },
    { start: ``, delta: `,"speed":"fast"`, want: "fast" },
    { start: ``, delta: ``, want: "" },
  ];
  for (const tc of cases) {
    const observer = new ClaudeStreamUsageObserver();
    let start = `data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":20,"output_tokens":1`;
    if (tc.start !== "") start += "," + tc.start;
    observer.observeLine(start + `}}}`);
    observer.observeLine(`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15${tc.delta}}}`);
    const d = observer.usage();
    expect(d).toBeDefined();
    expect(d!.responseServiceTier).toBe(tc.want);
    expect(d!.outputTokens).toBe(15);
    expect(d!.inputTokens).toBe(20);
  }
});

test("ParseClaudeUsageFallsBackToTopLevelThinkingTokens", () => {
  const d = parseClaudeUsage(`{"usage":{"input_tokens":3,"output_tokens":10,"thinking_tokens":4}}`);
  expect(d.outputTokens).toBe(10);
  expect(d.reasoningTokens).toBe(4);
  expect(d.totalTokens).toBe(13);
  expect(d.tokenBreakdown.output.nonReasoningTokens).toBe(6);
});

test("StreamUsageBufferObserveClaudeStream_MergesStartAndDelta", () => {
  const observer = new ClaudeStreamUsageObserver();
  observer.observeLine(`data: {"type":"message_start","message":{"id":"msg_123","model":"claude-opus-5","usage":{"input_tokens":2095,"cache_creation_input_tokens":7185,"cache_read_input_tokens":355598,"output_tokens":1}}}`);
  observer.observeLine(`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}`);
  const d = observer.usage();
  expect(d).toBeDefined();
  expect(d!.inputTokens).toBe(2095);
  expect(d!.outputTokens).toBe(15);
  expect(d!.cacheReadTokens).toBe(355598);
  expect(d!.cacheCreationTokens).toBe(7185);
  expect(d!.cachedTokens).toBe(355598);
  expect(d!.totalTokens).toBe(2095 + 15 + 355598 + 7185);
  expect(observer.responseModel).toBe("claude-opus-5");
});

test("StreamUsageBufferObserveClaudeStream_FailurePreservesUsage", () => {
  const observer = new ClaudeStreamUsageObserver();
  observer.observeLine(`data: {"type":"message_start","message":{"id":"msg_123","model":"claude-opus-5","usage":{"input_tokens":2095,"cache_creation_input_tokens":7185,"cache_read_input_tokens":355598,"output_tokens":1}}}`);
  const stats = new UsageStatistics({ enabled: true, now: () => 0 });
  const record = stats.record({ provider: "claude", model: "claude-opus-5", failed: true, fail: { statusCode: 499 }, detail: observer.usage() });
  expect(record).toBeDefined();
  expect(record!.failed).toBe(true);
  expect(record!.detail.inputTokens).toBe(2095);
  expect(record!.detail.cacheReadTokens).toBe(355598);
  expect(record!.detail.cacheCreationTokens).toBe(7185);
});

test("ClaudeStreamUsageObserver handles lines split across chunks and error events", () => {
  const observer = new ClaudeStreamUsageObserver();
  const frames = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":7,"output_tokens":1}}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';
  for (let i = 0; i < frames.length; i += 9) observer.observeChunk(frames.slice(i, i + 9));
  observer.flush();
  expect(observer.usage()!.inputTokens).toBe(7);
  expect(observer.sawErrorEvent).toBe(true);
  expect(observer.errorType).toBe("overloaded_error");
  expect(observer.sawMessageStop).toBe(false);
});
