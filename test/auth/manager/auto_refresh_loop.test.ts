// Ported from: sdk/cliproxy/auth/auto_refresh_loop_test.go
// Skipped cases: TestNextRefreshCheckAt_RefreshEvaluatorFallback (RefreshEvaluator runtimes not ported),
// TestCodexDualRefreshScheduling / TestCodexUseSIWCActiveAccessTokenAndValidity / TestCodexSIWCRefreshDoesNotPostponeOuterIntervalRefresh /
// TestManagerRefreshOuterPreservesConcurrentSIWCBind / TestNextRefreshCheckAtIncludesSIWCWhenClassifiedAsAPIKey (Codex SIWC not ported).
import { expect, test } from "bun:test";
import { AutoRefreshLoop, MaxRefreshTimerWaitMs, nextRefreshCheckAt, type RefreshLeadResolver, type RefreshTimers } from "../../../src/auth/manager/index.ts";
import { StatusDisabled } from "../../../src/auth/types.ts";
import { Clock, Hour, Minute, auth, fakeExecutor, newManager, settle } from "./helpers.ts";

const now = Date.parse("2026-04-12T00:00:00Z");
const leadFor =
  (provider: string, leadMs: number): RefreshLeadResolver =>
  (a) =>
    a.provider === provider ? leadMs : undefined;

test("NextRefreshCheckAt_DisabledWithInvalidGrantUnschedule", () => {
  const expiry = now + Hour;
  const lead = leadFor("disabled-schedule", 10 * Minute);
  // Case 1: a disabled credential without invalid_grant is still scheduled for token refresh.
  const normalDisabled = auth({ id: "normal-disabled", provider: "disabled-schedule", disabled: true, status: StatusDisabled, metadata: { email: "x@example.com", expires_at: new Date(expiry).toISOString() } });
  expect(nextRefreshCheckAt(now, normalDisabled, 15 * Minute, lead)).toEqual({ next: expiry - 10 * Minute, scheduled: true });
  // Case 2: a disabled credential with invalid_grant is permanently unscheduled.
  const invalidGrantDisabled = auth({
    id: "invalid-grant-disabled",
    provider: "disabled-schedule",
    disabled: true,
    status: StatusDisabled,
    lastError: { httpStatus: 400, message: `{"error": "invalid_grant", "error_description": "Bad Request"}`, retryable: false },
    metadata: { email: "x@example.com", expires_at: new Date(expiry).toISOString() },
  });
  expect(nextRefreshCheckAt(now, invalidGrantDisabled, 15 * Minute, lead).scheduled).toBe(false);
});

test("NextRefreshCheckAt_APIKeyUnschedule", () => {
  const a = auth({ id: "a1", provider: "test", attributes: { api_key: "k" } });
  expect(nextRefreshCheckAt(now, a, 15 * Minute).scheduled).toBe(false);
});

test("NextRefreshCheckAt_NextRefreshAfterGate", () => {
  const nextAfter = now + 30 * Minute;
  const a = auth({ id: "a1", provider: "test", nextRefreshAfter: nextAfter, metadata: { email: "x@example.com" } });
  expect(nextRefreshCheckAt(now, a, 15 * Minute)).toEqual({ next: nextAfter, scheduled: true });
});

test("NextRefreshCheckAt_PreferredInterval_PicksEarliestCandidate", () => {
  const expiry = now + 20 * Minute;
  const a = auth({ id: "a1", provider: "test", lastRefreshedAt: now, metadata: { email: "x@example.com", expires_at: new Date(expiry).toISOString(), refresh_interval_seconds: 900 } });
  expect(nextRefreshCheckAt(now, a, 15 * Minute)).toEqual({ next: expiry - 15 * Minute, scheduled: true });
});

test("NextRefreshCheckAt_ProviderLead_Expiry", () => {
  const expiry = now + Hour;
  const a = auth({ id: "a1", provider: "provider-lead-expiry", metadata: { email: "x@example.com", expires_at: new Date(expiry).toISOString() } });
  expect(nextRefreshCheckAt(now, a, 15 * Minute, leadFor("provider-lead-expiry", 10 * Minute))).toEqual({ next: expiry - 10 * Minute, scheduled: true });
});

test("NextRefreshCheckAt_RelativeExpiry", () => {
  const issuedAt = now - 15 * Minute;
  const a = auth({ id: "relative-expiry-auth", provider: "relative-expiry", metadata: { access_token: "test-access", expires_in: 3600, timestamp: issuedAt } });
  expect(nextRefreshCheckAt(now, a, 15 * Minute, leadFor("relative-expiry", 30 * Minute))).toEqual({ next: issuedAt + Hour - 30 * Minute, scheduled: true });
});

const idleHost = {
  now: () => now,
  authIds: () => [],
  auth: () => undefined,
  hasExecutor: () => false,
  shouldRefresh: () => false,
  nextCheckAt: () => ({ next: 0, scheduled: false }),
  refresh: async () => {},
};
const idleTimers: RefreshTimers = { setTimeout: () => ({}), clearTimeout: () => {} };

test("AuthAutoRefreshLoop_TimerWaitClampedForLongNextExpiry", () => {
  const loop = new AutoRefreshLoop(idleHost, 5000, idleTimers);
  loop.upsert("a1", now + Hour);
  expect(loop.nextWait(now)).toEqual({ wait: MaxRefreshTimerWaitMs, ok: true });
  // Short wait should not be clamped.
  loop.upsert("a2", now + 10_000);
  expect(loop.nextWait(now)).toEqual({ wait: 10_000, ok: true });
});

test("AuthAutoRefreshLoop_PopDue_AfterSystemSuspendResume", () => {
  const loop = new AutoRefreshLoop(idleHost, 5000, idleTimers);
  const beforeSleep = Date.parse("2026-04-12T10:00:00Z");
  loop.upsert("gemini-oauth", beforeSleep + 50 * Minute);
  expect(loop.nextWait(beforeSleep)).toEqual({ wait: MaxRefreshTimerWaitMs, ok: true });
  expect(loop.popDue(beforeSleep)).toEqual([]);
  // The host resumes two hours later; the clamped timer re-evaluates with the wall clock.
  const afterResume = beforeSleep + 2 * Hour;
  expect(loop.nextWait(afterResume)).toEqual({ wait: 0, ok: true });
  expect(loop.popDue(afterResume)).toEqual(["gemini-oauth"]);
});

// Manager-level: the loop refreshes a due OAuth credential through its executor when the timer fires.
test("AutoRefresh_RefreshesDueAuthThroughExecutor", async () => {
  const clock = new Clock(now);
  const pending: Array<{ fn: () => void; at: number }> = [];
  const timers: RefreshTimers = {
    setTimeout: (fn, ms) => {
      const entry = { fn, at: clock.now() + ms };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      const idx = pending.indexOf(handle as { fn: () => void; at: number });
      if (idx >= 0) pending.splice(idx, 1);
    },
  };
  const { manager } = newManager({ clock, timers, refreshLead: leadFor("claude", 4 * Hour) });
  const executor = fakeExecutor({
    identifier: "claude",
    refresh: (a) => {
      a.metadata.access_token = "rotated";
      a.metadata.expired = new Date(clock.now() + 8 * Hour).toISOString();
      return a;
    },
  });
  manager.registerExecutor(executor);
  manager.register(auth({ id: "claude-oauth", provider: "claude", metadata: { access_token: "old", refresh_token: "rt", expired: new Date(clock.now() + 5 * Hour).toISOString() } }));
  const loop = manager.startAutoRefresh(5000);
  // Due in one hour (expiry - lead); not refreshed yet.
  expect(loop.entries().get("claude-oauth")).toBe(clock.now() + Hour);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.at - clock.now()).toBe(MaxRefreshTimerWaitMs);

  clock.advance(Hour + 1000);
  const timer = pending.shift()!;
  timer.fn();
  await settle();
  expect(executor.refreshCalls).toBe(1);
  const refreshed = manager.getById("claude-oauth")!;
  expect(refreshed.metadata.access_token).toBe("rotated");
  expect(refreshed.lastRefreshedAt).toBe(clock.now());
  // Rescheduled for the new expiry minus the lead.
  expect(loop.entries().get("claude-oauth")).toBe(clock.now() + 4 * Hour);
  manager.stopAutoRefresh();
  expect(pending).toHaveLength(0);
});

// A failing refresh backs off five minutes; an invalid_grant failure doubles from one minute.
test("AutoRefresh_FailureBackoff", async () => {
  const clock = new Clock(now);
  let fail: Error | undefined = new Error("token refresh failed with status 503");
  const { manager } = newManager({ clock, refreshLead: leadFor("claude", 4 * Hour) });
  manager.registerExecutor(fakeExecutor({ identifier: "claude", refresh: (a) => (fail ? Promise.reject(fail) : a) }));
  manager.register(auth({ id: "claude-oauth", provider: "claude", metadata: { access_token: "old", refresh_token: "rt", expired: new Date(clock.now() + 2 * Hour).toISOString() } }));
  const loop = manager.startAutoRefresh(5000);
  expect(await loop.tick()).toEqual(["claude-oauth"]);
  expect(manager.getById("claude-oauth")!.nextRefreshAfter).toBe(clock.now() + 5 * Minute);
  expect(loop.entries().get("claude-oauth")).toBe(clock.now() + 5 * Minute);

  fail = new Error(`token refresh failed with status 400: {"error":"invalid_grant"}`);
  clock.advance(5 * Minute);
  expect(await loop.tick()).toEqual(["claude-oauth"]);
  let a = manager.getById("claude-oauth")!;
  expect(a.refreshFailures).toBe(1);
  expect(a.nextRefreshAfter).toBe(clock.now() + Minute);
  clock.advance(Minute);
  await loop.tick();
  a = manager.getById("claude-oauth")!;
  expect(a.refreshFailures).toBe(2);
  expect(a.nextRefreshAfter).toBe(clock.now() + 2 * Minute);
  manager.stopAutoRefresh();
});
