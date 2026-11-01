// Ported from: sdk/cliproxy/auth/conductor_issue7017_test.go, sdk/cliproxy/auth/conductor_issue7017_execution_test.go
// Ported from: sdk/cliproxy/auth/conductor_issue7017_review_r1_test.go, sdk/cliproxy/auth/conductor_issue7017_review_r3_test.go
// Ported from: sdk/cliproxy/auth/conductor_issue7017_review_r4_test.go, sdk/cliproxy/auth/conductor_issue7017_review_r5_test.go
// Skipped cases: the CooldownSnapshotForAuth / newCooldownView assertions of TestIssue7017MarkResultTurnRateLimitCoolsModelWithoutQuota
// and TestIssue7017CooldownViewTransient429IsNotQuota (cooldown views feed the Management API, not ported);
// TestIssue7017RetryAfterFromErrorPrefersHomeAggregate, TestIssue7017HomeRequestScopedStopKeepsTrustedRetryAfter,
// TestHasTrustedRetryDeadlineCoversSafeHeaderCarriers and all of review_r6 (Home dispatcher not ported);
// TestTrustedRetryAfterIdentityHintMayDifferFromDeadline, TestTrustedRetryAfterDeadlineDecays and
// TestIssue7017ExpiredTrustedWrapperFallsBackToProviderHint (the trustedRetryAfterError wrapper is not ported: the manager
// hands back the original StatusError and safeResponseHeaders reads its retryAfterMs). MarkUpstreamAttempt markers are a
// Go context mechanic; the marked-attempt cases run the same executor without them.
import { afterEach, expect, test } from "bun:test";
import {
  ErrorCodeTransientRateLimit,
  MinQuotaCooldownFloorMs,
  applyAuthFailureState,
  isTransientRateLimitResultError,
  resultErrorFromError,
  safeResponseHeaders,
  setQuotaCooldownDisabled,
  setTransientErrorCooldownSeconds,
} from "../../../src/auth/manager/index.ts";
import type { Auth, ModelState } from "../../../src/auth/types.ts";
import { Hour, auth, drain, fakeExecutor, newManager, opts, registerModels, rejection, req, statusError, streamOf, type TestManager } from "./helpers.ts";

afterEach(() => {
  setQuotaCooldownDisabled(false);
  setTransientErrorCooldownSeconds(0);
});

const turnBody = `{"error":{"type":"rate_limit_error","code":"turn_rate_limit_exceeded","message":"Codex is at capacity, please try again later"}}`;
const hintError = (hintMs: number | undefined, credentialScoped = false) => statusError(429, turnBody, { transientRateLimit: true, retryAfterMs: hintMs, credentialScoped });
const transientResult = () => ({ code: ErrorCodeTransientRateLimit, message: turnBody, retryable: true, httpStatus: 429 });

function modelState(partial: Partial<ModelState>): ModelState {
  return { status: "active", unavailable: false, nextRetryAfter: 0, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: 0, ...partial };
}

function setup(retry: number, maxWaitMs: number, failure: () => unknown, ...ids: string[]) {
  const tm = newManager();
  tm.manager.setRetryConfig(retry, maxWaitMs, 0);
  const calls: string[] = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "codex",
      execute: (a) => {
        calls.push(a.id);
        throw failure();
      },
      count: (a) => {
        calls.push(a.id);
        throw failure();
      },
      stream: (a) => {
        calls.push(a.id);
        throw failure();
      },
    }),
  );
  for (const id of ids) {
    registerModels(tm.registry, id, "codex", "gpt-6.1-sol", "gpt-6-astra");
    tm.manager.register(auth({ id, provider: "codex", metadata: { type: "codex" } }), { skipPersist: true });
  }
  return { tm, calls };
}

// --- conductor_issue7017_test.go ---

test("Issue7017ResultErrorFromErrorMarksTransientRateLimit", () => {
  const resultErr = resultErrorFromError(hintError(undefined))!;
  expect(resultErr.code).toBe(ErrorCodeTransientRateLimit);
  expect(resultErr.httpStatus).toBe(429);
  expect(isTransientRateLimitResultError(resultErr)).toBe(true);
});

test("Issue7017MarkResultTurnRateLimitCoolsModelWithoutQuota", () => {
  const tm = newManager();
  tm.manager.register(
    auth({ id: "auth-turn-limit", provider: "codex", metadata: { type: "codex" }, modelStates: { "gpt-6.1-sol": modelState({}), "gpt-6-astra": modelState({}) } }),
    { skipPersist: true },
  );
  const before = tm.clock.now();
  tm.manager.markResult({ authId: "auth-turn-limit", provider: "codex", model: "gpt-6.1-sol", success: false, retryAfterMs: 256_000, error: transientResult() });
  const got = tm.manager.getById("auth-turn-limit")!;
  const state = got.modelStates!["gpt-6.1-sol"]!;
  expect(state.unavailable).toBe(true);
  expect(state.nextRetryAfter).toBe(before + 256_000);
  expect(state.quota.exceeded).toBe(false);
  expect(state.quota.reason).not.toBe("quota");
  expect(state.quota.backoffLevel ?? 0).toBe(0);
  expect(got.quota.exceeded).toBe(false);
  expect(["quota", "credential_quota"]).not.toContain(got.quota.reason ?? "");
  const sibling = got.modelStates!["gpt-6-astra"]!;
  expect(sibling.unavailable || sibling.quota.exceeded).toBe(false);
});

test("Issue7017MarkResultTurnRateLimitNoHintUsesTransientCooldown", () => {
  const tm = newManager();
  tm.manager.register(auth({ id: "auth-turn-limit-nohint", provider: "codex", metadata: { type: "codex" } }), { skipPersist: true });
  const before = tm.clock.now();
  tm.manager.markResult({ authId: "auth-turn-limit-nohint", provider: "codex", model: "gpt-6.1-sol", success: false, error: transientResult() });
  const state = tm.manager.getById("auth-turn-limit-nohint")!.modelStates!["gpt-6.1-sol"]!;
  expect(state.quota.exceeded).toBe(false);
  expect(state.quota.backoffLevel ?? 0).toBe(0);
  expect(state.nextRetryAfter).toBeGreaterThanOrEqual(before + 30_000);
  expect(state.nextRetryAfter).toBeLessThanOrEqual(before + 180_000);
});

test("Issue7017AuthLevelTurnRateLimitIsNotQuota", () => {
  const target = auth({ id: "auth-turn-level" });
  const before = 1_000_000;
  applyAuthFailureState(target, transientResult(), 120_000, before, false);
  expect(target.quota.exceeded).toBe(false);
  expect(target.quota.reason).not.toBe("quota");
  expect(target.nextRetryAfter).toBe(before + 120_000);
});

// --- conductor_issue7017_execution_test.go ---

test("Issue7017ExecuteSingleCredentialTerminalRetryAfter", async () => {
  const { tm, calls } = setup(0, 0, () => hintError(256_000), "turn-single");
  const err = await rejection(tm.manager.execute(["codex"], req("gpt-6.1-sol"), opts()));
  expect(safeResponseHeaders(err)?.get("Retry-After")).toBe("256");
  expect(calls.length).toBe(1);
  const state = tm.manager.getById("turn-single")!.modelStates!["gpt-6.1-sol"]!;
  expect(state.quota.exceeded).toBe(false);
  // A follow-up inside the deadline advertises the locally computed remaining time without reaching upstream.
  const followUp = await rejection(tm.manager.execute(["codex"], req("gpt-6.1-sol"), opts()));
  expect(safeResponseHeaders(followUp)?.get("Retry-After") ?? "").not.toBe("");
  expect(calls.length).toBe(1);
});

test("Issue7017ExecuteStreamMultiCredentialFailsOver", async () => {
  const { tm, calls } = setup(0, 0, () => hintError(256_000), "turn-a", "turn-b");
  const result = await tm.manager.executeStream(["codex"], req("gpt-6.1-sol"), opts({ stream: true })).catch((err) => ({ thrown: err }));
  const err = "thrown" in result ? result.thrown : (await drain(result)).error;
  expect(err).toBeDefined();
  expect(calls.length).toBe(2);
  expect(calls[0]).not.toBe(calls[1]);
  expect(safeResponseHeaders(err)?.get("Retry-After")).toBe("256");
  for (const id of ["turn-a", "turn-b"]) {
    const got = tm.manager.getById(id)!;
    expect(got.modelStates!["gpt-6.1-sol"]!.quota.exceeded).toBe(false);
    const sibling = got.modelStates?.["gpt-6-astra"];
    if (sibling) expect(sibling.unavailable || sibling.quota.exceeded).toBe(false);
  }
});

test("Issue7017ExecuteCountCoolsWithoutQuota", async () => {
  const { tm } = setup(0, 0, () => hintError(60_000), "turn-count");
  const err = await rejection(tm.manager.executeCount(["codex"], req("gpt-6.1-sol"), opts()));
  expect(safeResponseHeaders(err)?.get("Retry-After")).toBe("60");
  expect(tm.manager.getById("turn-count")!.modelStates!["gpt-6.1-sol"]!.quota.exceeded).toBe(false);
});

test("Issue7017CredentialScopedTransientFallsBackToQuota", () => {
  const tm = newManager();
  tm.manager.register(auth({ id: "turn-scoped", provider: "codex", metadata: { type: "codex" } }), { skipPersist: true });
  const resultErr = resultErrorFromError(hintError(60_000, true))!;
  expect(resultErr.code).not.toBe(ErrorCodeTransientRateLimit);
  tm.manager.markResult({ authId: "turn-scoped", provider: "codex", model: "gpt-6.1-sol", success: false, retryAfterMs: 60_000, credentialScope: true, error: resultErr });
  const got = tm.manager.getById("turn-scoped")!;
  expect(got.quota.exceeded).toBe(true);
  expect(got.quota.reason).toBe("credential_quota");
});

function liveQuotaAuth(tm: TestManager, id: string, future: number): void {
  tm.manager.register(
    auth({
      id,
      provider: "codex",
      metadata: { type: "codex" },
      modelStates: { "gpt-6.1-sol": modelState({ status: "error", unavailable: true, nextRetryAfter: future, quota: { exceeded: true, reason: "quota", nextRecoverAt: future, backoffLevel: 2 } }) },
    }),
    { skipPersist: true },
  );
}

test("Issue7017TransientZeroCooldownKeepsQuotaDeadline", () => {
  setTransientErrorCooldownSeconds(-1);
  const tm = newManager();
  const future = tm.clock.now() + 2 * Hour;
  liveQuotaAuth(tm, "turn-zero-cooldown", future);
  tm.manager.markResult({ authId: "turn-zero-cooldown", provider: "codex", model: "gpt-6.1-sol", success: false, error: transientResult() });
  const state = tm.manager.getById("turn-zero-cooldown")!.modelStates!["gpt-6.1-sol"]!;
  expect(state.quota).toEqual({ exceeded: true, reason: "quota", nextRecoverAt: future, backoffLevel: 2 });
  expect(state.nextRetryAfter).toBe(future);
  expect(state.unavailable).toBe(true);
});

// --- conductor_issue7017_review_r1_test.go ---

test("Issue7017ExecuteMarkedAttemptKeepsTrustedRetryAfter", async () => {
  const { tm } = setup(0, 0, () => hintError(256_000), "turn-marked");
  const err = await rejection(tm.manager.execute(["codex"], req("gpt-6.1-sol"), opts()));
  expect(safeResponseHeaders(err)?.get("Retry-After")).toBe("256");
});

test("Issue7017ExecuteStreamMarkedAttemptKeepsTrustedRetryAfter", async () => {
  const { tm } = setup(0, 0, () => hintError(256_000), "turn-marked-stream");
  const err = await rejection(tm.manager.executeStream(["codex"], req("gpt-6.1-sol"), opts({ stream: true })));
  expect(safeResponseHeaders(err)?.get("Retry-After")).toBe("256");
});

test("Issue7017ExecuteStreamBootstrapMarkedAttemptKeepsTrustedRetryAfter", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  tm.manager.registerExecutor(fakeExecutor({ identifier: "codex", stream: () => streamOf([hintError(256_000)], new Headers({ "Content-Type": "text/event-stream" })) }));
  registerModels(tm.registry, "turn-marked-bootstrap", "codex", "gpt-6.1-sol");
  tm.manager.register(auth({ id: "turn-marked-bootstrap", provider: "codex" }), { skipPersist: true });
  const result = await tm.manager.executeStream(["codex"], req("gpt-6.1-sol"), opts({ stream: true }));
  const { error } = await drain(result);
  expect(error).toBeDefined();
  expect(safeResponseHeaders(error)?.get("Retry-After")).toBe("256");
});

test("Issue7017MarkResultExplicitZeroHintSkipsCooldown", () => {
  const tm = newManager();
  tm.manager.register(auth({ id: "turn-zero-hint", provider: "codex", metadata: { type: "codex" } }), { skipPersist: true });
  tm.manager.markResult({ authId: "turn-zero-hint", provider: "codex", model: "gpt-6.1-sol", success: false, retryAfterMs: 0, error: transientResult() });
  const state = tm.manager.getById("turn-zero-hint")!.modelStates!["gpt-6.1-sol"]!;
  expect(state.unavailable).toBe(false);
  expect(state.nextRetryAfter).toBe(0);
  expect(state.quota.exceeded).toBe(false);
});

test("Issue7017TransientZeroHintKeepsQuotaDeadline", () => {
  const tm = newManager();
  const future = tm.clock.now() + 2 * Hour;
  liveQuotaAuth(tm, "turn-zero-hint-quota", future);
  tm.manager.markResult({ authId: "turn-zero-hint-quota", provider: "codex", model: "gpt-6.1-sol", success: false, retryAfterMs: 0, error: transientResult() });
  const state = tm.manager.getById("turn-zero-hint-quota")!.modelStates!["gpt-6.1-sol"]!;
  expect(state.nextRetryAfter).toBe(future);
  expect(state.unavailable).toBe(true);
  expect(state.quota).toEqual({ exceeded: true, reason: "quota", nextRecoverAt: future, backoffLevel: 2 });
});

// --- conductor_issue7017_review_r3_test.go ---

test("Issue7017ExplicitZeroHintRetriesImmediately", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(1, 0, 0);
  let calls = 0;
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "codex",
      execute: () => {
        calls++;
        if (calls === 1) throw hintError(0);
        return { payload: "ok" };
      },
    }),
  );
  registerModels(tm.registry, "turn-zero-retry", "codex", "gpt-6.1-sol", "gpt-6-astra");
  tm.manager.register(auth({ id: "turn-zero-retry", provider: "codex", metadata: { type: "codex" } }), { skipPersist: true });
  const resp = await tm.manager.execute(["codex"], req("gpt-6.1-sol"), opts());
  expect(resp.payload).toBe("ok");
  expect(calls).toBe(2);
});

// --- conductor_issue7017_review_r4_test.go / review_r5_test.go ---

function waitSetup(target: Auth, model: string): TestManager {
  const tm = newManager();
  registerModels(tm.registry, target.id, "codex", model, "gpt-6-astra");
  tm.manager.register(target, { skipPersist: true });
  return tm;
}

const closestWait = (tm: TestManager, id: string, model: string) => tm.manager.closestCooldownWait(["codex"], model, 0, 5, 429, new Set([id]));

test("Issue7017SiblingQuotaDoesNotBlockTransientZeroWait", () => {
  const model = "gpt-6.1-sol";
  const now = Date.parse("2026-10-28T12:00:00Z");
  const future = now + Hour;
  const tm = waitSetup(
    auth({
      id: "turn-sibling-quota",
      provider: "codex",
      quota: { exceeded: true, reason: "quota", nextRecoverAt: future, backoffLevel: 1 },
      modelStates: {
        [model]: modelState({ status: "error", lastError: transientResult() }),
        "gpt-6-astra": modelState({ status: "error", unavailable: true, nextRetryAfter: future, quota: { exceeded: true, reason: "quota", nextRecoverAt: future, backoffLevel: 1 } }),
      },
    }),
    model,
  );
  expect(closestWait(tm, "turn-sibling-quota", model)).toEqual({ wait: 0, found: true });
});

test("Issue7017PositiveTransientHintSkipsQuotaFloor", () => {
  const model = "gpt-6.1-sol";
  const now = Date.parse("2026-10-28T12:00:00Z");
  const tm = waitSetup(
    auth({ id: "turn-positive-hint", provider: "codex", modelStates: { [model]: modelState({ status: "error", unavailable: true, nextRetryAfter: now + 8000, lastError: transientResult() }) } }),
    model,
  );
  const { wait, found } = closestWait(tm, "turn-positive-hint", model);
  expect(found).toBe(true);
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThanOrEqual(8000);
});

test("Issue7017ExpiredOwnQuotaDoesNotBlockTransientRetry", () => {
  const model = "gpt-6.1-sol";
  const now = Date.parse("2026-10-28T12:00:00Z");
  const tm = waitSetup(
    auth({
      id: "turn-expired-own-quota",
      provider: "codex",
      modelStates: { [model]: modelState({ status: "error", unavailable: true, nextRetryAfter: now + 8000, quota: { exceeded: true, reason: "quota", nextRecoverAt: now - Hour, backoffLevel: 1 }, lastError: transientResult() }) },
    }),
    model,
  );
  const { wait, found } = closestWait(tm, "turn-expired-own-quota", model);
  expect(found).toBe(true);
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThanOrEqual(8000);
});

test("Issue7017LiveOwnQuotaKeepsFloorOverTransient", () => {
  const model = "gpt-6.1-sol";
  const now = Date.parse("2026-10-28T12:00:00Z");
  const tm = waitSetup(
    auth({
      id: "turn-live-own-quota",
      provider: "codex",
      modelStates: { [model]: modelState({ status: "error", unavailable: true, nextRetryAfter: now + 3000, quota: { exceeded: true, reason: "quota", nextRecoverAt: now + 3000, backoffLevel: 1 }, lastError: transientResult() }) },
    }),
    model,
  );
  const { wait, found } = closestWait(tm, "turn-live-own-quota", model);
  expect(found).toBe(true);
  expect(wait).toBeGreaterThanOrEqual(MinQuotaCooldownFloorMs);
});
