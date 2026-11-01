// Ported from: sdk/cliproxy/auth/force_refresh_test.go
// Skipped cases: TestManager_ForceRefreshAll_WorkersBounded / TestManager_ForceRefreshAll_CanceledContextSkipsExecutors /
// TestManager_ForceRefreshAll_DynamicCancellationSkipsRemaining / TestManager_RefreshWorkersResolution (worker pool and
// context cancellation not ported). The "antigravity" provider of the Go fixtures is replaced by "claude".
import { expect, test } from "bun:test";
import { RoundRobinSelector, hasUnauthorizedAuthFailure } from "../../../src/auth/manager/index.ts";
import { StatusActive, StatusError } from "../../../src/auth/types.ts";
import { auth, fakeExecutor, newManager } from "./helpers.ts";

test("Manager_ForceRefreshAuth_ClearsErrorAndRefreshes", async () => {
  const { manager } = newManager({ selector: new RoundRobinSelector() });
  const executor = fakeExecutor({ identifier: "claude", refresh: (a) => ({ ...a, metadata: { ...a.metadata, access_token: "new-tok" } }) });
  manager.registerExecutor(executor);
  const a = auth({ id: "ag-err", provider: "claude", status: StatusError, unavailable: true, lastError: { code: "unauthorized", message: "token revoked", retryable: false }, metadata: { access_token: "old-tok", refresh_token: "ref-tok" } });
  manager.register(a);
  expect(hasUnauthorizedAuthFailure(manager.getById(a.id))).toBe(true);

  const refreshed = await manager.forceRefresh(a.id);
  expect(refreshed.status).toBe(StatusActive);
  expect(refreshed.unavailable).toBe(false);
  expect(refreshed.lastError).toBeUndefined();
  expect(executor.refreshCalls).toBe(1);
});

test("Manager_ForceRefreshAll", async () => {
  const { manager } = newManager({ selector: new RoundRobinSelector() });
  const executor = fakeExecutor({ identifier: "claude" });
  manager.registerExecutor(executor);
  manager.register(auth({ id: "ag-1", provider: "claude", metadata: { refresh_token: "ref-1" } }));
  manager.register(auth({ id: "ag-2", provider: "claude", metadata: { refresh_token: "ref-2" } }));
  manager.register(auth({ id: "ag-no-ref", provider: "claude", metadata: { access_token: "no-refresh" } }));
  const results = await manager.forceRefreshAll();
  expect(results).toHaveLength(2);
  for (const res of results) expect(res.success, res.id).toBe(true);
  expect(executor.refreshCalls).toBe(2);
});

test("Manager_ForceRefreshAuth_PreservesErrorOnFailure", async () => {
  const { manager } = newManager({ selector: new RoundRobinSelector() });
  // No executor registered, so the refresh fails.
  const a = auth({ id: "ag-fail", provider: "claude", status: StatusError, unavailable: true, lastError: { code: "unauthorized", message: "token revoked", retryable: false }, metadata: { access_token: "old-tok", refresh_token: "ref-tok" } });
  manager.register(a);
  let err: unknown;
  try {
    await manager.forceRefresh(a.id);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  const current = manager.getById(a.id)!;
  expect(current.status).toBe(StatusError);
  expect(current.unavailable).toBe(true);
  expect(current.lastError).toBeDefined();
});
