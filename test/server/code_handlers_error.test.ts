// Ported from: sdk/api/handlers/claude/code_handlers_error_test.go
// Skipped cases: TestPendingClaudeStreamErrorUsesBufferedError (Go channel plumbing; the iterator model has no
// pending-error channel), TestClaudeMessagesHandlerSendKeepAliveBeforeFTWritesSSEErrorOnFailure (pre-first-token
// keep-alive ticks not ported).
import { expect, test } from "bun:test";
import { ModelCooldownError } from "../../src/auth/manager/index.ts";
import { StatusError, type ErrorMessage } from "../../src/executor/types.ts";
import { ClaudeCodeAPIHandler } from "../../src/server/claude_handlers.ts";
import { claudeErrorResponse, claudeErrorTypeFromStatus, toClaudeError } from "../../src/server/errors.ts";
import { countOccurrences, forwardFromChunks, lastErrorFrame, messagesBody, messagesRequest, newTestManager, registerFakeAuth, streamExecutor } from "./helpers.ts";

test("ClaudeErrorTypeFromStatus", () => {
  const cases: [number, string][] = [
    [400, "invalid_request_error"],
    [409, "conflict_error"],
    [408, "timeout_error"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [504, "timeout_error"],
  ];
  for (const [status, want] of cases) expect(claudeErrorTypeFromStatus(status)).toBe(want);
});

test("ClaudeIncompleteStreamError", async () => {
  const message = "stream error: stream disconnected before completion: stream closed before response.completed";
  const msg: ErrorMessage = { statusCode: 408, error: new Error(message) };
  for (const streaming of [false, true]) {
    let status: number;
    let body: string;
    if (streaming) {
      // The committed stream learns the status from the thrown error (Go: ErrorMessage.StatusCode).
      const thrown = new StatusError(408, message);
      const outcome = await forwardFromChunks(["event: message_start\ndata: {}\n\n"], thrown);
      expect(outcome.terminal?.error).toBe(thrown);
      expect(outcome.terminal?.statusCode).toBe(408);
      status = 200;
      body = outcome.body;
      const prefix = "event: error\ndata: ";
      expect(countOccurrences(body, prefix)).toBe(1);
      body = body.slice(body.indexOf(prefix) + prefix.length).trim();
    } else {
      const response = claudeErrorResponse(msg);
      status = response.status;
      body = await response.text();
    }
    expect(status).toBe(streaming ? 200 : 408);
    const parsed = JSON.parse(body) as { type: string; error: { type: string; message: string } };
    expect(parsed.type).toBe("error");
    expect(parsed.error.type).toBe("timeout_error");
    expect(parsed.error.message).toBe(message);
  }
});

test("ClaudeErrorExtractsOpenAIStyleUpstreamJSON", () => {
  const got = toClaudeError({
    statusCode: 400,
    error: new Error(`{"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","type":"invalid_request_error","code":"context_too_large"}}`),
  });
  expect(got.type).toBe("error");
  expect(got.error.type).toBe("invalid_request_error");
  expect(got.error.message).toBe("Your input exceeds the context window of this model. Please adjust your input and try again.");
});

test("ClaudeErrorExtractsClaudeStyleUpstreamJSON", () => {
  const got = toClaudeError({
    statusCode: 429,
    error: new Error(`{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."},"request_id":"req_123"}`),
  });
  expect(got.error.type).toBe("rate_limit_error");
  expect(got.error.message).toBe("This request would exceed your account's rate limit. Please try again later.");
});

const threadNotFoundJSON = `{"type":"error","error":{"type":"not_found_error","message":"No thread state was found for the requested previous_message_id. Replay the full conversation with thread create to start a new Thread."}}`;

test("ClaudeErrorMarksWrappedMissingThreadForClientReplay", () => {
  const err = new StatusError(404, "wrapped upstream error", { body: `{"type":"error","error":{"type":"not_found_error","message":"No thread state was found for the requested previous_message_id."}}` });
  const got = toClaudeError({ statusCode: 404, error: err });
  expect(got.error.details?.error_code).toBe("thread_not_found");
});

test("ClaudeErrorMarksMissingThreadForClientReplay", () => {
  const got = toClaudeError({ statusCode: 404, error: new Error(threadNotFoundJSON) });
  expect(got.error.details?.error_code).toBe("thread_not_found");
});

test("ClaudeErrorMarksPlainTextMissingThreadForClientReplay", () => {
  const got = toClaudeError({
    statusCode: 404,
    error: new Error("No thread state was found for the requested previous_message_id. Replay the full conversation with thread create to start a new Thread."),
  });
  expect(got.error.details?.error_code).toBe("thread_not_found");
});

test("ClaudeErrorMarksStructuredExecutorMissingThreadForClientReplay", () => {
  const err = new StatusError(404, "No thread state was found for the requested previous_message_id. Replay the full conversation with thread create to start a new Thread.", {
    body: threadNotFoundJSON,
  });
  const got = toClaudeError({ statusCode: 404, error: err });
  expect(got.error.details?.error_code).toBe("thread_not_found");
});

test("WriteClaudeDirectErrorMarksMissingThreadForClientReplay", async () => {
  const response = claudeErrorResponse({ statusCode: 404, error: new Error("direct"), directBody: threadNotFoundJSON });
  const body = (await response.json()) as { error: { details?: { error_code: string } } };
  expect(response.status).toBe(404);
  expect(body.error.details?.error_code).toBe("thread_not_found");
});

test("WriteClaudeErrorResponseUsesClaudeEnvelope", async () => {
  const response = claudeErrorResponse({
    statusCode: 400,
    error: new Error(`{"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","type":"invalid_request_error","code":"context_too_large"}}`),
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  const body = (await response.json()) as { type: string; error: { type: string; message: string } };
  expect(body.type).toBe("error");
  expect(body.error.type).toBe("invalid_request_error");
  expect(body.error.message).toBe("Your input exceeds the context window of this model. Please adjust your input and try again.");
});

test("WriteClaudeErrorResponse_IncludesRetryAfterForModelCooldownDefaultSettings", async () => {
  const response = claudeErrorResponse({ statusCode: 429, error: new ModelCooldownError("claude-sonnet-4-6", "claude", 20_000) });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("20");
  const body = (await response.json()) as { error: { type: string } };
  expect(body.error.type).toBe("rate_limit_error");
});

async function runHandlerStream(model: string, chunks: string[], terminal?: unknown): Promise<{ status: number; body: string; contentType: string | null }> {
  const { manager, registry } = newTestManager();
  const executor = streamExecutor("fake-claude-executor", chunks, terminal);
  manager.registerExecutor(executor);
  registerFakeAuth(manager, registry, `${model}-auth`, executor.identifier, model);
  const handler = new ClaudeCodeAPIHandler({ manager, registry });
  const response = await handler.claudeMessages(messagesRequest(model, true), messagesBody(model, true));
  return { status: response.status, body: await response.text(), contentType: response.headers.get("Content-Type") };
}

const messageStart = `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n`;

test("ClaudeMessagesHandlerDeduplicatesTranslatedSSEErrorAndTerminalChunkError", async () => {
  const sseErrorChunk =
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n` +
    `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Gemini response finished with MALFORMED_FUNCTION_CALL"}}\n\n`;
  const { body } = await runHandlerStream("dedup-sse-error-claude-model", [sseErrorChunk], new Error(`{"type":"error","error":{"type":"api_error","message":"Gemini response finished with MALFORMED_FUNCTION_CALL"}}`));
  expect(countOccurrences(body, "event: error\n")).toBe(1);
});

test("ClaudeMessagesHandlerTruncatedStreamWithoutMessageStopWritesSSEError", async () => {
  const { status, body, contentType } = await runHandlerStream("truncated-stream-claude-model", [
    messageStart,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n`,
  ]);
  expect(status).toBe(200);
  expect(contentType).toBe("text/event-stream");
  expect(body).toContain("event: error\ndata: ");
  expect(body).toContain("message_stop");
  const frame = lastErrorFrame(body);
  expect((frame?.error as { type: string }).type).toBe("api_error");
});

test("ClaudeStreamTerminalErrorDoesNotOverwriteSSEStatusWhenUnwritten", async () => {
  // The SSE response is already committed (status 200); the first chunk carried no bytes.
  const outcome = await forwardFromChunks([""], new StatusError(502, "upstream failed after SSE commit"));
  expect(outcome.body.startsWith("event: error\ndata: ")).toBe(true);
  expect(outcome.terminal?.statusCode).toBe(502);
});

test("ClaudeStreamTerminalErrorAfterPartialLineStartsOnNewLine", async () => {
  const outcome = await forwardFromChunks([`event: content_block_delta\ndata: {"type":"content_block_delta"`], new StatusError(502, "stream cut mid-line"));
  expect(outcome.body).toContain("\nevent: error\ndata: ");
});

test("ClaudeStreamCompleteWithMessageStopDoesNotEmitErrorOnClose", async () => {
  const { status, body } = await runHandlerStream("complete-stream-claude-model", [messageStart, `event: message_stop\ndata: {"type":"message_stop"}\n\n`]);
  expect(status).toBe(200);
  expect(body).not.toContain("event: error");
});

test("ClaudeStreamTerminalErrorAfterSingleNewlineInsertsBlankLine", async () => {
  const outcome = await forwardFromChunks(
    [`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n`],
    new StatusError(502, "stream cut before blank line"),
  );
  expect(outcome.body).toContain("\n\nevent: error\ndata: ");
});

test("ClaudeStreamBareCompletedMessageJSONDoesNotEmitErrorOnClose", async () => {
  const { status, body } = await runHandlerStream("bare-json-stream-claude-model", [
    `{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}\n`,
  ]);
  expect(status).toBe(200);
  expect(body).not.toContain("event: error");
});

test("ClaudeStreamMessageStopWithArbitraryJSONFormattingCompletesCleanly", async () => {
  const { status, body } = await runHandlerStream("formatted-message-stop-claude-model", [
    `event:message_start\ndata: {"type" : "message_start", "message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
    `event:message_stop\ndata: {"type" : "message_stop"}\n\n`,
  ]);
  expect(status).toBe(200);
  expect(body).not.toContain("event: error");
});

test("ClaudeStreamTextDeltaMentioningMessageStopStillFailsWhenTruncated", async () => {
  const { body } = await runHandlerStream("false-positive-message-stop-claude-model", [
    messageStart,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"emit","input":{"type":"message_stop"}}}\n\n`,
  ]);
  expect(body).toContain("event: error\ndata: ");
});

test("ClaudeStreamTruncatedErrorEventHeaderDoesNotSuppressTerminalError", async () => {
  const outcome = await forwardFromChunks([`${messageStart}event: error\n`], new StatusError(502, "upstream stream closed before message_stop"));
  expect(outcome.body).toContain(`event: error\ndata: {"type":"error"`);
});

test("ClaudeStreamErrorEventWithoutTrailingBlankLineIsTerminatedOnEOF", async () => {
  for (const suffix of ["", "\n"]) {
    const outcome = await forwardFromChunks([`event: error\ndata: {"type":"error","error":{"type":"api_error","message":"failed"}}${suffix}`], new StatusError(502, `{"type":"error","error":{"type":"api_error","message":"failed"}}`));
    expect(outcome.body).toBe(`event: error\ndata: {"type":"error","error":{"type":"api_error","message":"failed"}}\n\n`);
  }
});

test("ClaudeStreamMessageStopWithoutTrailingBlankLineIsTerminatedOnEOF", async () => {
  for (const suffix of ["", "\n"]) {
    const outcome = await forwardFromChunks([`event: message_stop\ndata: {"type":"message_stop"}${suffix}`]);
    expect(outcome.body).toBe(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    expect(outcome.terminal).toBeUndefined();
  }
});

test("ClaudeMessagesHandlerEmptyStreamClosesWithSSEError", async () => {
  const outcome = await forwardFromChunks([]);
  expect(outcome.body).toContain("event: error\ndata: ");
  expect(outcome.body).toContain("message_stop");
  expect(outcome.terminal?.statusCode).toBe(502);
});

test("ClaudeStreamMultiLineDataEventsAreRecognizedAcrossChunks", async () => {
  // multiline message_stop split across chunks
  const stop = await forwardFromChunks([`event: message_stop\ndata: {"type":\n`, `data: "message_stop"}\n\n`]);
  expect(stop.body).not.toContain("event: error");

  // multiline error event split across chunks
  const errored = await forwardFromChunks([`event: error\ndata: {"type":"error",\n`, `data: "error":{"type":"api_error","message":"boom"}}\n\n`], new StatusError(502, "boom"));
  expect(countOccurrences(errored.body, "event: error")).toBe(1);

  // multiline tool_use with standalone nested message_stop line still fails when truncated
  const nested = await forwardFromChunks([
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"emit","input":\ndata: {"type":"message_stop"}\ndata: }}\n\n`,
  ]);
  expect(nested.body).toContain("event: error\ndata: ");
});
