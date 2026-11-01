// Ported from: sdk/cliproxy/auth/conductor_transport_retry_test.go, sdk/cliproxy/auth/connection_lifecycle_cooldown_test.go
// Ported from: sdk/cliproxy/auth/conductor_cloudflare_520_test.go
// Skipped cases: TestConfiguredTLSHandshakeTimeoutIsRetryable "claude/chrome configured handshake timeout" and the
// configured half of TestExecuteRetriesConfiguredClaudeHandshakeTimeoutToConfiguredRounds (the typed configured TLS
// handshake timeout comes from the Go uTLS/transport layer; Bun fetch has no configurable handshake bound),
// TestHomeExecuteRetriesPreHTTPTransportFailure (Home dispatcher not ported). Go net/url error values are
// rebuilt from their Error() text; context.Canceled / DeadlineExceeded become the DOMException AbortError /
// TimeoutError that fetch raises, and gorilla CloseErrors become CodexWebsocketCloseError.
import { afterEach, expect, test } from "bun:test";
import {
  ErrorCodeConnectionLifecycle,
  ErrorCodeTransientTransport,
  getAvailableAuths,
  isCloudflareChallengeError,
  isCloudflareChallengeErrorMessage,
  isCloudflareChallengeResultError,
  isConnectionLifecycleError,
  isConnectionLifecycleResultError,
  isRequestInvalidError,
  isRequestRetryRoundError,
  isTransientTransportError,
  isTransientTransportResultError,
  resultErrorFromError,
  setQuotaCooldownDisabled,
  setTransientErrorCooldownSeconds,
  shouldSkipCredentialCooldown,
  AuthManagerError,
} from "../../../src/auth/manager/index.ts";
import { CodexWebsocketCloseError } from "../../../src/executor/codex/websockets/connection.ts";
import { StatusError } from "../../../src/executor/types.ts";
import type { AuthError } from "../../../src/auth/types.ts";
import { auth, drain, fakeExecutor, newManager, opts, registerModels, rejection, req, streamOf, type TestManager } from "./helpers.ts";

afterEach(() => {
  setQuotaCooldownDisabled(false);
  setTransientErrorCooldownSeconds(0);
});

const windowsCodexTLSHandshakeError = () =>
  new Error(
    'Post "https://chatgpt.com/backend-api/codex/responses": tls: TLS handshake: read tcp 127.0.0.1:1->127.0.0.1:2: wsarecv: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.',
  );
const dialRefusedError = () => new Error('Post "https://chatgpt.com/backend-api/codex/responses": dial tcp: connect: connection refused');
const canceled = () => new DOMException("The operation was aborted.", "AbortError");
const deadline = () => new DOMException("The operation timed out.", "TimeoutError");

function assertNoCooldown(tm: TestManager, authId: string, model: string): void {
  const updated = tm.manager.getById(authId)!;
  expect(updated.unavailable).toBe(false);
  expect(updated.nextRetryAfter).toBe(0);
  const state = updated.modelStates?.[model];
  if (state) {
    expect(state.unavailable).toBe(false);
    expect(state.nextRetryAfter).toBe(0);
  }
}

function markFailure(tm: TestManager, authId: string, model: string, error: AuthError | undefined, retryAfterMs?: number): void {
  tm.manager.markResult({ authId, provider: "codex", model, success: false, error, retryAfterMs });
}

/** Fails the first call with `fail`, then succeeds with "ok" (Go: transportThenSuccessExecutor). */
function transportThenSuccess(identifier: string, fail: unknown) {
  let calls = 0;
  const next = () => ++calls;
  const exec = fakeExecutor({
    identifier,
    execute: () => {
      if (next() === 1) throw fail;
      return { payload: "ok" };
    },
    count: () => {
      if (next() === 1) throw fail;
      return { payload: "ok" };
    },
    stream: () => {
      if (next() === 1) throw fail;
      return streamOf(["ok"]);
    },
  });
  return { exec, calls: () => calls };
}

function singleAuth(provider: string, model: string, executor?: ReturnType<typeof fakeExecutor>): TestManager {
  const tm = newManager();
  if (executor) tm.manager.registerExecutor(executor);
  registerModels(tm.registry, `${provider}-auth`, provider, model);
  tm.manager.register(auth({ id: `${provider}-auth`, provider }));
  return tm;
}

// --- conductor_transport_retry_test.go ---

test("Manager_ShouldRetryAfterError_RetriesPreHTTPTransportFailure", () => {
  const model = "gpt-transport-retry";
  const tm = singleAuth("codex", model);
  tm.manager.setRetryConfig(1, 0, 0);
  const cases: Array<{ name: string; err: unknown; want: boolean }> = [
    { name: "windows tls handshake", err: windowsCodexTLSHandshakeError(), want: true },
    { name: "dial refused", err: dialRefusedError(), want: true },
    { name: "unexpected eof", err: new Error("unexpected EOF"), want: true },
    { name: "http2 force closed", err: new Error("http2: client connection force closed via ClientConn.Close"), want: true },
    { name: "http2 conn closed", err: new Error('Post "https://example.com": http2: client conn is closed'), want: true },
    { name: "unauthorized", err: new AuthManagerError("", "unauthorized", { httpStatus: 401 }), want: false },
    { name: "canceled", err: canceled(), want: false },
    { name: "certificate", err: new Error('Post "https://chatgpt.com/backend-api/codex/responses": x509: certificate signed by unknown authority'), want: false },
  ];
  for (const tc of cases) {
    const first = tm.manager.shouldRetryAfterError(tc.err, 0, ["codex"], model, 0, 1);
    expect({ name: tc.name, retry: first.retry }).toEqual({ name: tc.name, retry: tc.want });
    if (tc.want) {
      expect(first.wait).toBe(0);
      expect(tm.manager.shouldRetryAfterError(tc.err, 1, ["codex"], model, 0, 1).retry).toBe(false);
    }
  }
});

test("ConfiguredTLSHandshakeTimeoutIsRetryable (caller-owned shapes stay non-retryable)", () => {
  const cases: Array<{ name: string; err: unknown }> = [
    { name: "caller deadline stays non retryable", err: deadline() },
    { name: "percent encoded marker is not trusted", err: new DOMException("tls%20handshake%20timeout: context deadline exceeded", "TimeoutError") },
    { name: "plaintext timeout phrase is not trusted", err: new DOMException("external transport tls handshake timeout: context deadline exceeded", "TimeoutError") },
    { name: "caller cancellation stays non retryable", err: canceled() },
  ];
  for (const tc of cases) {
    expect({ name: tc.name, transient: isTransientTransportError(tc.err) }).toEqual({ name: tc.name, transient: false });
    expect(isRequestRetryRoundError(tc.err)).toBe(false);
    const resultErr = resultErrorFromError(tc.err)!;
    expect(resultErr.code).not.toBe(ErrorCodeTransientTransport);
    expect(isTransientTransportResultError(resultErr)).toBe(false);
  }
  // A result reduced to the handshake-timeout phrase alone is not promoted to transport.
  expect(isTransientTransportResultError({ message: "tls handshake timeout", retryable: false })).toBe(false);
});

test("Manager_MarkResult_PreHTTPTransportFailureDoesNotCooldown", () => {
  setTransientErrorCooldownSeconds(5);
  const model = "gpt-6-astra";
  const cases: Array<{ name: string; err: AuthError | undefined }> = [
    { name: "typed tls handshake", err: resultErrorFromError(windowsCodexTLSHandshakeError()) },
    { name: "connection reset message", err: { message: "connection reset", retryable: false } },
  ];
  for (const tc of cases) {
    const tm = newManager();
    tm.manager.register(auth({ id: `auth-transport-${tc.name}`, provider: "codex" }));
    markFailure(tm, `auth-transport-${tc.name}`, model, tc.err);
    assertNoCooldown(tm, `auth-transport-${tc.name}`, model);
  }
});

test("ExecuteRetriesPreHTTPTransportFailureWithoutCooling", async () => {
  const model = "gpt-6-astra-retry";
  const { exec, calls } = transportThenSuccess("codex", windowsCodexTLSHandshakeError());
  const tm = singleAuth("codex", model, exec);
  tm.manager.setRetryConfig(1, 0, 0);
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe("ok");
  expect(calls()).toBe(2);
  assertNoCooldown(tm, "codex-auth", model);
});

test("Manager_HTTP2ClosedConnectionRespectsRequestRetry", async () => {
  for (const message of ["http2: client connection force closed via ClientConn.Close", "http2: client conn is closed"]) {
    for (const kind of ["execute", "stream", "count"] as const) {
      for (const retries of [0, 1]) {
        const fail = new Error(message);
        const model = `http2-retry-${kind}-${retries}`;
        const { exec, calls } = transportThenSuccess("openai", fail);
        const tm = singleAuth("openai", model, exec);
        tm.manager.setRetryConfig(retries, 0, 0);
        const call = async (): Promise<unknown> => {
          try {
            if (kind === "execute") await tm.manager.execute(["openai"], req(model), opts());
            else if (kind === "count") await tm.manager.executeCount(["openai"], req(model), opts());
            else {
              const { error } = await drain(await tm.manager.executeStream(["openai"], req(model), opts({ stream: true })));
              return error;
            }
          } catch (err) {
            return err;
          }
          return undefined;
        };
        const errCall = await call();
        assertNoCooldown(tm, "openai-auth", model);
        if (retries === 0) {
          expect(errCall).toBe(fail);
          expect(calls()).toBe(1);
          expect(await call()).toBeUndefined();
        } else {
          expect(errCall).toBeUndefined();
        }
        expect(calls()).toBe(2);
        assertNoCooldown(tm, "openai-auth", model);
      }
    }
  }
});

test("ExecuteDoesNotPoisonCredentialOnPreHTTPTransportFailure", async () => {
  const model = "gpt-6-astra-poison";
  const fail = windowsCodexTLSHandshakeError();
  const { exec, calls } = transportThenSuccess("codex", fail);
  const tm = singleAuth("codex", model, exec);
  tm.manager.setRetryConfig(0, 0, 0);
  const first = await rejection(tm.manager.execute(["codex"], req(model), opts()));
  expect(first).toBe(fail);
  assertNoCooldown(tm, "codex-auth", model);
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe("ok");
  expect(calls()).toBe(2);
});

test("ExecuteRetriesConfiguredClaudeHandshakeTimeoutToConfiguredRounds (caller deadline runs once)", async () => {
  const model = "claude-handshake-retry";
  let calls = 0;
  const exec = fakeExecutor({
    identifier: "claude",
    execute: () => {
      calls++;
      throw deadline();
    },
  });
  const tm = singleAuth("claude", model, exec);
  tm.manager.setRetryConfig(3, 0, 0);
  await rejection(tm.manager.execute(["claude"], req(model), opts()));
  expect(calls).toBe(1);
  assertNoCooldown(tm, "claude-auth", model);
});

// --- connection_lifecycle_cooldown_test.go ---

test("Manager_MarkResult_ConnectionLifecycleDoesNotCooldown", () => {
  setTransientErrorCooldownSeconds(5);
  const cases: Array<{ name: string; err: AuthError | undefined }> = [
    { name: "websocket 1000", err: { message: "websocket: close 1000 (normal)", retryable: false } },
    { name: "websocket 1001", err: { message: "websocket: close 1001 (going away)", retryable: false } },
    { name: "websocket 1006", err: { message: "websocket: close 1006 (abnormal closure): unexpected EOF", retryable: false } },
    { name: "context canceled", err: { message: "context canceled", retryable: false } },
    { name: "context deadline exceeded", err: { message: "context deadline exceeded", retryable: false } },
    { name: "unexpected EOF", err: { message: "unexpected EOF", retryable: false } },
    { name: "plain EOF", err: { message: "EOF", retryable: false } },
    { name: "wrapped unexpected EOF", err: { message: "read tcp 127.0.0.1:1->127.0.0.1:2: unexpected EOF", retryable: false } },
    { name: "http2 force closed", err: { message: "http2: client connection force closed via ClientConn.Close", retryable: false } },
    { name: "http2 conn closed", err: { message: "http2: client conn is closed", retryable: false } },
    { name: "typed canceled", err: resultErrorFromError(canceled()) },
    { name: "typed deadline", err: resultErrorFromError(deadline()) },
  ];
  for (const tc of cases) {
    const tm = newManager();
    const id = `auth-lifecycle-${tc.name}`;
    tm.manager.register(auth({ id, provider: "codex" }));
    markFailure(tm, id, "gpt-5.6-sol", tc.err);
    assertNoCooldown(tm, id, "gpt-5.6-sol");
  }
});

test("Manager_MarkResult_ConnectionLifecycleAuthLevelDoesNotCooldown", () => {
  setTransientErrorCooldownSeconds(5);
  const tm = newManager();
  tm.manager.register(auth({ id: "auth-lifecycle-auth-level", provider: "codex" }));
  markFailure(tm, "auth-lifecycle-auth-level", "", { message: "websocket: close 1006 (abnormal closure): unexpected EOF", retryable: false });
  const updated = tm.manager.getById("auth-lifecycle-auth-level")!;
  expect(updated.unavailable).toBe(false);
  expect(updated.nextRetryAfter).toBe(0);
});

test("Manager_MarkResult_HTTP2ClosedConnectionKeepsPoolAvailable", () => {
  setTransientErrorCooldownSeconds(60);
  for (const message of ["http2: client connection force closed via ClientConn.Close", "http2: client conn is closed", "unexpected EOF"]) {
    for (const mode of ["raw", "classified", "wrapped"] as const) {
      const tm = newManager();
      const model = "sample-model";
      let resultErr: AuthError = { message, retryable: false };
      if (mode === "classified") resultErr = resultErrorFromError(new Error(message))!;
      if (mode === "wrapped") resultErr = resultErrorFromError(new Error(`Post "https://example.com/v1/chat/completions": ${message}`))!;
      if (mode !== "raw") {
        expect(resultErr.code).toBe(ErrorCodeConnectionLifecycle);
      }
      for (let i = 0; i < 4; i++) {
        tm.manager.register(auth({ id: `http2-pool-${i}`, provider: "openai" }));
        tm.manager.markResult({ authId: `http2-pool-${i}`, provider: "openai", model, success: false, error: resultErr });
      }
      const auths = tm.manager.list();
      expect(getAvailableAuths(auths, "openai", model, tm.clock.now()).length).toBe(4);
      for (const a of auths) assertNoCooldown(tm, a.id, model);
    }
  }
});

test("Manager_MarkResult_HTTPStatusWithLifecycleTextStillCooldowns", () => {
  setTransientErrorCooldownSeconds(5);
  const cases: Array<{ name: string; status: number; message: string; wantAuth?: boolean }> = [
    { name: "401 unexpected EOF", status: 401, message: "unexpected EOF", wantAuth: true },
    { name: "429 context canceled", status: 429, message: "context canceled", wantAuth: true },
    { name: "500 unexpected EOF", status: 500, message: "unexpected EOF" },
    { name: "500 websocket 1006 text", status: 500, message: "websocket: close 1006 (abnormal closure): unexpected EOF" },
    { name: "401 http2 force closed", status: 401, message: "http2: client connection force closed via ClientConn.Close", wantAuth: true },
    { name: "429 http2 conn closed", status: 429, message: "http2: client conn is closed", wantAuth: true },
    { name: "500 http2 force closed", status: 500, message: "http2: client connection force closed via ClientConn.Close" },
    { name: "500 http2 conn closed", status: 500, message: "http2: client conn is closed" },
  ];
  for (const tc of cases) {
    const tm = newManager();
    const id = `auth-status-${tc.name}`;
    tm.manager.register(auth({ id, provider: "codex" }));
    const before = tm.clock.now();
    markFailure(tm, id, "gpt-5.6-sol", { message: tc.message, retryable: false, httpStatus: tc.status });
    const state = tm.manager.getById(id)!.modelStates!["gpt-5.6-sol"]!;
    expect(state.nextRetryAfter).not.toBe(0);
    if (tc.status === 500) expect(state.nextRetryAfter).toBeGreaterThanOrEqual(before + 4000);
    if (tc.wantAuth) expect(state.unavailable).toBe(true);
  }
});

test("Manager_MarkResult_NonLifecycleStillCooldowns", () => {
  setTransientErrorCooldownSeconds(5);
  const tm = newManager();
  tm.manager.register(auth({ id: "auth-still-cools", provider: "codex" }));
  const before = tm.clock.now();
  markFailure(tm, "auth-still-cools", "gpt-5.6-sol", { message: "upstream internal failure", retryable: true, httpStatus: 500 });
  const state = tm.manager.getById("auth-still-cools")!.modelStates!["gpt-5.6-sol"]!;
  expect(state.unavailable).toBe(true);
  expect(state.nextRetryAfter).toBeGreaterThanOrEqual(before + 4000);
});

test("ResultErrorFromError_ConnectionLifecycleDoesNotBecomeRequestScoped", () => {
  const cases: unknown[] = [
    canceled(),
    deadline(),
    new Error("EOF"),
    new Error("unexpected EOF"),
    new CodexWebsocketCloseError(1000, "normal"),
    new CodexWebsocketCloseError(1001, "bye"),
    new CodexWebsocketCloseError(1006, ""),
    new Error("wrap: unexpected EOF"),
    new Error("websocket: close 1000 (normal)"),
    new Error("websocket: close 1006 (abnormal closure): unexpected EOF"),
    new Error("context deadline exceeded"),
    new Error("http2: client connection force closed via ClientConn.Close"),
    new Error("http2: client conn is closed"),
    new Error('Post "https://example.com": http2: client conn is closed'),
  ];
  for (const err of cases) {
    expect(isConnectionLifecycleError(err)).toBe(true);
    const got = resultErrorFromError(err)!;
    expect(got.code).toBe(ErrorCodeConnectionLifecycle);
    expect(isRequestInvalidError(err)).toBe(false);
    expect(shouldSkipCredentialCooldown(got)).toBe(true);
  }
});

test("IsConnectionLifecycleError_StatusBearingErrorsStayCoolable", () => {
  const cases = [
    new StatusError(401, "unexpected EOF"),
    new StatusError(429, "context canceled"),
    new StatusError(500, "unexpected EOF"),
    new StatusError(502, "websocket: close 1006 (abnormal closure): unexpected EOF"),
    new StatusError(401, "http2: client connection force closed via ClientConn.Close"),
    new StatusError(429, "http2: client conn is closed"),
    new StatusError(500, "http2: client connection force closed via ClientConn.Close"),
    new StatusError(500, "http2: client conn is closed"),
  ];
  for (const err of cases) {
    expect(isConnectionLifecycleError(err)).toBe(false);
    expect(shouldSkipCredentialCooldown(resultErrorFromError(err))).toBe(false);
  }
});

test("IsConnectionLifecycleError_TypedCloseWins", () => {
  const err = Object.assign(new CodexWebsocketCloseError(1006, ""), { statusCode: 502 });
  expect(isConnectionLifecycleError(err)).toBe(true);
  const got = resultErrorFromError(err)!;
  expect(got.code).toBe(ErrorCodeConnectionLifecycle);
  expect(shouldSkipCredentialCooldown(got)).toBe(true);
  expect(isConnectionLifecycleResultError(got)).toBe(true);
  const tm = newManager();
  tm.manager.register(auth({ id: "auth-typed-close", provider: "codex" }));
  markFailure(tm, "auth-typed-close", "gpt-5.6-sol", got);
  assertNoCooldown(tm, "auth-typed-close", "gpt-5.6-sol");
});

// --- conductor_cloudflare_520_test.go ---

const origin520Msg = `<html><body><div class="cf-error-details cf-error-520"><h1>Web server is returning an unknown error</h1><p>There is an unknown connection issue between Cloudflare and the origin web server.</p></div></body></html>`;
const short520Msg = `<html><body><div class="cf-error-details cf-error-520"><h1>Web server is returning an unknown error</h1></div></body></html>`;

test("IsCloudflareChallengeErrorMessage_ExcludesOriginErrors", () => {
  const origin520 = `<html><head><title>Web server is returning an unknown error</title></head><body><div class="cf-error-details cf-error-520"><h1>Web server is returning an unknown error</h1><p>There is an unknown connection issue between Cloudflare and the origin web server.</p><ul><li>Ray ID: a385507da9eeb4c4</li><li>Error reference number: 520</li><li>Cloudflare Location: Los Angeles</li></ul></div></body></html>`;
  expect(isCloudflareChallengeErrorMessage(origin520)).toBe(false);
  expect(isCloudflareChallengeErrorMessage(`<html><body><h1>Web server is returning an unknown error</h1><p>There is an unknown connection issue between Cloudflare and the origin web server.</p></body></html>`)).toBe(false);
  for (const challenge of [
    "cf-mitigated: challenge",
    `<html><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`,
    "cloudflare challenge required",
    `<html><head><title>Just a moment...</title></head><body>Checking your browser... cloudflare</body></html>`,
  ]) {
    expect(isCloudflareChallengeErrorMessage(challenge)).toBe(true);
  }
});

function markOn(tm: TestManager, id: string, provider: string, model: string, error: AuthError, retryAfterMs?: number) {
  tm.manager.register(auth({ id, provider, status: "active" }));
  tm.manager.markResult({ authId: id, provider, model, success: false, error, retryAfterMs });
  return tm.manager.getById(id)!;
}

test("Manager_MarkResult_Cloudflare520OriginError_NotTreatedAsChallenge", () => {
  const tm = newManager();
  const updated = markOn(tm, "auth-test-520", "codex", "gpt-5.6-sol", { httpStatus: 520, message: origin520Msg, retryable: false });
  const state = updated.modelStates!["gpt-5.6-sol"]!;
  expect(state.quota.exceeded).toBe(false);
  expect(state.quota.reason ?? "").toBe("");
  expect(state.statusMessage).toBe(origin520Msg);
  expect(state.lastError?.httpStatus).toBe(520);
  expect(state.unavailable).toBe(true);
  expect(state.nextRetryAfter - tm.clock.now()).toBe(60_000);
});

test("Manager_MarkResult_Cloudflare520_CustomTransientCooldown", () => {
  setTransientErrorCooldownSeconds(5);
  const tm = newManager();
  const state = markOn(tm, "auth-test-520-custom-cooldown", "codex", "gpt-5.6-sol", { httpStatus: 520, message: short520Msg, retryable: false }).modelStates!["gpt-5.6-sol"]!;
  expect(state.nextRetryAfter - tm.clock.now()).toBe(5000);
});

test("Manager_MarkResult_Cloudflare520_DisabledTransientCooldown", () => {
  setTransientErrorCooldownSeconds(-1);
  const tm = newManager();
  const state = markOn(tm, "auth-test-520-disabled-cooldown", "codex", "gpt-5.6-sol", { httpStatus: 520, message: short520Msg, retryable: false }).modelStates!["gpt-5.6-sol"]!;
  expect(state.nextRetryAfter).toBe(0);
  expect(state.unavailable).toBe(false);
});

test("Manager_MarkResult_Cloudflare520_DisableCoolingAuth", () => {
  const tm = newManager();
  tm.manager.register(auth({ id: "auth-test-520-disable-cooling-auth", provider: "codex", metadata: { disable_cooling: true } }));
  tm.manager.markResult({ authId: "auth-test-520-disable-cooling-auth", provider: "codex", model: "gpt-5.6-sol", success: false, error: { httpStatus: 520, message: short520Msg, retryable: false } });
  const state = tm.manager.getById("auth-test-520-disable-cooling-auth")!.modelStates!["gpt-5.6-sol"]!;
  expect(state.nextRetryAfter).toBe(0);
  expect(state.unavailable).toBe(false);
});

test("Manager_MarkResult_Cloudflare520_WithRetryAfterHint", () => {
  const tm = newManager();
  const state = markOn(tm, "auth-test-520-hint", "codex", "gpt-5.6-sol", { httpStatus: 520, message: short520Msg, retryable: false }, 15_000).modelStates!["gpt-5.6-sol"]!;
  expect(state.nextRetryAfter - tm.clock.now()).toBe(15_000);
});

test("Manager_MarkResult_Cloudflare520_DisabledTransientCooldown_IgnoresHint", () => {
  setTransientErrorCooldownSeconds(-1);
  const tm = newManager();
  const state = markOn(tm, "auth-test-520-disabled-with-hint", "codex", "gpt-5.6-sol", { httpStatus: 520, message: short520Msg, retryable: false }, 15_000).modelStates!["gpt-5.6-sol"]!;
  expect(state.nextRetryAfter).toBe(0);
  expect(state.unavailable).toBe(false);
});

test("Manager_MarkResult_AuthLevelCloudflare520_DisabledTransientCooldown_IgnoresHint", () => {
  setTransientErrorCooldownSeconds(-1);
  const tm = newManager();
  const updated = markOn(tm, "auth-test-520-auth-disabled-with-hint", "codex", "", { httpStatus: 520, message: short520Msg, retryable: false }, 15_000);
  expect(updated.nextRetryAfter).toBe(0);
  expect(updated.unavailable).toBe(false);
});

test("Manager_MarkResult_HTTP503_TransientCooldown_RespectsDisabledAndHint", () => {
  setTransientErrorCooldownSeconds(-1);
  let tm = newManager();
  let state = markOn(tm, "auth-test-503-disabled", "claude", "claude-3-5-sonnet", { httpStatus: 503, message: "service unavailable", retryable: false }, 20_000).modelStates!["claude-3-5-sonnet"]!;
  expect(state.nextRetryAfter).toBe(0);
  expect(state.unavailable).toBe(false);

  setTransientErrorCooldownSeconds(0);
  tm = newManager();
  state = markOn(tm, "auth-test-503-hint", "claude", "claude-3-5-sonnet", { httpStatus: 503, message: "service unavailable", retryable: false }, 20_000).modelStates!["claude-3-5-sonnet"]!;
  expect(state.nextRetryAfter - tm.clock.now()).toBe(20_000);
  expect(state.unavailable).toBe(true);
});

test("Manager_MarkResult_AuthLevelCloudflare520_SetsTransientError", () => {
  const tm = newManager();
  const updated = markOn(tm, "auth-test-520-authlevel", "codex", "", { httpStatus: 520, message: origin520Msg, retryable: false });
  expect(updated.quota.exceeded).toBe(false);
  expect(updated.quota.reason ?? "").toBe("");
  expect(updated.statusMessage).toBe("transient upstream error");
  expect(updated.lastError?.httpStatus).toBe(520);
  expect(updated.unavailable).toBe(true);
  expect(updated.nextRetryAfter - tm.clock.now()).toBe(60_000);
});

test("IsCloudflareChallengeResultError_Excludes5xx", () => {
  for (const status of [500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]) {
    expect(isCloudflareChallengeResultError({ httpStatus: status, message: "cf-mitigated: challenge but with 5xx status code", retryable: false })).toBe(false);
  }
  expect(isCloudflareChallengeResultError({ httpStatus: 403, message: "cf-mitigated: challenge", retryable: false })).toBe(true);
});

test("IsCloudflareChallengeError", () => {
  expect(isCloudflareChallengeError(new AuthManagerError("", "cf-error-details cf-error-520: Web server is returning an unknown error", { httpStatus: 520 }))).toBe(false);
  expect(isCloudflareChallengeError(new AuthManagerError("", "cf-mitigated: challenge", { httpStatus: 403 }))).toBe(true);
  expect(isCloudflareChallengeError(new Error("challenge-platform orchestrate script blocked"))).toBe(true);
  expect(isCloudflareChallengeError(new Error("Web server is returning an unknown error between Cloudflare and origin"))).toBe(false);
});


