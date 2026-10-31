// Ported from: test/usage_logging_test.go
// Skipped cases: none; TestGeminiExecutorRecordsSuccessfulZeroUsageInQueue is adapted: the port records at the
//   HTTP layer from Claude-shaped responses, so the request goes through the real server with a fake executor and
//   the record is read back from GET /v0/usage instead of the Redis usage queue.
// Also covers (new): stream records, failure records, client aborts, disabled statistics and secret masking.
import { expect, test } from "bun:test";
import { StatusError } from "../../src/executor/types.ts";
import { createServer } from "../../src/server/server.ts";
import type { UsageResponseJSON } from "../../src/usage/statistics.ts";
import { UsageStatistics } from "../../src/usage/statistics.ts";
import { baseNow, chunkStream, fakeExecutor, messagesRequest, newTestManager, readText, testAuth, type FakeExecutorSpec } from "./helpers.ts";

const clientKey = "sk-proxy-client-secret-0001";
const upstreamKey = "sk-ant-upstream-secret-9999";
const model = "claude-usage-test";

function claudeJSON(usage: Record<string, number>): string {
  return JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-usage-test-20261028", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage });
}

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const messageStart = sse("message_start", {
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-usage-test-20261028", content: [], usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40, cache_creation_input_tokens: 7 } },
});
const textDelta = sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } });
const messageDelta = sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } });
const messageStop = sse("message_stop", { type: "message_stop" });

function setup(spec: FakeExecutorSpec, options: { enabled?: boolean; apiKeys?: string[] } = {}) {
  let now = baseNow;
  const clock = () => now;
  const { manager, registry } = newTestManager(clock);
  manager.registerExecutor(fakeExecutor({ identifier: "claude", ...spec }));
  manager.register(testAuth({ id: "claude-key-1", provider: "claude", label: "team-a", attributes: { api_key: upstreamKey }, metadata: { disable_cooling: true } }));
  registry.registerClient("claude-key-1", "claude", [{ id: model, type: "claude" }]);
  const usage = new UsageStatistics({ enabled: options.enabled ?? true, now: clock });
  const server = createServer({ manager, registry, apiKeys: options.apiKeys ?? [clientKey], usage, now: clock });
  const advance = (ms: number) => (now += ms);
  return { server, usage, advance };
}

const auth = { Authorization: `Bearer ${clientKey}` };

async function getUsage(server: ReturnType<typeof createServer>, query = ""): Promise<{ status: number; text: string; json?: UsageResponseJSON }> {
  const resp = await server.fetch(new Request(`http://proxy.test/v0/usage${query}`, { headers: auth }));
  const text = await resp.text();
  return { status: resp.status, text, json: resp.status === 200 ? (JSON.parse(text) as UsageResponseJSON) : undefined };
}

test("RecordsSuccessfulZeroUsage: a non-stream success with zero usage is still counted", async () => {
  const { server } = setup({ execute: () => ({ payload: claudeJSON({ input_tokens: 0, output_tokens: 0 }) }) });
  const resp = await server.fetch(messagesRequest(model, false, { headers: auth }));
  expect(resp.status).toBe(200);
  await resp.text();
  const { json } = await getUsage(server);
  const record = json!.recent_requests[0]!;
  expect(record.provider).toBe("claude");
  expect(record.model).toBe(model);
  expect(record.failed).toBe(false);
  expect(record.tokens.total_tokens).toBe(0);
  expect(json!.usage.total_requests).toBe(1);
});

test("non-stream request records tokens, credential, masked keys and latency; no secret is exposed", async () => {
  let ctx!: ReturnType<typeof setup>;
  ctx = setup({
    execute: () => {
      ctx.advance(250);
      return { payload: claudeJSON({ input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 }) };
    },
  });
  const resp = await ctx.server.fetch(messagesRequest(model, false, { headers: { ...auth, "X-Claude-Code-Session-Id": "sess-123" } }));
  expect(resp.status).toBe(200);
  await resp.text();

  const { json, text } = await getUsage(ctx.server);
  expect(text).not.toContain(clientKey);
  expect(text).not.toContain(upstreamKey);
  const u = json!.usage;
  expect(u.total_requests).toBe(1);
  expect(u.success_count).toBe(1);
  expect(u.total_tokens).toBe(50);
  expect(u.tokens).toMatchObject({ input_tokens: 30, output_tokens: 12, cache_read_tokens: 5, cache_creation_tokens: 3 });
  expect(u.credentials["claude-key-1"]).toMatchObject({ provider: "claude", label: "team-a", total_requests: 1, total_tokens: 50 });
  expect(u.models[model]).toMatchObject({ total_requests: 1, total_tokens: 50 });
  expect(Object.keys(u.apis)).toEqual(["sk-p...0001"]);
  const record = json!.recent_requests[0]!;
  expect(record).toMatchObject({
    provider: "claude",
    model,
    alias: model,
    response_model: "claude-usage-test-20261028",
    endpoint: "POST /v1/messages",
    auth_id: "claude-key-1",
    auth_index: "team-a",
    source: "sk-a...9999",
    api_key: "sk-p...0001",
    session_id: "sess-123",
    stream: false,
    failed: false,
    latency_ms: 250,
    timestamp: new Date(baseNow).toISOString(),
  });
});

test("non-stream upstream failure is recorded as failed with its status", async () => {
  const { server } = setup({ execute: () => Promise.reject(new StatusError(429, "rate limited", { body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}' })) });
  const resp = await server.fetch(messagesRequest(model, false, { headers: auth }));
  expect(resp.status).toBe(429);
  await resp.text();
  const { json } = await getUsage(server);
  expect(json!.usage.failure_count).toBe(1);
  expect(json!.failed_requests).toBe(1);
  expect(json!.recent_requests[0]).toMatchObject({ failed: true, fail: { status_code: 429 }, auth_id: "claude-key-1", provider: "claude" });
});

test("stream request records merged message_start + message_delta usage at stream end", async () => {
  const { server } = setup({ stream: () => chunkStream([messageStart, textDelta, messageDelta, messageStop]) });
  const resp = await server.fetch(messagesRequest(model, true, { headers: auth }));
  expect(resp.status).toBe(200);
  await readText(resp.body);
  const { json } = await getUsage(server);
  const record = json!.recent_requests[0]!;
  expect(record).toMatchObject({ stream: true, failed: false, response_model: "claude-usage-test-20261028", auth_id: "claude-key-1" });
  expect(record.tokens).toEqual({ input_tokens: 100, output_tokens: 25, reasoning_tokens: 0, cached_tokens: 40, cache_read_tokens: 40, cache_creation_tokens: 7, total_tokens: 172 });
  expect(json!.usage.total_tokens).toBe(172);
});

test("stream with an upstream error event is a failure keeping the usage seen so far", async () => {
  const errorFrame = sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  const { server } = setup({ stream: () => chunkStream([messageStart, textDelta, errorFrame]) });
  const resp = await server.fetch(messagesRequest(model, true, { headers: auth }));
  await readText(resp.body);
  const { json } = await getUsage(server);
  expect(json!.recent_requests[0]).toMatchObject({ stream: true, failed: true, fail: { status_code: 529 } });
  expect(json!.recent_requests[0]!.tokens.input_tokens).toBe(100);
});

test("stream that fails mid-way records the terminal status", async () => {
  const { server } = setup({ stream: () => chunkStream([messageStart, textDelta], new StatusError(500, "boom")) });
  const resp = await server.fetch(messagesRequest(model, true, { headers: auth }));
  const body = await readText(resp.body);
  expect(body).toContain("event: error");
  const { json } = await getUsage(server);
  expect(json!.recent_requests[0]).toMatchObject({ failed: true, fail: { status_code: 500 } });
});

test("stream closed before message_stop is recorded as truncated (502)", async () => {
  const { server } = setup({ stream: () => chunkStream([messageStart, textDelta]) });
  const resp = await server.fetch(messagesRequest(model, true, { headers: auth }));
  await readText(resp.body);
  const { json } = await getUsage(server);
  expect(json!.recent_requests[0]).toMatchObject({ failed: true, fail: { status_code: 502, code: "stream_truncated" } });
});

test("stream failing before the first chunk is recorded as a failure", async () => {
  const { server } = setup({ stream: () => chunkStream([], new StatusError(503, "unavailable")) });
  const resp = await server.fetch(messagesRequest(model, true, { headers: auth }));
  expect(resp.status).toBe(503);
  await resp.text();
  const { json } = await getUsage(server);
  expect(json!.usage.total_requests).toBe(1);
  expect(json!.recent_requests[0]).toMatchObject({ stream: true, failed: true, fail: { status_code: 503 } });
});

test("client abort mid-stream is recorded as a 499 failure with the usage seen so far", async () => {
  let release!: () => void;
  const hang = new Promise<void>((resolve) => (release = resolve));
  async function* chunks() {
    yield messageStart;
    await hang;
  }
  const { server } = setup({ stream: () => ({ chunks: chunks() }) });
  const controller = new AbortController();
  const resp = await server.fetch(messagesRequest(model, true, { headers: auth, signal: controller.signal }));
  const reader = resp.body!.getReader();
  await reader.read();
  controller.abort();
  release();
  await reader.cancel().catch(() => {});
  const { json } = await getUsage(server);
  expect(json!.usage.total_requests).toBe(1);
  expect(json!.recent_requests[0]).toMatchObject({ failed: true, fail: { status_code: 499, code: "client_closed" } });
  expect(json!.recent_requests[0]!.tokens.input_tokens).toBe(100);
});

test("count_tokens is not recorded (upstream CountTokens publishes no usage)", async () => {
  const { server } = setup({ count: () => ({ payload: '{"input_tokens":12}' }) });
  const resp = await server.fetch(messagesRequest(model, false, { headers: auth, path: "/v1/messages/count_tokens" }));
  expect(resp.status).toBe(200);
  const { json } = await getUsage(server);
  expect(json!.usage.total_requests).toBe(0);
});

test("GET /v0/usage requires the inbound API key and accepts since", async () => {
  const { server, advance } = setup({ execute: () => ({ payload: claudeJSON({ input_tokens: 1, output_tokens: 1 }) }) });
  const unauth = await server.fetch(new Request("http://proxy.test/v0/usage"));
  expect(unauth.status).toBe(401);
  await server.fetch(messagesRequest(model, false, { headers: auth }));
  advance(60_000);
  await server.fetch(messagesRequest(model, false, { headers: auth }));
  const filtered = await getUsage(server, `?since=${encodeURIComponent(new Date(baseNow + 30_000).toISOString())}`);
  expect(filtered.json!.usage.total_requests).toBe(1);
  expect(filtered.json!.history_complete).toBe(true);
  const bad = await getUsage(server, "?since=not-a-date");
  expect(bad.status).toBe(400);
  const post = await server.fetch(new Request("http://proxy.test/v0/usage", { method: "POST", headers: auth }));
  expect(post.status).toBe(405);
});

test("GET /v0/usage is open when no inbound keys are configured; records then carry no client key", async () => {
  const { server } = setup({ execute: () => ({ payload: claudeJSON({ input_tokens: 2, output_tokens: 3 }) }) }, { apiKeys: [] });
  await server.fetch(messagesRequest(model, false));
  const resp = await server.fetch(new Request("http://proxy.test/v0/usage"));
  expect(resp.status).toBe(200);
  const json = (await resp.json()) as UsageResponseJSON;
  expect(json.recent_requests[0]!.api_key).toBe("");
  expect(Object.keys(json.usage.apis)).toEqual(["POST /v1/messages"]);
});

test("disabled statistics: GET /v0/usage is 404 and nothing is recorded", async () => {
  const { server, usage } = setup({ execute: () => ({ payload: claudeJSON({ input_tokens: 5, output_tokens: 5 }) }), stream: () => chunkStream([messageStart, messageStop]) }, { enabled: false });
  const resp = await server.fetch(messagesRequest(model, false, { headers: auth }));
  expect(resp.status).toBe(200);
  await readText((await server.fetch(messagesRequest(model, true, { headers: auth }))).body);
  const { status } = await getUsage(server);
  expect(status).toBe(404);
  expect(usage.snapshot().usage.total_requests).toBe(0);
  expect(usage.recent()).toEqual([]);
});
