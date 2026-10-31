// Ported from: sdk/api/handlers/openai/openai_responses_handlers_stream_error_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_compact_test.go
// Skipped cases: TestResponsesHandlerPreservesDirectResponseBeforeFirstFrame (plugin RequestTerminatedError direct
//   responses are not ported); TestResponsesHandlerSendKeepAliveBeforeFT (pre-first-token keep-alives are not ported);
//   TestOpenAIResponsesCompactDecodesZstdRequestBody (zstd request bodies are not ported);
//   TestOpenAIResponsesCompactTransientFailureDoesNotCooldownAuthAndPreservesError and
//   TestOpenAIResponsesCompactRequestFaultStopsFallbackAndPreservesError (the AuthManager's compact-specific
//   cooldown neutrality lives in the manager, outside this slice). Adaptations: the request-log
//   (API_RESPONSE_ERROR) assertions of the forward tests are dropped, the client-facing body is checked;
//   TestResponsesHandlerDoesNotLoseErrorBeforeFirstPayload runs 5 iterations instead of 100 (no goroutine race
//   to provoke); the compact tests use a "codex" executor because this port serves /responses/compact on Codex
//   credentials only.
// Also covers (new): routing with sourceFormat "openai-response", the OpenAI error envelope for auth/model errors,
//   the /v1/models OpenAI shape for OpenAI clients, usage records for Responses requests.
import { describe, expect, test } from "bun:test";
import { StatusError, type ErrorMessage, type StreamResult } from "../../src/executor/types.ts";
import { executionErrorMessage } from "../../src/server/errors.ts";
import { forwardResponsesStream, isOpenAIModelsRequest } from "../../src/server/responses_handlers.ts";
import { ResponsesSSEFramer, isCodexResponsesClientRequest, sanitizeResponsesStreamErrorMessage } from "../../src/server/responses_sse.ts";
import { createServer } from "../../src/server/server.ts";
import { UsageStatistics } from "../../src/usage/statistics.ts";
import type { UsageResponseJSON } from "../../src/usage/statistics.ts";
import { baseNow, chunkIterator, fakeExecutor, newTestManager, registerFakeAuth, type FakeExecutorSpec } from "./helpers.ts";

const codexUA = "Codex Desktop/26.803.41515";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (resp: Response): Promise<any> => resp.json();

function responsesRequest(body: unknown, headers: Record<string, string> = {}, path = "/v1/responses"): Request {
  return new Request(`http://proxy.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A server with one fake provider serving `model`. */
function setup(spec: FakeExecutorSpec & { identifier?: string }, model = "test-model", options: { apiKeys?: string[]; usage?: UsageStatistics } = {}) {
  const { manager, registry } = newTestManager();
  const executor = fakeExecutor(spec);
  manager.registerExecutor(executor);
  registerFakeAuth(manager, registry, `${executor.identifier}-auth`, executor.identifier, model);
  const server = createServer({ manager, registry, apiKeys: options.apiKeys, usage: options.usage, now: () => baseNow });
  return { server, executor, manager };
}

/** A streaming fake: yields `chunks` then throws `terminal` (Go: prematureResponsesStreamExecutor). */
function streamSpec(chunks: string[], terminal?: unknown): FakeExecutorSpec {
  return { identifier: "premature-responses-stream", stream: (): StreamResult => ({ chunks: chunkIterator(chunks, terminal) }) };
}

async function streamThroughHandler(chunks: string[], terminal: unknown, headers: Record<string, string> = {}) {
  const { server } = setup(streamSpec(chunks, terminal), "stream-model");
  const resp = await server.fetch(responsesRequest({ model: "stream-model", input: "hi", stream: true }, headers));
  return { status: resp.status, body: await resp.text(), headers: resp.headers };
}

/** Go: h.forwardResponsesStream(c, flusher, cancel, data, errs, framer). */
async function forward(chunks: string[], options: { userAgent?: string; error?: unknown; framer?: ResponsesSSEFramer; initial?: string } = {}) {
  const codexClient = isCodexResponsesClientRequest(new Headers(options.userAgent ? { "User-Agent": options.userAgent } : {}));
  let terminal: ErrorMessage | undefined;
  const stream = forwardResponsesStream({
    initial: options.initial ?? "",
    framer: options.framer ?? new ResponsesSSEFramer(),
    plan: { kind: "forward" },
    iterator: chunkIterator(chunks, options.error)[Symbol.asyncIterator](),
    codexClient,
    normalize: (err) => sanitizeResponsesStreamErrorMessage(executionErrorMessage(err))!,
    onDone: (t) => {
      terminal = t;
    },
  });
  return { body: await new Response(stream).text(), terminal: terminal as ErrorMessage | undefined };
}

const deltaFrame = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';

describe("openai_responses_handlers_stream_error_test", () => {
  test("TestResponsesHandlerEmitsFailureWhenExecutorStopsAfterPartialOutput", async () => {
    const { status, body } = await streamThroughHandler([deltaFrame], new Error("unexpected EOF"), { "User-Agent": codexUA });
    expect(status).toBe(200);
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("event: response.failed");
    expect(body).toContain("unexpected EOF");
  });

  test("TestSanitizeResponsesStreamErrorMessageNormalizesSuccessStatus", () => {
    const got = sanitizeResponsesStreamErrorMessage({ statusCode: 200, error: new Error("upstream failed") });
    expect(got?.statusCode).toBe(500);
  });

  test("TestResponsesHandlerCommitsValidFrameBeforeMalformedFrameInSameChunk", async () => {
    const { status, body } = await streamThroughHandler(
      [deltaFrame + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta"\n\n'],
      undefined,
      { "User-Agent": codexUA },
    );
    expect(status).toBe(200);
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("event: response.failed");
  });

  test("TestResponsesHandlerAcceptsMultilineDataAcrossExecutorChunks", async () => {
    const { status, body } = await streamThroughHandler(['event: response.completed\ndata: {"type":"response.completed",', 'data: "response":{"id":"resp-1","status":"completed"}}\n\n'], undefined);
    expect(status).toBe(200);
    expect(body).toContain("event: response.completed");
  });

  test("TestResponsesHandlerSanitizesErrorBeforeFirstFrame", async () => {
    const raw = `{"error":{"type":"server_error","code":"upstream_failed","message":"initial upstream failure: {\\"api_key\\":\\"initial-message-secret\\"}"},"debug":{"token":"initial-debug-secret","trace":"${"x".repeat(8192)}"}}`;
    const { status, body } = await streamThroughHandler([], new StatusError(502, raw));
    expect(status).not.toBe(200);
    expect(body).toContain("upstream_failed");
    expect(body).toContain("initial upstream failure");
    expect(body).not.toContain("initial-message-secret");
    expect(body).not.toContain("initial-debug-secret");
    expect(body.length).toBeLessThanOrEqual(4096);
  });

  test("TestResponsesHandlerFlushesDataOnlyFrameBeforeStreamingError", async () => {
    const { status, body } = await streamThroughHandler([`data: {"type":"response.output_text.delta","delta":"partial"}`], new Error("upstream failed after data-only frame"), { "User-Agent": codexUA });
    expect(status).toBe(200);
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("event: response.failed");
  });

  test("TestResponsesHandlerEmitsFailureWhenDataOnlyStreamClosesCleanly", async () => {
    const { status, body } = await streamThroughHandler([`data: {"type":"response.output_text.delta","delta":"partial"}`], undefined, { "User-Agent": codexUA });
    expect(status).toBe(200);
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("event: response.failed");
    expect(body).not.toContain("event: response.completed");
  });

  test("TestResponsesHandlerDoesNotCommitHeadersForIncompleteFirstFrame", async () => {
    const { status, body } = await streamThroughHandler(["event: response.created"], new StatusError(502, "upstream failed before first complete frame"));
    expect(status).not.toBe(200);
    expect(body).toContain("upstream failed before first complete frame");
  });

  test("TestResponsesHandlerRejectsStreamClosedBeforeFirstPayload", async () => {
    const { status, body } = await streamThroughHandler([], undefined);
    expect(status).not.toBe(200);
    expect(body).toContain("closed before first payload");
    // A gateway failure is a server error, never a client error.
    expect(JSON.parse(body).error.type).toBe("server_error");
  });

  test("TestResponsesHandlerDoesNotLoseErrorBeforeFirstPayload", async () => {
    for (let i = 0; i < 5; i++) {
      const { status, body } = await streamThroughHandler([], new StatusError(502, "upstream failed before first payload"));
      expect(status).not.toBe(200);
      expect(body).toContain("upstream failed before first payload");
    }
  });

  const exposed: { name: string; status: number; message: string }[] = [
    { name: "bad request", status: 400, message: `{"error":{"type":"invalid_request","code":"cyber_policy","message":"blocked"}}` },
    { name: "cyber policy behind bad gateway status", status: 502, message: `{"error":{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk.","param":null}}` },
    { name: "context length exceeded behind bad gateway status", status: 502, message: `{"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window."}}` },
    { name: "conflict", status: 409, message: "conflict" },
    { name: "message too big", status: 413, message: "too large" },
    { name: "unprocessable entity", status: 422, message: "invalid input" },
    { name: "authentication", status: 401, message: "invalid credential" },
    { name: "payment required", status: 402, message: "insufficient credits" },
    { name: "quota error", status: 429, message: "usage limit reached" },
    { name: "request timeout", status: 408, message: "upstream timeout" },
    { name: "transport error", status: 500, message: "unexpected EOF" },
    { name: "upstream websocket drop", status: 500, message: `{"error":{"message":"websocket: close 1006 (abnormal closure): unexpected EOF","type":"server_error","code":"internal_server_error"}}` },
  ];
  for (const tc of exposed) {
    test(`TestForwardResponsesStreamExposesTerminalErrors/${tc.name}`, async () => {
      const { body } = await forward([], { error: new StatusError(tc.status, tc.message) });
      expect(body).toContain(`"type":"error"`);
      expect(body).toContain("event: error\ndata: ");
      expect(body).toContain(`"error":{`);
    });
  }

  test("TestForwardResponsesStreamUsesResponseFailedForCodex", async () => {
    const { body } = await forward([], { userAgent: codexUA, error: new StatusError(400, `{"error":{"type":"invalid_request","code":"cyber_policy","message":"blocked"}}`) });
    expect(body).toContain("event: response.failed");
    expect(body).not.toContain("event: error");
    expect(body).toContain(`"type":"invalid_request"`);
    expect(body).toContain(`"code":"cyber_policy"`);
  });

  test("TestForwardResponsesStreamExposesTransportErrorAfterOutputForCodex", async () => {
    const framer = new ResponsesSSEFramer();
    const initial = framer.writeChunk(deltaFrame);
    const { body, terminal } = await forward([], { userAgent: codexUA, error: new StatusError(502, "unexpected EOF"), framer, initial });
    expect(body).toContain("event: response.failed");
    expect(body).toContain("unexpected EOF");
    expect(framer.lastEvent).toBe("response.output_text.delta");
    expect(terminal?.statusCode).toBe(502);
  });

  test("TestForwardResponsesStreamSanitizesDiagnosticErrorDetails", async () => {
    const debugSecret = "super-secret-provider-debug-value";
    const messageSecret = "super-secret-provider-message-value";
    const raw = `{"error":{"type":"server_error","code":"upstream_failed","message":"upstream failed: {\\"api_key\\":\\"${messageSecret}\\"}"},"debug":{"api_key":"${debugSecret}","trace":"${"x".repeat(8192)}"}}`;
    const framer = new ResponsesSSEFramer();
    const initial = framer.writeChunk(deltaFrame);
    const { body, terminal } = await forward([], { error: new StatusError(502, raw), framer, initial });
    expect(body).toContain("upstream failed");
    expect(body).toContain("upstream_failed");
    expect(body).not.toContain(debugSecret);
    expect(body).not.toContain(messageSecret);
    // The terminal diagnostic handed to usage/logging is the sanitised, bounded text.
    const diagnostic = terminal!.error.message;
    expect(diagnostic).not.toContain(debugSecret);
    expect(diagnostic).not.toContain(messageSecret);
    expect(diagnostic.length).toBeLessThanOrEqual(4096);
  });

  test("TestForwardResponsesStreamPreservesNestedResponseError", async () => {
    const framer = new ResponsesSSEFramer();
    const initial = framer.writeChunk(deltaFrame);
    const { body } = await forward([], {
      userAgent: codexUA,
      framer,
      initial,
      error: new StatusError(502, `{"type":"response.failed","response":{"error":{"type":"server_error","code":"upstream_failed","message":"nested response failure","param":"input"}}}`),
    });
    for (const want of ["nested response failure", "upstream_failed", "server_error"]) expect(body).toContain(want);
  });

  test("TestForwardResponsesStreamSanitizesLastEventDiagnostic", async () => {
    const eventSecret = "event-secret-value";
    const eventName = "custom-event-Bearer " + eventSecret + "x".repeat(1024);
    const framer = new ResponsesSSEFramer();
    const initial = framer.writeChunk(`event: ${eventName}\ndata: {"message":"partial"}\n\n`);
    await forward([], { error: new StatusError(502, "unexpected EOF"), framer, initial });
    expect(framer.lastEvent).not.toContain(eventSecret);
    expect(framer.lastEvent.length).toBeLessThanOrEqual(1024);
  });

  for (const tc of [
    { name: "event error with payload type", frame: 'event: error\ndata: {"type":"provider.error","error":{"code":"failed","message":"token=payload-secret"}}\n\n' },
    { name: "typed nested error", frame: 'data: {"type":"provider.error","error":{"code":"failed","message":"token=payload-secret"}}\n\n' },
    { name: "top level error fields", frame: 'data: {"code":"failed","message":"token=payload-secret"}\n\n' },
  ]) {
    test(`TestForwardResponsesStreamSanitizesPayloadErrorsAndStopsAtFailure/${tc.name}`, async () => {
      const { body, terminal } = await forward([tc.frame + 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'], { userAgent: codexUA });
      expect(terminal).toBeDefined();
      expect(body).not.toContain("payload-secret");
      expect(body).not.toContain("event: response.completed");
      expect(body.split("event: response.failed").length - 1).toBe(1);
      expect(body).toContain("[REDACTED]");
    });
  }

  test("TestForwardResponsesStreamReportsDataOnlyErrorFlushedAtEOF", async () => {
    const { body, terminal } = await forward([`data: {"type":"error","error":{"message":"failed at EOF"}}`], { userAgent: codexUA });
    expect(terminal?.error.message).toContain("failed at EOF");
    expect(body.split("event: response.failed").length - 1).toBe(1);
  });

  test("TestForwardResponsesStreamDoesNotAppendFailureAfterTerminalEvent", async () => {
    const framer = new ResponsesSSEFramer();
    const initial = framer.writeChunk('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}\n\n');
    const { body } = await forward([], { userAgent: codexUA, framer, initial, error: new StatusError(502, "unexpected EOF after completion") });
    expect(body).not.toContain("event: response.failed");
    expect(body).not.toContain("event: error");
    expect(framer.lastEvent).toBe("response.completed");
  });

  test("TestForwardResponsesStreamFailsWhenUpstreamClosesWithoutTerminalEvent", async () => {
    const framer = new ResponsesSSEFramer();
    const initial = framer.writeChunk(deltaFrame);
    const { body } = await forward([], { userAgent: codexUA, framer, initial });
    expect(body).toContain("event: response.failed");
    expect(body).toContain("closed before a terminal event");
  });
});

describe("openai_responses_compact_test", () => {
  test("TestOpenAIResponsesCompactRejectsStream", async () => {
    const { server, executor } = setup({ identifier: "codex", execute: () => ({ payload: `{"ok":true}` }) });
    const resp = await server.fetch(responsesRequest({ model: "test-model", stream: true }, {}, "/v1/responses/compact"));
    expect(resp.status).toBe(400);
    expect(executor.executeCalls).toHaveLength(0);
    expect((await json(resp)).error.type).toBe("invalid_request_error");
  });

  test("TestOpenAIResponsesCompactExecute", async () => {
    const { server, executor } = setup({ identifier: "codex", execute: () => ({ payload: `{"ok":true}` }) });
    const resp = await server.fetch(responsesRequest({ model: "test-model", input: "hello" }, {}, "/v1/responses/compact"));
    expect(resp.status).toBe(200);
    expect(executor.lastOptions?.alt).toBe("responses/compact");
    expect(executor.lastOptions?.sourceFormat).toBe("openai-response");
    expect((await resp.text()).trim()).toBe(`{"ok":true}`);
  });

  test("compact drops a false stream flag and is refused for non-Codex models (port: Codex only)", async () => {
    const { server, executor } = setup({ identifier: "codex", execute: () => ({ payload: `{"ok":true}` }) });
    const resp = await server.fetch(responsesRequest({ model: "test-model", input: "hello", stream: false }, {}, "/v1/responses/compact"));
    expect(resp.status).toBe(200);
    expect(JSON.parse(executor.executeCalls[0]!.payload).stream).toBeUndefined();

    const other = setup({ identifier: "claude", execute: () => ({ payload: `{"ok":true}` }) });
    const refused = await other.server.fetch(responsesRequest({ model: "test-model", input: "hello" }, {}, "/v1/responses/compact"));
    expect(refused.status).toBe(501);
    expect(other.executor.executeCalls).toHaveLength(0);
  });
});

describe("responses routes (new)", () => {
  test("non-stream request reaches the executor in the openai-response format and returns its payload", async () => {
    const payload = JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    const { server, executor } = setup({ identifier: "codex", execute: () => ({ payload }) });
    const resp = await server.fetch(responsesRequest({ model: "test-model", input: "hi" }, { originator: "codex_cli_rs", session_id: "s-1", "x-codex-turn-metadata": "{}", authorization: "Bearer nope" }));
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(payload);
    const opts = executor.lastOptions!;
    expect(opts.sourceFormat).toBe("openai-response");
    expect(executor.executeCalls[0]!.format).toBe("openai-response");
    expect(opts.metadata?.request_path).toBe("/v1/responses");
    // Codex client identity headers reach the executor; inbound credentials never do.
    expect(opts.headers?.get("originator")).toBe("codex_cli_rs");
    expect(opts.headers?.get("session_id")).toBe("s-1");
    expect(opts.headers?.get("x-codex-turn-metadata")).toBe("{}");
    expect(opts.headers?.get("authorization")).toBeNull();
  });

  test("unknown model is a 400 model_not_found in the OpenAI envelope", async () => {
    const { server } = setup({ identifier: "codex" });
    const resp = await server.fetch(responsesRequest({ model: "nope", input: "hi" }));
    expect(resp.status).toBe(400);
    const body = await json(resp);
    expect(body.error).toMatchObject({ type: "invalid_request_error", code: "model_not_found", param: "model" });
    expect(body.error.message).toContain("nope");
  });

  test("inbound auth like /v1 with the OpenAI envelope", async () => {
    const { server } = setup({ identifier: "codex" }, "test-model", { apiKeys: ["sk-proxy"] });
    const missing = await server.fetch(responsesRequest({ model: "test-model", input: "hi" }));
    expect(missing.status).toBe(401);
    expect((await json(missing)).error).toMatchObject({ type: "authentication_error", code: "invalid_api_key" });
    const ok = await server.fetch(responsesRequest({ model: "test-model", input: "hi" }, { Authorization: "Bearer sk-proxy" }));
    expect(ok.status).not.toBe(401);
    await ok.text();
  });

  test("an upstream error before any output keeps its status and the OpenAI envelope", async () => {
    const { server } = setup({ identifier: "codex", execute: () => Promise.reject(new StatusError(429, `{"error":{"type":"rate_limit_error","message":"slow down"}}`)) });
    const resp = await server.fetch(responsesRequest({ model: "test-model", input: "hi" }));
    expect(resp.status).toBe(429);
    expect((await json(resp)).error.message).toBe("slow down");
  });

  test("a truncated stream is never typed invalid_request_error", async () => {
    const truncated = new StatusError(400, "upstream stream closed before message_stop", { streamTruncated: true });
    const { body } = await streamThroughHandler([deltaFrame], truncated);
    const frame = body.split("\n\n").find((f) => f.includes("event: error"))!;
    const payload = JSON.parse(frame.slice(frame.indexOf("data: ") + 6));
    expect(payload.error.type).toBe("server_error");
  });

  test("/v1/models answers the OpenAI list for OpenAI clients and the Claude list otherwise", async () => {
    const { server } = setup({ identifier: "codex" });
    const claude = await json(await server.fetch(new Request("http://proxy.test/v1/models", { headers: { "anthropic-version": "2023-06-01" } })));
    expect(claude.object).toBeUndefined();
    expect(claude.has_more).toBe(false);
    const plain = await json(await server.fetch(new Request("http://proxy.test/v1/models")));
    expect(plain.has_more).toBe(false);
    for (const headers of [{ "User-Agent": "OpenAI/Python 1.99.0" }, { "User-Agent": codexUA }, { Originator: "codex_cli_rs" }] as Record<string, string>[]) {
      const openai = await json(await server.fetch(new Request("http://proxy.test/v1/models", { headers })));
      expect(openai.object).toBe("list");
      expect(openai.data[0].id).toBe("test-model");
      expect(Object.keys(openai.data[0]).every((k) => ["id", "object", "created", "owned_by"].includes(k))).toBe(true);
    }
    const viaQuery = await json(await server.fetch(new Request("http://proxy.test/v1/models?client_version=0.99.0")));
    expect(viaQuery.object).toBe("list");
    const detail = await json(await server.fetch(new Request("http://proxy.test/v1/models/test-model", { headers: { "User-Agent": "openai-node/5.0" } })));
    expect(detail.id).toBe("test-model");
  });

  test("isOpenAIModelsRequest keeps Anthropic clients on the Claude shape", () => {
    const url = new URL("http://proxy.test/v1/models");
    expect(isOpenAIModelsRequest(new Request(url.href, { headers: { "User-Agent": "claude-cli/2.1.0" } }), url)).toBe(false);
    expect(isOpenAIModelsRequest(new Request(url.href, { headers: { "User-Agent": "OpenAI/JS 5.0", "Anthropic-Version": "2023-06-01" } }), url)).toBe(false);
    expect(isOpenAIModelsRequest(new Request(url.href, { headers: { "OpenAI-Beta": "responses=v1" } }), url)).toBe(true);
  });

  test("usage records for non-stream and stream Responses requests", async () => {
    const usage = new UsageStatistics({ enabled: true, now: () => baseNow });
    const responseUsage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 130 };
    const payload = JSON.stringify({ id: "resp_1", object: "response", model: "gpt-x-2026", status: "completed", output: [], usage: responseUsage });
    const completed = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", model: "gpt-x-2026", status: "completed", output: [], usage: responseUsage } })}\n\n`;
    const { server } = setup(
      { identifier: "codex", execute: () => ({ payload }), stream: () => ({ chunks: chunkIterator(['event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n', completed]) }) },
      "test-model",
      { usage },
    );
    await (await server.fetch(responsesRequest({ model: "test-model", input: "hi" }))).text();
    await (await server.fetch(responsesRequest({ model: "test-model", input: "hi", stream: true }))).text();
    await (await server.fetch(responsesRequest({ model: "test-model", input: "hi", stream: true }))).text();
    const snapshot = (await json(await server.fetch(new Request("http://proxy.test/v0/usage")))) as UsageResponseJSON;
    const records = snapshot.recent_requests;
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.failed).toBe(false);
      expect(record.tokens.input_tokens).toBe(100);
      expect(record.tokens.output_tokens).toBe(30);
      expect(record.tokens.cached_tokens).toBe(40);
      expect(record.tokens.reasoning_tokens).toBe(10);
    }
  });
});
