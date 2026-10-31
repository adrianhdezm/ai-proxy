// Ported from: sdk/cliproxy/auth/conductor_cooldown_monotonic_test.go
// Skipped cases: the "404_then_cloudflare" sub-case of TestManager_ApplyAuthFailureState_PreservesLongerCredentialDeadline is
// run as a plain 403 (Cloudflare challenge detection not ported); the result is the same (the longer 12h deadline is kept).
import { expect, test } from "bun:test";
import { QuotaBackoffBaseMs, canonicalModelKey, existingModelState, isAuthBlockedForModel } from "../../../src/auth/manager/index.ts";
import { Hour, Minute, auth, newManager, registerModels, type TestManager } from "./helpers.ts";

// Later failure writes must never shorten a still-live cooldown; they may only extend it (#5501).

function newCooldownMonotonicManager(...models: string[]): { tm: TestManager; id: string } {
  const tm = newManager();
  const id = "auth-monotonic-" + models[0];
  registerModels(tm.registry, id, "claude", ...models);
  tm.manager.register(auth({ id, provider: "claude" }));
  return { tm, id };
}

test("Manager_MarkResult_CredentialScopeKeepsLongerSiblingDeadline", () => {
  const { tm, id } = newCooldownMonotonicManager("model-a", "model-b");
  const before = tm.clock.now();
  tm.manager.markResult({ authId: id, provider: "claude", model: "model-b", success: false, error: { httpStatus: 401, message: "long 401", retryable: false } });
  const bState = existingModelState(tm.manager.getById(id), "model-b")!;
  expect(bState.nextRetryAfter).toBeGreaterThanOrEqual(before + 25 * Minute);

  // Shorter credential-scoped 429 on model-a must not shorten model-b.
  tm.manager.markResult({ authId: id, provider: "claude", model: "model-a", success: false, retryAfterMs: 5 * Minute, credentialScope: true, error: { httpStatus: 429, message: "credential 429", retryable: false } });
  const updated = tm.manager.getById(id)!;
  expect(existingModelState(updated, "model-b")!.nextRetryAfter).toBeGreaterThanOrEqual(before + 25 * Minute);
  expect(isAuthBlockedForModel(updated, "model-a", before + 6 * Minute).blocked).toBe(false);
  expect(isAuthBlockedForModel(updated, "model-b", before + 6 * Minute).blocked).toBe(true);
});

test("Manager_MarkResult_CredentialScope_DoesNotPromoteSiblingDeadlineToQuota", () => {
  const { tm, id } = newCooldownMonotonicManager("model-a", "model-b");
  const before = tm.clock.now();
  tm.manager.markResult({ authId: id, provider: "claude", model: "model-b", success: false, error: { httpStatus: 404, message: "model not found", retryable: false } });
  tm.manager.markResult({ authId: id, provider: "claude", model: "model-a", success: false, retryAfterMs: 5 * Minute, credentialScope: true, error: { httpStatus: 429, message: "credential 429", retryable: false } });

  const bState1 = existingModelState(tm.manager.getById(id), "model-b")!;
  expect(bState1.nextRetryAfter).toBeGreaterThanOrEqual(before + 11 * Hour);
  expect(bState1.quota.nextRecoverAt).toBeLessThanOrEqual(before + 10 * Minute);

  tm.manager.markResult({ authId: id, provider: "claude", model: "model-b", success: false, retryAfterMs: 5 * Minute, credentialScope: true, error: { httpStatus: 429, message: "credential 429", retryable: false } });
  const snap2 = tm.manager.getById(id)!;
  expect(existingModelState(snap2, "model-a")!.nextRetryAfter).toBeLessThanOrEqual(before + 10 * Minute);
  expect(snap2.quota.nextRecoverAt).toBeLessThanOrEqual(before + 10 * Minute);
  expect(isAuthBlockedForModel(snap2, "model-a", before + 6 * Minute).blocked).toBe(false);
  expect(isAuthBlockedForModel(snap2, "model-b", before + 6 * Minute).blocked).toBe(true);
});

test("Manager_MarkResult_LaterShorterFailureKeepsLongerModelDeadline", () => {
  const seconds: Array<{ name: string; second: (tm: TestManager, id: string) => void }> = [
    {
      name: "401_then_short_429",
      second: (tm, id) => tm.manager.markResult({ authId: id, provider: "claude", model: "model-a", success: false, retryAfterMs: 2 * Minute, error: { httpStatus: 429, message: "short 429", retryable: false } }),
    },
    {
      name: "401_then_transient_500",
      second: (tm, id) => tm.manager.markResult({ authId: id, provider: "claude", model: "model-a", success: false, error: { httpStatus: 500, message: "transient 500", retryable: false } }),
    },
  ];
  for (const tc of seconds) {
    const { tm, id } = newCooldownMonotonicManager("model-a");
    const before = tm.clock.now();
    tm.manager.markResult({ authId: id, provider: "claude", model: "model-a", success: false, error: { httpStatus: 401, message: "long 401", retryable: false } });
    expect(existingModelState(tm.manager.getById(id), "model-a")!.nextRetryAfter, tc.name).toBeGreaterThanOrEqual(before + 25 * Minute);
    tc.second(tm, id);
    expect(existingModelState(tm.manager.getById(id), "model-a")!.nextRetryAfter, tc.name).toBeGreaterThanOrEqual(before + 25 * Minute);
  }
});

// The client-facing registry projection must agree with scheduling: a live credential-wide cooldown
// suspends models that carry no per-model state (#5501).
test("Manager_ClientModelProjection_ReflectsAuthLevelCooldown", () => {
  const { tm, id } = newCooldownMonotonicManager("model-a");
  tm.manager.markResult({ authId: id, provider: "claude", model: "", success: false, error: { httpStatus: 401, message: "credential-wide 401", retryable: false } });
  const snap = tm.manager.getById(id)!;
  expect(snap.unavailable).toBe(true);
  expect(snap.nextRetryAfter).toBeGreaterThanOrEqual(tm.clock.now() + 25 * Minute);
  expect(isAuthBlockedForModel(snap, "model-a", tm.clock.now()).blocked).toBe(true);
  expect(tm.registry.isModelSuspendedForClient(id, "model-a")).toBe(true);
});

test("Manager_ApplyAuthFailureState_PreservesLongerCredentialDeadline", () => {
  const cases = [
    { name: "404_then_invalid_grant", second: { httpStatus: 400, message: "invalid_grant", retryable: false } },
    { name: "404_then_403", second: { httpStatus: 403, message: "just a moment...", retryable: false } },
    { name: "404_then_transient_500", second: { httpStatus: 500, message: "internal server error", retryable: false } },
  ];
  for (const tc of cases) {
    const { tm, id } = newCooldownMonotonicManager("model-a");
    const before = tm.clock.now();
    tm.manager.markResult({ authId: id, provider: "claude", model: "", success: false, error: { httpStatus: 404, message: "credential not found", retryable: false } });
    const snap = tm.manager.getById(id)!;
    expect(snap.unavailable, tc.name).toBe(true);
    expect(snap.nextRetryAfter, tc.name).toBeGreaterThanOrEqual(before + 11 * Hour);
    tm.manager.markResult({ authId: id, provider: "claude", model: "", success: false, error: tc.second });
    expect(tm.manager.getById(id)!.nextRetryAfter, tc.name).toBeGreaterThanOrEqual(before + 11 * Hour);
  }
});

test("Manager_MarkResult_CredentialScopeDoesNotInheritModelQuotaDeadline", () => {
  for (const credentialModel of ["claude-sonnet-5", "claude-fable-5-1"]) {
    const { tm, id } = newCooldownMonotonicManager("claude-fable-5-1", "claude-sonnet-5", "claude-opus-5-5", "claude-sonnet-4");
    for (const model of ["claude-fable-5-1", "claude-sonnet-5", "claude-opus-5-5"]) tm.manager.markResult({ authId: id, provider: "claude", model, success: true });
    const before = tm.clock.now();
    tm.manager.markResult({ authId: id, provider: "claude", model: "claude-fable-5-1", success: false, retryAfterMs: 8 * 24 * Hour, error: { httpStatus: 429, message: "Usage credits are required for this model.", retryable: false } });
    const modelOnly = tm.manager.getById(id)!;
    expect(modelOnly.quota.reason).toBe("quota");
    expect(modelOnly.quota.nextRecoverAt).toBeGreaterThan(before + 7 * 24 * Hour);
    expect(isAuthBlockedForModel(modelOnly, "claude-opus-5-5", before).blocked).toBe(false);

    const credentialRetry = 3 * Hour;
    tm.manager.markResult({ authId: id, provider: "claude", model: credentialModel, success: false, retryAfterMs: credentialRetry, credentialScope: true, error: { httpStatus: 429, message: "shared window rejected", retryable: false } });
    const updated = tm.manager.getById(id)!;
    expect(updated.quota.reason, credentialModel).toBe("credential_quota");
    expect(updated.quota.nextRecoverAt, credentialModel).toBeGreaterThanOrEqual(before + credentialRetry - Hour);
    expect(updated.quota.nextRecoverAt, credentialModel).toBeLessThanOrEqual(before + credentialRetry + Hour);
    expect(isAuthBlockedForModel(updated, "claude-opus-5-5", before + credentialRetry + Minute).blocked, credentialModel).toBe(false);
    const fable = isAuthBlockedForModel(updated, "claude-fable-5-1", before + credentialRetry + Minute);
    expect(fable.blocked, credentialModel).toBe(true);
    expect(fable.next, credentialModel).toBeGreaterThan(before + 7 * 24 * Hour);

    const credentialDeadline = updated.quota.nextRecoverAt;
    tm.manager.markResult({ authId: id, provider: "claude", model: "claude-sonnet-4", success: false, retryAfterMs: 30 * Minute, credentialScope: true, error: { httpStatus: 429, message: "shorter shared window rejection", retryable: false } });
    expect(tm.manager.getById(id)!.quota.nextRecoverAt, credentialModel).toBe(credentialDeadline);
  }
});

test("Manager_MarkResult_CredentialScopeBackoffPersistsAcrossWindows", () => {
  const { tm, id } = newCooldownMonotonicManager("model-a", "model-b");
  tm.manager.markResult({ authId: id, provider: "claude", model: "model-a", success: false, credentialScope: true, error: { httpStatus: 429, message: "credential quota exceeded", retryable: false } });
  expect(tm.manager.getById(id)!.quota.backoffLevel).toBe(1);

  // Let the first window expire.
  tm.clock.advance(2 * Minute);
  const secondFailureAt = tm.clock.now();
  tm.manager.markResult({ authId: id, provider: "claude", model: "model-b", success: false, credentialScope: true, error: { httpStatus: 429, message: "credential quota exceeded again", retryable: false } });
  const updated = tm.manager.getById(id)!;
  expect(updated.quota.backoffLevel).toBe(2);
  expect(updated.quota.nextRecoverAt).toBeGreaterThanOrEqual(secondFailureAt + 2 * QuotaBackoffBaseMs);
});

test("Manager_MarkResult_CredentialScopeDoesNotInheritModelBackoffLevel", () => {
  const cases = [
    { name: "without_retry_hint", retryAfterMs: undefined, wantBackoffLevel: 1, wantCooldownDuration: QuotaBackoffBaseMs },
    { name: "with_retry_hint", retryAfterMs: 10_000, wantBackoffLevel: 0, wantCooldownDuration: 10_000 },
  ];
  for (const tc of cases) {
    const { tm, id } = newCooldownMonotonicManager("model-a", "model-b");
    tm.manager.markResult({ authId: id, provider: "claude", model: "model-a", success: false, error: { httpStatus: 429, message: "model-only quota exceeded", retryable: false } });
    const modelOnly = tm.manager.getById(id)!;
    expect(modelOnly.quota.reason, tc.name).toBe("quota");
    expect(existingModelState(modelOnly, canonicalModelKey("model-a"))!.quota.backoffLevel, tc.name).toBe(1);

    const secondFailureStarted = tm.clock.now();
    tm.manager.markResult({ authId: id, provider: "claude", model: "model-a", success: false, retryAfterMs: tc.retryAfterMs, credentialScope: true, error: { httpStatus: 429, message: "credential quota exceeded", retryable: false } });
    const updated = tm.manager.getById(id)!;
    expect(updated.quota.backoffLevel ?? 0, tc.name).toBe(tc.wantBackoffLevel);
    expect(updated.quota.nextRecoverAt, tc.name).toBe(secondFailureStarted + tc.wantCooldownDuration);
  }
});
