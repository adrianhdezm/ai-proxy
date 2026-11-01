// Ported from: internal/runtime/executor/codex_websockets_executor_test.go
// Ported from: internal/runtime/executor/codex_websockets_interrupt_test.go
// Ported from: internal/runtime/executor/codex_websockets_active_response_test.go
// Ported from: internal/runtime/executor/codex_websockets_error_terminal_test.go
// Ported from: internal/runtime/executor/codex_websockets_executor_store_test.go
// Ported from: internal/runtime/executor/websocket_upstream_disconnect_test.go
// Ported from: internal/runtime/executor/websocket_session_target_test.go
// Ported from: internal/runtime/executor/codex_websockets_write_loss_test.go
// Ported from: sdk/cliproxy/executor/websocket_test.go
// Skipped cases: BenchmarkBuildCodexWebsocketRequestBodyLargePayload (benchmark),
//   TestCodexWebsocketsExecuteRestoresClaudeAgentReasoningReplay (Claude prompt-cache / agent replay scope of the
//   websocket path is covered by the HTTP replay tests), the TestApplyCodexPromptCacheHeaders* cases other than
//   SetsSessionIDAndLegacyConversation (derived / Claude session prompt-cache keys not ported),
//   TestCodexWebsocketUpgradeFallbackLocalErrorDoesNotMarkUpstreamAttempt and the UpstreamAttempted assertions
//   (upstream attempt tracker not ported), TestMapCodexWebsocketWriteError* (gorilla write errors; the Bun client
//   reports closes, covered by MapsMessageTooBigClose), TestApplyCodexHeaders*/TestApplyModelHeaderOverrides*
//   (HTTP header helpers, covered by the HTTP executor tests), TestNewProxyAwareWebsocketDialerDirectDisablesProxy
//   (gorilla dialer), every lifecycle / Home / SIWC / xAI case (TestCodexWebsocketUpgradeRequiredDoesNotFallbackToHTTPWithLifecycle,
//   TestCodexWebsocketTerminalFailureInvalidatesRetainedLifecycle, TestCodexWebsocket*LifecycleBindFailure*,
//   TestWebsocketSessionCloseEndsRetainedLifecycleOnce, TestSessionlessWebsocketSelectionEndAndDirectCloseRaceClosesOnce,
//   TestWebsocketDrainDuringBindClosesOwnedConnectionOnce, TestWebsocketTargetReplacementPhysicallyClosesOwnedConnectionOnce,
//   TestWebsocketLifecycleEndThenInvalidateAndCloseAllPhysicallyClosesOnce, TestAuditAccountedCodexXAIReconnectReuseAndTargetChange,
//   TestHomeSelectionRegistryDrainClosesRealWebsocketSessions, TestAuditHomeCodex426WebsocketToHTTPFreshSelection,
//   TestWebsocketRegistryDrainClosesAndEndsRetainedSession, TestManagerRegisterExecutor_PreservesSharedWebsocketSessionsAcrossExecutorReplacement),
//   TestCodexWebsocketsExecute*ObservesWebSocketResponseEvents (response event observers not ported),
//   TestCodexWebsocketsExecute*HandshakeUsageLimitReachedSetsRetryAfter (Bun's client does not expose a rejected
//   handshake's body), the ping/pong/chunked-write/logging cases TestCodexWebsockets_PingHandlerDoesNotBlockOnWriteMu,
//   _KeepalivePingDuringUpload_*, _ChunkedWriteAllowsPongInterleaving, _PingLoggingRedacted, _SendErrorLogsSessionObject
//   (Bun's client answers pings itself and writes whole messages), TestClearRetryActiveStateClearsOriginalConnection /
//   TestWebsocketRetryBindFailureClearsActiveSessionState (lifecycle retry binding), TestWebsocketExecutorsReconnectWhenSessionTargetChanges
//   (xAI half; the Codex half is the target-change case below), and TestCodexWebsocketInvalidatePublishesLossEpochBeforeReleasingConnLock
//   (lock ordering has no equivalent on one thread; the epoch half is covered by the transport-loss case below).
import { afterAll, describe, expect, test } from "bun:test";
import { AuthManager } from "../../../src/auth/manager/index.ts";
import { newAuth, type Auth } from "../../../src/auth/types.ts";
import { CodexReasoningReplayCache } from "../../../src/cache/codex_reasoning_replay_cache.ts";
import { codexOriginator, codexUserAgent, sanitizeCodexInputItemIDs } from "../../../src/executor/codex/index.ts";
import {
  CloseAllExecutionSessionsID,
  CodexAutoExecutor,
  CodexWebsocketConn,
  CodexWebsocketSession,
  CodexWebsocketSessionStore,
  CodexWebsocketsExecutor,
  ExecutionSessionMetadataKey,
  NoActiveUpstreamWebsocketError,
  UpstreamWebsocketInterruptRejectedError,
  UpstreamWebsocketReplayRequiredError,
  UpstreamWebsocketTurnError,
  WebsocketContextMetadataKey,
  type WebSocketLike,
  type WebsocketExecutionContext,
  applyCodexPromptCacheHeaders,
  applyCodexWebsocketHeaders,
  buildCodexResponsesWebsocketURL,
  clearCodexReasoningReplayOnWebsocketError,
  codexResponsesWebsocketBetaHeaderValue,
  codexWebsocketsEnabled,
  dialBunCodexWebsocket,
  frameCodexWebsocketRequestBody,
  invalidateUpstreamConn,
  isTerminalEvent,
  isUpstreamWebsocketReplayRequired,
  parseCodexWebsocketError,
  startUpstreamReader,
} from "../../../src/executor/codex/websockets/index.ts";
import { StatusError, type ExecOptions } from "../../../src/executor/types.ts";
import { drain, getString, getValue } from "./helpers.ts";
import { codexTurnEvents, eventually, startFakeCodexWebsocket } from "./websocket_helpers.ts";

function wsAuth(baseURL: string, id = "codex-test", extra: Record<string, string> = {}): Auth {
  return newAuth({ id, provider: "codex", attributes: { api_key: "sk-test", base_url: baseURL, ...extra } });
}

function executor(extra: ConstructorParameters<typeof CodexWebsocketsExecutor>[0] = {}): CodexWebsocketsExecutor {
  return new CodexWebsocketsExecutor({ disableImageGeneration: true, store: new CodexWebsocketSessionStore(), ...extra });
}

function responsesOptions(extra: Partial<ExecOptions> = {}, metadata: Record<string, unknown> = {}): ExecOptions {
  return { stream: true, sourceFormat: "openai-response", responseFormat: "openai-response", metadata: { ...metadata }, ...extra } as ExecOptions;
}

function downstreamContext(extra: Partial<WebsocketExecutionContext> = {}): Record<string, unknown> {
  return { [WebsocketContextMetadataKey]: { downstreamWebsocket: true, ...extra } satisfies WebsocketExecutionContext };
}

/** A connection over a WebSocket double that is open and records sends. */
function fakeConn(): { conn: CodexWebsocketConn; sent: string[] } {
  const sent: string[] = [];
  const ws: WebSocketLike = {
    readyState: 1,
    send: (data: string) => {
      sent.push(data);
    },
    close: () => {},
    addEventListener: () => {},
  };
  return { conn: new CodexWebsocketConn(ws), sent };
}

const helloInput = `{"model":"gpt-5-codex","input":[{"type":"message","role":"user","content":"hello"}]}`;

describe("request body", () => {
  test("TestBuildCodexWebsocketRequestBodyPreservesPreviousResponseID", () => {
    const body = `{"model":"gpt-5-codex","previous_response_id":"resp-1","input":[{"type":"message","id":"msg-1"}]}`;
    const ws = frameCodexWebsocketRequestBody(sanitizeCodexInputItemIDs(body));
    expect(getString(ws, "type")).toBe("response.create");
    expect(getString(ws, "previous_response_id")).toBe("resp-1");
    expect(getString(ws, "input.0.id")).toBe("msg-1");
  });

  test("TestBuildCodexWebsocketRequestBodySanitizesOverlongInputItemIDs", () => {
    const longReasoningItemID = "rs_" + "a".repeat(64);
    const longCallItemID = "grok-call-item-".repeat(6);
    const longOutputItemID = "grok-output-item-".repeat(6);
    const body = `{"model":"gpt-5-codex","input":[{"type":"reasoning","id":"${longReasoningItemID}","encrypted_content":"gAAAA-encrypted","summary":[]},{"type":"function_call","id":"${longCallItemID}","call_id":"call-1","name":"lookup"},{"type":"function_call_output","id":"${longOutputItemID}","call_id":"call-1","output":"ok"},{"type":"message","id":"item_74ec40c883248ebb4885ec84"}]}`;
    const first = frameCodexWebsocketRequestBody(sanitizeCodexInputItemIDs(body));
    const second = frameCodexWebsocketRequestBody(sanitizeCodexInputItemIDs(body));
    expect((getValue(first, "input") as unknown[]).length).toBe(3);
    expect(getString(first, "input.0.type")).toBe("function_call");
    const shortCall = getString(first, "input.0.id");
    const shortOutput = getString(first, "input.1.id");
    expect([...shortCall].length).toBeLessThanOrEqual(64);
    expect(shortCall).not.toBe(longCallItemID);
    expect([...shortOutput].length).toBeLessThanOrEqual(64);
    expect(shortCall).not.toBe(shortOutput);
    expect(getString(second, "input.0.id")).toBe(shortCall);
    expect(getString(first, "input.0.call_id")).toBe("call-1");
    expect(getString(first, "input.1.call_id")).toBe("call-1");
    expect(getString(first, "input.2.id")).toBe("msg_item_74ec40c883248ebb4885ec84");
  });

  test("TestBuildCodexResponsesWebsocketURLRequiresHTTPURL", () => {
    expect(buildCodexResponsesWebsocketURL("https://example.com/backend/responses")).toBe("wss://example.com/backend/responses");
    expect(() => buildCodexResponsesWebsocketURL("ftp://example.com/responses")).toThrow();
    expect(() => buildCodexResponsesWebsocketURL("https:///responses")).toThrow();
  });

  test("TestApplyCodexPromptCacheHeadersSetsSessionIDAndLegacyConversation", () => {
    const { headers } = applyCodexPromptCacheHeaders("openai-response", { model: "gpt-5-codex", payload: `{"prompt_cache_key":"cache-1"}`, format: "openai-response" }, `{"model":"gpt-5-codex"}`);
    expect(headers.get("session_id")).toBe("cache-1");
    expect(headers.get("Session-Id")).toBeNull();
    expect(headers.get("Conversation_id")).toBe("cache-1");
  });
});

describe("parseCodexWebsocketError", () => {
  test("TestParseCodexWebsocketErrorMarksConnectionLimitRetryable", () => {
    const err = parseCodexWebsocketError(`{"type":"error","status":429,"error":{"code":"websocket_connection_limit_reached","message":"too many websockets"},"headers":{"retry-after":"1"}}`)!;
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(0);
    expect(err.headers?.get("retry-after")).toBe("1");
  });

  test("TestParseCodexWebsocketErrorUsesUsageLimitRetryMetadata", () => {
    const err = parseCodexWebsocketError(`{"type":"error","status":429,"body":{"error":{"type":"usage_limit_reached","message":"usage limit reached","resets_in_seconds":7}}}`)!;
    expect(err.retryAfterMs).toBe(7000);
    expect(err.credentialScoped).toBe(true);
  });

  test("TestParseCodexWebsocketErrorPreservesWrappedBodyAndHeaders", () => {
    const err = parseCodexWebsocketError(`{"type":"error","status":429,"body":{"error":{"code":"websocket_connection_limit_reached","type":"server_error","message":"too many websocket connections"}},"headers":{"x-request-id":"req-1"}}`)!;
    expect(getValue(err.message, "status")).toBe(429);
    expect(getString(err.message, "body.error.code")).toBe("websocket_connection_limit_reached");
    expect(getString(err.message, "error.code")).toBe("websocket_connection_limit_reached");
    expect(err.retryAfterMs).toBe(0);
    expect(err.headers?.get("x-request-id")).toBe("req-1");
  });

  test("events without a status are not websocket errors", () => {
    expect(parseCodexWebsocketError(`{"type":"error","error":{"message":"x"}}`)).toBeUndefined();
    expect(parseCodexWebsocketError(`{"type":"response.completed"}`)).toBeUndefined();
  });

  test("TestClearCodexReasoningReplayOnWebsocketInvalidSignature", () => {
    const cache = new CodexReasoningReplayCache();
    const scope = { modelName: "gpt-5.4", sessionKey: "claude:ws-invalid:agent:main", requestFingerprint: "" };
    const bytes = new Uint8Array(1 + 8 + 16 + 16 + 32);
    bytes[0] = 0x80;
    for (let i = 9; i < bytes.length; i++) bytes[i] = (32 + i) & 0xff;
    const encrypted = Buffer.from(bytes).toString("base64url");
    expect(cache.cacheItem(scope.modelName, scope.sessionKey, `{"type":"reasoning","summary":[],"content":null,"encrypted_content":"${encrypted}"}`)).toBe(true);
    clearCodexReasoningReplayOnWebsocketError(cache, scope, `{"type":"error","status":400,"body":{"error":{"message":"Invalid signature in thinking block","type":"invalid_request_error","code":"invalid_request_error"}}}`);
    expect(cache.getItem(scope.modelName, scope.sessionKey)).toBeUndefined();
  });
});

describe("applyCodexWebsocketHeaders", () => {
  test("TestApplyCodexWebsocketHeadersDefaultsToCurrentResponsesBeta", () => {
    const headers = applyCodexWebsocketHeaders(new Headers(), undefined, "", undefined, false, undefined);
    expect(headers.get("OpenAI-Beta")).toBe(codexResponsesWebsocketBetaHeaderValue);
    expect(headers.get("User-Agent")).toBe(codexUserAgent);
    expect(codexUserAgent.startsWith(codexOriginator + "/")).toBe(true);
    expect(headers.get("Originator")).toBe(codexOriginator);
    for (const name of ["Version", "x-codex-beta-features", "X-Codex-Turn-Metadata", "X-Client-Request-Id"]) expect(headers.get(name)).toBeNull();
  });

  for (const [name, auth, token] of [
    ["OAuth", newAuth({ id: "a", provider: "codex", attributes: { "header:User-Agent": "custom-ua", "header:Originator": "custom-origin" } }), ""],
    ["API key", newAuth({ id: "b", provider: "codex", attributes: { api_key: "sk-test", "header:User-Agent": "custom-ua", "header:Originator": "custom-origin" } }), "sk-test"],
  ] as const) {
    test(`TestApplyCodexWebsocketHeadersDefaultsToCodexCloaking/${name}`, () => {
      const headers = new Headers({ "User-Agent": "existing-ua", Originator: "existing-origin" });
      const client = new Headers({ "User-Agent": "client-ua", Originator: "client-origin" });
      const got = applyCodexWebsocketHeaders(headers, auth, token, { headerDefaults: { userAgent: "config-ua" } }, false, client);
      expect(got.get("User-Agent")).toBe(codexUserAgent);
      expect(got.get("Originator")).toBe(codexOriginator);
    });
  }

  const oauth = newAuth({ id: "oauth", provider: "codex", metadata: { email: "user@example.com" } });
  const noCloak = { disableCloaking: true };

  for (const [name, client, wantSession, wantThread] of [
    ["both session and thread present", { "Session-Id": "sess-both", "Thread-Id": "thread-both" }, "sess-both", "thread-both"],
    ["only session present", { "Session-Id": "sess-only" }, "sess-only", ""],
    ["only thread present", { "Thread-Id": "thread-only" }, "", "thread-only"],
    ["neither present", {}, "", ""],
  ] as const) {
    for (const withCacheAliases of [false, true]) {
      test(`TestApplyCodexWebsocketHeadersNativeSessionCombinations/${name}/cache_aliases=${withCacheAliases}`, () => {
        const initial = withCacheAliases ? new Headers({ session_id: "cache-alias", Conversation_id: "cache-alias" }) : new Headers();
        const got = applyCodexWebsocketHeaders(initial, oauth, "", noCloak, true, new Headers(client));
        expect(got.get("Session-Id") ?? "").toBe(wantSession);
        expect(got.get("Thread-Id") ?? "").toBe(wantThread);
        expect(got.get("session_id")).toBeNull();
        expect(got.get("conversation_id")).toBeNull();
      });
    }
  }

  test("TestApplyCodexWebsocketHeadersCanonicalizesLegacyUnderscoreSessionHeader", () => {
    const client = new Headers({ Originator: "Codex Desktop", "User-Agent": "codex_cli_rs/0.1.0", Session_id: "legacy-underscore-session" });
    const got = applyCodexWebsocketHeaders(new Headers(), oauth, "", undefined, false, client);
    expect(got.get("session_id")).toBe("legacy-underscore-session");
    expect(got.get("Session-Id")).toBeNull();
  });

  test("TestApplyCodexWebsocketHeadersUsesConfigDefaultsForOAuth", () => {
    const got = applyCodexWebsocketHeaders(new Headers(), oauth, "", { disableCloaking: true, headerDefaults: { userAgent: "my-codex-client/1.0", betaFeatures: "feature-a,feature-b" } }, false, undefined);
    expect(got.get("User-Agent")).toBe("my-codex-client/1.0");
    expect(got.get("x-codex-beta-features")).toBe("feature-a,feature-b");
    expect(got.get("OpenAI-Beta")).toBe(codexResponsesWebsocketBetaHeaderValue);
  });

  test("TestApplyCodexWebsocketHeadersPrefersExistingHeadersOverClientAndConfig", () => {
    const headers = new Headers({ "User-Agent": "existing-ua", "X-Codex-Beta-Features": "existing-beta" });
    const client = new Headers({ "User-Agent": "client-ua", "X-Codex-Beta-Features": "client-beta" });
    const got = applyCodexWebsocketHeaders(headers, oauth, "", { disableCloaking: true, headerDefaults: { userAgent: "config-ua", betaFeatures: "config-beta" } }, false, client);
    expect(got.get("User-Agent")).toBe("existing-ua");
    expect(got.get("x-codex-beta-features")).toBe("existing-beta");
  });

  test("TestApplyCodexWebsocketHeadersConfigUserAgentOverridesClientHeader", () => {
    const client = new Headers({ "User-Agent": "client-ua", "X-Codex-Beta-Features": "client-beta" });
    const got = applyCodexWebsocketHeaders(new Headers(), oauth, "", { disableCloaking: true, headerDefaults: { userAgent: "config-ua", betaFeatures: "config-beta" } }, false, client);
    expect(got.get("User-Agent")).toBe("config-ua");
    expect(got.get("x-codex-beta-features")).toBe("client-beta");
  });

  test("TestApplyCodexWebsocketHeadersIgnoresConfigForAPIKeyAuth", () => {
    const auth = newAuth({ id: "k", provider: "codex", attributes: { api_key: "sk-test" } });
    const got = applyCodexWebsocketHeaders(new Headers(), auth, "sk-test", { disableCloaking: true, headerDefaults: { userAgent: "config-ua", betaFeatures: "config-beta" } }, false, undefined);
    expect(got.get("User-Agent")).toBeNull();
    expect(got.get("x-codex-beta-features")).toBeNull();
    expect(got.get("Originator")).toBeNull();
    expect(got.get("Authorization")).toBe("Bearer sk-test");
  });

  test("TestApplyCodexWebsocketHeadersPreservesExplicitAPIKeyUserAgent", () => {
    const auth = newAuth({ id: "k", provider: "codex", attributes: { api_key: "sk-test" } });
    const got = applyCodexWebsocketHeaders(new Headers(), auth, "sk-test", { disableCloaking: true }, false, new Headers({ "User-Agent": "api-key-client/1.0", Originator: "explicit-origin" }));
    expect(got.get("User-Agent")).toBe("api-key-client/1.0");
    expect(got.get("Originator")).toBe("explicit-origin");
  });

  test("TestApplyCodexWebsocketHeadersUsesCanonicalAccountHeader", () => {
    const auth = newAuth({ id: "o", provider: "codex", metadata: { account_id: "acct-1" } });
    expect(applyCodexWebsocketHeaders(new Headers(), auth, "", undefined, false, undefined).get("ChatGPT-Account-ID")).toBe("acct-1");
  });

  test("TestApplyCodexWebsocketHeaders_EmptyAPIKey_OmitsAuthorizationAndOAuthHeaders", () => {
    const auth = newAuth({ id: "e", provider: "codex", attributes: { auth_kind: "apikey", base_url: "https://custom-codex.example.com" }, metadata: { account_id: "acc-ws-123" } });
    const got = applyCodexWebsocketHeaders(new Headers(), auth, "", { disableCloaking: true, headerDefaults: { userAgent: "oauth-default-ua", betaFeatures: "oauth-beta" } }, false, undefined);
    expect(got.get("Authorization")).toBeNull();
    expect(got.get("ChatGPT-Account-ID")).toBeNull();
    expect(got.get("Originator")).toBeNull();
    expect(got.get("x-codex-beta-features")).toBeNull();
    expect(got.get("User-Agent")).not.toBe("oauth-default-ua");
  });
});

describe("execute / executeStream over a fake upstream", () => {
  const completedEmpty = `{"type":"response.completed","response":{"id":"resp-1","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}`;
  const upstream = startFakeCodexWebsocket({
    onMessage(conn) {
      conn.send(completedEmpty);
    },
  });
  afterAll(() => upstream.close());

  test("TestCodexWebsocketsExecuteResponsesLiteDoesNotInjectImageGenerationTool", async () => {
    const exec = new CodexWebsocketsExecutor({ store: new CodexWebsocketSessionStore() });
    const auth = wsAuth(upstream.url, "lite", { plan_type: "pro" });
    const payload = `{"model":"gpt-5.6-sol","input":[{"type":"additional_tools","role":"developer","tools":[{"type":"custom","name":"exec"}]},{"role":"user","content":"hello"}],"parallel_tool_calls":true,"client_metadata":{"ws_request_header_x_openai_internal_codex_responses_lite":"true"}}`;
    const before = upstream.connections.length;
    await exec.execute(auth, { model: "gpt-5.6-sol", payload, format: "codex" }, { stream: false, sourceFormat: "codex" } as ExecOptions);
    const sent = await upstream.connections[before]!.message(0);
    expect(getValue(sent, "instructions")).toBeUndefined();
    expect(getValue(sent, "tools")).toBeUndefined();
    expect(getString(sent, "input.0.type")).toBe("additional_tools");
    expect(getString(sent, "client_metadata.ws_request_header_x_openai_internal_codex_responses_lite")).toBe("true");
    expect(getValue(sent, "parallel_tool_calls")).toBe(false);
  });

  test("TestCodexWebsocketsExecuteStreamResponsesLiteForcesParallelToolCallsFalse", async () => {
    const exec = new CodexWebsocketsExecutor({ store: new CodexWebsocketSessionStore() });
    const payload = `{"model":"gpt-5.6-luna","input":[{"type":"additional_tools","role":"developer","tools":[{"type":"custom","name":"exec"}]},{"role":"user","content":"hello"}],"parallel_tool_calls":true,"client_metadata":{"ws_request_header_x_openai_internal_codex_responses_lite":"true"}}`;
    const before = upstream.connections.length;
    const result = await exec.executeStream(wsAuth(upstream.url, "lite", { plan_type: "pro" }), { model: "gpt-5.6-luna", payload, format: "codex" }, { stream: true, sourceFormat: "codex" } as ExecOptions);
    const { error } = await drain(result);
    expect(error).toBeUndefined();
    expect(getValue(await upstream.connections[before]!.message(0), "parallel_tool_calls")).toBe(false);
  });

  test("TestCodexWebsocketsExecutePreservesPreviousResponseIDUpstream", async () => {
    const exec = executor();
    const before = upstream.connections.length;
    const payload = `{"model":"gpt-5-codex","previous_response_id":"resp-1","input":[{"type":"message","id":"msg-1"}]}`;
    await exec.execute(wsAuth(upstream.url), { model: "gpt-5-codex", payload, format: "codex" }, { stream: false, sourceFormat: "codex" } as ExecOptions);
    const conn = upstream.connections[before]!;
    expect(conn.path).toBe("/responses");
    const sent = await conn.message(0);
    expect(getString(sent, "type")).toBe("response.create");
    expect(getString(sent, "previous_response_id")).toBe("resp-1");
  });

  test("TestCodexWebsocketsExecuteStreamPassesThroughUpstreamWebsocketPayloadForDownstreamWebsocket", async () => {
    const delta = `{"type":"response.output_text.delta","delta":"hello"}`;
    const server = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.send(delta);
        conn.send(completedEmpty);
      },
    });
    try {
      const exec = executor();
      const payload = `{"model":"prolite/gpt-5-codex","input":[{"type":"additional_tools","role":"developer","tools":[{"type":"custom","name":"exec"}]},{"type":"message","role":"user","content":"hello"}],"parallel_tool_calls":true}`;
      const result = await exec.executeStream(wsAuth(server.url), { model: "gpt-5-codex", payload, format: "openai-response" }, responsesOptions({}, downstreamContext()));
      const { chunks, error } = await drain(result);
      expect(error).toBeUndefined();
      expect(chunks[0]!.trim()).toBe(delta);
      const sent = await server.connections[0]!.message(0);
      expect(getString(sent, "model")).toBe("gpt-5-codex");
      expect(getValue(sent, "parallel_tool_calls")).toBe(true);
    } finally {
      server.close();
    }
  });

  test("TestCodexWebsocketsExecuteStreamPropagatesUpstreamErrorForDownstreamWebsocket", async () => {
    const server = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.send(`{"type":"error","status":429,"error":{"code":"websocket_connection_limit_reached","message":"too many websockets"}}`);
      },
    });
    try {
      const result = await executor().executeStream(wsAuth(server.url), { model: "gpt-5-codex", payload: helloInput, format: "openai-response" }, responsesOptions({}, downstreamContext()));
      const { chunks, error } = await drain(result);
      expect(chunks).toEqual([]);
      expect(error).toBeInstanceOf(StatusError);
      expect((error as StatusError).statusCode).toBe(429);
    } finally {
      server.close();
    }
  });

  test("TestCodexWebsocketsExecuteStreamMapsMessageTooBigClose", async () => {
    const server = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.close(1009, "message too big");
      },
    });
    try {
      const result = await executor().executeStream(wsAuth(server.url), { model: "gpt-5-codex", payload: helloInput, format: "openai-response" }, responsesOptions());
      const { error } = await drain(result);
      expect(error).toBeInstanceOf(StatusError);
      expect((error as StatusError).statusCode).toBe(413);
      expect(getString((error as StatusError).message, "error.code")).toBe("message_too_big");
      expect((error as StatusError).requestScoped).toBe(true);
    } finally {
      server.close();
    }
  });

  test("TestCodexWebsocketsExecuteStreamUpgradeRequiredReturnsWithoutLockingSession", async () => {
    let attempts = 0;
    const server = startFakeCodexWebsocket({
      reject() {
        attempts++;
        return new Response(`{"error":{"message":"websocket unavailable"}}`, { status: 426 });
      },
    });
    try {
      const exec = executor();
      const opts = responsesOptions({}, { ...downstreamContext(), [ExecutionSessionMetadataKey]: "ws-upgrade-required-session" });
      for (const payload of [`{"model":"gpt-5.4","generate":false,"input":[]}`, `{"model":"gpt-5.4","previous_response_id":"resp-1","input":[{"type":"message","id":"msg-2"}]}`]) {
        const err = await exec.executeStream(wsAuth(server.url), { model: "gpt-5.4", payload, format: "openai-response" }, opts).then(
          () => undefined,
          (e) => e,
        );
        expect(err).toBeInstanceOf(StatusError);
        expect((err as StatusError).statusCode).toBe(426);
      }
      expect(attempts).toBe(2);
      exec.closeExecutionSession("ws-upgrade-required-session");
    } finally {
      server.close();
    }
  });

  test("TestCodexWebsocketsExecuteStreamHandshakeErrorReturnsWithoutLockingSession", async () => {
    const server = startFakeCodexWebsocket({ reject: () => new Response(`{"error":{"message":"unauthorized"}}`, { status: 401 }) });
    try {
      const exec = executor();
      const opts = responsesOptions({}, { [ExecutionSessionMetadataKey]: "ws-handshake-error-session" });
      for (let i = 0; i < 2; i++) {
        const err = await exec.executeStream(wsAuth(server.url), { model: "gpt-5.4", payload: `{"model":"gpt-5.4","input":[{"type":"message","id":"msg-1"}]}`, format: "openai-response" }, opts).then(
          () => undefined,
          (e) => e,
        );
        expect((err as StatusError).statusCode).toBe(401);
      }
      exec.closeExecutionSession("ws-handshake-error-session");
    } finally {
      server.close();
    }
  });

  test("a 426 handshake falls back to HTTP outside a downstream websocket", async () => {
    const server = startFakeCodexWebsocket({ reject: () => new Response("upgrade required", { status: 426 }) });
    let httpCalls = 0;
    try {
      const exec = new CodexWebsocketsExecutor({
        disableImageGeneration: true,
        store: new CodexWebsocketSessionStore(),
        fetch: async () => {
          httpCalls++;
          return new Response(`data: ${completedEmpty}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
        },
      });
      const result = await exec.executeStream(wsAuth(server.url), { model: "gpt-5.4", payload: helloInput, format: "openai-response" }, responsesOptions());
      const { chunks, error } = await drain(result);
      expect(error).toBeUndefined();
      expect(chunks.join("")).toContain("response.completed");
      expect(httpCalls).toBe(1);
    } finally {
      server.close();
    }
  });

  test("TestCodexWebsocketZeroTokenIncompleteReleasesSessionRequestLock", async () => {
    const server = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.send(`{"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":10,"output_tokens":0,"total_tokens":10}}}`);
      },
    });
    try {
      const store = new CodexWebsocketSessionStore();
      const exec = executor({ streamBootstrapBuffering: true, store });
      const opts = responsesOptions({}, { [ExecutionSessionMetadataKey]: "zero-token-session" });
      const result = await exec.executeStream(wsAuth(server.url, "auth-a"), { model: "gpt-5-codex", payload: helloInput, format: "openai-response" }, opts).catch(() => undefined);
      if (result) await drain(result);
      const release = await Promise.race([store.getOrCreate("zero-token-session")!.lock(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000))]);
      expect(release).toBeDefined();
      release!();
      exec.closeExecutionSession("zero-token-session");
    } finally {
      server.close();
    }
  });

  test("TestCodexWebsockets_SessionlessBufferingImmediateTerminalClosesConnection", async () => {
    const server = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.send(`{"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[]}}`);
      },
    });
    try {
      const result = await executor({ streamBootstrapBuffering: true }).executeStream(wsAuth(server.url, "auth-buffering-close"), { model: "gpt-5.6-sol", payload: helloInput, format: "openai-response" }, responsesOptions());
      const { error } = await drain(result);
      expect(error).toBeUndefined();
      await eventually(() => server.connections[0]!.closed);
    } finally {
      server.close();
    }
  });
});

describe("sessions", () => {
  test("TestExistingWebsocketSessionConnRequiresMatchingHealthyConnection", () => {
    const exec = executor();
    const { conn } = fakeConn();
    const sess = new CodexWebsocketSession("s");
    sess.conn = conn;
    sess.authID = "auth-a";
    sess.wsURL = "ws://example.test/responses";
    sess.resetUpstreamDisconnectError(conn);
    expect(exec.existingSessionConn(sess, "auth-a", "ws://example.test/responses", "")).toBe(conn);
    expect(exec.existingSessionConn(sess, "auth-b", "ws://example.test/responses", "")).toBeUndefined();
    expect(exec.existingSessionConn(sess, "auth-a", "ws://other.test/responses", "")).toBeUndefined();
    // Go: TestWebsocketSessionIsolatesReusableConnectionByProxy.
    expect(exec.existingSessionConn(sess, "auth-a", "ws://example.test/responses", "http://proxy.test:8080")).toBeUndefined();
    sess.setUpstreamDisconnectError(conn, new Error("upstream disconnected"));
    expect(exec.existingSessionConn(sess, "auth-a", "ws://example.test/responses", "")).toBeUndefined();
  });

  test("TestCodexWebsocketMissingRequiredSessionDoesNotMarkUpstreamAttempt", async () => {
    const exec = executor();
    const opts = responsesOptions({ stream: false }, { [ExecutionSessionMetadataKey]: "missing-codex-session", [WebsocketContextMetadataKey]: { downstreamWebsocket: false, requiredUpstreamWebsocket: true } });
    const err = await exec.execute(wsAuth("https://chatgpt.example"), { model: "gpt-5.4", payload: `{"model":"gpt-5.4","previous_response_id":"resp-1","input":[]}`, format: "openai-response" }, opts).then(
      () => undefined,
      (e) => e,
    );
    expect(isUpstreamWebsocketReplayRequired(err)).toBe(true);
  });

  test("TestCodexAutoExecutorRequiredUpstreamWebsocketRejectsHTTPFallback", async () => {
    const exec = new CodexAutoExecutor({ disableImageGeneration: true, store: new CodexWebsocketSessionStore() });
    const auth = newAuth({ id: "codex-http-only", provider: "codex", attributes: { api_key: "sk-test" } });
    const err = await exec
      .executeStream(auth, { model: "gpt-5.4", payload: `{"model":"gpt-5.4","previous_response_id":"resp-1","input":[{"type":"message","id":"msg-2"}]}`, format: "openai-response" }, responsesOptions({}, downstreamContext({ requiredUpstreamWebsocket: true })))
      .then(
        () => undefined,
        (e) => e,
      );
    expect(err).toBeInstanceOf(StatusError);
    expect((err as StatusError).statusCode).toBe(426);
    expect(getString((err as StatusError).message, "error.code")).toBe("upstream_http_replay_required");
    expect((err as StatusError).requestScoped).toBe(true);
  });

  test("codexWebsocketsEnabled reads attributes first, then metadata (Go: codexWebsocketsEnabled)", () => {
    expect(codexWebsocketsEnabled(newAuth({ id: "a", provider: "codex", attributes: { websockets: "true" } }))).toBe(true);
    expect(codexWebsocketsEnabled(newAuth({ id: "a", provider: "codex", attributes: { websockets: "false" }, metadata: { websockets: true } }))).toBe(false);
    expect(codexWebsocketsEnabled(newAuth({ id: "a", provider: "codex", attributes: { websockets: "maybe" }, metadata: { websockets: true } }))).toBe(true);
    expect(codexWebsocketsEnabled(newAuth({ id: "a", provider: "codex", metadata: { websockets: "1" } }))).toBe(true);
    expect(codexWebsocketsEnabled(newAuth({ id: "a", provider: "codex" }))).toBe(false);
  });

  test("TestCodexWebsockets_LastEventAndTerminalTracking", () => {
    const conn1 = fakeConn().conn;
    const conn2 = fakeConn().conn;
    const sess = new CodexWebsocketSession("track-session");
    sess.resetUpstreamDisconnectError(conn1);
    expect(sess.getLastEventType(conn1)).toBe("");
    sess.setLastEventType(conn1, "response.output_item.added");
    expect(sess.getLastEventType(conn1)).toBe("response.output_item.added");
    expect(isTerminalEvent(sess.getLastEventType(conn1))).toBe(false);
    sess.setLastEventType(conn1, "response.completed");
    expect(isTerminalEvent(sess.getLastEventType(conn1))).toBe(true);
    sess.resetUpstreamDisconnectError(conn2);
    expect(sess.getLastEventType(conn2)).toBe("");
    expect(sess.getLastEventType(conn1)).toBe("");
  });

  test("TestCodexWebsocketSessionActiveChannelBelongsToConnection", () => {
    const a = fakeConn().conn;
    const b = fakeConn().conn;
    const sess = new CodexWebsocketSession("active");
    const queueA = sess.activate(a);
    expect(sess.activeForConn(b)).toBeUndefined();
    expect(sess.activeForConn(a)).toBe(queueA);
    expect(sess.clearActive(b, queueA)).toBe(false);
    expect(sess.clearActive(a, queueA)).toBe(true);
    expect(sess.activeForConn(a)).toBeUndefined();
  });

  test("TestCodexWebsocketsUpstreamDisconnectChanSignalsOnInvalidate", async () => {
    const exec = executor();
    const disconnect = exec.upstreamDisconnect("sess-1")!;
    const sess = exec.store.getOrCreate("sess-1")!;
    const { conn } = fakeConn();
    sess.conn = conn;
    sess.authID = "auth-1";
    sess.wsURL = "ws://example.test/responses";
    sess.readerConn = conn;
    const upstreamErr = new Error("upstream gone");
    invalidateUpstreamConn(sess, conn, { reason: "test_invalidate", err: upstreamErr, notify: true });
    expect(await disconnect).toBe(upstreamErr);
    expect(sess.conn).toBeUndefined();
  });

  test("a turn error does not publish the disconnect (Go: notifyUpstreamDisconnect)", async () => {
    const sess = new CodexWebsocketSession("turn-error");
    let fired = false;
    void sess.upstreamDisconnect.then(() => {
      fired = true;
    });
    sess.notifyUpstreamDisconnect(new UpstreamWebsocketTurnError());
    await Promise.resolve();
    expect(fired).toBe(false);
  });

  test("TestWebsocketActivationAfterUpstreamDisconnect", async () => {
    const server = startFakeCodexWebsocket({ onOpen: (c) => c.terminate() });
    try {
      const conn = await dialBunCodexWebsocket(server.url.replace("http", "ws"), new Headers(), {});
      const sess = new CodexWebsocketSession("activation");
      sess.conn = conn;
      sess.readerConn = conn;
      startUpstreamReader(sess, conn, { mapReadError: (e) => e });
      await eventually(() => sess.conn === undefined);
      const queue = sess.activate(conn);
      const next = await queue.next();
      expect(next.done).toBe(false);
      expect(next.value?.err).toBeDefined();
    } finally {
      server.close();
    }
  });

  test("TestCodexWebsocketsExecutor_CloseAllReleasesSessions", () => {
    const store = new CodexWebsocketSessionStore();
    const exec1 = executor({ store });
    const exec2 = executor({ store });
    const sess1 = exec1.store.getOrCreate("test-session-store-survives-replace");
    expect(exec2.store.getOrCreate("test-session-store-survives-replace")).toBe(sess1);
    exec1.closeExecutionSession(CloseAllExecutionSessionsID);
    expect(store.sessions.has("test-session-store-survives-replace")).toBe(false);
  });

  test("TestManagerRemove_ClosesOnlyRemovedAuthWebsocketSessions", () => {
    const store = new CodexWebsocketSessionStore();
    const auto = new CodexAutoExecutor({ store });
    const manager = new AuthManager({ sleep: async () => {} });
    manager.registerExecutor(auto);
    manager.register(newAuth({ id: "auth-a", provider: "codex", attributes: { api_key: "a" } }));
    manager.register(newAuth({ id: "auth-b", provider: "codex", attributes: { api_key: "b" } }));
    const a = fakeConn();
    const b = fakeConn();
    const sessA = store.getOrCreate("session-a")!;
    sessA.conn = a.conn;
    sessA.authID = "auth-a";
    const sessB = store.getOrCreate("session-b")!;
    sessB.conn = b.conn;
    sessB.authID = "auth-b";
    manager.remove("auth-a");
    expect(store.sessions.has("session-a")).toBe(false);
    expect(sessA.conn).toBeUndefined();
    expect(store.sessions.get("session-b")).toBe(sessB);
    expect(sessB.conn).toBe(b.conn);
    // Manager.closeExecutionSession reaches the executor (Go: Manager.CloseExecutionSession).
    manager.closeExecutionSession("session-b");
    expect(store.sessions.has("session-b")).toBe(false);
    expect(sessB.conn).toBeUndefined();
  });

  test("TestUpstreamWebsocketReplayRequiredError", () => {
    const err = new UpstreamWebsocketReplayRequiredError();
    expect(isUpstreamWebsocketReplayRequired(err)).toBe(true);
    expect(isUpstreamWebsocketReplayRequired(new Error("wrapped", { cause: err }))).toBe(true);
    expect(err.statusCode).toBe(426);
    expect(err.requestScoped).toBe(true);
  });
});

describe("interrupts", () => {
  test("TestInterruptExecutionSessionRequiresActiveRead", async () => {
    const server = startFakeCodexWebsocket();
    try {
      const exec = executor();
      const conn = await dialBunCodexWebsocket(server.url.replace("http", "ws"), new Headers(), {});
      await eventually(() => server.connections.length === 1);
      const sess = exec.store.getOrCreate("interrupt-requires-active-read")!;
      sess.conn = conn;
      sess.authID = "auth";
      sess.wsURL = server.url;
      startUpstreamReader(sess, conn, { mapReadError: (e) => e });
      const interrupt = `{"type":"response.interrupt","response_id":"r1","mode":"discard_partial_items"}`;
      await expect(exec.interruptExecutionSession("interrupt-requires-active-read", interrupt)).rejects.toBeInstanceOf(NoActiveUpstreamWebsocketError);
      const queue = sess.activate(conn);
      await exec.interruptExecutionSession("interrupt-requires-active-read", interrupt);
      expect(await server.connections[0]!.message(0)).toBe(interrupt);
      expect(server.connections[0]!.received).toEqual([interrupt]);
      sess.clearActive(conn, queue);
      exec.closeExecutionSession("interrupt-requires-active-read");
    } finally {
      server.close();
    }
  });

  test("TestInterruptExecutionSessionTracksActiveResponseIdentity", async () => {
    const server = startFakeCodexWebsocket({
      onOpen(conn) {
        conn.send(`{"type":"response.created","response":{"id":"r1"}}`);
        conn.send(`{"type":"response.failed","response":{"id":"queued-1"}}`);
      },
      onMessage(conn, message) {
        if (message.includes(`"response_id":"r1"`) && conn.received.length === 1) conn.send(`{"type":"response.completed","response":{"id":"r1","output":[]}}`);
      },
    });
    try {
      const exec = executor();
      const conn = await dialBunCodexWebsocket(server.url.replace("http", "ws"), new Headers(), {});
      const sess = exec.store.getOrCreate("active-response-identity")!;
      sess.conn = conn;
      startUpstreamReader(sess, conn, { mapReadError: (e) => e });
      const queue = sess.activate(conn);
      const interrupt = (payload: string) => exec.interruptExecutionSession("active-response-identity", payload);
      await eventually(() => sess.terminalResponseIDs.has("queued-1"));
      await interrupt(`{"type":"response.interrupt","response_id":"r1"}`);
      await expect(interrupt(`{"type":"response.interrupt","response_id":"unknown"}`)).rejects.toBeInstanceOf(UpstreamWebsocketInterruptRejectedError);
      await eventually(() => sess.terminalResponseIDs.has("r1"));
      await interrupt(`{"type":"response.interrupt","response_id":"r1"}`);
      await expect(interrupt(`{"type":"response.interrupt","response_id":"unknown-2"}`)).rejects.toBeInstanceOf(UpstreamWebsocketInterruptRejectedError);
      conn.send("barrier");
      await server.connections[0]!.message(1);
      expect(server.connections[0]!.received).toEqual([`{"type":"response.interrupt","response_id":"r1"}`, "barrier"]);
      sess.clearActive(conn, queue);
      exec.closeExecutionSession("active-response-identity");
    } finally {
      server.close();
    }
  });

  test("TestInterruptExecutionSessionErrorTerminalShapes", async () => {
    const sess = new CodexWebsocketSession("shapes");
    const { conn, sent } = fakeConn();
    const store = new CodexWebsocketSessionStore();
    store.sessions.set("shapes", sess);
    const exec = executor({ store });
    sess.conn = conn;
    sess.resetTerminalError(conn);
    const queue = sess.activate(conn);
    const track = (payload: string) => {
      const root = JSON.parse(payload);
      sess.trackResponseEvent(conn, root.type, root);
    };
    const interrupt = (id: string) => exec.interruptExecutionSession("shapes", `{"type":"response.interrupt","response_id":"${id}"}`);
    track(`{"type":"response.created","response":{"id":"r1"}}`);
    // An error for another response does not end r1.
    track(`{"type":"error","response_id":"queued-1","error":{"message":"rejected"}}`);
    await interrupt("r1");
    // r1 ends with a top-level response_id error.
    track(`{"type":"error","response_id":"r1","error":{"message":"boom"}}`);
    await expect(interrupt("unknown")).rejects.toBeInstanceOf(UpstreamWebsocketInterruptRejectedError);
    await expect(interrupt("r1")).rejects.toBeInstanceOf(UpstreamWebsocketInterruptRejectedError);
    track(`{"type":"response.created","response":{"id":"r2"}}`);
    await interrupt("r2");
    // An id-less failure ends the running response.
    track(`{"type":"response.failed","response":{"error":{"message":"boom"}}}`);
    await interrupt("r2"); // already terminal: idempotent
    await expect(interrupt("unknown-3")).rejects.toBeInstanceOf(UpstreamWebsocketInterruptRejectedError);
    expect(sent).toEqual([`{"type":"response.interrupt","response_id":"r1"}`, `{"type":"response.interrupt","response_id":"r2"}`]);
    sess.clearActive(conn, queue);
  });
});

describe("liveness and transport loss", () => {
  test("the read deadline ends an idle upstream socket (Go: codexResponsesWebsocketIdleTimeout)", async () => {
    const server = startFakeCodexWebsocket();
    try {
      const pending: Array<() => void> = [];
      const timers = { set: (fn: () => void) => pending.push(fn), clear: () => {} };
      const exec = executor({ timers, idleTimeoutMs: 1000 });
      const conn = await dialBunCodexWebsocket(server.url.replace("http", "ws"), new Headers(), {});
      const sess = exec.store.getOrCreate("idle")!;
      sess.conn = conn;
      startUpstreamReader(sess, conn, { mapReadError: (e) => e, timers, idleTimeoutMs: 1000 });
      const disconnect = sess.upstreamDisconnect;
      pending.at(-1)!();
      const err = await disconnect;
      expect((err as Error).name).toBe("TimeoutError");
      expect(sess.conn).toBeUndefined();
      await eventually(() => server.connections[0]!.closed);
    } finally {
      server.close();
    }
  });

  test("a dropped upstream during a downstream websocket turn is a turn error that advances the input epoch", async () => {
    const server = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.send(`{"type":"response.created","response":{"id":"resp-x"}}`);
        setTimeout(() => conn.terminate(), 5);
      },
    });
    try {
      const exec = executor();
      const epoch = { value: 0 };
      const opts = responsesOptions({}, { [ExecutionSessionMetadataKey]: "loss", ...downstreamContext({ inputEpoch: epoch, messageEpoch: 0 }) });
      const result = await exec.executeStream(wsAuth(server.url), { model: "gpt-5", payload: `{"model":"gpt-5","event_id":"evt-1","input":[]}`, format: "openai-response" }, opts);
      const { chunks, error } = await drain(result);
      expect(chunks.length).toBe(1);
      expect(error).toBeInstanceOf(UpstreamWebsocketTurnError);
      expect((error as UpstreamWebsocketTurnError).statusCode).toBe(502);
      expect((error as UpstreamWebsocketTurnError).eventId).toBe("evt-1");
      expect(epoch.value).toBe(1);
      // TestCodexWebsocketWriteLossIsRecordedForNextContinuation: a continuation needing the lost socket answers 409.
      const required = responsesOptions({}, { [ExecutionSessionMetadataKey]: "loss", ...downstreamContext({ requiredUpstreamWebsocket: true, inputEpoch: epoch, messageEpoch: 1 }) });
      const err = await exec.executeStream(wsAuth(server.url), { model: "gpt-5", payload: `{"model":"gpt-5","previous_response_id":"resp-x","input":[]}`, format: "openai-response" }, required).then(
        () => undefined,
        (e) => e,
      );
      expect(err).toBeInstanceOf(UpstreamWebsocketTurnError);
      expect((err as UpstreamWebsocketTurnError).statusCode).toBe(409);
      // Input read before the loss is refused as not sent.
      const stale = responsesOptions({}, { [ExecutionSessionMetadataKey]: "loss", ...downstreamContext({ inputEpoch: epoch, messageEpoch: 0 }) });
      const staleErr = await exec.executeStream(wsAuth(server.url), { model: "gpt-5", payload: `{"model":"gpt-5","input":[]}`, format: "openai-response" }, stale).then(
        () => undefined,
        (e) => e,
      );
      expect((staleErr as UpstreamWebsocketTurnError).notSent).toBe(true);
      exec.closeExecutionSession("loss");
    } finally {
      server.close();
    }
  });

  test("a session reuses its upstream socket across turns and reconnects when the target changes", async () => {
    let n = 0;
    const server = startFakeCodexWebsocket({
      onMessage(conn) {
        n++;
        for (const event of codexTurnEvents(`resp_${n}`)) conn.send(event);
      },
    });
    try {
      const exec = executor();
      const opts = () => responsesOptions({}, { [ExecutionSessionMetadataKey]: "reuse", ...downstreamContext() });
      for (const id of ["auth-a", "auth-a", "auth-b"]) {
        const result = await exec.executeStream(wsAuth(server.url, id), { model: "gpt-5", payload: `{"model":"gpt-5","input":[]}`, format: "openai-response" }, opts());
        const { error } = await drain(result);
        expect(error).toBeUndefined();
      }
      expect(server.connections.length).toBe(2);
      expect(server.connections[0]!.received.length).toBe(2);
      await eventually(() => server.connections[0]!.closed);
      exec.closeExecutionSession("reuse");
      await eventually(() => server.connections[1]!.closed);
    } finally {
      server.close();
    }
  });
});
