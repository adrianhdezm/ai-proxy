// Ported from: test/codex_incomplete_stream_error_type_test.go, test/codex_stream_disconnect_failover_test.go
// Skipped cases: TestCodexStreamDisconnectAfterOutputDoesNotFailOver / TestCodexStreamDisconnectBeforeOutputFailsOver and
// the other manager-level cases of codex_stream_disconnect_failover_test.go (executor + manager behaviour; the Codex
// executor lives in another slice), the response.failed / "request_timeout" code assertions (OpenAI Responses surface;
// this port serves the Claude Messages surface where the terminal frame is `event: error`).
import { expect, test } from "bun:test";
import { StatusError } from "../../src/executor/types.ts";
import { ClaudeCodeAPIHandler } from "../../src/server/claude_handlers.ts";
import { fakeExecutor, lastErrorFrame, messagesBody, messagesRequest, newTestManager, registerFakeAuth, streamExecutor } from "./helpers.ts";

const messageStart = `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"gpt-5.4","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n`;

// TestCodexIncompleteStreamIsNotTypedAsInvalidRequest: the upstream stops mid function-call
// arguments without a terminal event. The emitted terminal frame must not claim the request was
// invalid: on the Claude surface that is an api_error, never invalid_request_error.
test("CodexIncompleteStreamIsNotTypedAsInvalidRequest", async () => {
  const model = "gpt-5.4";
  const chunks = [
    messageStart,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"fc_1","name":"edit","input":{}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"app/page.tsx\\""}}\n\n`,
  ];
  for (const terminal of [
    // The executor noticed the truncation and tagged it (whatever status it chose).
    new StatusError(408, "stream disconnected before completion: stream closed before response.completed", { streamTruncated: true }),
    new StatusError(400, "stream disconnected before completion", { streamTruncated: true, body: `{"error":{"type":"invalid_request_error","message":"stream disconnected before completion"}}` }),
    // A raw transport failure.
    new TypeError("fetch failed: socket hang up"),
    // Or the body simply ended (CloseError path).
    undefined,
  ]) {
    const { manager, registry } = newTestManager();
    const executor = streamExecutor("codex", chunks, terminal);
    manager.registerExecutor(executor);
    registerFakeAuth(manager, registry, "codex-incomplete-stream", "codex", model);
    const handler = new ClaudeCodeAPIHandler({ manager, registry });
    const response = await handler.claudeMessages(messagesRequest(model, true), messagesBody(model, true));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body.startsWith(messageStart)).toBe(true);
    const frame = lastErrorFrame(body);
    expect(frame).toBeDefined();
    const detail = frame!.error as { type: string; message: string };
    expect(detail.type).not.toBe("invalid_request_error");
    expect(detail.type).toBe("api_error");
  }
});

// TestCodexStreamDisconnectExhaustionNotInvalidRequestError: the upstream closes without any SSE
// bytes. Every credential is exhausted before anything was committed, so the client gets a JSON
// error whose type is server-side, not invalid_request_error.
test("CodexStreamDisconnectExhaustionNotInvalidRequestError", async () => {
  const model = "gpt-6-astra";
  for (const executor of [
    // Upstream body ends without data.
    streamExecutor("codex", []),
    // Upstream connection drops before any data.
    streamExecutor("codex", [], new TypeError("fetch failed: connection reset")),
    // Executor could not even open the stream.
    fakeExecutor({
      identifier: "codex",
      stream: () => {
        throw new StatusError(502, "upstream disconnected", { streamTruncated: true });
      },
    }),
  ]) {
    const { manager, registry } = newTestManager();
    manager.registerExecutor(executor);
    registerFakeAuth(manager, registry, "codex-exhaustion-test", "codex", model);
    const handler = new ClaudeCodeAPIHandler({ manager, registry });
    const response = await handler.claudeMessages(messagesRequest(model, true), messagesBody(model, true));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).not.toBe("invalid_request_error");
    expect(body.error.type).toBe("api_error");
  }
});
