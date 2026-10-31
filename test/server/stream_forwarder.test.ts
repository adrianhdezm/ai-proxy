// Ported from: sdk/api/handlers/stream_forwarder_test.go
// Skipped cases: TestPendingStreamErrorReturnsBufferedError / TestPendingStreamErrorIgnoresUnavailableErrors (Go channel
// plumbing; the iterator model surfaces the terminal error by throwing), TestValidateSSEDataJSONAllowsMultilinePayload /
// TestSplitCRLFRepro / TestSSEJSONValidationStateSplitCRLFVariants (OpenAI SSE JSON validation state not ported).
import { expect, test } from "bun:test";
import { StatusError } from "../../src/executor/types.ts";
import { ClaudeSSEStreamState, advanceClaudeSSENewlineCount } from "../../src/server/sse_state.ts";
import { forwardFromChunks, lastErrorFrame } from "./helpers.ts";

test("ForwardStreamNormalizesErrorBeforeWriteAndCancel", async () => {
  // The terminal error is passed through the Claude envelope before it is written, and the same
  // (already normalised) message is what onDone receives.
  const outcome = await forwardFromChunks(["event: message_start\ndata: {}\n\n"], new StatusError(502, "raw secret", { body: `{"type":"error","error":{"type":"api_error","message":"safe error"}}` }));
  const frame = lastErrorFrame(outcome.body);
  expect((frame?.error as { message: string }).message).toBe("safe error");
  expect(outcome.body).not.toContain("raw secret");
  expect(outcome.terminal?.statusCode).toBe(502);
  expect((outcome.terminal?.error as StatusError).message).toBe("raw secret");
});

test("CloseError surfaces a missing message_stop as a 502 terminal frame (new)", async () => {
  const outcome = await forwardFromChunks(["event: message_start\ndata: {}\n\n", `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n`]);
  expect(outcome.terminal?.statusCode).toBe(502);
  expect(outcome.terminal?.error.message).toBe("upstream stream closed before message_stop");
  const frame = lastErrorFrame(outcome.body);
  expect((frame?.error as { type: string }).type).toBe("api_error");
  expect(outcome.body.endsWith("\n\n")).toBe(true);
});

test("client disconnect stops forwarding and releases the upstream iterator (new)", async () => {
  const controller = new AbortController();
  let released = false;
  let produced = 0;
  async function* chunks(): AsyncGenerator<string> {
    try {
      yield "event: message_start\ndata: {}\n\n";
      for (;;) {
        produced++;
        await new Promise((r) => setTimeout(r, 1));
        yield `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n`;
        if (produced === 3) controller.abort();
      }
    } finally {
      released = true;
    }
  }
  const iterator = chunks();
  const first = await iterator.next();
  const { forwardClaudeStream } = await import("../../src/server/claude_handlers.ts");
  const stream = forwardClaudeStream({ first, iterator, signal: controller.signal, errorBody: () => "{}" });
  const text = await new Response(stream).text();
  expect(released).toBe(true);
  expect(text).not.toContain("event: error");
  expect(produced).toBeLessThan(10);
});

test("claudeSSEStreamState newline accounting and boundaries (new)", () => {
  expect(advanceClaudeSSENewlineCount(2, "data: x")).toBe(0);
  expect(advanceClaudeSSENewlineCount(0, "x\r\n")).toBe(1);
  expect(advanceClaudeSSENewlineCount(0, "x\n\n\n")).toBe(2);
  const state = new ClaudeSSEStreamState();
  state.observeChunk("event: message_stop\ndata: {\"type\":\"message_stop\"}");
  state.flushPendingLine();
  expect(state.sawMessageStop).toBe(true);
  expect(state.ensureSSEEventBoundary()).toBe("\n\n");
  expect(state.ensureSSEEventBoundary()).toBe("");
});
