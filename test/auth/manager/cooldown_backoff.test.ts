// Ported from: sdk/cliproxy/auth/cooldown_backoff_test.go
// Skipped cases: TestSchedulerPromotesUnknownFailureAfterRetryDeadline (incremental scheduler internals not ported;
// the recovery itself is covered by TestRecoverableUnknownFailuresHaveFiniteCooldown).
import { afterEach, expect, test } from "bun:test";
import { CooldownWaitJitterCapMs, applyAuthFailureState, isAuthBlockedForModel, jitteredCooldownWait, setQuotaCooldownDisabled, setTransientErrorCooldownSeconds, type ExecutionResult } from "../../../src/auth/manager/index.ts";
import { StatusError } from "../../../src/auth/types.ts";
import { auth, baseNow, newManager } from "./helpers.ts";

afterEach(() => {
  setQuotaCooldownDisabled(false);
  setTransientErrorCooldownSeconds(0);
});

function quotaResult(authID: string, model: string): ExecutionResult {
  return { authId: authID, provider: "codex", model, success: false, error: { code: "rate_limit", message: "quota", retryable: true, httpStatus: 429 } };
}

test("MarkResultQuotaBackoffEscalatesOncePerWindow", () => {
  const { manager, clock } = newManager();
  manager.register(auth({ id: "auth-quota-window", provider: "codex", metadata: { type: "codex" } }));

  manager.markResult(quotaResult("auth-quota-window", "gpt-5"));
  const firstState = manager.getById("auth-quota-window")!.modelStates!["gpt-5"]!;
  expect(firstState.quota.backoffLevel).toBe(1);
  expect(firstState.quota.nextRecoverAt).toBeGreaterThan(clock.now());

  // A second in-flight failure lands while the first window is still open.
  manager.markResult(quotaResult("auth-quota-window", "gpt-5"));
  const secondState = manager.getById("auth-quota-window")!.modelStates!["gpt-5"]!;
  expect(secondState.quota.backoffLevel).toBe(1);
  expect(secondState.quota.nextRecoverAt).toBe(firstState.quota.nextRecoverAt);
  expect(secondState.nextRetryAfter).toBe(firstState.nextRetryAfter);
});

test("MarkResultQuotaBackoffEscalatesAfterWindowExpiry", () => {
  const { manager, clock } = newManager();
  const expired = clock.now() - 1000;
  manager.register(
    auth({
      id: "auth-quota-expired",
      provider: "codex",
      metadata: { type: "codex" },
      modelStates: { "gpt-5": { status: StatusError, unavailable: true, nextRetryAfter: expired, quota: { exceeded: true, reason: "quota", nextRecoverAt: expired, backoffLevel: 3 }, updatedAt: 0 } },
    }),
  );
  manager.markResult(quotaResult("auth-quota-expired", "gpt-5"));
  const state = manager.getById("auth-quota-expired")!.modelStates!["gpt-5"]!;
  expect(state.quota.backoffLevel).toBe(4);
  expect(state.quota.nextRecoverAt).toBeGreaterThan(clock.now());
});

test("ApplyAuthFailureStateQuotaBackoffOncePerWindow", () => {
  const now = baseNow;
  const quotaErr = { code: "rate_limit", message: "quota", retryable: false, httpStatus: 429 };
  const a = auth({ id: "auth-level-quota" });

  applyAuthFailureState(a, quotaErr, undefined, now, false);
  expect(a.quota.backoffLevel).toBe(1);
  const firstRecover = a.quota.nextRecoverAt;
  expect(firstRecover).toBe(now + 1000);

  // In-window failure keeps the current window and level.
  applyAuthFailureState(a, quotaErr, undefined, now + 100, false);
  expect(a.quota.backoffLevel).toBe(1);
  expect(a.quota.nextRecoverAt).toBe(firstRecover);

  // A failure after the window expired escalates to the next level.
  applyAuthFailureState(a, quotaErr, undefined, now + 2000, false);
  expect(a.quota.backoffLevel).toBe(2);
  expect(a.quota.nextRecoverAt).toBe(now + 4000);

  // A provider supplied retry hint always takes effect, even in-window (clamped to the floor).
  applyAuthFailureState(a, quotaErr, 10_000, now + 3000, false);
  expect(a.quota.backoffLevel).toBe(2);
  expect(a.quota.nextRecoverAt).toBe(now + 13_000);
});

test("RecoverableUnknownFailuresHaveFiniteCooldown", () => {
  const cases: Array<{ name: string; model: string; resultErr?: { message: string; retryable: boolean } }> = [
    { name: "model failure without error details", model: "gpt-5" },
    { name: "auth failure without status or transport signature", model: "", resultErr: { message: "upstream exploded", retryable: false } },
  ];
  for (const testCase of cases) {
    const { manager, clock } = newManager();
    const id = "auth-unknown-" + testCase.name;
    manager.register(auth({ id, provider: "codex" }));
    manager.markResult({ authId: id, provider: "codex", model: testCase.model, success: false, error: testCase.resultErr });
    const updated = manager.getById(id)!;
    const nextRetryAfter = testCase.model === "" ? updated.nextRetryAfter : updated.modelStates![testCase.model]!.nextRetryAfter;
    expect(nextRetryAfter).not.toBe(0);
    expect(isAuthBlockedForModel(updated, testCase.model, clock.now()).blocked).toBe(true);
    expect(isAuthBlockedForModel(updated, testCase.model, nextRetryAfter + 1).blocked).toBe(false);
  }
});

test("JitteredCooldownWaitBounds", () => {
  const cases = [
    { wait: 1000, maxWait: 0, maxJitter: 250 },
    { wait: 8000, maxWait: 0, maxJitter: 2000 },
    { wait: 30_000, maxWait: 0, maxJitter: 2000 },
    { wait: 1000, maxWait: 30_000, maxJitter: 250 },
    { wait: 29_000, maxWait: 30_000, maxJitter: 1000 },
  ];
  for (const tc of cases) {
    for (let i = 0; i < 200; i++) {
      const got = jitteredCooldownWait(tc.wait, tc.maxWait);
      expect(got).toBeGreaterThanOrEqual(tc.wait);
      expect(got).toBeLessThan(tc.wait + tc.maxJitter);
      if (tc.maxWait > 0) expect(got).toBeLessThanOrEqual(tc.maxWait);
    }
  }
  // maxWait is a hard ceiling: zero headroom disables jitter entirely.
  for (let i = 0; i < 50; i++) expect(jitteredCooldownWait(30_000, 30_000)).toBe(30_000);
  expect(jitteredCooldownWait(0, 60_000)).toBe(0);
  expect(jitteredCooldownWait(-1000, 60_000)).toBe(-1000);
  expect(jitteredCooldownWait(3, 0)).toBe(3);
  expect(CooldownWaitJitterCapMs).toBe(2000);
});
