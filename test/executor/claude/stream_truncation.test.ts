// Ported from: internal/runtime/executor/claude_executor_stream_truncation_test.go
// Skipped cases: TestClaudeExecutorTranslatedStreamTruncationReportsError (no Claude->OpenAI response translator),
// TestOpenAICompatExecutorClaude*, TestGeminiExecutorClaudeStreamTruncationReportsError,
// TestGeminiVertexExecutorClaudeStreamTruncationReportsError, TestKimiExecutorStreamReadErrorDoesNotSynthesizeDoneBeforeScanError,
// TestGeminiAndVertexClaudeStreamWithFinishSignalCompletes, TestTranslatedClaudeStreamTruncationPreservesBufferedUsageOnFailure
// (other executors, not this slice); the usage-plugin "failed record" assertions are replaced by the StatusError the
// iterator throws (usage plugins are not ported).
import { describe, expect, test } from "bun:test";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudeMessageIDFromSSE } from "../../../src/executor/claude/response.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { apiKeyAuth, claudeOpts, collect, withUpstream } from "./helpers.ts";

const req = { model: "claude-opus-5", payload: `{"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}],"stream":true}`, format: "claude" as const };
const sse = (body: string) => () => new Response(body, { headers: { "Content-Type": "text/event-stream" } });

async function runStream(body: string) {
  return withUpstream(sse(body), async (upstream) => collect(await createClaudeExecutor().executeStream(apiKeyAuth(upstream.url), req, claudeOpts({ stream: true, responseFormat: "claude" }))));
}

describe("claude stream termination", () => {
  test("StreamTruncationReportsError", async () => {
    const got = await runStream(
      "event: message_start\n" +
        `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n` +
        "event: content_block_delta\n" +
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n`,
    );
    expect(got.chunks.join("")).not.toContain("message_stop");
    expect(got.error).toBeInstanceOf(StatusError);
    const err = got.error as StatusError;
    expect(err.message).toContain("message_stop");
    expect(err.statusCode).toBe(502);
    expect(err.streamTruncated).toBe(true);
  });

  test("StreamCompleteNoError", async () => {
    const got = await runStream(
      "event: message_start\n" +
        `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n` +
        "event: message_delta\n" +
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n` +
        "event: message_stop\n" +
        `data: {"type":"message_stop"}\n\n`,
    );
    expect(got.error).toBeUndefined();
    expect(got.chunks).toHaveLength(3);
  });

  test("StreamErrorEventDoesNotCommitContinuityAndMarksFailed", async () => {
    const sseWithError =
      "event: message_start\n" +
      `data: {"type":"message_start","message":{"id":"msg_err_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n` +
      "event: error\n" +
      `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;
    expect(claudeMessageIDFromSSE(sseWithError)).toBe("");
    const got = await runStream(sseWithError);
    expect(got.chunks.join("")).toContain("overloaded_error");
    expect(got.error).toBeInstanceOf(StatusError);
    const err = got.error as StatusError;
    expect(err.statusCode).toBe(529);
    expect(err.streamTruncated).toBe(false);
  });

  for (const [type, status] of [
    ["rate_limit_error", 429],
    ["api_error", 500],
    ["invalid_request_error", 400],
  ] as const) {
    test(`error event ${type} maps to ${status}`, async () => {
      const got = await runStream(`event: error\ndata: {"type":"error","error":{"type":"${type}","message":"x"}}\n\n`);
      expect(got.chunks).toHaveLength(1);
      expect((got.error as StatusError).statusCode).toBe(status);
    });
  }

  test("MultiLineDataMessageStopAndErrorEvents", async () => {
    const multiLineSuccess =
      "event: message_start\n" +
      `data: {"type":"message_start",\n` +
      `data: "message":{"id":"msg_multi_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n` +
      "event: message_stop\n" +
      `data: {"type":\n` +
      `data: "message_stop"}\n\n`;
    expect(claudeMessageIDFromSSE(multiLineSuccess)).toBe("msg_multi_1");
    expect((await runStream(multiLineSuccess)).error).toBeUndefined();

    const nestedMultiLineTruncated =
      "event: message_start\n" +
      `data: {"type":"message_start","message":{"id":"msg_nested_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n` +
      "event: content_block_start\n" +
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"emit","input":\n` +
      `data: {"type":"message_stop"}\n` +
      "data: }}\n\n";
    expect(claudeMessageIDFromSSE(nestedMultiLineTruncated)).toBe("");
    const truncated = await runStream(nestedMultiLineTruncated);
    expect(truncated.error).toBeInstanceOf(StatusError);
    expect((truncated.error as StatusError).streamTruncated).toBe(true);
  });
});
