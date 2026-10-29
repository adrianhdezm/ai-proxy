// Ported from: sdk/cliproxy/auth/conductor_remove_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { StatusActive, StatusDisabled } from "../../../src/auth/types.ts";
import type { RefreshTimers } from "../../../src/auth/manager/index.ts";
import { Hour, Minute, auth, newManager } from "./helpers.ts";

const idleTimers: RefreshTimers = { setTimeout: () => ({}), clearTimeout: () => {} };

test("Manager_Remove_DeletesRuntimeAuth", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "remove-runtime-auth", provider: "claude", status: StatusActive, metadata: { email: "x@example.com" } }));
  manager.remove("remove-runtime-auth");
  expect(manager.getById("remove-runtime-auth")).toBeUndefined();
});

test("Manager_Update_MissingAuthIsNoOp", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "missing-update-auth", provider: "claude", status: StatusActive }));
  manager.remove("missing-update-auth");
  const updated = manager.update(auth({ id: "missing-update-auth", provider: "claude", status: StatusDisabled, disabled: true }));
  expect(updated).toBeUndefined();
  expect(manager.getById("missing-update-auth")).toBeUndefined();
});

test("Manager_Remove_UnschedulesAutoRefresh", () => {
  const { manager, clock } = newManager({ timers: idleTimers, refreshLead: (a) => (a.provider === "provider-lead-expiry" ? 10 * Minute : undefined) });
  const loop = manager.startAutoRefresh(1000);
  const a = auth({ id: "remove-refresh-auth", provider: "provider-lead-expiry", metadata: { email: "x@example.com", expires_at: new Date(clock.now() + Hour).toISOString() } });
  manager.register(a);
  expect(manager.nextRefreshCheckAt(a, clock.now(), 1000).scheduled).toBe(true);
  expect(loop.entries().has(a.id)).toBe(true);
  manager.remove(a.id);
  expect(manager.getById(a.id)).toBeUndefined();
  expect(loop.entries().has(a.id)).toBe(false);
  manager.stopAutoRefresh();
});
