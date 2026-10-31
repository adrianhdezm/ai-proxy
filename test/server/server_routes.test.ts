// Ported from: internal/api/server_test.go
// Ported from: internal/api/server_cors_preflight_test.go
// Ported from: internal/api/server_config_v8_etag_test.go
// Ported from: internal/api/server_stop_test.go
// Ported from: internal/api/server_model_detail_test.go
// Ported from: internal/api/protocol_multiplexer_test.go
// Skipped cases: server_test.go: every Home, Codex alpha-search/SIWC, plugin-host, Management, realtime/live,
// Interactions, xAI/Grok, Devin, Antigravity and request-log case (features or providers not ported);
// TestNewServerAppliesTrustedProxyConfiguration and TestHealthzAccessLogging (gin client-IP resolution and
// access logging, not ported); TestModelsWithClientVersion*, TestCodexClientModelsEndpoint_* and
// TestModelsForCPAClientSerializesWebSearchCapabilities (the Codex client model catalogue for
// ?client_version= is not ported; the plain OpenAI list is returned); the "plain request stays on openai
// format" half of TestModelsDispatchByAnthropicVersionHeader (the port answers unmarked /v1/models requests in
// the Claude shape and keeps the OpenAI list for OpenAI/Codex clients, see README); the hot reload of
// TestClaudeModelListCloakingConfigHotReload (one server per setting instead). server_config_v8_etag_test.go:
// only the CORS exposure of ETag is kept (the v8 config endpoint is Management). server_model_detail_test.go:
// TestIssue5190ModelDetailLifecycle / TestIssue5190ModelDetailUsesVisibleCatalog (plugin interceptors) and the
// Home half of TestIssue5190ModelDetailHomeVisibility. protocol_multiplexer_test.go: only
// TestServerRejectsIncompleteUnauthenticatedRequestBodiesPromptly is kept (the RESP/HTTP accept multiplexer
// is not ported); its request-log/commercial-mode variants collapse to one run, the trailing-slash 307 row is
// dropped (the port serves the stripped path directly) and the check is that the status line arrives before
// the body does, not that Go's server closes the connection.
import { afterEach, describe, expect, test } from "bun:test";
import { AuthManager } from "../../src/auth/manager/index.ts";
import type { ProviderExecutor, StreamResult } from "../../src/executor/types.ts";
import { ModelRegistry } from "../../src/registry/index.ts";
import { createServer, type ProxyServer } from "../../src/server/server.ts";
import { TestWebsocketClient } from "../executor/codex/websocket_helpers.ts";
import { chunkStream, fakeManager, registerFakeAuth } from "./helpers.ts";

const started: ProxyServer[] = [];
afterEach(async () => {
  for (const server of started.splice(0)) await server.stop();
});

function startServer(server: ProxyServer): string {
  started.push(server);
  const bun = server.start();
  return `127.0.0.1:${bun.port}`;
}

describe("TestHealthz", () => {
  const server = createServer({ manager: fakeManager(), registry: new ModelRegistry(), apiKeys: ["test-key"] });
  test("GET", async () => {
    const response = await server.fetch(new Request("http://proxy.test/healthz"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ok");
  });
  test("HEAD", async () => {
    const response = await server.fetch(new Request("http://proxy.test/healthz", { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("CORS", () => {
  const server = createServer({ manager: fakeManager(), registry: new ModelRegistry(), apiKeys: ["test-key"] });
  const preflight = (path: string, method: string, requestHeaders: string) =>
    server.fetch(new Request(`http://proxy.test${path}`, { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:8765", "Access-Control-Request-Method": method, "Access-Control-Request-Headers": requestHeaders } }));
  const allowed = (response: Response) => {
    const value = response.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(value).not.toBe("*");
    return new Set(value.split(",").map((name) => name.trim().toLowerCase()));
  };

  test("TestCORSPreflightExplicitlyAllowsAuthorization", async () => {
    const cases: [string, string, string, string[]][] = [
      ["/v1/models", "GET", "authorization", ["Authorization"]],
      ["/v1/responses", "POST", "authorization,content-type", ["Authorization", "Content-Type"]],
      ["/v1/models", "GET", "x-api-key,x-goog-api-key", ["X-Api-Key", "X-Goog-Api-Key"]],
      ["/v1/messages", "POST", "x-api-key,anthropic-version,anthropic-beta", ["X-Api-Key", "Anthropic-Version", "Anthropic-Beta"]],
    ];
    for (const [path, method, requested, want] of cases) {
      const response = await preflight(path, method, requested);
      expect(response.status).toBe(204);
      const names = allowed(response);
      for (const name of want) expect(names.has(name.toLowerCase())).toBe(true);
    }
  });

  test("TestCORSPreflightEchoesRequestedAllowHeaders", async () => {
    const response = await preflight("/v1/responses", "POST", "authorization, x-custom-sdk-header");
    expect(response.status).toBe(204);
    const names = allowed(response);
    expect(names.has("authorization")).toBe(true);
    expect(names.has("x-custom-sdk-header")).toBe(true);
  });

  test("TestConfigV8ETagExposedForCORS (exposure half): ETag is CORS-readable on every response", async () => {
    for (const response of [await server.fetch(new Request("http://proxy.test/v1/models", { headers: { Origin: "http://127.0.0.1:5173" } })), await server.fetch(new Request("http://proxy.test/healthz"))]) {
      const exposed = (response.headers.get("Access-Control-Expose-Headers") ?? "").split(",").map((name) => name.trim().toLowerCase());
      expect(exposed).toContain("etag");
    }
  });
});

test("TestServerStop_ViolentShutdownImmediatelyClosesWithoutContextDeadlineError", async () => {
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => (started = resolve));
  const manager = fakeManager({
    execute: () => {
      started();
      return new Promise(() => {}); // never answers on its own
    },
  });
  const registry = new ModelRegistry();
  registry.registerClient("c", "claude", [{ id: "claude-sonnet-4-6", type: "claude" }]);
  const server = createServer({ manager, registry, host: "127.0.0.1", port: 0 });
  const addr = startServer(server);
  const inflight = fetch(`http://${addr}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }) }).then(
    () => "completed",
    () => "interrupted",
  );
  await requestStarted;
  await server.stop();
  expect(server.server).toBeUndefined();
  expect(await inflight).toBe("interrupted");
});

describe("models", () => {
  const registry = () => {
    const r = new ModelRegistry();
    r.registerClient("test-anthropic-version-dispatch", "claude", [
      { id: "claude-sonnet-4-6", type: "claude", ownedBy: "anthropic", displayName: "Claude 4.6 Sonnet", contextLength: 200000, maxCompletionTokens: 64000 },
      { id: "gpt-4o", type: "openai", ownedBy: "openai" },
    ]);
    return r;
  };

  test("TestModelsDispatchByAnthropicVersionHeader: Anthropic-Version routes to the Claude format with cloaked ids", async () => {
    const server = createServer({ manager: fakeManager(), registry: registry(), apiKeys: ["test-key"], cloakModelList: true });
    const response = await server.fetch(new Request("http://proxy.test/v1/models", { headers: { Authorization: "Bearer test-key", "User-Agent": "Zed/1.0", "Anthropic-Version": "2023-06-01" } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object?: string; has_more?: boolean; data: Record<string, unknown>[] };
    expect(body.object).not.toBe("list");
    expect(body.has_more).toBeDefined();
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-fable-5-dd-o4-tpg");
    expect(ids).not.toContain("gpt-4o");
    const claude = body.data.find((m) => m.id === "claude-sonnet-4-6")!;
    for (const field of ["max_input_tokens", "max_tokens", "display_name"]) expect(claude[field]).toBeDefined();

    // An OpenAI client gets the OpenAI list with raw ids.
    const openai = await server.fetch(new Request("http://proxy.test/v1/models", { headers: { Authorization: "Bearer test-key", "User-Agent": "codex_cli_rs/0.100.0" } }));
    const list = (await openai.json()) as { object: string; data: Record<string, unknown>[] };
    expect(list.object).toBe("list");
    expect(list.data.map((m) => m.id)).toContain("gpt-4o");
    for (const model of list.data) {
      expect(model.max_input_tokens).toBeUndefined();
      expect(["claude-gpt-4o", "claude-fable-5-dd-o4-tpg"]).not.toContain(model.id as string);
    }
  });

  test("TestClaudeModelListCloakingConfigHotReload (adapted: one server per setting)", async () => {
    const r = new ModelRegistry();
    r.registerClient("test-claude-model-list-cloaking-hot-reload", "claude", [{ id: "gpt-model-list-hot-reload", type: "openai", ownedBy: "test" }]);
    const ids = async (cloakModelList: boolean) => {
      const server = createServer({ manager: fakeManager(), registry: r, apiKeys: ["test-key"], cloakModelList });
      const response = await server.fetch(new Request("http://proxy.test/v1/models", { headers: { Authorization: "Bearer test-key", "Anthropic-Version": "2023-06-01" } }));
      return ((await response.json()) as { data: { id: string }[] }).data.map((m) => m.id);
    };
    expect(await ids(true)).toContain("claude-fable-5-dd-daoler-toh-tsil-ledom-tpg");
    expect(await ids(false)).toContain("gpt-model-list-hot-reload");
  });

  test("TestIssue5190ModelDetailHomeVisibility (local half): a model id containing / resolves and needs auth", async () => {
    const r = new ModelRegistry();
    r.registerClient("TestIssue5190ModelDetailHomeVisibility", "openai", [{ id: "local/only", type: "openai" }]);
    const server = createServer({ manager: fakeManager(), registry: r, apiKeys: ["test-key"] });
    const authorized = await server.fetch(new Request("http://proxy.test/v1/models/local/only", { headers: { Authorization: "Bearer test-key", "User-Agent": "codex_cli_rs/0.100.0" } }));
    expect(authorized.status).toBe(200);
    expect(((await authorized.json()) as { id: string }).id).toBe("local/only");
    const unauthorized = await server.fetch(new Request("http://proxy.test/v1/models/local/only"));
    expect(unauthorized.status).toBe(401);
  });
});

test("TestServerResponsesWebsocketReauthorizesEachTurn", async () => {
  const registry = new ModelRegistry();
  const manager = new AuthManager({ registry, sleep: async () => {}, random: () => 0 });
  manager.setRetryConfig(0, 0, 0);
  let calls = 0;
  const executor: ProviderExecutor = {
    identifier: "ws-reauth",
    execute: () => Promise.reject(new Error("unused")),
    countTokens: () => Promise.reject(new Error("unused")),
    refresh: async (auth) => auth,
    executeStream: async (): Promise<StreamResult> => {
      calls++;
      return chunkStream([`data: {"type":"response.completed","response":{"id":"r${calls}","output":[]}}\n\n`]);
    },
  };
  manager.registerExecutor(executor);
  registerFakeAuth(manager, registry, "ws-reauth-auth", "ws-reauth", "ws-reauth-model");
  const server = createServer({ manager, registry, host: "127.0.0.1", port: 0, apiKeys: ["key-1"] });
  const addr = startServer(server);
  const url = `ws://${addr}/v1/responses`;

  const client = new TestWebsocketClient(url, { Authorization: "Bearer key-1" });
  await client.opened;
  const turn = { type: "response.create", model: "ws-reauth-model", input: [{ type: "message", role: "user", content: "turn 1" }] };
  client.send(turn);
  const first = await client.waitForType("response.completed");

  server.setAPIKeys(["key-2"]); // key-1 revoked

  // A fresh dial with the revoked key fails at the handshake with 401.
  const fresh = await fetch(`http://${addr}/v1/responses`, { headers: { Authorization: "Bearer key-1", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  expect(fresh.status).toBe(401);

  // The next turn on the open socket is rejected with an error event and does not execute.
  client.send({ ...turn, input: [{ type: "message", role: "user", content: "turn 2" }] });
  const rejected = await client.waitForType("error", first + 1);
  expect(client.parsed(rejected).status).toBe(401);
  expect(calls).toBe(1);
  client.close();
});

describe("TestServerRejectsIncompleteUnauthenticatedRequestBodiesPromptly", () => {
  const rows: [string, string, string][] = [
    ["1MiB boundary connection close", "POST /v1/messages HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n{", "HTTP/1.1 401 "],
    ["1MiB plus 1 connection close", "POST /v1/messages HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n{", "HTTP/1.1 401 "],
    ["1MiB boundary keep-alive", "POST /v1/messages HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 1048576\r\n\r\n{", "HTTP/1.1 401 "],
    ["small body keep-alive", "POST /v1/responses HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 128\r\n\r\n{", "HTTP/1.1 401 "],
    ["small multipart body keep-alive", "POST /v1/images/edits HTTP/1.1\r\nHost: %s\r\nContent-Type: multipart/form-data; boundary=abc\r\nContent-Length: 128\r\n\r\n--abc\r\n", "HTTP/1.1 401 "],
    ["compressed response small body keep-alive", "POST /v1/messages HTTP/1.1\r\nHost: %s\r\nAccept-Encoding: gzip\r\nContent-Type: application/json\r\nContent-Length: 128\r\n\r\n{", "HTTP/1.1 401 "],
    ["chunked incomplete body", "POST /v1/messages HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{", "HTTP/1.1 401 "],
    ["options small incomplete body keep-alive", "OPTIONS /v1/messages HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 128\r\n\r\n{", "HTTP/1.1 204 "],
    ["options chunked incomplete body keep-alive", "OPTIONS /v1/messages HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{", "HTTP/1.1 204 "],
    ["healthz small incomplete body keep-alive", "GET /healthz HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 128\r\n\r\n{", "HTTP/1.1 200 "],
    ["forged websocket upgrade header on healthz keep-alive", "GET /healthz HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 128\r\n\r\n{", "HTTP/1.1 200 "],
  ];
  for (const [name, raw, wantPrefix] of rows) {
    test(name, async () => {
      const server = createServer({ manager: fakeManager(), registry: new ModelRegistry(), host: "127.0.0.1", port: 0, apiKeys: ["test-key"] });
      const addr = startServer(server);
      const [hostname, port] = addr.split(":");
      let received = "";
      let gotStatus!: () => void;
      const statusLine = new Promise<void>((resolve) => (gotStatus = resolve));
      const socket = await Bun.connect({
        hostname: hostname!,
        port: Number(port),
        socket: {
          data(_socket, data) {
            received += new TextDecoder().decode(data);
            if (received.includes("\r\n")) gotStatus();
          },
          close() {
            gotStatus();
          },
        },
      });
      socket.write(raw.replace("%s", addr));
      await statusLine;
      socket.end();
      expect(received.startsWith(wantPrefix)).toBe(true);
    });
  }
});
