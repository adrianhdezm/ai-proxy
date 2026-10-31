// New (no upstream test): router, inbound API-key auth, CORS preflight, body size limit,
// unknown model / unknown route errors and the /v1/models shape over the Bun server.
import { afterEach, expect, test } from "bun:test";
import { ModelRegistry } from "../../src/registry/index.ts";
import { createServer, type ProxyServer } from "../../src/server/server.ts";
import { chunkStream, fakeManager, messagesBody, messagesRequest } from "./helpers.ts";

const started: ProxyServer[] = [];
afterEach(async () => {
  for (const server of started.splice(0)) await server.stop();
});

function registryWith(...models: { id: string; provider?: string; displayName?: string; created?: number }[]): ModelRegistry {
  const registry = new ModelRegistry();
  models.forEach((model, i) => {
    registry.registerClient(`client-${i}`, model.provider ?? "claude", [{ id: model.id, type: model.provider ?? "claude", displayName: model.displayName, created: model.created, ownedBy: "anthropic" }]);
  });
  return registry;
}

const okManager = () =>
  fakeManager({
    execute: async (_providers, req) => ({ payload: JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) }),
    stream: async () => chunkStream([`event: message_start\ndata: {"type":"message_start"}\n\n`, `event: message_stop\ndata: {"type":"message_stop"}\n\n`]),
    count: async () => ({ payload: `{"input_tokens":7}` }),
  });

test("inbound auth: 401 when keys are configured and the credential is missing or wrong", async () => {
  const server = createServer({ manager: okManager(), registry: registryWith({ id: "claude-sonnet-4-6" }), apiKeys: ["sk-good"] });
  const missing = await server.fetch(messagesRequest("claude-sonnet-4-6", false));
  expect(missing.status).toBe(401);
  const missingBody = (await missing.json()) as { type: string; error: { type: string; message: string } };
  expect(missingBody.type).toBe("error");
  expect(missingBody.error.type).toBe("authentication_error");
  expect(missingBody.error.message).toContain("missing");

  const wrong = await server.fetch(messagesRequest("claude-sonnet-4-6", false, { headers: { "x-api-key": "sk-bad" } }));
  expect(wrong.status).toBe(401);
  expect(((await wrong.json()) as { error: { message: string } }).error.message).toContain("invalid");

  const wrongScheme = await server.fetch(messagesRequest("claude-sonnet-4-6", false, { headers: { Authorization: "Basic sk-good" } }));
  expect(wrongScheme.status).toBe(401);

  // /v1/models is protected too; the health endpoint is not.
  expect((await server.fetch(new Request("http://proxy.test/v1/models"))).status).toBe(401);
  expect((await server.fetch(new Request("http://proxy.test/health"))).status).toBe(200);
});

test("inbound auth: accepted via Authorization Bearer, x-api-key, x-goog-api-key and ?key=", async () => {
  const manager = okManager();
  const server = createServer({ manager, registry: registryWith({ id: "claude-sonnet-4-6" }), apiKeys: ["sk-good", "sk-other"] });
  const attempts: Request[] = [
    messagesRequest("claude-sonnet-4-6", false, { headers: { Authorization: "Bearer sk-good" } }),
    messagesRequest("claude-sonnet-4-6", false, { headers: { "x-api-key": "sk-other" } }),
    messagesRequest("claude-sonnet-4-6", false, { headers: { "x-goog-api-key": "sk-good" } }),
    messagesRequest("claude-sonnet-4-6", false, { path: "/v1/messages?key=sk-good" }),
  ];
  for (const request of attempts) {
    const response = await server.fetch(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { type: string };
    expect(body.type).toBe("message");
  }
  expect(manager.calls).toHaveLength(4);
  // The inbound credential never reaches the executor options.
  for (const call of manager.calls) {
    expect(call.opts.headers?.get("Authorization")).toBeNull();
    expect(call.opts.headers?.get("x-api-key")).toBeNull();
    expect(call.opts.headers?.get("x-goog-api-key")).toBeNull();
  }
});

test("no configured keys leaves the API open", async () => {
  const server = createServer({ manager: okManager(), registry: registryWith({ id: "claude-sonnet-4-6" }) });
  const response = await server.fetch(messagesRequest("claude-sonnet-4-6", false));
  expect(response.status).toBe(200);
});

test("unknown model -> 400 invalid_request_error (Go: getRequestDetails); thinking suffix is stripped for the lookup", async () => {
  const manager = okManager();
  const server = createServer({ manager, registry: registryWith({ id: "claude-sonnet-4-6" }) });
  const unknown = await server.fetch(messagesRequest("gpt-unknown", false));
  expect(unknown.status).toBe(400);
  const body = (await unknown.json()) as { type: string; error: { type: string; message: string } };
  expect(body.type).toBe("error");
  expect(body.error.type).toBe("invalid_request_error");
  expect(body.error.message).toBe("unknown provider for model gpt-unknown");
  expect(manager.calls).toHaveLength(0);

  const streaming = await server.fetch(messagesRequest("gpt-unknown", true));
  expect(streaming.status).toBe(400);
  expect(streaming.headers.get("Content-Type")).toBe("application/json");

  const suffixed = await server.fetch(messagesRequest("claude-sonnet-4-6(high)", false));
  expect(suffixed.status).toBe(200);
  const call = manager.calls[0]!;
  expect(call.providers).toEqual(["claude"]);
  expect(call.req.model).toBe("claude-sonnet-4-6(high)");
  expect(call.req.format).toBe("claude");
  expect(call.opts.sourceFormat).toBe("claude");
  expect(call.opts.metadata?.requested_model).toBe("claude-sonnet-4-6(high)");
  expect(call.opts.metadata?.request_path).toBe("/v1/messages");
  expect(call.opts.originalRequest).toBe(messagesBody("claude-sonnet-4-6(high)", false));
});

test("invalid JSON body -> 400 invalid_request_error", async () => {
  const server = createServer({ manager: okManager(), registry: registryWith({ id: "claude-sonnet-4-6" }) });
  const response = await server.fetch(new Request("http://proxy.test/v1/messages", { method: "POST", body: "{not json" }));
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { type: string } };
  expect(body.error.type).toBe("invalid_request_error");
});

test("/v1/models shape and /v1/models/:id", async () => {
  const server = createServer({ manager: okManager(), registry: registryWith({ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", created: 1_700_000_000 }, { id: "gpt-5.4", provider: "codex", displayName: "GPT-5.4" }) });
  const response = await server.fetch(new Request("http://proxy.test/v1/models", { headers: { "anthropic-version": "2023-06-01" } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  const body = (await response.json()) as { data: Record<string, unknown>[]; has_more: boolean; first_id: string; last_id: string };
  expect(body.has_more).toBe(false);
  expect(body.data.map((m) => m.id)).toEqual(["claude-sonnet-4-6", "gpt-5.4"]);
  expect(body.first_id).toBe("claude-sonnet-4-6");
  expect(body.last_id).toBe("gpt-5.4");
  const claude = body.data[0]!;
  expect(claude.type).toBe("model");
  expect(claude.display_name).toBe("Claude Sonnet 4.6");
  expect(claude.created_at).toBe("2023-11-14T22:13:20Z");
  expect(claude.max_input_tokens).toBe(200000);
  expect(claude.max_tokens).toBe(64000);

  const detail = await server.fetch(new Request("http://proxy.test/v1/models/gpt-5.4"));
  expect(detail.status).toBe(200);
  expect(((await detail.json()) as { id: string }).id).toBe("gpt-5.4");
  const missing = await server.fetch(new Request("http://proxy.test/v1/models/nope"));
  expect(missing.status).toBe(404);
});

test("CORS preflight and headers on every response", async () => {
  const server = createServer({ manager: okManager(), registry: registryWith({ id: "claude-sonnet-4-6" }), apiKeys: ["sk-good"] });
  const preflight = await server.fetch(
    new Request("http://proxy.test/v1/messages", { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-custom-header, authorization" } }),
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  const allowHeaders = preflight.headers.get("Access-Control-Allow-Headers") ?? "";
  expect(allowHeaders).toContain("Authorization");
  expect(allowHeaders).toContain("X-Api-Key");
  expect(allowHeaders).toContain("Anthropic-Version");
  expect(allowHeaders).toContain("X-Custom-Header");
  expect(allowHeaders.split(", ").filter((h) => h === "Authorization")).toHaveLength(1);

  const denied = await server.fetch(messagesRequest("claude-sonnet-4-6", false));
  expect(denied.status).toBe(401);
  expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(denied.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
});

test("unknown route -> 404 Claude error; wrong method -> 405", async () => {
  const server = createServer({ manager: okManager(), registry: registryWith({ id: "claude-sonnet-4-6" }) });
  const notFound = await server.fetch(new Request("http://proxy.test/v1/chat/completions", { method: "POST", body: "{}" }));
  expect(notFound.status).toBe(404);
  const body = (await notFound.json()) as { type: string; error: { type: string } };
  expect(body.type).toBe("error");
  expect(body.error.type).toBe("not_found_error");
  const wrongMethod = await server.fetch(new Request("http://proxy.test/v1/messages", { method: "GET" }));
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get("Allow")).toBe("POST");
});

test("request body limit -> 413 request_too_large", async () => {
  const server = createServer({ manager: okManager(), registry: registryWith({ id: "claude-sonnet-4-6" }), maxRequestBodyBytes: 64 });
  const big = await server.fetch(messagesRequest("claude-sonnet-4-6", false, { extra: { system: "x".repeat(200) } }));
  expect(big.status).toBe(413);
  const body = (await big.json()) as { error: { type: string } };
  expect(body.error.type).toBe("request_too_large");
  const declared = await server.fetch(new Request("http://proxy.test/v1/messages", { method: "POST", headers: { "Content-Length": "9999" }, body: "{}" }));
  expect(declared.status).toBe(413);
});

test("count_tokens and streaming over a real socket", async () => {
  const server = createServer({ manager: okManager(), registry: registryWith({ id: "claude-sonnet-4-6" }), apiKeys: ["sk-good"], port: 0 });
  started.push(server);
  const bun = server.start();
  const base = `http://127.0.0.1:${bun.port}`;
  const count = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", headers: { "x-api-key": "sk-good" }, body: messagesBody("claude-sonnet-4-6", false) });
  expect(count.status).toBe(200);
  expect(((await count.json()) as { input_tokens: number }).input_tokens).toBe(7);

  const stream = await fetch(`${base}/v1/messages`, { method: "POST", headers: { Authorization: "Bearer sk-good" }, body: messagesBody("claude-sonnet-4-6", true) });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
  const text = await stream.text();
  expect(text).toBe(`event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);

  const health = await fetch(`${base}/`);
  expect(health.status).toBe(200);
  await server.stop();
  expect(server.server).toBeUndefined();
});

test("passthroughHeaders forwards filtered upstream headers on success and errors", async () => {
  const { StatusError } = await import("../../src/executor/types.ts");
  const manager = fakeManager({
    execute: async () => ({ payload: `{"type":"message"}`, headers: new Headers({ "request-id": "req_up", "set-cookie": "a=b", "x-litellm-key": "x" }) }),
    count: async () => {
      throw new StatusError(429, "slow down", { headers: new Headers({ "Retry-After": "7", "request-id": "req_err" }), retryAfterMs: 7000 });
    },
  });
  const registry = registryWith({ id: "claude-sonnet-4-6" });
  const off = createServer({ manager, registry });
  const plain = await off.fetch(messagesRequest("claude-sonnet-4-6", false));
  expect(plain.headers.get("request-id")).toBeNull();

  const on = createServer({ manager, registry, passthroughHeaders: true });
  const forwarded = await on.fetch(messagesRequest("claude-sonnet-4-6", false));
  expect(forwarded.headers.get("request-id")).toBe("req_up");
  expect(forwarded.headers.get("set-cookie")).toBeNull();
  expect(forwarded.headers.get("x-litellm-key")).toBeNull();

  const failed = await on.fetch(messagesRequest("claude-sonnet-4-6", false, { path: "/v1/messages/count_tokens" }));
  expect(failed.status).toBe(429);
  expect(failed.headers.get("Retry-After")).toBe("7");
  expect(failed.headers.get("request-id")).toBe("req_err");
  const body = (await failed.json()) as { error: { type: string } };
  expect(body.error.type).toBe("rate_limit_error");
});
