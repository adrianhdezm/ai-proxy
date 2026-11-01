// Ported from: sdk/cliproxy/auth/conductor_update_test.go
// Skipped cases: TestManager_Update_FileSnapshotReadDoesNotHoldGlobalLock (file snapshot binding / global lock not ported).
import { expect, test } from "bun:test";
import { StatusActive, StatusDisabled, StatusError } from "../../../src/auth/types.ts";
import { Hour, Minute, auth, newManager } from "./helpers.ts";

const quotaState = (backoffLevel: number) => ({ status: StatusActive, unavailable: false, nextRetryAfter: 0, quota: { exceeded: false, nextRecoverAt: 0, backoffLevel }, updatedAt: 0 });

test("Manager_RegisterCanonicalizesThinkingSuffixModelStates", () => {
  const { manager, clock } = newManager();
  const now = clock.now();
  const laterRetry = now + 2 * Hour;
  const registered = manager.register(
    auth({
      id: "auth-thinking-states",
      provider: "gemini",
      modelStates: {
        "gemini-3.1-pro-preview(high)": { status: StatusError, unavailable: true, nextRetryAfter: now + Hour, quota: { exceeded: true, nextRecoverAt: now + Hour, backoffLevel: 1 }, updatedAt: now },
        "gemini-3.1-pro-preview(low)": { status: StatusError, unavailable: true, nextRetryAfter: laterRetry, quota: { exceeded: true, nextRecoverAt: laterRetry, backoffLevel: 2 }, updatedAt: now + Minute },
      },
    }),
  );
  expect(Object.keys(registered.modelStates!)).toEqual(["gemini-3.1-pro-preview"]);
  const state = registered.modelStates!["gemini-3.1-pro-preview"]!;
  expect(state.unavailable).toBe(true);
  expect(state.nextRetryAfter).toBe(laterRetry);
  expect(state.quota.backoffLevel).toBe(2);
  expect(state.quota.nextRecoverAt).toBe(laterRetry);
});

test("Manager_Update_PreservesModelStates", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "auth-1", provider: "claude", metadata: { k: "v" }, modelStates: { "test-model": quotaState(7) } }));
  manager.update(auth({ id: "auth-1", provider: "claude", metadata: { k: "v2" } }));
  const updated = manager.getById("auth-1")!;
  expect(updated.modelStates!["test-model"]!.quota.backoffLevel).toBe(7);
  expect(updated.metadata.k).toBe("v2");
});

test("Manager_Update_DisabledExistingDoesNotInheritModelStates", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "auth-disabled", provider: "claude", disabled: true, status: StatusDisabled, modelStates: { "stale-model": quotaState(5) } }));
  manager.update(auth({ id: "auth-disabled", provider: "claude", disabled: true, status: StatusDisabled }));
  expect(Object.keys(manager.getById("auth-disabled")!.modelStates ?? {})).toHaveLength(0);
});

test("Manager_Update_ActiveToDisabledDoesNotInheritModelStates", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "auth-a2d", provider: "claude", status: StatusActive, modelStates: { "stale-model": quotaState(9) } }));
  manager.update(auth({ id: "auth-a2d", provider: "claude", disabled: true, status: StatusDisabled }));
  expect(Object.keys(manager.getById("auth-a2d")!.modelStates ?? {})).toHaveLength(0);
});

test("Manager_Update_DisabledToActiveDoesNotInheritStaleModelStates", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "auth-d2a", provider: "claude", disabled: true, status: StatusDisabled, modelStates: { "stale-model": quotaState(4) } }));
  manager.update(auth({ id: "auth-d2a", provider: "claude", status: StatusActive }));
  expect(Object.keys(manager.getById("auth-d2a")!.modelStates ?? {})).toHaveLength(0);
});

test("Manager_Update_ActiveInheritsModelStates", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "auth-active", provider: "claude", status: StatusActive, modelStates: { "active-model": quotaState(3) } }));
  manager.update(auth({ id: "auth-active", provider: "claude", status: StatusActive }));
  const state = manager.getById("auth-active")!.modelStates!["active-model"];
  expect(state).toBeDefined();
  expect(state!.quota.backoffLevel).toBe(3);
});
