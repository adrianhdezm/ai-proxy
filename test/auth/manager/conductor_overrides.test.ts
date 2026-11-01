// Ported from: sdk/cliproxy/auth/conductor_overrides_test.go
// Skipped cases: TestManager_ShouldRetryAfterError_SkipsWrappedHomeConcurrencyBusy (Home not ported), the "credential policy"
// row of TestManager_ShouldRetryAfterError_IgnoresRequestIneligibleOverrides (credential policies not ported),
// TestManager_ShouldRetryAfterError_UsesOAuthModelAliasForCooldown (oauth-model-alias not ported),
// TestManagerExecute(Stream)_AntigravityInvalidGrantFallsBackAndSuspendsAuth (Antigravity; the invalid-grant fallback is run
// with the Claude provider instead), TestManager_DeepSeek* (DeepSeek balance classification of openai-compatibility providers
// not ported), the xai row of TestManager_RequestScopedErrorStopsCredentialFallbackWithoutSuspendingAuth (xAI),
// TestManager_RecordResult_AvailabilityNeutralSkipsSchedulerUpdate (incremental scheduler not ported; the neutral count_tokens
// path is covered by TestManager_ExecuteCount_GenericRouteNotFoundDoesNotSuspendModel), the NewRequestScopedError /
// MarkRequestScoped half of TestManager_MarkResult_RequestFaultBodyDoesNotCooldownModelOrAuth (Go SDK constructors; the
// request_scoped code is used directly). Result hooks become wrapped markResult calls.
import { afterEach, expect, test } from "bun:test";
import {
  AuthManagerError,
  ErrorCodeRequestScoped,
  isAuthBlockedForModel,
  isCountTokensEndpointNotFoundError,
  sanitizeUpstreamErrorSummary,
  setQuotaCooldownDisabled,
  setTransientErrorCooldownSeconds,
  type ExecutionResult,
} from "../../../src/auth/manager/index.ts";
import { PinnedAuthMetadataKey, StatusError, statusCodeOf } from "../../../src/executor/types.ts";
import type { Auth, ModelState } from "../../../src/auth/types.ts";
import { Hour, Minute, auth, drain, fakeExecutor, newManager, opts, registerModels, rejection, req, streamOf, type TestManager } from "./helpers.ts";

afterEach(() => {
  setQuotaCooldownDisabled(false);
  setTransientErrorCooldownSeconds(0);
});

const boom = () => new AuthManagerError("", "boom", { httpStatus: 500 });
const requestScopedNotFoundMessage =
  "Item with id 'rs_0b5f3eb6f51f175c0169ca74e4a85881998539920821603a74' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true, or remove this item from your input.";

function ms(partial: Partial<ModelState>): ModelState {
  return { status: "active", unavailable: false, nextRetryAfter: 0, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: 0, ...partial };
}

function withAuths(provider: string, model: string, ...auths: Auth[]): TestManager {
  const tm = newManager();
  for (const a of auths) {
    if (model !== "") registerModels(tm.registry, a.id, provider, model);
    tm.manager.register(a);
  }
  return tm;
}

const settings = (tm: TestManager) => tm.manager.retrySettings();
const shouldRetry = (tm: TestManager, err: unknown, attempt: number, provider: string, model: string, maxWait: number, extra: { opts?: Parameters<TestManager["manager"]["shouldRetryAfterError"]>[7] } = {}) =>
  tm.manager.shouldRetryAfterError(err, attempt, [provider], model, maxWait, settings(tm).requestRetry, undefined, extra.opts);

test("Manager_ShouldRetryAfterError_RespectsAuthRequestRetryOverride", () => {
  const model = "test-model";
  const tm = newManager();
  tm.manager.setRetryConfig(3, 30_000, 0);
  const next = tm.clock.now() + 5000;
  const target = auth({ id: "auth-1", provider: "claude", metadata: { request_retry: 0 }, modelStates: { [model]: ms({ unavailable: true, status: "error", nextRetryAfter: next, lastError: { httpStatus: 500, message: "upstream unavailable", retryable: false } }) } });
  registerModels(tm.registry, target.id, "claude", model);
  tm.manager.register(target);
  const err = new AuthManagerError("", "boom", { httpStatus: 500 });
  expect(shouldRetry(tm, err, 0, "claude", model, 30_000).retry).toBe(false);
  target.metadata.request_retry = 1;
  tm.manager.update(target);
  const second = shouldRetry(tm, err, 0, "claude", model, 30_000);
  expect(second.retry).toBe(true);
  expect(second.wait).toBeGreaterThan(0);
  expect(shouldRetry(tm, err, 1, "claude", model, 30_000).retry).toBe(false);
});

test("Manager_ShouldRetryAfterError_RetriesLocalRoundWithoutCooldown", () => {
  const model = "gpt-retry-without-cooldown";
  const tm = withAuths("codex", model, auth({ id: "retry-auth", provider: "codex" }));
  tm.manager.setRetryConfig(1, 0, 0);
  for (const status of [429, 502]) {
    const err = new AuthManagerError("", "retryable failure", { httpStatus: status });
    expect(shouldRetry(tm, err, 0, "codex", model, 0)).toEqual({ wait: 0, retry: true });
    expect(shouldRetry(tm, err, 1, "codex", model, 0).retry).toBe(false);
  }
});

test("Manager_ShouldRetryAfterError_DoesNotWaitWhenAnotherCredentialIsAvailable", () => {
  const model = "retry-available-credential";
  const tm = newManager();
  tm.manager.setRetryConfig(1, Minute, 1);
  const cooling = auth({ id: "cooling", provider: "codex", modelStates: { [model]: ms({ unavailable: true, status: "error", nextRetryAfter: tm.clock.now() + 30_000 }) } });
  for (const a of [cooling, auth({ id: "available", provider: "codex" })]) {
    registerModels(tm.registry, a.id, "codex", model);
    tm.manager.register(a);
  }
  expect(shouldRetry(tm, new AuthManagerError("", "rate limited", { httpStatus: 429 }), 0, "codex", model, Minute)).toEqual({ wait: 0, retry: true });
});

test("Manager_ShouldRetryAfterError_IgnoresUnrelatedModelOverride", () => {
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  registerModels(tm.registry, "target-auth", "codex", "retry-target");
  registerModels(tm.registry, "unrelated-auth", "codex", "retry-unrelated");
  tm.manager.register(auth({ id: "target-auth", provider: "codex", metadata: { request_retry: 0 } }));
  tm.manager.register(auth({ id: "unrelated-auth", provider: "codex", metadata: { request_retry: 2 } }));
  expect(shouldRetry(tm, new AuthManagerError("", "retryable failure", { httpStatus: 502 }), 0, "codex", "retry-target", 0)).toEqual({ wait: 0, retry: false });
});

test("Manager_ShouldRetryAfterError_IgnoresDisabledRetryOverride", () => {
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  tm.manager.register(auth({ id: "active-auth", provider: "codex", metadata: { request_retry: 0 } }));
  tm.manager.register(auth({ id: "disabled-auth", provider: "codex", disabled: true, metadata: { request_retry: 2 } }));
  expect(shouldRetry(tm, new AuthManagerError("", "retryable failure", { httpStatus: 502 }), 0, "codex", "", 0)).toEqual({ wait: 0, retry: false });
});

test("Manager_ShouldRetryAfterError_IgnoresNonRoundCooldownOverrides", () => {
  const cases: Array<{ name: string; state: Partial<ModelState> }> = [
    { name: "model disabled", state: { status: "disabled" } },
    { name: "unauthorized", state: { status: "error", unavailable: true, lastError: { httpStatus: 401, message: "unauthorized", retryable: false } } },
    { name: "payment required", state: { status: "error", unavailable: true, lastError: { httpStatus: 402, message: "payment required", retryable: false } } },
    { name: "not found", state: { status: "error", unavailable: true, lastError: { httpStatus: 404, message: "not found", retryable: false } } },
    { name: "model unsupported", state: { status: "error", unavailable: true, lastError: { httpStatus: 400, message: "model not supported", retryable: false } } },
  ];
  for (const tc of cases) {
    const tm = newManager();
    tm.manager.setRetryConfig(0, Minute, 0);
    const model = `retry-non-round-${tc.name}`;
    const state = ms(tc.state);
    if (state.status !== "disabled") state.nextRetryAfter = tm.clock.now() + Minute;
    for (const a of [
      auth({ id: "eligible", provider: "codex", metadata: { request_retry: 0 } }),
      auth({ id: "ineligible", provider: "codex", metadata: { request_retry: 2 }, modelStates: { [model]: state } }),
    ]) {
      registerModels(tm.registry, a.id, "codex", model);
      tm.manager.register(a);
    }
    expect({ name: tc.name, result: shouldRetry(tm, new AuthManagerError("", "upstream unavailable", { httpStatus: 502 }), 0, "codex", model, Minute) }).toEqual({ name: tc.name, result: { wait: 0, retry: false } });
  }
});

test("Manager_ShouldRetryAfterError_IgnoresRequestIneligibleOverrides (pinned credential)", () => {
  const model = "retry-eligibility";
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  for (const a of [auth({ id: "retry-pinned-eligible", provider: "codex", metadata: { request_retry: 0 } }), auth({ id: "retry-pinned-ineligible", provider: "codex", metadata: { request_retry: 2 } })]) {
    registerModels(tm.registry, a.id, "codex", model);
    tm.manager.register(a);
  }
  const result = tm.manager.shouldRetryAfterError(new AuthManagerError("", "retryable failure", { httpStatus: 502 }), 0, ["codex"], model, 0, 0, undefined, opts({ metadata: { [PinnedAuthMetadataKey]: "retry-pinned-eligible" } }));
  expect(result).toEqual({ wait: 0, retry: false });
});

function alwaysFail(identifier: string, err: () => unknown) {
  let calls = 0;
  const fail = () => {
    calls++;
    throw err();
  };
  return { executor: fakeExecutor({ identifier, execute: fail, count: fail, stream: fail }), calls: () => calls };
}

test("Manager_RequestRetryRunsAdditionalLocalRoundWithoutCooldown", async () => {
  for (const kind of ["nonstream", "count", "stream"] as const) {
    const model = `retry-model-${kind}`;
    const { executor, calls } = alwaysFail("claude", boom);
    const tm = newManager();
    tm.manager.setRetryConfig(1, 0, 0);
    tm.manager.registerExecutor(executor);
    registerModels(tm.registry, "retry-auth", "claude", model);
    tm.manager.register(auth({ id: "retry-auth", provider: "claude", metadata: { disable_cooling: true } }));
    const run = kind === "nonstream" ? tm.manager.execute(["claude"], req(model), opts()) : kind === "count" ? tm.manager.executeCount(["claude"], req(model), opts()) : tm.manager.executeStream(["claude"], req(model), opts({ stream: true }));
    expect(statusCodeOf(await rejection(run))).toBe(500);
    expect(calls()).toBe(2);
  }
});

test("Manager_MaxRetryCredentials_LimitsCrossCredentialRetries", async () => {
  for (const kind of ["execute", "execute_count", "execute_stream"] as const) {
    for (const [limit, wantCalls] of [[1, 1], [0, 2]] as const) {
      const { executor, calls } = alwaysFail("claude", boom);
      const tm = newManager();
      tm.manager.setRetryConfig(0, 0, limit);
      tm.manager.registerExecutor(executor);
      for (const id of ["auth-1", "auth-2"]) {
        registerModels(tm.registry, id, "claude", "test-model");
        tm.manager.register(auth({ id, provider: "claude" }));
      }
      const run = kind === "execute" ? tm.manager.execute(["claude"], req("test-model"), opts()) : kind === "execute_count" ? tm.manager.executeCount(["claude"], req("test-model"), opts()) : tm.manager.executeStream(["claude"], req("test-model"), opts());
      await rejection(run);
      expect({ kind, limit, calls: calls() }).toEqual({ kind, limit, calls: wantCalls });
    }
  }
});

/** Go: authFallbackExecutor. */
function fallbackExecutor(identifier: string, errors: { execute?: Record<string, unknown>; streamFirst?: Record<string, unknown>; streamTail?: Record<string, unknown>; count?: Record<string, unknown> }) {
  return fakeExecutor({
    identifier,
    execute: (a) => {
      if (errors.execute?.[a.id]) throw errors.execute[a.id];
      return { payload: a.id };
    },
    count: (a) => {
      if (errors.count?.[a.id]) throw errors.count[a.id];
      return { payload: a.id };
    },
    stream: (a) => {
      const headers = new Headers({ "X-Auth": a.id });
      if (errors.streamFirst?.[a.id]) return streamOf([errors.streamFirst[a.id] as Error], headers);
      return streamOf(errors.streamTail?.[a.id] ? [a.id, errors.streamTail[a.id] as Error] : [a.id], headers);
    },
  });
}

function badGoodManager(provider: string, model: string, executor: ReturnType<typeof fakeExecutor>, retry = 0): TestManager {
  const tm = newManager();
  tm.manager.setRetryConfig(retry, 30_000, 0);
  tm.manager.registerExecutor(executor);
  for (const id of ["aa-bad-auth", "bb-good-auth"]) {
    registerModels(tm.registry, id, provider, model);
    tm.manager.register(auth({ id, provider }));
  }
  return tm;
}

function expectSuspended(tm: TestManager, model: string): void {
  const state = tm.manager.getById("aa-bad-auth")!.modelStates![model]!;
  expect(state.unavailable).toBe(true);
  expect(state.nextRetryAfter).not.toBe(0);
}

test("Manager_ModelSupportBadRequest_FallsBackAndSuspendsAuth", async () => {
  const model = "claude-opus-4-6";
  const executor = fallbackExecutor("claude", { execute: { "aa-bad-auth": new AuthManagerError("", "invalid_request_error: The requested model is not supported.", { httpStatus: 400 }) } });
  const tm = badGoodManager("claude", model, executor);
  for (let i = 0; i < 2; i++) expect((await tm.manager.execute(["claude"], req(model), opts())).payload).toBe("bb-good-auth");
  expect(executor.executeCalls).toEqual(["aa-bad-auth", "bb-good-auth", "bb-good-auth"]);
  expectSuspended(tm, model);
});

const invalidGrantErr = () =>
  new AuthManagerError(
    "",
    `bad response status code 400, message: {"error":"invalid_grant","error_description":"Bad Request"}, body: {"type":"error","error":{"type":"invalid_request_error","message":"{\\"error\\":\\"invalid_grant\\"}"}}`,
    { httpStatus: 400 },
  );

test("ManagerExecute(Stream)_InvalidGrantFallsBackAndSuspendsAuth (Antigravity case on Claude)", async () => {
  const model = "claude-opus-4-6";
  let executor = fallbackExecutor("claude", { execute: { "aa-bad-auth": invalidGrantErr() } });
  let tm = badGoodManager("claude", model, executor);
  for (let i = 0; i < 2; i++) expect((await tm.manager.execute(["claude"], req(model), opts())).payload).toBe("bb-good-auth");
  expect(executor.executeCalls).toEqual(["aa-bad-auth", "bb-good-auth", "bb-good-auth"]);
  expectSuspended(tm, model);

  executor = fallbackExecutor("claude", { streamFirst: { "aa-bad-auth": invalidGrantErr() } });
  tm = badGoodManager("claude", model, executor);
  for (let i = 0; i < 2; i++) {
    const { payload } = await drain(await tm.manager.executeStream(["claude"], req(model), opts({ stream: true })));
    expect(payload).toBe("bb-good-auth");
  }
  expect(executor.streamCalls).toEqual(["aa-bad-auth", "bb-good-auth", "bb-good-auth"]);
  expectSuspended(tm, model);
});

test("ManagerExecuteStream_ModelSupportBadRequestFallsBackAndSuspendsAuth", async () => {
  const model = "claude-opus-4-6";
  const executor = fallbackExecutor("claude", { streamFirst: { "aa-bad-auth": new AuthManagerError("", "invalid_request_error: The requested model is not supported.", { httpStatus: 400 }) } });
  const tm = badGoodManager("claude", model, executor);
  for (let i = 0; i < 2; i++) {
    const result = await tm.manager.executeStream(["claude"], req(model), opts({ stream: true }));
    expect(result.headers?.get("X-Auth")).toBe("bb-good-auth");
    expect((await drain(result)).payload).toBe("bb-good-auth");
  }
  expect(executor.streamCalls).toEqual(["aa-bad-auth", "bb-good-auth", "bb-good-auth"]);
  expectSuspended(tm, model);
});

function markOne(tm: TestManager, result: Omit<ExecutionResult, "provider" | "success"> & { provider?: string }) {
  tm.manager.markResult({ provider: "claude", success: false, ...result });
  return tm.manager.getById(result.authId)!;
}

test("Manager_MarkResult_RespectsAuthDisableCoolingOverride", () => {
  const tm = withAuths("claude", "", auth({ id: "auth-1", provider: "claude", metadata: { disable_cooling: true } }));
  const updated = markOne(tm, { authId: "auth-1", model: "test-model", error: { httpStatus: 500, message: "boom", retryable: false } });
  expect(updated.modelStates!["test-model"]!.nextRetryAfter).toBe(0);
});

test("Manager_MarkResult_TransientErrorCooldownDefault", () => {
  const tm = withAuths("claude", "", auth({ id: "auth-transient-default", provider: "claude" }));
  const state = markOne(tm, { authId: "auth-transient-default", model: "m", error: { httpStatus: 502, message: "bad gateway", retryable: false } }).modelStates!.m!;
  expect(state.nextRetryAfter - tm.clock.now()).toBe(60_000);
});

test("Manager_MarkResult_TransientErrorCooldownDisabled", () => {
  setTransientErrorCooldownSeconds(-1);
  const tm = withAuths("claude", "", auth({ id: "model-auth", provider: "claude" }), auth({ id: "auth-level", provider: "claude" }));
  expect(markOne(tm, { authId: "model-auth", model: "m", error: { httpStatus: 502, message: "bad gateway", retryable: false } }).modelStates!.m!.nextRetryAfter).toBe(0);
  expect(markOne(tm, { authId: "auth-level", model: "", error: { httpStatus: 503, message: "unavailable", retryable: false } }).nextRetryAfter).toBe(0);
});

test("Manager_MarkResult_TransientErrorCooldownDoesNotDisableAuthErrors", () => {
  setTransientErrorCooldownSeconds(-1);
  const tm = withAuths("claude", "", auth({ id: "auth-transient-auth-error", provider: "claude" }));
  const state = markOne(tm, { authId: "auth-transient-auth-error", model: "m", error: { httpStatus: 403, message: "forbidden", retryable: false } }).modelStates!.m!;
  expect(state.nextRetryAfter - tm.clock.now()).toBe(30 * Minute);
});

test("Manager_MarkResult_RespectsAuthDisableCoolingOverride_On403", () => {
  const tm = withAuths("claude", "test-model-403", auth({ id: "auth-403", provider: "claude", metadata: { disable_cooling: true } }));
  expect(markOne(tm, { authId: "auth-403", model: "test-model-403", error: { httpStatus: 403, message: "forbidden", retryable: false } }).modelStates!["test-model-403"]!.nextRetryAfter).toBe(0);
  expect(tm.registry.getModelCount("test-model-403")).toBeGreaterThan(0);
});

test("Manager_MarkResult_CloudflareChallenge_On403", () => {
  const tm = withAuths("claude", "test-model-cf-403", auth({ id: "auth-cf-403", provider: "claude" }));
  const state = markOne(tm, { authId: "auth-cf-403", model: "test-model-cf-403", error: { httpStatus: 403, message: "cf-mitigated: challenge", retryable: false } }).modelStates!["test-model-cf-403"]!;
  const diff = state.nextRetryAfter - tm.clock.now();
  expect(diff).toBeGreaterThanOrEqual(5000);
  expect(diff).toBeLessThanOrEqual(25_000);
  expect(state.statusMessage).toBe("cloudflare challenge");
  expect(tm.registry.isModelSuspendedForClient("auth-cf-403", "test-model-cf-403")).toBe(true);
});

function disableCoolingManager(id: string, model: string, err: unknown, retry = 0, maxWait = 0) {
  const executor = fallbackExecutor("claude", { execute: { [id]: err } });
  const tm = newManager();
  tm.manager.setRetryConfig(retry, maxWait, 0);
  tm.manager.registerExecutor(executor);
  registerModels(tm.registry, id, "claude", model);
  tm.manager.register(auth({ id, provider: "claude", metadata: { disable_cooling: true } }));
  return { tm, executor };
}

test("Manager_Execute_DisableCooling_DoesNotBlackoutAfter403", async () => {
  const { tm } = disableCoolingManager("auth-403-exec", "m", new AuthManagerError("", "forbidden", { httpStatus: 403 }));
  expect(statusCodeOf(await rejection(tm.manager.execute(["claude"], req("m"), opts())))).toBe(403);
  expect(statusCodeOf(await rejection(tm.manager.execute(["claude"], req("m"), opts())))).toBe(403);
});

test("Manager_Execute_DisableCooling_DoesNotBlackoutAfter429RetryAfter", async () => {
  const { tm } = disableCoolingManager("auth-429-exec", "m", new StatusError(429, "quota exhausted", { retryAfterMs: 2 * Minute }));
  expect(statusCodeOf(await rejection(tm.manager.execute(["claude"], req("m"), opts())))).toBe(429);
  expect(statusCodeOf(await rejection(tm.manager.execute(["claude"], req("m"), opts())))).toBe(429);
});

test("Manager_Execute_DisableCooling_RetriesAfter429RetryAfter", async () => {
  const { tm, executor } = disableCoolingManager("auth-429-retryafter-exec", "m", new StatusError(429, "quota exhausted", { retryAfterMs: 5 }), 3, 100);
  expect(statusCodeOf(await rejection(tm.manager.execute(["claude"], req("m"), opts())))).toBe(429);
  expect(executor.executeCalls.length).toBe(4);
});

test("Manager_RequestScopedErrorStopsCredentialFallbackWithoutSuspendingAuth", async () => {
  const incomplete = () => new StatusError(408, "stream error: stream disconnected before completion: stream closed before response.completed", { requestScoped: true });
  const messageTooBig = () => new StatusError(413, `{"error":{"message":"upstream websocket message too big","type":"invalid_request_error","code":"message_too_big"}}`, { requestScoped: true });
  const e = (status: number, message: string) => () => new AuthManagerError("", message, { httpStatus: status });
  const invalidRequest = e(400, `{"error":{"type":"invalid_request_error","code":"invalid_value","message":"Invalid input."}}`);
  const badRequest = e(400, `{"error":{"type":"bad_request_error","code":"invalid_value","message":"Bad input."}}`);
  const cyberPolicy = e(502, `{"error":{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk."}}`);
  const tooLarge = e(413, `{"error":{"code":"message_too_big","message":"upstream websocket message too big"}}`);
  const plainBadRequest = e(400, "bad request");
  const conflict = e(409, `{"error":{"type":"conflict_error","code":"conflict","message":"request conflict"}}`);
  const contextLength = e(502, `{"error":{"type":"server_error","code":"context_length_exceeded","message":"input too long"}}`);
  const invalidRequestType = e(502, `{"body":{"error":{"type":"invalid_request","message":"invalid input"}}}`);
  const itemNotPersisted = e(404, requestScopedNotFoundMessage);
  const cases: Array<{ name: string; stream?: boolean; afterPayload?: boolean; err: () => Error; status: number }> = [
    { name: "non-streaming incomplete", err: incomplete, status: 408 },
    { name: "streaming incomplete", stream: true, err: incomplete, status: 408 },
    { name: "streaming codex websocket message too big", stream: true, err: messageTooBig, status: 413 },
    { name: "non-streaming invalid request", err: invalidRequest, status: 400 },
    { name: "streaming invalid request", stream: true, err: invalidRequest, status: 400 },
    { name: "non-streaming bad request", err: badRequest, status: 400 },
    { name: "streaming bad request", stream: true, err: badRequest, status: 400 },
    { name: "streaming cyber policy", stream: true, err: cyberPolicy, status: 502 },
    { name: "non-streaming message too big", err: tooLarge, status: 413 },
    { name: "streaming message too big", stream: true, err: tooLarge, status: 413 },
    { name: "non-streaming plain bad request", err: plainBadRequest, status: 400 },
    { name: "streaming plain bad request", stream: true, err: plainBadRequest, status: 400 },
    { name: "non-streaming conflict", err: conflict, status: 409 },
    { name: "streaming conflict", stream: true, err: conflict, status: 409 },
    { name: "streaming conflict after payload", stream: true, afterPayload: true, err: conflict, status: 409 },
    { name: "non-streaming context length behind bad gateway", err: contextLength, status: 502 },
    { name: "streaming context length behind bad gateway", stream: true, err: contextLength, status: 502 },
    { name: "streaming invalid request type behind bad gateway", stream: true, err: invalidRequestType, status: 502 },
    { name: "non-streaming item not persisted", err: itemNotPersisted, status: 404 },
    { name: "streaming item not persisted", stream: true, err: itemNotPersisted, status: 404 },
    { name: "streaming item not persisted after payload", stream: true, afterPayload: true, err: itemNotPersisted, status: 404 },
  ];
  for (const tc of cases) {
    const errors = tc.afterPayload ? { streamTail: { "aa-bad-auth": tc.err() } } : tc.stream ? { streamFirst: { "aa-bad-auth": tc.err() } } : { execute: { "aa-bad-auth": tc.err() } };
    const executor = fallbackExecutor("codex", errors);
    const tm = badGoodManager("codex", "gpt-5.5", executor, 2);
    let err: unknown;
    if (tc.stream) {
      try {
        err = (await drain(await tm.manager.executeStream(["codex"], req("gpt-5.5"), opts({ stream: true })))).error;
      } catch (thrown) {
        err = thrown;
      }
    } else {
      err = await rejection(tm.manager.execute(["codex"], req("gpt-5.5"), opts()));
    }
    expect({ name: tc.name, status: statusCodeOf(err) }).toEqual({ name: tc.name, status: tc.status });
    expect({ name: tc.name, calls: tc.stream ? executor.streamCalls : executor.executeCalls }).toEqual({ name: tc.name, calls: ["aa-bad-auth"] });
    const bad = tm.manager.getById("aa-bad-auth")!;
    expect({ name: tc.name, unavailable: bad.unavailable, model: bad.modelStates?.["gpt-5.5"]?.unavailable ?? false }).toEqual({ name: tc.name, unavailable: false, model: false });
  }
});

test("Manager_UnknownUpstreamErrorRotatesAndPenalizesModelOnly", async () => {
  const model = "gemini-3.6-pro";
  const sibling = "gemini-3.6-flash";
  const executor = fallbackExecutor("gemini", { execute: { "aa-bad-auth": new AuthManagerError("", `{"error":{"code":500,"message":"Internal error encountered.","status":"UNKNOWN"}}`, { httpStatus: 500 }) } });
  const tm = newManager();
  tm.manager.setRetryConfig(3, 30_000, 0);
  tm.manager.registerExecutor(executor);
  for (const id of ["aa-bad-auth", "bb-good-auth"]) {
    registerModels(tm.registry, id, "gemini", model, sibling);
    tm.manager.register(auth({ id, provider: "gemini" }));
  }
  expect((await tm.manager.execute(["gemini"], req(model), opts())).payload).toBe("bb-good-auth");
  expect(executor.executeCalls).toEqual(["aa-bad-auth", "bb-good-auth"]);
  const bad = tm.manager.getById("aa-bad-auth")!;
  expect(bad.modelStates![model]!.nextRetryAfter).not.toBe(0);
  expect(isAuthBlockedForModel(bad, model, tm.clock.now()).blocked).toBe(true);
  expect(isAuthBlockedForModel(bad, sibling, tm.clock.now()).blocked).toBe(false);
});

test("Manager_MarkResult_RequestScopedNotFoundDoesNotCooldownAuth", () => {
  const tm = withAuths("openai", "", auth({ id: "auth-1", provider: "openai" }));
  const updated = markOne(tm, { authId: "auth-1", provider: "openai", model: "gpt-4.1", error: { httpStatus: 404, message: requestScopedNotFoundMessage, retryable: false } });
  expect(updated.unavailable).toBe(false);
  expect(updated.nextRetryAfter).toBe(0);
  const state = updated.modelStates?.["gpt-4.1"];
  if (state) expect(state.unavailable || state.nextRetryAfter !== 0).toBe(false);
});

function countManager(id: string, model: string, err: unknown) {
  const executor = fallbackExecutor("claude", { count: { [id]: err } });
  const tm = newManager();
  tm.manager.registerExecutor(executor);
  registerModels(tm.registry, id, "claude", model);
  tm.manager.register(auth({ id, provider: "claude" }));
  const results: ExecutionResult[] = [];
  const original = tm.manager.markResult.bind(tm.manager);
  tm.manager.markResult = (result) => {
    results.push(result);
    original(result);
  };
  return { tm, results };
}

test("Manager_ExecuteCount_GenericRouteNotFoundDoesNotSuspendModel", async () => {
  const model = "count-route-not-found-model";
  const { tm, results } = countManager("count-route-not-found-auth", model, new AuthManagerError("", "404 page not found", { httpStatus: 404 }));
  await rejection(tm.manager.executeCount(["claude"], req(model), opts()));
  const updated = tm.manager.getById("count-route-not-found-auth")!;
  expect(updated.unavailable).toBe(false);
  expect(updated.modelStates?.[model]?.unavailable ?? false).toBe(false);
  expect(results.filter((r) => !r.success).length).toBe(0);
  expect(tm.registry.getModelCount(model)).toBe(1);
  expect((await tm.manager.execute(["claude"], req(model), opts())).payload).toBe("count-route-not-found-auth");
});

test("Manager_ExecuteCount_ExplicitModelNotFoundSuspendsModel", async () => {
  const model = "count-explicitly-missing-model";
  const { tm, results } = countManager(
    "count-model-not-found-auth",
    model,
    new AuthManagerError("model_not_found", `{"type":"error","error":{"type":"not_found_error","message":"model count-explicitly-missing-model was not found"}}`, { httpStatus: 404 }),
  );
  await rejection(tm.manager.executeCount(["claude"], req(model), opts()));
  const state = tm.manager.getById("count-model-not-found-auth")!.modelStates![model]!;
  expect(state.unavailable).toBe(true);
  expect(state.lastError?.code).toBe("model_not_found");
  expect(results.length).toBe(1);
  expect(results[0]!.error?.code).toBe("model_not_found");
  expect(state.nextRetryAfter - tm.clock.now()).toBe(12 * Hour);
  expect(tm.registry.getModelCount(model)).toBe(0);
});

test("IsCountTokensEndpointNotFoundError", () => {
  const e = (message: string, status = 404, code = "") => new AuthManagerError(code, message, { httpStatus: status });
  const cases: Array<{ name: string; err: unknown; model?: string; want: boolean }> = [
    { name: "empty router 404", err: e(""), want: true },
    { name: "plain router 404", err: e("404 page not found"), want: true },
    { name: "wrapped router 404", err: e("upstream request failed: 404 page not found"), want: true },
    { name: "fastapi route 404", err: e(`{"detail":"Not Found"}`), want: true },
    { name: "problem details route 404", err: e(`{"title":"Not Found","status":404}`), want: true },
    { name: "nested generic route 404", err: e(`{"error":{"type":"not_found_error","message":"Not Found"}}`), want: true },
    { name: "generic model api route 404", err: e(`{"type":"not_found_error","title":"Model API","detail":"Not Found"}`), want: true },
    { name: "generic model metadata route 404", err: e(`{"error":{"type":"not_found_error","message":"model metadata route not found"}}`), want: true },
    { name: "generic model provider 404", err: e(`{"error":{"type":"not_found_error","message":"model provider was not found"}}`), want: true },
    { name: "generic route with misleading metadata", err: e(`{"message":"Not Found","request_id":"model_not_found"}`), want: true },
    { name: "express count route 404", err: e("Cannot POST /v1/messages/count_tokens"), want: true },
    { name: "html route 404", err: e("<html><title>404 Not Found</title></html>"), want: true },
    { name: "structured model 404", err: e(`{"error":{"type":"not_found_error","message":"model claude-missing was not found"}}`), want: false },
    { name: "anthropic exact model reference", err: e(`{"error":{"type":"not_found_error","message":"model: claude-missing"}}`), want: false },
    { name: "anthropic model reference with thinking suffix", err: e(`{"error":{"type":"not_found_error","message":"model: claude-missing"}}`), model: "claude-missing(high)", want: false },
    { name: "requested model does not exist", err: e(`{"error":{"type":"not_found_error","message":"The requested model does not exist"}}`), want: false },
    { name: "requested quoted model could not be found", err: e(`{"error":{"type":"not_found_error","message":"The requested model 'foo' could not be found"}}`), model: "foo", want: false },
    { name: "problem details model type uri", err: e(`{"type":"https://example.com/problems/model-not-found","title":"Not Found","status":404}`), want: false },
    { name: "structured model error string", err: e(`{"error":"model claude-missing does not exist"}`), want: false },
    { name: "model code with generic message", err: e(`{"message":"Not Found","code":"model_not_found","model":"claude-missing"}`), want: false },
    { name: "typed model not found code", err: e("Not Found", 404, "model_not_found"), want: false },
    { name: "typed wrapper with structured model code", err: e(`{"error":{"code":"model_not_found","message":"Not Found"}}`, 404, "not_found"), want: false },
    { name: "wrapped structured model code", err: Object.assign(new Error("upstream failed", { cause: new StatusError(404, `{"error":{"code":"model_not_found","message":"Not Found"}}`) }), { statusCode: 404 }), want: false },
    { name: "joined structured model code", err: Object.assign(new AggregateError([new Error("upstream failed"), new StatusError(404, `{"error":{"code":"model_not_found","message":"Not Found"}}`)]), { statusCode: 404 }), want: false },
    { name: "outer generic inner model 404", err: e(`{"message":"Not Found","error":{"type":"not_found_error","message":"model claude-missing does not exist"}}`), want: false },
    { name: "unstructured model text", err: e("model claude-missing was not found"), want: true },
    { name: "non 404", err: e("404 page not found", 500), want: false },
  ];
  for (const tc of cases) {
    expect({ name: tc.name, got: isCountTokensEndpointNotFoundError(tc.err, tc.model ?? "claude-missing") }).toEqual({ name: tc.name, got: tc.want });
  }
});

test("Manager_Execute_GenericRouteNotFoundStillSuspendsModel", async () => {
  const model = "messages-route-not-found-model";
  const executor = fallbackExecutor("claude", { execute: { "messages-route-not-found-auth": new AuthManagerError("", "404 page not found", { httpStatus: 404 }) } });
  const tm = newManager();
  tm.manager.registerExecutor(executor);
  registerModels(tm.registry, "messages-route-not-found-auth", "claude", model);
  tm.manager.register(auth({ id: "messages-route-not-found-auth", provider: "claude" }));
  await rejection(tm.manager.execute(["claude"], req(model), opts()));
  const state = tm.manager.getById("messages-route-not-found-auth")!.modelStates![model]!;
  expect(state.unavailable).toBe(true);
  expect(state.nextRetryAfter).not.toBe(0);
});

test("Manager_RequestScopedNotFoundStopsRetryWithoutSuspendingAuth", async () => {
  const notFound = new AuthManagerError("", requestScopedNotFoundMessage, { httpStatus: 404 });
  const executor = fallbackExecutor("openai", { execute: { "aa-bad-auth": notFound } });
  const tm = badGoodManager("openai", "gpt-4.1", executor);
  const err = await rejection(tm.manager.execute(["openai"], req("gpt-4.1"), opts()));
  expect(err).toBe(notFound);
  expect(executor.executeCalls).toEqual(["aa-bad-auth"]);
  const bad = tm.manager.getById("aa-bad-auth")!;
  expect(bad.unavailable).toBe(false);
  expect(bad.nextRetryAfter).toBe(0);
});

test("Manager_MarkResult_RequestFaultBodyDoesNotCooldownModelOrAuth", () => {
  const tm = withAuths("deepseek", "", auth({ id: "auth-request-fault", provider: "deepseek" }));
  let updated = markOne(tm, { authId: "auth-request-fault", provider: "deepseek", model: "deepseek-chat", error: { httpStatus: 401, message: `{"error":{"message":"Invalid request parameter","type":"invalid_request_error"}}`, retryable: false } });
  expect(updated.unavailable).toBe(false);
  expect(updated.nextRetryAfter).toBe(0);
  updated = markOne(tm, { authId: "auth-request-fault", provider: "deepseek", model: "deepseek-chat", error: { code: ErrorCodeRequestScoped, httpStatus: 401, message: "explicit request fault", retryable: false } });
  expect(updated.unavailable || updated.nextRetryAfter !== 0).toBe(false);
});

// selector.go sanitizer: natural-language secrets (consumed by the server's permanent OAuth failure classification).
test("SanitizeUpstreamErrorSummary redacts natural-language secrets (selector.go sanitizerNaturalSecretPattern)", () => {
  expect(sanitizeUpstreamErrorSummary("Refresh credential has already been consumed; sign in again.")).toBe("Refresh credential: [REDACTED] sign in again.");
  expect(sanitizeUpstreamErrorSummary("invalid api key sk-abcdefgh1234")).toBe("invalid token: [REDACTED]");
});
