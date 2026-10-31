// New (no upstream test): end-to-end OpenAICompatExecutor behaviour against a fake
// chat.completions server — Claude inbound non-stream (text + tool call), a streaming
// Claude SSE sequence ending in message_stop, upstream 429 with Retry-After, stream
// truncation (before any output, [DONE]-only, dropped connection, after output without
// finish_reason, after finish_reason without [DONE]), in-stream error payloads, request
// headers, countTokens and refresh.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { OpenAICompatExecutor, createOpenAIExecutor } from "../../../src/executor/openai/index.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { FormatClaude } from "../../../src/translator/types.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { getGlobalRegistry } from "../../../src/registry/index.ts";
import { apiKeyAuth, drain, getString, getValue, jsonResponse, parseClaudeEvents, sseChunkedResponse, sseResponse, startUpstream } from "./helpers.ts";

const upstream = startUpstream(() => jsonResponse("{}", 500));
afterAll(() => upstream.close());

const executor = createOpenAIExecutor();
const auth = apiKeyAuth({ baseURL: upstream.baseURL, apiKey: "sk-test" });

const claudeRequest = (stream: boolean, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "hello" }], stream, ...extra });

const textChunks =
  'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n' +
  'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n';
const finishChunk = 'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}\n\n';

beforeEach(() => {
  upstream.requests.length = 0;
});

describe("execute (non-stream)", () => {
  test("text response is translated to a Claude message", async () => {
    upstream.respond(() => jsonResponse(`{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"Hello there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}`, 200, { "x-request-id": "req-1" }));
    const resp = await executor.execute(auth, { model: "gpt-4o", payload: claudeRequest(false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    const body = JSON.parse(resp.payload);
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.input_tokens).toBe(9);
    expect(body.usage.output_tokens).toBe(3);
    expect(resp.headers?.get("x-request-id")).toBe("req-1");
    expect(resp.metadata?.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, totalTokens: 12 });

    const sent = upstream.requests[0]!;
    expect(sent.url).toBe("/v1/chat/completions");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe("Bearer sk-test");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.headers.get("user-agent")).toBe("cli-proxy-openai-compat");
    expect(sent.headers.get("accept")).not.toBe("text/event-stream");
    expect(getString(sent.body, "model")).toBe("gpt-4o");
    expect(getValue(sent.body, "stream")).toBe(false);
    expect(getValue(sent.body, "stream_options")).toBeUndefined();
  });

  test("tool call response becomes a tool_use block", async () => {
    upstream.respond(() =>
      jsonResponse(
        `{"id":"chatcmpl-2","object":"chat.completion","model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}}`,
      ),
    );
    const payload = claudeRequest(false, { tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }] });
    const resp = await executor.execute(auth, { model: "gpt-4o", payload, format: FormatClaude }, { stream: false, sourceFormat: FormatClaude, originalRequest: payload });
    const body = JSON.parse(resp.payload);
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([{ type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "Paris" } }]);
    const sent = upstream.lastBody();
    expect(getString(sent, "tools.0.function.name")).toBe("get_weather");
  });

  test("custom headers and the client's User-Agent are forwarded", async () => {
    upstream.respond(() => jsonResponse(`{"id":"c","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`));
    const custom = apiKeyAuth({ baseURL: upstream.baseURL + "/", apiKey: "sk-test", attributes: { "header:X-Custom": "yes", "header:X-From-Client": "$X-Client" } });
    const clientHeaders = new Headers({ "User-Agent": "my-client/1.0", "X-Client": "forwarded" });
    await executor.execute(custom, { model: "gpt-4o", payload: claudeRequest(false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude, headers: clientHeaders });
    const sent = upstream.requests[0]!;
    expect(sent.url).toBe("/v1/chat/completions");
    expect(sent.headers.get("x-custom")).toBe("yes");
    expect(sent.headers.get("x-from-client")).toBe("forwarded");
    expect(sent.headers.get("user-agent")).toBe("my-client/1.0");
  });

  test("missing base URL is a 401 StatusError before any upstream call", async () => {
    const noBase = newAuth({ id: "openai:nobase", provider: "openai", attributes: { api_key: "sk" } });
    let caught: unknown;
    try {
      await executor.execute(noBase, { model: "gpt-4o", payload: claudeRequest(false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StatusError);
    expect((caught as StatusError).statusCode).toBe(401);
    expect((caught as StatusError).message).toBe("missing provider baseURL");
    expect(upstream.requests.length).toBe(0);
  });

  test("non-2xx without Retry-After is a StatusError with the upstream body and no retry hint", async () => {
    upstream.respond(() => jsonResponse(`{"error":{"message":"bad key","type":"invalid_request_error"}}`, 401));
    let caught: unknown;
    try {
      await executor.execute(auth, { model: "gpt-4o", payload: claudeRequest(false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    } catch (err) {
      caught = err;
    }
    const err = caught as StatusError;
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(401);
    expect(err.responseBody()).toContain("bad key");
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("a thinking refusal is request scoped (no upstream call, no failover)", async () => {
    const registry = getGlobalRegistry();
    registry.registerClient("openai-executor-test", "openai", [{ id: "gpt-5-level", type: "openai", thinking: { levels: ["low", "high"] } }]);
    let caught: unknown;
    try {
      await executor.execute(auth, { model: "gpt-5-level(bogus)", payload: claudeRequest(false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    } catch (err) {
      caught = err;
    } finally {
      registry.unregisterClient("openai-executor-test");
    }
    expect(caught).toBeInstanceOf(StatusError);
    expect((caught as StatusError).statusCode).toBe(400);
    expect((caught as StatusError).requestScoped).toBe(true);
    expect(upstream.requests.length).toBe(0);
  });
});

describe("executeStream", () => {
  test("produces a valid Claude SSE sequence ending in message_stop", async () => {
    upstream.respond(() => sseResponse(textChunks + finishChunk + "data: [DONE]\n\n", { "x-request-id": "stream-1" }));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude, originalRequest: claudeRequest(true) });
    expect(result.headers?.get("x-request-id")).toBe("stream-1");
    const { chunks, error } = await drain(result);
    expect(error).toBeUndefined();
    const events = parseClaudeEvents(chunks);
    expect(events.map((e) => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    const start = JSON.parse(events[0]!.payload);
    expect(start.message.usage.input_tokens).toBeGreaterThan(0); // estimated from the Claude request
    const text = events.filter((e) => e.type === "content_block_delta").map((e) => JSON.parse(e.payload).delta.text).join("");
    expect(text).toBe("Hello");
    const delta = JSON.parse(events[5]!.payload);
    expect(delta.delta.stop_reason).toBe("end_turn");
    expect(delta.usage).toMatchObject({ input_tokens: 9, output_tokens: 2 });

    const sent = upstream.requests[0]!;
    expect(sent.headers.get("accept")).toBe("text/event-stream");
    expect(sent.headers.get("cache-control")).toBe("no-cache");
    expect(sent.headers.get("authorization")).toBe("Bearer sk-test");
    expect(getValue(sent.body, "stream")).toBe(true);
    expect(getValue(sent.body, "stream_options.include_usage")).toBe(true);
  });

  test("stream cut before any output is a 502 so the manager can fail over", async () => {
    upstream.respond(() => sseChunkedResponse([": warming up\n\n"]));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { chunks, error } = await drain(result);
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).message).toBe("upstream stream closed before [DONE]");
    expect((error as StatusError).streamTruncated).toBe(false);
  });

  test("a [DONE]-only stream (no output at all) is a 502 instead of a stream without message_start", async () => {
    upstream.respond(() => sseResponse("data: [DONE]\n\n"));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { chunks, error } = await drain(result);
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).message).toBe("upstream stream ended without output");
  });

  test("a connection dropped mid-body before any output is a 502", async () => {
    // Raw TCP upstream: valid chunked 200 headers and a keepalive comment, then the socket closes
    // without the terminating chunk, so the body read fails.
    const raw = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          const comment = ": keepalive\n\n";
          socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n${comment.length.toString(16)}\r\n${comment}\r\n`);
          socket.end();
        },
      },
    });
    try {
      const rawAuth = apiKeyAuth({ baseURL: `http://127.0.0.1:${raw.port}/v1`, apiKey: "sk-test" });
      const result = await executor.executeStream(rawAuth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
      const { chunks, error } = await drain(result);
      expect(chunks).toEqual([]);
      expect(error).toBeInstanceOf(StatusError);
      expect((error as StatusError).statusCode).toBe(502);
    } finally {
      raw.stop(true);
    }
  });

  test("no yielded chunk is ever empty", async () => {
    upstream.respond(() => sseChunkedResponse([": keepalive\n\n", 'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n', 'data: {"choices":[{"index":0,"delta":{}}]}\n\n', textChunks, finishChunk, "data: [DONE]\n\n"]));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { chunks, error } = await drain(result);
    expect(error).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(parseClaudeEvents(chunks).map((e) => e.type)[0]).toBe("message_start");
  });

  test("stream cut after output but before finish_reason fails with 502 (upstream behaviour for Claude clients)", async () => {
    upstream.respond(() => sseChunkedResponse([textChunks]));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { chunks, error } = await drain(result);
    const events = parseClaudeEvents(chunks);
    expect(events.map((e) => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta"]);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).message).toBe("upstream stream closed before [DONE]");
  });

  test("stream ending after finish_reason without [DONE] flushes message_stop", async () => {
    upstream.respond(() => sseChunkedResponse([textChunks, finishChunk]));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { chunks, error } = await drain(result);
    expect(error).toBeUndefined();
    const events = parseClaudeEvents(chunks);
    expect(events[events.length - 1]!.type).toBe("message_stop");
    expect(events.filter((e) => e.type === "message_delta").length).toBe(1);
  });

  test("trailing frame without a blank-line terminator is still processed", async () => {
    upstream.respond(() => sseChunkedResponse([textChunks + finishChunk + "data: [DONE]"]));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { chunks, error } = await drain(result);
    expect(error).toBeUndefined();
    expect(parseClaudeEvents(chunks).map((e) => e.type)).toContain("message_stop");
  });

  test("an error payload inside the stream becomes a StatusError with its status", async () => {
    upstream.respond(() => sseResponse('data: {"error":{"message":"The model is overloaded","type":"server_error","status":503}}\n\n'));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { chunks, error } = await drain(result);
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(503);
    expect((error as StatusError).responseBody()).toContain("overloaded");
  });

  test("an `event: error` frame without a status is a 502", async () => {
    upstream.respond(() => sseResponse('event: error\ndata: {"message":"boom"}\n\n'));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { error } = await drain(result);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).responseBody()).toContain("boom");
  });

  test("a bare JSON error body on a 200 stream is surfaced as a 502 with the payload", async () => {
    upstream.respond(() => sseResponse('{"error":{"message":"not sse"}}\n'));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { error } = await drain(result);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).responseBody()).toContain("not sse");
  });

  test("an invalid data frame is a 502", async () => {
    upstream.respond(() => sseResponse('data: {"choices":[{"delta":{"content":"x"\n\n'));
    const result = await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { error } = await drain(result);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).message).toBe("upstream stream ended with incomplete SSE data frame");
  });

  test("upstream 429 with Retry-After at stream bootstrap", async () => {
    upstream.respond(() => jsonResponse(`{"error":{"message":"slow down"}}`, 429, { "Retry-After": "3" }));
    let caught: unknown;
    try {
      await executor.executeStream(auth, { model: "gpt-4o", payload: claudeRequest(true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    } catch (err) {
      caught = err;
    }
    expect((caught as StatusError).statusCode).toBe(429);
    expect((caught as StatusError).retryAfterMs).toBe(3000);
  });
});

describe("countTokens and refresh", () => {
  test("countTokens returns a Claude input_tokens estimate without calling upstream", async () => {
    const resp = await executor.countTokens(auth, { model: "gpt-4o", payload: claudeRequest(false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    const body = JSON.parse(resp.payload);
    expect(Object.keys(body)).toEqual(["input_tokens"]);
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(upstream.requests.length).toBe(0);
  });

  test("refresh returns API-key auths unchanged and refuses OAuth material", async () => {
    expect(await executor.refresh(auth)).toBe(auth);
    const oauth = newAuth({ id: "openai:oauth", provider: "openai", attributes: {}, metadata: { refresh_token: "r" } });
    await expect(executor.refresh(oauth)).rejects.toThrow("cannot refresh oauth credentials");
  });

  test("identifier and factory", () => {
    expect(executor.identifier).toBe("openai");
    expect(new OpenAICompatExecutor(undefined, { provider: "openai-compat" }).identifier).toBe("openai-compat");
  });
});
