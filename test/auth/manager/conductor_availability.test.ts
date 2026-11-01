// Ported from: sdk/cliproxy/auth/conductor_availability_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { updateAggregatedAvailability } from "../../../src/auth/manager/index.ts";
import { StatusActive, StatusDisabled, StatusError } from "../../../src/auth/types.ts";
import { Hour, Minute, auth, baseNow, newManager, registerModels } from "./helpers.ts";

test("UpdateAggregatedAvailability_UnavailableWithoutNextRetryDoesNotBlockAuth", () => {
  const a = auth({ id: "a", modelStates: { "test-model": { status: StatusError, unavailable: true, nextRetryAfter: 0, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: 0 } } });
  updateAggregatedAvailability(a, baseNow);
  expect(a.unavailable).toBe(false);
  expect(a.nextRetryAfter).toBe(0);
});

test("UpdateAggregatedAvailability_FutureNextRetryBlocksAuth", () => {
  const next = baseNow + 5 * Minute;
  const a = auth({ id: "a", modelStates: { "test-model": { status: StatusError, unavailable: true, nextRetryAfter: next, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: 0 } } });
  updateAggregatedAvailability(a, baseNow);
  expect(a.unavailable).toBe(true);
  expect(a.nextRetryAfter).toBe(next);
});

test("Manager_AvailableProvidersAndHasProviderAuth_ExcludeDisabled", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "active", provider: "claude", status: StatusActive }));
  manager.register(auth({ id: "flag-disabled", provider: "gemini", disabled: true }));
  manager.register(auth({ id: "status-disabled", provider: "codex", status: StatusDisabled }));
  expect(manager.availableProviders()).toEqual(["claude"]);
  expect(manager.hasProviderAuth("claude")).toBe(true);
  expect(manager.hasProviderAuth("gemini")).toBe(false);
  expect(manager.hasProviderAuth("codex")).toBe(false);
});

test("Manager_ResetQuotaClearsRuntimeAndRegistryState", () => {
  const { manager, registry, clock } = newManager();
  const authID = "reset-quota-auth";
  const model = "reset-quota-model";
  const next = clock.now() + Hour;
  registerModels(registry, authID, "claude", model);
  manager.register(
    auth({
      id: authID,
      provider: "claude",
      status: StatusError,
      statusMessage: "quota exhausted",
      unavailable: true,
      nextRetryAfter: next,
      quota: { exceeded: true, reason: "quota", nextRecoverAt: next, backoffLevel: 2 },
      modelStates: { [model]: { status: StatusError, statusMessage: "quota exhausted", unavailable: true, nextRetryAfter: next, quota: { exceeded: true, reason: "quota", nextRecoverAt: next, backoffLevel: 2 }, updatedAt: next } },
    }),
  );
  registry.setModelQuotaExceeded(authID, model);
  registry.suspendClientModel(authID, model, "quota");
  expect(registry.getModelCount(model)).toBe(0);

  const reset = manager.resetQuota(authID);
  expect(reset).toBeDefined();
  expect(reset!.models).toEqual([model]);
  const updated = reset!.auth;
  expect(updated.status).toBe(StatusActive);
  expect(updated.statusMessage).toBeUndefined();
  expect(updated.unavailable).toBe(false);
  expect(updated.nextRetryAfter).toBe(0);
  expect(updated.quota).toEqual({ exceeded: false, nextRecoverAt: 0 });
  const state = updated.modelStates![model]!;
  expect(state.status).toBe(StatusActive);
  expect(state.unavailable).toBe(false);
  expect(state.nextRetryAfter).toBe(0);
  expect(state.quota.exceeded).toBe(false);
  expect(state.quota.nextRecoverAt).toBe(0);
  expect(state.quota.backoffLevel ?? 0).toBe(0);
  expect(registry.getModelCount(model)).toBe(1);
});
