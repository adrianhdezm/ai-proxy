// Ported from: sdk/cliproxy/auth/conductor_unauthorized_refresh_test.go
// Skipped cases: TestManagerReloginAfterRefreshFailureRestoresAccount is ported without the on-disk auth file
// snapshot (the TS store has no file snapshot binding); the tryRefreshAfterUnauthorized assertion of
// TestManager_ConcurrentUnauthorized_BarrierExecutionPreservesTerminalState is covered through refreshAuth.
import { expect, test } from "bun:test";
import { hasUnauthorizedAuthFailure, authAccessToken } from "../../../src/auth/manager/index.ts";
import { StatusActive, StatusError, type Auth } from "../../../src/auth/types.ts";
import { Hour, auth, deferred, fakeExecutor, newManager, opts, registerModels, req, statusError, streamOf, type FakeExecutor, type TestManager } from "./helpers.ts";

interface UnauthorizedExecutorSpec {
  tokenInvalid: Set<string>;
  refreshFail?: boolean;
  refreshErr?: Error;
  refreshTokens: Record<string, string>;
  onExecute?: (authID: string) => Promise<void> | void;
}

function unauthorizedRefreshExecutor(spec: UnauthorizedExecutorSpec): FakeExecutor {
  const unauthorized = () => statusError(401, "Your authentication token has been invalidated. Please try signing in again.");
  return fakeExecutor({
    identifier: "codex",
    execute: async (a) => {
      if (spec.onExecute) await spec.onExecute(a.id);
      const token = authAccessToken(a);
      if (spec.tokenInvalid.has(token)) throw unauthorized();
      return { payload: `${a.id}:${token}` };
    },
    stream: async (a) => {
      if (spec.onExecute) await spec.onExecute(a.id);
      const token = authAccessToken(a);
      if (spec.tokenInvalid.has(token)) throw unauthorized();
      return streamOf([`${a.id}:${token}`], new Headers({ "X-Auth": a.id }));
    },
    refresh: async (a) => {
      if (spec.refreshErr) throw spec.refreshErr;
      if (spec.refreshFail) throw statusError(401, "refresh token invalid");
      a.metadata.access_token = spec.refreshTokens[a.id] ?? "refreshed-access-token";
      return a;
    },
  });
}

function fixture(refreshFail: boolean): { tm: TestManager; executor: FakeExecutor; spec: UnauthorizedExecutorSpec; primary: Auth; backup: Auth; model: string } {
  const model = "gpt-5.5";
  const primary = auth({ id: "aa-primary", provider: "codex", metadata: { access_token: "stale-access-token", refresh_token: "primary-refresh-token" } });
  const backup = auth({ id: "bb-backup", provider: "codex", metadata: { access_token: "backup-access-token", refresh_token: "backup-refresh-token" } });
  const spec: UnauthorizedExecutorSpec = { tokenInvalid: new Set(["stale-access-token"]), refreshFail, refreshTokens: { [primary.id]: "fresh-access-token" } };
  const executor = unauthorizedRefreshExecutor(spec);
  const tm = newManager();
  tm.manager.registerExecutor(executor);
  registerModels(tm.registry, primary.id, "codex", model);
  registerModels(tm.registry, backup.id, "codex", model);
  tm.manager.register(primary);
  tm.manager.register(backup);
  return { tm, executor, spec, primary, backup, model };
}

const invalidGrant = () => new Error(`token refresh failed with status 400: {"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}`);

test("Manager_Execute_UnauthorizedRefreshesCurrentAuthBeforeFallback", async () => {
  const { tm, executor, primary, model } = fixture(false);
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe(`${primary.id}:fresh-access-token`);
  expect(executor.refreshCalls).toBe(1);
  expect(executor.executeCalls).toEqual([primary.id, primary.id]);
  const updated = tm.manager.getById(primary.id)!;
  expect(authAccessToken(updated)).toBe("fresh-access-token");
  expect(updated.modelStates?.[model]?.unavailable ?? false).toBe(false);
});

test("Manager_ExecuteStream_UnauthorizedRefreshesCurrentAuthBeforeFallback", async () => {
  const { tm, executor, primary, model } = fixture(false);
  const stream = await tm.manager.executeStream(["codex"], req(model), opts({ stream: true }));
  const chunks: string[] = [];
  for await (const chunk of stream.chunks) chunks.push(chunk);
  expect(chunks).toEqual([`${primary.id}:fresh-access-token`]);
  expect(executor.refreshCalls).toBe(1);
  expect(executor.streamCalls).toEqual([primary.id, primary.id]);
});

test("Manager_Execute_RejectedTokenWithInvalidGrantStopsSelectingAuth", async () => {
  const { tm, executor, spec, primary, backup, model } = fixture(false);
  spec.refreshErr = invalidGrant();
  // The revoked access token still has a future expiry, as in production.
  const updated = tm.manager.getById(primary.id)!;
  updated.metadata.expired = new Date(tm.clock.now() + 6 * Hour).toISOString();
  tm.manager.update(updated);

  for (let i = 0; i < 2; i++) {
    const resp = await tm.manager.execute(["codex"], req(model), opts());
    expect(resp.payload).toBe(`${backup.id}:backup-access-token`);
  }
  expect(executor.executeCalls.filter((id) => id === primary.id)).toHaveLength(1);
  expect(executor.refreshCalls).toBe(1);
  expect(hasUnauthorizedAuthFailure(tm.manager.getById(primary.id))).toBe(true);
});

test("Manager_MarkResult_InFlightResultDoesNotReviveTerminalUnauthorizedAuth", async () => {
  const { tm, executor, spec, primary, backup, model } = fixture(false);
  spec.refreshErr = invalidGrant();
  await tm.manager.execute(["codex"], req(model), opts());
  expect(hasUnauthorizedAuthFailure(tm.manager.getById(primary.id))).toBe(true);

  tm.manager.markResult({ authId: primary.id, provider: "codex", model, success: false, error: { httpStatus: 500, code: "internal_error", message: "internal server error", retryable: false } });
  expect(hasUnauthorizedAuthFailure(tm.manager.getById(primary.id))).toBe(true);

  tm.manager.markResult({ authId: primary.id, provider: "codex", model, success: true });
  expect(hasUnauthorizedAuthFailure(tm.manager.getById(primary.id))).toBe(true);

  tm.manager.resetQuota(primary.id);
  const callsBefore = executor.executeCalls.length;
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe(`${backup.id}:backup-access-token`);
  expect(executor.executeCalls.slice(callsBefore)).not.toContain(primary.id);
});

test("Manager_ConcurrentUnauthorized_BarrierExecutionPreservesTerminalState", async () => {
  const model = "gpt-5.5";
  const primary = auth({ id: "aa-primary", provider: "codex", metadata: { access_token: "stale-access-token", refresh_token: "primary-refresh-token", expired: new Date(Date.now() + 6 * Hour).toISOString() } });
  const backup = auth({ id: "bb-backup", provider: "codex", metadata: { access_token: "backup-access-token", refresh_token: "backup-refresh-token" } });
  const release = deferred();
  let entered = 0;
  const bothEntered = deferred();
  const spec: UnauthorizedExecutorSpec = {
    tokenInvalid: new Set(["stale-access-token"]),
    refreshErr: invalidGrant(),
    refreshTokens: {},
    onExecute: async (authID) => {
      if (authID !== primary.id) return;
      entered++;
      if (entered === 2) bothEntered.resolve();
      await release.promise;
    },
  };
  const executor = unauthorizedRefreshExecutor(spec);
  const tm = newManager();
  tm.manager.registerExecutor(executor);
  registerModels(tm.registry, primary.id, "codex", model);
  registerModels(tm.registry, backup.id, "codex", model);
  tm.manager.register(primary);
  tm.manager.register(backup);

  const runs = [0, 1].map(() => tm.manager.execute(["codex"], req(model), opts()));
  await bothEntered.promise;
  release.resolve();
  const results = await Promise.all(runs);
  for (const resp of results) expect(resp.payload).toBe(`${backup.id}:backup-access-token`);

  // Only one refresh attempt for the invalidated primary token.
  expect(executor.refreshCalls).toBe(1);
  expect(hasUnauthorizedAuthFailure(tm.manager.getById(primary.id))).toBe(true);

  // A background refresh does not touch a terminal unauthorized auth.
  const callsBefore = executor.refreshCalls;
  await tm.manager.refreshAuth(primary.id).catch(() => undefined);
  expect(executor.refreshCalls).toBe(callsBefore);

  // A manual force refresh does.
  await tm.manager.forceRefresh(primary.id).catch(() => undefined);
  expect(executor.refreshCalls).toBe(callsBefore + 1);

  const execCallsBefore = executor.executeCalls.length;
  const resp3 = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp3.payload).toBe(`${backup.id}:backup-access-token`);
  expect(executor.executeCalls.slice(execCallsBefore)).not.toContain(primary.id);
});

test("Manager_ForceRefreshAuth_FailurePreservesTerminalUnauthorizedState", async () => {
  const { tm, spec, primary, backup, model } = fixture(false);
  const updated = tm.manager.getById(primary.id)!;
  updated.metadata.expired = new Date(tm.clock.now() + 6 * Hour).toISOString();
  tm.manager.update(updated);
  spec.refreshErr = invalidGrant();
  await tm.manager.execute(["codex"], req(model), opts());
  expect(hasUnauthorizedAuthFailure(tm.manager.getById(primary.id))).toBe(true);

  // 1. A forced refresh fails with 503.
  spec.refreshErr = new Error("upstream 503 service unavailable");
  let errForce: unknown;
  try {
    await tm.manager.forceRefresh(primary.id);
  } catch (err) {
    errForce = err;
  }
  expect(errForce).toBeDefined();
  const afterFailed = tm.manager.getById(primary.id)!;
  expect(hasUnauthorizedAuthFailure(afterFailed)).toBe(true);
  expect(afterFailed.nextRefreshAfter).toBe(0);
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe(`${backup.id}:backup-access-token`);

  // 2. A forced refresh succeeds with a valid token.
  spec.refreshErr = undefined;
  spec.refreshTokens[primary.id] = "newly-minted-token";
  const refreshed = await tm.manager.forceRefresh(primary.id);
  expect(refreshed.status).toBe(StatusActive);
  expect(refreshed.unavailable).toBe(false);
  expect(hasUnauthorizedAuthFailure(refreshed)).toBe(false);
});

test("Manager_Execute_UnauthorizedRefreshFailureFallsBackToNextAuth", async () => {
  const { tm, executor, primary, backup, model } = fixture(true);
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe(`${backup.id}:backup-access-token`);
  expect(executor.refreshCalls).toBe(1);
  expect(executor.executeCalls).toEqual([primary.id, backup.id]);
  const state = tm.manager.getById(primary.id)!.modelStates![model]!;
  expect(state.unavailable).toBe(true);
  expect(state.statusMessage === "unauthorized" || state.lastError?.httpStatus === 401).toBe(true);
});

test("Manager_Execute_UnauthorizedWithoutRefreshTokenDoesNotCallRefresh", async () => {
  const model = "gpt-5.5";
  const primary = auth({ id: "aa-primary-api-key", provider: "codex", metadata: { access_token: "stale-access-token" } });
  const backup = auth({ id: "bb-backup-api-key", provider: "codex", metadata: { access_token: "backup-access-token" } });
  const executor = unauthorizedRefreshExecutor({ tokenInvalid: new Set(["stale-access-token"]), refreshTokens: {} });
  const tm = newManager();
  tm.manager.registerExecutor(executor);
  registerModels(tm.registry, primary.id, "codex", model);
  registerModels(tm.registry, backup.id, "codex", model);
  tm.manager.register(primary);
  tm.manager.register(backup);
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe(`${backup.id}:backup-access-token`);
  expect(executor.refreshCalls).toBe(0);
  expect(executor.executeCalls).toEqual([primary.id, backup.id]);
});

test("Manager_Execute_UnauthorizedRefreshThenRetryStillFailsFallsBackOnce", async () => {
  const { tm, executor, spec, primary, backup, model } = fixture(false);
  spec.refreshTokens[primary.id] = "still-invalid-token";
  spec.tokenInvalid.add("still-invalid-token");
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe(`${backup.id}:backup-access-token`);
  expect(executor.refreshCalls).toBe(1);
  expect(executor.executeCalls).toEqual([primary.id, primary.id, backup.id]);
});

test("ManagerReloginAfterRefreshFailureRestoresAccount", async () => {
  const outage = () => new Error("token refresh failed with status 503: upstream connect error");
  const cases = [
    { name: "invalid grant", refreshErr: invalidGrant, rateLimited: false },
    { name: "token endpoint 503", refreshErr: outage, rateLimited: false },
    { name: "active 429 cooldown", refreshErr: outage, rateLimited: true },
    { name: "active 429 cooldown with invalid grant", refreshErr: invalidGrant, rateLimited: true },
  ];
  const snapshot = (tm: TestManager, token: string, expiry: number): Auth =>
    auth({
      id: "claude-a.json",
      provider: "claude",
      status: StatusActive,
      attributes: { path: "/auths/claude-a.json", source: "/auths/claude-a.json" },
      metadata: { type: "claude", access_token: `${token}-at`, refresh_token: `${token}-rt`, expired: new Date(expiry).toISOString() },
    });
  for (const tc of cases) {
    const tm = newManager();
    tm.manager.registerExecutor(fakeExecutor({ identifier: "claude", refresh: () => Promise.reject(tc.refreshErr()) }));
    tm.manager.register(snapshot(tm, "old", tm.clock.now() - Hour));
    if (tc.rateLimited) {
      tm.manager.markResult({ authId: "claude-a.json", provider: "claude", model: "", success: false, retryAfterMs: Hour, error: { httpStatus: 429, message: "rate limited", retryable: false } });
    }
    await tm.manager.refreshAuth("claude-a.json").catch(() => undefined); // expired token, refresh fails
    if (!tc.rateLimited) {
      const unchanged = snapshot(tm, "old", tm.clock.now() - Hour);
      unchanged.prefix = "kept";
      tm.manager.update(unchanged);
      const carried = tm.manager.getById("claude-a.json")!;
      expect(carried.unavailable, tc.name).toBe(true);
      expect(carried.status, tc.name).toBe(StatusError);
      expect(carried.lastError, tc.name).toBeDefined();
    }
    tm.manager.update(snapshot(tm, "new", tm.clock.now() + 8 * Hour));
    const after = tm.manager.getById("claude-a.json")!;
    if (tc.rateLimited) {
      expect(after.unavailable, tc.name).toBe(true);
      expect(after.nextRetryAfter, tc.name).toBeGreaterThan(tm.clock.now());
      expect(after.refreshFailures ?? 0, tc.name).toBe(0);
      expect(after.nextRefreshAfter, tc.name).toBe(0);
      continue;
    }
    expect(after.unavailable, tc.name).toBe(false);
    expect(after.status, tc.name).toBe(StatusActive);
    expect(after.lastError, tc.name).toBeUndefined();
    expect(after.refreshFailures ?? 0, tc.name).toBe(0);
    expect(after.nextRefreshAfter, tc.name).toBe(0);
  }
});
