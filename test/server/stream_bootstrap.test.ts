// Ported from: sdk/api/handlers/handlers_stream_bootstrap_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_signature_test.go
// Ported from: sdk/api/handlers/openai/permanent_oauth_classification_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_compact_test.go
// Skipped cases: handlers_stream_bootstrap_test.go: TestExecuteStreamWithAuthManager_RetriesAfterDroppedBootstrapPayload
// (the dropped bootstrap payload comes from a plugin stream interceptor; plugins are not ported),
// TestExecuteStreamWithAuthManager_HomeBootstrapFailureDoesNotRedispatch (Home), the CPA trace-id half of
// TestExecuteStreamWithAuthManager_SelectedAuthCallbackReceivesAuthID (X-CPA-TRACE-ID is not ported),
// TestExecuteStreamWithPreFTKeepAlive_CancelWaitsForBootstrapGoroutine (pre-first-token keep-alives are not ported)
// and TestExecuteStreamWithAuthManager_ResolvesBootstrapRetryHeadersBeforeReturn (Go channel/goroutine ordering;
// the retry headers are checked in TestExecuteStreamWithAuthManager_RetriesBeforeFirstByte). The Go cases drive
// ExecuteStreamWithAuthManager with the chat handler type; here they run through POST /v1/responses with
// stream:true (OpenAI chat inbound is not ported) and the pinned/selected-auth cases through the manager's
// metadata keys, which is how the handlers pass them. The bootstrap retry is the manager's pre-first-byte
// failover, so streaming.bootstrap-retries has no separate switch. openai_responses_compact_test.go: only
// TestOpenAIResponsesCompactDecodesZstdRequestBody is ported here (the rest is in responses_handlers.test.ts).
import { describe, expect, test } from "bun:test";
import { AuthManagerError, SelectedAuthCallbackMetadataKey } from "../../src/auth/manager/index.ts";
import { PinnedAuthMetadataKey, type ExecOptions, type ProviderExecutor, type StreamResult } from "../../src/executor/types.ts";
import { createServer } from "../../src/server/server.ts";
import { chunkStream, newTestManager, registerFakeAuth, testAuth } from "./helpers.ts";

function responsesRequest(body: unknown, headers: Record<string, string> = {}, path = "/v1/responses"): Request {
  return new Request(`http://proxy.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

const completed = (id: string) => `event: response.completed\ndata: {"type":"response.completed","response":{"id":"${id}","status":"completed","output":[]}}\n\n`;

interface Scripted extends ProviderExecutor {
  calls: number;
  authIDs: string[];
}

function scripted(identifier: string, stream: (call: number, authID: string, opts: ExecOptions) => Promise<StreamResult> | StreamResult): Scripted {
  const exec: Scripted = {
    identifier,
    calls: 0,
    authIDs: [],
    execute: () => Promise.reject(new AuthManagerError("not_implemented", "Execute not implemented")),
    countTokens: () => Promise.reject(new AuthManagerError("not_implemented", "CountTokens not implemented")),
    refresh: async (auth) => auth,
    executeStream: async (auth, _req, opts) => {
      exec.calls++;
      exec.authIDs.push(auth.id);
      return stream(exec.calls, auth.id, opts);
    },
  };
  return exec;
}

const unauthorized = () => new AuthManagerError("unauthorized", "unauthorized", { httpStatus: 401 });

function setup(executor: Scripted, authIDs: string[], model = "test-model", passthroughHeaders = false) {
  const { manager, registry } = newTestManager();
  manager.registerExecutor(executor);
  for (const id of authIDs) {
    manager.register(testAuth({ id, provider: executor.identifier, metadata: { email: `${id}@example.com` } }));
    registry.registerClient(id, executor.identifier, [{ id: model, type: executor.identifier }]);
  }
  return { manager, registry, server: createServer({ manager, registry, passthroughHeaders }) };
}

const streamBody = (model = "test-model") => ({ model, input: "hi", stream: true });

describe("handlers_stream_bootstrap_test", () => {
  test("TestExecuteStreamWithAuthManager_RetriesBeforeFirstByte", async () => {
    const executor = scripted("codex", (call) =>
      call === 1 ? chunkStream([], unauthorized(), new Headers({ "X-Upstream-Attempt": "1" })) : chunkStream([completed("ok")], undefined, new Headers({ "X-Upstream-Attempt": "2" })),
    );
    const { server } = setup(executor, ["auth1", "auth2"], "test-model", true);
    const response = await server.fetch(responsesRequest(streamBody()));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`"id":"ok"`);
    expect(executor.calls).toBe(2);
    expect(response.headers.get("X-Upstream-Attempt")).toBe("2");
  });

  test("TestExecuteStreamWithAuthManager_HeaderPassthroughDisabledByDefault", async () => {
    const executor = scripted("codex", (call) =>
      call === 1 ? chunkStream([], unauthorized(), new Headers({ "X-Upstream-Attempt": "1" })) : chunkStream([completed("ok")], undefined, new Headers({ "X-Upstream-Attempt": "2" })),
    );
    const { server } = setup(executor, ["auth1", "auth2"]);
    const response = await server.fetch(responsesRequest(streamBody()));
    expect(await response.text()).toContain(`"id":"ok"`);
    expect(response.headers.get("X-Upstream-Attempt")).toBeNull();
  });

  test("TestExecuteStreamWithAuthManager_ResetsResponsesValidatorOnBootstrapRetry", async () => {
    const executor = scripted("bootstrap-test", (call) =>
      call === 1 ? chunkStream([`event: response.completed\ndata: {"type":"response.completed",`], unauthorized()) : chunkStream([`event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n`]),
    );
    const { server } = setup(executor, ["auth1", "auth2"], "bootstrap-model");
    const response = await server.fetch(responsesRequest(streamBody("bootstrap-model")));
    const text = await response.text();
    expect(executor.calls).toBe(2);
    expect(text).toContain("response.completed");
    expect(text).not.toContain(`"type":"error"`);
  });

  test("TestExecuteStreamWithAuthManager_CancelDuringSynchronousBootstrap", async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const executor = scripted("bootstrap-test", (_call, _id, opts) => {
      started();
      return {
        chunks: (async function* () {
          await new Promise<void>((_resolve, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true }));
          yield "";
        })(),
      };
    });
    const { server } = setup(executor, ["auth1"], "bootstrap-model");
    const controller = new AbortController();
    const pending = server.fetch(new Request("http://proxy.test/v1/responses", { method: "POST", body: JSON.stringify(streamBody("bootstrap-model")), signal: controller.signal }));
    await begun;
    controller.abort();
    const response = await pending;
    // The handler returns once the bootstrap is cancelled; nothing streams afterwards.
    const text = await response.text().catch(() => "");
    expect(text).not.toContain("response.completed");
  });

  test("TestExecuteStreamWithAuthManager_EmptyClosedStream", async () => {
    const executor = scripted("bootstrap-test", () => chunkStream([]));
    const { server } = setup(executor, ["auth1"], "bootstrap-model");
    const response = await server.fetch(responsesRequest(streamBody("bootstrap-model")));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toContain("response.completed");
  });

  test("TestExecuteStreamWithAuthManager_DoesNotRetryAfterFirstByte", async () => {
    const executor = scripted("codex", () => chunkStream([`event: response.created\ndata: {"type":"response.created","response":{"id":"partial"}}\n\n`], new AuthManagerError("upstream_closed", "upstream closed", { httpStatus: 502 })));
    const { server } = setup(executor, ["auth1", "auth2"]);
    const response = await server.fetch(responsesRequest(streamBody()));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(`"id":"partial"`);
    expect(text).toMatch(/"type":"(error|response\.failed)"/);
    expect(executor.calls).toBe(1);
  });

  test("TestExecuteStreamWithAuthManager_EnrichesBootstrapRetryAuthUnavailableError", async () => {
    const executor = scripted("codex", () => chunkStream([], unauthorized()));
    const { server } = setup(executor, ["auth1"]);
    const response = await server.fetch(responsesRequest(streamBody()));
    const text = await response.text();
    expect(text).not.toContain("response.completed");
    expect(executor.calls).toBe(1);
    // A lone credential failing with 401 surfaces the upstream status; asking again finds no
    // available credential and the error names the providers and model (Go: enrichAuthSelectionError).
    expect(response.status).toBe(401);
    const again = await server.fetch(responsesRequest(streamBody()));
    expect(again.status).toBe(503);
    const body = (await again.json()) as { error: { message: string } };
    expect(body.error.message).toContain("providers=codex");
    expect(body.error.message).toContain("model=test-model");
    expect(executor.calls).toBe(1);
  });

  test("TestExecuteStreamWithAuthManager_ForwardsOverloadErrorWhenAllAuthsOverloaded", async () => {
    const overloaded = `{"type":"error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","sequence_number":0}`;
    const executor = scripted("codex", () => Promise.reject(new AuthManagerError("server_is_overloaded", overloaded, { httpStatus: 503 })));
    const { manager, registry } = newTestManager();
    manager.registerExecutor(executor);
    for (const id of ["auth-overload-1", "auth-overload-2"]) {
      manager.register(testAuth({ id, provider: "codex", metadata: { email: `${id}@example.com` } }));
      registry.registerClient(id, "codex", [{ id: "gpt-5.6-sol", type: "codex" }]);
    }
    const server = createServer({ manager, registry });
    for (let i = 0; i < 2; i++) {
      // The second request finds both credentials cooling down and must still report the upstream reason.
      const response = await server.fetch(responsesRequest(streamBody("gpt-5.6-sol")));
      const text = await response.text();
      expect(text.includes("Our servers are currently overloaded. Please try again later.") || text.includes("server_is_overloaded")).toBe(true);
    }
  });

  test("TestExecuteStreamWithAuthManager_PinnedAuthKeepsSameUpstream", async () => {
    const executor = scripted("codex", (_call, authID) => (authID === "auth1" ? chunkStream([], unauthorized()) : chunkStream(["ok"])));
    const { manager } = setup(executor, ["auth1", "auth2"]);
    let failed = false;
    try {
      const result = await manager.executeStream(["codex"], { model: "test-model", payload: `{"model":"test-model"}`, format: "openai-response" }, { stream: true, metadata: { [PinnedAuthMetadataKey]: "auth1" } });
      for await (const chunk of result.chunks) expect(chunk).not.toBe("ok");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(executor.authIDs.length).toBeGreaterThan(0);
    for (const id of executor.authIDs) expect(id).toBe("auth1");
  });

  test("TestExecuteStreamWithAuthManager_SelectedAuthCallbackReceivesAuthID (callback half)", async () => {
    const executor = scripted("codex", () => chunkStream(["ok"]));
    const { manager } = setup(executor, ["auth2"]);
    let selected = "";
    const result = await manager.executeStream(["codex"], { model: "test-model", payload: `{"model":"test-model"}`, format: "openai-response" }, { stream: true, metadata: { [SelectedAuthCallbackMetadataKey]: (id: string) => (selected = id) } });
    let got = "";
    for await (const chunk of result.chunks) got += chunk;
    expect(got).toBe("ok");
    expect(selected).toBe("auth2");
  });

  test("TestExecuteStreamWithAuthManager_ValidatesOpenAIResponsesStreamDataJSON", async () => {
    const executor = scripted("codex", () => chunkStream([`event: response.completed\ndata: {"type"`]));
    const { server } = setup(executor, ["auth1"]);
    const response = await server.fetch(responsesRequest(streamBody()));
    const text = await response.text();
    // The truncated frame never reaches the client as a completed response.
    expect(text).not.toContain(`event: response.completed\ndata: {"type"\n`);
    expect(response.status === 502 || /"type":"(error|response\.failed)"/.test(text)).toBe(true);
  });

  test("TestExecuteStreamWithAuthManager_AllowsSplitOpenAIResponsesSSEEventLines", async () => {
    const executor = scripted("split-sse", () => chunkStream(["event: response.completed", `data: {"type":"response.completed","response":{"id":"resp-1","output":[]}}`]));
    const { server } = setup(executor, ["auth1"]);
    const response = await server.fetch(responsesRequest(streamBody()));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.completed");
    expect(text).toContain(`data: {"type":"response.completed","response":{"id":"resp-1","output":[]}}`);
    expect(text).not.toMatch(/"type":"(error|response\.failed)"/);
  });
});

describe("openai_responses_signature_test", () => {
  function captureExecutor() {
    const captured: { calls: number; alt?: string } = { calls: 0 };
    const executor: ProviderExecutor = {
      identifier: "codex",
      execute: async (_auth, _req, opts) => {
        captured.calls++;
        captured.alt = opts.alt;
        return { payload: `{"ok":true}` };
      },
      executeStream: () => Promise.reject(new Error("not implemented")),
      countTokens: () => Promise.reject(new Error("not implemented")),
      refresh: async (auth) => auth,
    };
    return { executor, captured };
  }

  test("TestOpenAIResponsesForwardsInvalidReasoningEncryptedContentToExecutor", async () => {
    const { manager, registry } = newTestManager();
    const { executor, captured } = captureExecutor();
    manager.registerExecutor(executor);
    registerFakeAuth(manager, registry, "signature-auth-responses", "codex", "test-signature-model");
    const server = createServer({ manager, registry });
    const body = `{"model":"test-signature-model","stream":false,"input":[{"id":"rs_bad","type":"reasoning","encrypted_content":"gAAAAABqFTIa\\u2026abc","summary":[]}]}`;
    const response = await server.fetch(responsesRequest(body));
    expect(response.status).toBe(200);
    expect(captured.calls).toBe(1);
  });

  test("TestOpenAIResponsesCompactForwardsInvalidReasoningEncryptedContentToExecutor", async () => {
    const { manager, registry } = newTestManager();
    const { executor, captured } = captureExecutor();
    manager.registerExecutor(executor);
    registerFakeAuth(manager, registry, "signature-auth-compact", "codex", "test-signature-compact-model");
    const server = createServer({ manager, registry });
    const body = `{"model":"test-signature-compact-model","input":[{"id":"rs_bad","type":"reasoning","encrypted_content":"bad","summary":[]}]}`;
    const response = await server.fetch(responsesRequest(body, {}, "/v1/responses/compact"));
    expect(response.status).toBe(200);
    expect(captured.calls).toBe(1);
    expect(captured.alt).toBe("responses/compact");
  });

  test("TestOpenAIResponsesCompactDecodesZstdRequestBody", async () => {
    const { manager, registry } = newTestManager();
    const { executor, captured } = captureExecutor();
    manager.registerExecutor(executor);
    registerFakeAuth(manager, registry, "auth3", "codex", "test-model");
    const server = createServer({ manager, registry });
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(`{"model":"test-model","input":"hello"}`));
    const response = await server.fetch(new Request("http://proxy.test/v1/responses/compact", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "zstd" }, body: compressed }));
    expect(response.status).toBe(200);
    expect(captured.calls).toBe(1);
    expect(captured.alt).toBe("responses/compact");
    expect((await response.text()).trim()).toBe(`{"ok":true}`);
  });
});

test("TestReproPermanentOAuthFailureClassification", async () => {
  const reproOAuthMessage = `token refresh failed with status 401: {"error":{"message":"Refresh credential has already been consumed; sign in again.","type":"invalid_request_error","code":"refresh_token_reused"}}`;
  for (const stream of [false, true]) {
    const model = `repro-permanent-oauth-${stream}`;
    const { manager, registry } = newTestManager();
    let calls = 0;
    const executor: ProviderExecutor = {
      identifier: "codex",
      execute: async () => {
        calls++;
        return { payload: `{"id":"resp-fixture","object":"response","status":"completed","output":[]}` };
      },
      executeStream: async () => {
        calls++;
        return chunkStream([`event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-fixture","object":"response","status":"completed","output":[]}}\n\n`]);
      },
      countTokens: () => Promise.reject(new Error("unused fixture method")),
      refresh: () => Promise.reject(new Error(reproOAuthMessage)),
    };
    manager.registerExecutor(executor);
    manager.register(
      testAuth({
        id: `failed-${model}`,
        provider: "codex",
        status: "error",
        unavailable: true,
        statusMessage: "unauthorized",
        lastError: { code: "unauthorized", message: reproOAuthMessage, retryable: false, httpStatus: 401 },
        metadata: { access_token: "expired-fixture", expired: new Date(Date.parse("2026-10-28T11:00:00Z")).toISOString() },
      }),
    );
    registry.registerClient(`failed-${model}`, "codex", [{ id: model, type: "codex" }]);
    const server = createServer({ manager, registry });
    const request = () => server.fetch(responsesRequest({ model, input: "fixture", stream }, { "User-Agent": "codex_cli_rs/0.153.4" }));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const got = await request();
      const payload = (await got.json()) as { error: { code: string; type: string; message: string; retryable?: boolean } };
      expect(got.status).toBe(503);
      expect(payload.error.type).toBe("authentication_error");
      expect(payload.error.code).toBe("upstream_authentication_required");
      expect(payload.error.retryable).toBe(false);
      expect(payload.error.message).toContain("refresh_token_reused");
      expect(payload.error.message).toContain("[REDACTED]");
    }
    expect(calls).toBe(0);

    // A healthy candidate makes the same route succeed.
    manager.register(testAuth({ id: `healthy-${model}`, provider: "codex" }));
    registry.registerClient(`healthy-${model}`, "codex", [{ id: model, type: "codex" }]);
    const control = await request();
    expect(control.status).toBe(200);
    expect(calls).toBe(1);
  }
});
