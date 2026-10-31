// Ported from: internal/runtime/executor/codex_executor_stream_output_test.go
// Skipped cases: none dropped; adaptations: openai-response inbound requests pass through untranslated in this
//   port, so the non-stream openai-response cases read the completed event (`response.output...`) instead of
//   the Go openai-response translation; the OpenAI chat case (TestCodexExecutorExecute_EmptyStreamCompletionOutputUsesOutputItemDone)
//   uses a Claude request; TestCodexAutoExecutorHTTPFallbackForwardsSequentialCutoffReasoningSummaryDelivery runs on the
//   plain executor (the auto/websocket executor is not ported). Transport failures are simulated with a
//   ReadableStream that errors after its last chunk (Go: unexpectedEOFReader). Added: a context-length terminal
//   error is request-scoped (port decision).
import { afterAll, describe, expect, test } from "bun:test";
import {
  CodexExecutor,
  codexTerminalFailureErr,
  codexTerminalStreamContextLengthErr,
  codexTerminalStreamErr,
} from "../../../src/executor/codex/index.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { apiKeyAuth, codexErrorCode, drain, getString, getValue, options, request, sseResponse, sseStreamResponse, startUpstream, stubFetch } from "./helpers.ts";

const responsesHello = (model: string) => `{"model":"${model}","input":"hello"}`;
const claudeHello = (model: string) => JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });

describe("codex executor stream output", () => {
  let respond: () => Response = () => sseResponse("");
  const upstream = startUpstream(() => respond());
  afterAll(() => upstream.close());
  const executor = new CodexExecutor();
  const auth = () => apiKeyAuth(upstream.url);

  test("TestCodexExecutorExecute_NonEmptyCompletionOutputHydratesMissingItemID", async () => {
    respond = () =>
      sseResponse(
        `data: {"type":"response.output_item.done","item":{"id":"fc_123","type":"function_call","call_id":"call_123","name":"weather","arguments":"{}"},"output_index":0}\n\n` +
          `data: {"type":"response.output_item.done","item":{"id":"fc_done_existing","type":"function_call","call_id":"call_existing","name":"other","arguments":"{}"},"output_index":1}\n\n` +
          `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[{"id":null,"type":"function_call","call_id":"call_123","name":"weather-terminal","arguments":"{}"},{"id":"fc_existing","type":"function_call","call_id":"call_existing","name":"preserved","arguments":"{}"}]}}\n\n`,
      );
    const resp = await executor.execute(auth(), request("gpt-5.4", `{"model":"gpt-5.4","input":"What is the weather?"}`), options("openai-response", false));
    expect(getString(resp.payload, "response.output.0.id")).toBe("fc_123");
    expect(getString(resp.payload, "response.output.0.name")).toBe("weather-terminal");
    expect(getString(resp.payload, "response.output.1.id")).toBe("fc_existing");
  });

  test("TestCodexExecutorExecute_EmptyStreamCompletionOutputUsesOutputItemDone (Claude)", async () => {
    respond = () =>
      sseResponse(
        `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]},"output_index":0}\n` +
          `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":1775555723,"status":"completed","model":"gpt-5.4-mini-2026-03-17","output":[],"usage":{"input_tokens":8,"output_tokens":28,"total_tokens":36}}}\n\n`,
      );
    const resp = await executor.execute(auth(), request("gpt-5.4-mini", claudeHello("gpt-5.4-mini")), options("claude", false));
    expect(getString(resp.payload, "content.0.text")).toBe("ok");
    expect(getValue(resp.payload, "usage.input_tokens")).toBe(8);
  });

  test("TestCodexExecutorExecuteSurfacesTerminalStreamError", async () => {
    respond = () =>
      sseResponse(
        "event: response.created\n" +
          `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n` +
          "event: error\n" +
          `data: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}\n\n` +
          "event: response.failed\n" +
          `data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}}\n\n`,
      );
    const err = await executor.execute(auth(), request("gpt-5.5", responsesHello("gpt-5.5")), options("openai-response", false)).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(400);
    expect(codexErrorCode(err.message)).toEqual({ type: "invalid_request_error", code: "context_too_large" });
    expect(err.message).toContain("Your input exceeds the context window");
    expect(err.requestScoped).toBe(true);
  });

  test("TestCodexExecutorExecuteIncompleteResponseIsSuccessful", async () => {
    respond = () =>
      sseResponse(
        `data: {"type":"response.incomplete","response":{"id":"resp_1","model":"gpt-5.5","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n`,
      );
    const resp = await executor.execute(auth(), request("gpt-5.5", claudeHello("gpt-5.5")), options("claude", false));
    expect(getString(resp.payload, "stop_reason")).toBe("max_tokens");
  });

  test("TestCodexExecutorExecuteExplicitTerminalFailureIsNotRequestScoped", async () => {
    respond = () => sseResponse(`data: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_value","message":"Invalid input."}}\n\n`);
    const err = await executor.execute(auth(), request("gpt-5.5", responsesHello("gpt-5.5")), options("openai-response", false)).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(400);
    expect(err.requestScoped).toBe(false);
  });

  test("TestCodexExecutorExecuteMissingCompletionIsRequestScoped", async () => {
    respond = () => sseResponse(`data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n`);
    const err = await executor.execute(auth(), request("gpt-5.5", responsesHello("gpt-5.5")), options("openai-response", false)).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(408);
    expect(err.requestScoped).toBe(true);
  });

  test("TestCodexExecutorExecuteStreamMissingCompletionIsRequestScoped", async () => {
    respond = () => sseResponse(`data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n`);
    const result = await executor.executeStream(auth(), request("gpt-5.5", responsesHello("gpt-5.5")), options("openai-response", true));
    const { error } = await drain(result);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(408);
    expect((error as StatusError).requestScoped).toBe(true);
    expect((error as StatusError).streamTruncated).toBe(true);
    expect(codexErrorCode((error as StatusError).body!)).toEqual({ type: "server_error", code: "request_timeout" });
  });

  test("TestCodexExecutorExecuteStreamExplicitTerminalFailureIsNotSuccessful", async () => {
    respond = () =>
      sseResponse(
        `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n` +
          `data: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_value","message":"Invalid input."}}\n\n`,
      );
    const result = await executor.executeStream(auth(), request("gpt-5.5", responsesHello("gpt-5.5")), options("openai-response", true));
    const { error } = await drain(result);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(400);
    expect((error as StatusError).requestScoped).toBe(false);
  });

  test("TestCodexAutoExecutorHTTPFallbackForwardsSequentialCutoffReasoningSummaryDelivery (plain executor)", async () => {
    respond = () => {
      const body = upstream.requests[upstream.requests.length - 1]!.body;
      const delivery = getString(body, "stream_options.reasoning_summary_delivery");
      const first =
        delivery === "sequential_cutoff"
          ? `data: {"type":"response.reasoning_summary_text.done","item_id":"rs_1","summary_index":0,"text":"Checking"}\n\n`
          : `data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"Checking"}\n\n`;
      return sseResponse(first + `data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`);
    };
    const payload = `{"model":"gpt-5.6-sol","input":"hello","reasoning":{"summary":"detailed"},"stream_options":{"reasoning_summary_delivery":"sequential_cutoff","include_usage":true}}`;
    const result = await executor.executeStream(auth(), request("gpt-5.6-sol", payload), options("openai-response", true, { responseFormat: "openai-response" }));
    const { chunks, error } = await drain(result);
    expect(error).toBeUndefined();
    const body = upstream.requests[upstream.requests.length - 1]!.body;
    expect(getValue(body, "stream_options.include_usage")).toBeUndefined();
    expect(chunks.join("")).toContain(`"type":"response.reasoning_summary_text.done"`);
  });

  test("TestCodexExecutorExecuteStreamSurfacesTerminalStreamError", async () => {
    respond = () =>
      sseResponse(
        "event: response.created\n" +
          `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n` +
          "event: error\n" +
          `data: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}\n\n`,
      );
    const result = await executor.executeStream(auth(), request("gpt-5.5", responsesHello("gpt-5.5")), options("openai-response", true));
    const { error } = await drain(result);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(400);
    expect(codexErrorCode((error as StatusError).message)).toEqual({ type: "invalid_request_error", code: "context_too_large" });
  });

  test("TestCodexExecutorExecuteStream_EmptyStreamCompletionOutputUsesOutputItemDone", async () => {
    respond = () =>
      sseResponse(
        `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]},"output_index":0}\n` +
          `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":1775555723,"status":"completed","model":"gpt-5.4-mini-2026-03-17","output":[],"usage":{"input_tokens":8,"output_tokens":28,"total_tokens":36}}}\n\n`,
      );
    const result = await executor.executeStream(auth(), request("gpt-5.4-mini", `{"model":"gpt-5.4-mini","input":"Say ok"}`), options("openai-response", true));
    const { chunks, error } = await drain(result);
    expect(error).toBeUndefined();
    let completed = "";
    for (const chunk of chunks) {
      const payload = chunk.trim();
      if (!payload.startsWith("data:")) continue;
      const data = payload.slice(5).trim();
      if (getString(data, "type") === "response.completed") completed = data;
    }
    expect(completed).not.toBe("");
    expect(getString(completed, "response.output.0.content.0.text")).toBe("ok");
  });
});

describe("TestCodexExecutorTransportFailureBeforeTerminalIsRequestScoped", () => {
  const created = `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n`;
  for (const stream of [false, true]) {
    test(stream ? "streaming" : "non-streaming", async () => {
      const { fetch } = stubFetch(() => sseStreamResponse([created], { failWith: new Error("unexpected EOF") }));
      const executor = new CodexExecutor({ fetch });
      const req = request("gpt-5.5", responsesHello("gpt-5.5"));
      const opts = options("openai-response", stream);
      let terminalErr: unknown;
      if (stream) terminalErr = (await drain(await executor.executeStream(apiKeyAuth("http://codex.test"), req, opts))).error;
      else terminalErr = await executor.execute(apiKeyAuth("http://codex.test"), req, opts).catch((e) => e);
      expect(terminalErr).toBeInstanceOf(StatusError);
      expect((terminalErr as StatusError).statusCode).toBe(408);
      expect((terminalErr as StatusError).requestScoped).toBe(true);
    });
  }
});

test("TestCodexExecutorExecuteIgnoresTransportErrorAfterCompletion", async () => {
  const completed = `data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`;
  const { fetch } = stubFetch(() => sseStreamResponse([completed], { failWith: new Error("unexpected EOF") }));
  const executor = new CodexExecutor({ fetch });
  const resp = await executor.execute(apiKeyAuth("http://codex.test"), request("gpt-5.5", claudeHello("gpt-5.5")), options("claude", false));
  expect(getString(resp.payload, "id")).toBe("resp_1");
});

test("TestCodexExecutorExecuteStreamIgnoresTransportErrorAfterCompletion", async () => {
  const completed = `data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`;
  const { fetch } = stubFetch(() => sseStreamResponse([completed], { failWith: new Error("unexpected EOF") }));
  const executor = new CodexExecutor({ fetch });
  const result = await executor.executeStream(apiKeyAuth("http://codex.test"), request("gpt-5.5", responsesHello("gpt-5.5")), options("openai-response", true));
  expect((await drain(result)).error).toBeUndefined();
});

const contextWindowMessage = "Your input exceeds the context window of this model. Please adjust your input and try again.";

test("TestCodexTerminalStreamContextLengthErrFromResponseFailed", () => {
  const err = codexTerminalStreamContextLengthErr(`{"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"context_length_exceeded","message":"${contextWindowMessage}"}}}`);
  expect(err).toBeDefined();
  expect(err!.statusCode).toBe(400);
  expect(codexErrorCode(err!.message)).toEqual({ type: "invalid_request_error", code: "context_too_large" });
});

test("TestCodexTerminalStreamContextLengthErrFromTopLevelError", () => {
  const err = codexTerminalStreamContextLengthErr(`{"type":"error","code":"context_length_exceeded","message":"${contextWindowMessage}","sequence_number":2}`);
  expect(err).toBeDefined();
  expect(err!.statusCode).toBe(400);
  expect(codexErrorCode(err!.message)).toEqual({ type: "invalid_request_error", code: "context_too_large" });
  expect(err!.message).toContain("Your input exceeds the context window");
});

test("TestCodexTerminalStreamContextLengthErrIgnoresOtherTerminalErrors", () => {
  expect(codexTerminalStreamContextLengthErr(`{"type":"error","error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"Rate limit reached."}}`)).toBeUndefined();
});

test("TestCodexTerminalStreamErrIgnoresRateLimitTerminalErrors", () => {
  expect(codexTerminalStreamErr(`{"type":"error","error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"Rate limit reached."}}`)).toBeUndefined();
});

describe("TestCodexTerminalFailureErrClassifiesStatus", () => {
  const cases = [
    { name: "invalid request", event: `{"type":"error","error":{"type":"invalid_request_error","code":"invalid_value","message":"Invalid input."}}`, want: 400 },
    { name: "cyber policy", event: `{"type":"error","error":{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk."}}`, want: 400 },
    { name: "authentication", event: `{"type":"response.failed","response":{"error":{"type":"authentication_error","code":"invalid_api_key","message":"Invalid token."}}}`, want: 401 },
    { name: "rate limit", event: `{"type":"error","error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"Rate limit reached."}}`, want: 429 },
    { name: "unknown upstream failure", event: `{"type":"response.failed","response":{"error":{"type":"upstream_error","code":"unknown","message":"Upstream failed."}}}`, want: 502 },
    {
      name: "overload stays a bad gateway without buffering",
      event: `{"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}`,
      want: 502,
    },
    {
      name: "model not found with invalid_request_error type maps to 404",
      event: `{"type":"error","error":{"type":"invalid_request_error","code":"model_not_found","message":"The model gpt-5.5 does not exist or you do not have access to it."}}`,
      want: 404,
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const failure = codexTerminalFailureErr(tc.event);
      expect(failure).toBeDefined();
      expect(failure!.error.statusCode).toBe(tc.want);
    });
  }
});

test("TestCodexTerminalStreamErrHandlesUsageLimitErrorEvent", () => {
  const failure = codexTerminalStreamErr(`{"type":"error","error":{"type":"usage_limit_reached","message":"You've hit your usage limit.","resets_in_seconds":300}}`);
  expect(failure).toBeDefined();
  expect(failure!.error.statusCode).toBe(429);
  expect(failure!.error.retryAfterMs).toBe(300_000);
  expect(failure!.error.credentialScoped).toBe(true);
});

test("TestCodexTerminalStreamErrHandlesUsageLimitResponseFailed", () => {
  const failure = codexTerminalStreamErr(`{"type":"response.failed","response":{"error":{"type":"usage_limit_reached","message":"usage limit reached","resets_in_seconds":60}}}`);
  expect(failure).toBeDefined();
  expect(failure!.error.statusCode).toBe(429);
  expect(failure!.error.retryAfterMs).toBeDefined();
});
