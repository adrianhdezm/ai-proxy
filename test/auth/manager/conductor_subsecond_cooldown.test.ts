// Ported from: sdk/cliproxy/auth/conductor_subsecond_cooldown_test.go
// Skipped cases: TestManager_Execute_SlowPoolExpiredCooldown_PreventsRetryStorm mutates manager internals from the
// executor; it is ported by advancing the injected clock while the second credential executes.
// TestClosestCooldownWaitWithAttempted_RespectsManagerAndProviderCoolingOverrides uses the manager-level disable-cooling
// switch in place of the openai-compatibility provider override (provider overrides not ported).
import { expect, test } from "bun:test";
import { MinQuotaCooldownFloorMs, applyAuthFailureState } from "../../../src/auth/manager/index.ts";
import { StatusError } from "../../../src/auth/types.ts";
import { statusCodeOf } from "../../../src/executor/types.ts";
import { Minute, auth, baseNow, fakeExecutor, newManager, opts, registerModels, req, statusError } from "./helpers.ts";

const model = "gemini-3.1-flash-image";

test("MarkResult_429SubSecondRetryAfter_EnforcesMinimumCooldownFloor", () => {
  const tm = newManager();
  registerModels(tm.registry, "auth-gemini-subsecond", "google", model);
  tm.manager.register(auth({ id: "auth-gemini-subsecond", provider: "google" }));
  const now = tm.clock.now();
  tm.manager.markResult({ authId: "auth-gemini-subsecond", provider: "google", model, success: false, retryAfterMs: 708, error: { httpStatus: 429, message: "RESOURCE_EXHAUSTED", retryable: false } });
  const state = tm.manager.getById("auth-gemini-subsecond")!.modelStates![model]!;
  expect(state.nextRetryAfter).toBeGreaterThanOrEqual(now + 10_000);
  expect(state.quota.nextRecoverAt).toBeGreaterThanOrEqual(now + 10_000);
});

test("MarkResult_429LongerRetryAfter_PreservedAboveFloor", () => {
  const tm = newManager();
  registerModels(tm.registry, "auth-gemini-longer", "google", model);
  tm.manager.register(auth({ id: "auth-gemini-longer", provider: "google" }));
  const now = tm.clock.now();
  tm.manager.markResult({ authId: "auth-gemini-longer", provider: "google", model, success: false, retryAfterMs: 5 * Minute, error: { httpStatus: 429, message: "RESOURCE_EXHAUSTED", retryable: false } });
  expect(tm.manager.getById("auth-gemini-longer")!.modelStates![model]!.nextRetryAfter).toBe(now + 5 * Minute);
});

test("ApplyAuthFailureState_429SubSecondRetryAfter_EnforcesMinimumCooldownFloor", () => {
  const a = auth({ id: "auth-level-subsecond" });
  applyAuthFailureState(a, { httpStatus: 429, message: "RESOURCE_EXHAUSTED", retryable: false }, 708, baseNow, false);
  expect(a.nextRetryAfter).toBeGreaterThanOrEqual(baseNow + 10_000);
  expect(a.quota.nextRecoverAt).toBeGreaterThanOrEqual(baseNow + 10_000);
});

test("Manager_Execute_429SubSecondRetryAfter_PreventsRetryStorm", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(5, 5000, 6);
  const executor = fakeExecutor({ identifier: "google", execute: () => Promise.reject(statusError(429, "quota exhausted", { retryAfterMs: 708 })) });
  tm.manager.registerExecutor(executor);
  for (const id of ["auth-storm-1", "auth-storm-2"]) {
    tm.manager.register(auth({ id, provider: "google" }));
    registerModels(tm.registry, id, "google", model);
  }
  let err: unknown;
  try {
    await tm.manager.execute(["google"], req(model), opts());
  } catch (e) {
    err = e;
  }
  expect(statusCodeOf(err)).toBe(429);
  // Each account is attempted once in round 0; the >= 10s cooldown exceeds maxWait (5s), so no retry storm.
  expect(executor.executeCalls).toHaveLength(2);
});

test("ClosestCooldownWaitWithAttempted_ExpiredCooldownDoesNotTriggerZeroWaitForAttemptedAuth", () => {
  const tm = newManager();
  const expired = tm.clock.now() - 5000;
  registerModels(tm.registry, "auth-attempted-expired", "google", model);
  tm.manager.register(
    auth({ id: "auth-attempted-expired", provider: "google", modelStates: { [model]: { status: StatusError, unavailable: true, nextRetryAfter: expired, quota: { exceeded: true, reason: "quota", nextRecoverAt: expired }, updatedAt: 0 } } }),
  );
  // Untried credential with an expired cooldown: immediately available.
  expect(tm.manager.closestCooldownWait(["google"], model, 0, 5, 429, undefined)).toEqual({ wait: 0, found: true });
  // Attempted in the round that just failed with 429: at least the floor, never zero.
  const attempted = tm.manager.closestCooldownWait(["google"], model, 0, 5, 429, new Set(["auth-attempted-expired"]));
  expect(attempted.found).toBe(true);
  expect(attempted.wait).toBeGreaterThanOrEqual(MinQuotaCooldownFloorMs);
});

test("Manager_Execute_SlowPoolExpiredCooldown_PreventsRetryStorm", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(5, 5000, 6);
  const authIDs = ["auth-slow-1", "auth-slow-2"];
  const executor = fakeExecutor({
    identifier: "google",
    execute: (a) => {
      // The pool iteration is slow enough for auth-slow-1's cooldown to expire before round 0 finishes.
      if (a.id === authIDs[1]) tm.clock.advance(11_000);
      return Promise.reject(statusError(429, "quota exhausted", { retryAfterMs: 708 }));
    },
  });
  tm.manager.registerExecutor(executor);
  for (const id of authIDs) {
    tm.manager.register(auth({ id, provider: "google" }));
    registerModels(tm.registry, id, "google", model);
  }
  let err: unknown;
  try {
    await tm.manager.execute(["google"], req(model), opts());
  } catch (e) {
    err = e;
  }
  expect(statusCodeOf(err)).toBe(429);
  const a1 = tm.manager.getById(authIDs[0]!)!;
  expect(a1.modelStates![model]!.nextRetryAfter).toBeLessThan(tm.clock.now());
  expect(executor.executeCalls).toHaveLength(2);
});

test("Manager_ShouldRetryAfterError_429EnforcesCooldownWaitEvenWithLargeMaxWait", () => {
  const tm = newManager();
  const expired = tm.clock.now() - 5000;
  registerModels(tm.registry, "auth-large-maxwait", "google", model);
  tm.manager.register(
    auth({ id: "auth-large-maxwait", provider: "google", modelStates: { [model]: { status: StatusError, unavailable: true, nextRetryAfter: expired, quota: { exceeded: true, reason: "quota", nextRecoverAt: expired }, updatedAt: 0 } } }),
  );
  const err429 = statusError(429, "RESOURCE_EXHAUSTED");
  const { wait, retry } = tm.manager.shouldRetryAfterError(err429, 0, ["google"], model, 30_000, 5, new Set(["auth-large-maxwait"]), opts());
  expect(retry).toBe(true);
  expect(wait).toBeGreaterThanOrEqual(MinQuotaCooldownFloorMs);
});

test("ClosestCooldownWaitWithAttempted_RespectsManagerAndProviderCoolingOverrides", () => {
  const tm = newManager();
  const expired = tm.clock.now() - 5000;
  const compatModel = "compat-model-override";
  registerModels(tm.registry, "auth-compat-override", "openai", compatModel);
  tm.manager.register(
    auth({ id: "auth-compat-override", provider: "openai", modelStates: { [compatModel]: { status: StatusError, unavailable: true, nextRetryAfter: expired, quota: { exceeded: true, reason: "quota", nextRecoverAt: expired }, updatedAt: 0 } } }),
  );
  const attempted = new Set(["auth-compat-override"]);
  const enabled = tm.manager.closestCooldownWait(["openai"], compatModel, 0, 5, 429, attempted);
  expect(enabled.found).toBe(true);
  expect(enabled.wait).toBeGreaterThanOrEqual(MinQuotaCooldownFloorMs);

  tm.manager.setCooldownDisabled(true);
  expect(tm.manager.closestCooldownWait(["openai"], compatModel, 0, 5, 429, attempted)).toEqual({ wait: 0, found: true });
});
