// Ported from: sdk/cliproxy/auth/conductor_refresh_disabled_test.go, sdk/cliproxy/auth/conductor_refresh_executor_key_test.go
// Ported from: sdk/cliproxy/auth/request_proxy_refresh_test.go, sdk/cliproxy/auth/conductor_quota_clock_test.go
// Ported from: sdk/cliproxy/auth/persist_policy_test.go, sdk/cliproxy/auth/metadata_keys_test.go
// Ported from: sdk/cliproxy/auth/conductor_executor_replace_test.go, sdk/cliproxy/auth/catalog_credential_quota_regression_test.go
// Ported from: sdk/cliproxy/auth/conductor_scheduler_refresh_test.go, sdk/cliproxy/auth/auto_refresh_issue6199_test.go
// Skipped cases: conductor_quota_clock only keeps the NextRetryAfter == Quota.NextRecoverAt half (stripping Go's monotonic
// clock reading has no JS equivalent); conductor_executor_replace TestManagerRefreshAndLegacySelectionKimiAliases /
// TestManagerSchedulerFastPathKimiAI / TestManagerKimiDomainIsolation (Kimi); catalog_credential_quota_regression keeps the
// pre-restart half (the .cds cooldown state store and ReconcileRegistryModelStates are not ported; cooldowns persist with the
// auth record); conductor_scheduler_refresh keeps StopsAutoRefreshRetry, TerminalOAuthFailure_ReturnsTerminalAuthError,
// QuotaCooldown_DoesNotClassifyAsTerminalAuth, RefreshAuthTransientFailure_ExpiredTokenMarkedUnavailableWithRetry,
// RefreshAuth_ExpiredAccessTokenBlockedFromSelection and RefreshAuth_RestoresStatusFromErrorToActive; the rest exercise the
// incremental scheduler (RefreshSchedulerEntry / PickNext rebuilds / ReadyAuthDemoted), registration epochs, persist
// watermarks, PrepareRequestAuth or the three-way MergeRefreshedAuth of concurrent proxy/metadata edits, none of which are
// ported. auto_refresh_issue6199 keeps RunningAuthDoesNotStarveHealthyAuth and RestartDoesNotDuplicateRunningJob; the
// queue-capacity / canceled-loop / queued-job cases test the Go worker job channel (the TS loop dispatches due auths
// directly under a concurrency gate). metadata_keys drops the fingerprint-profile key (uTLS fingerprint profiles are a
// Go-only mechanic). The persist_policy WithSkipPersist context is the `skipPersist` option.
import { afterEach, expect, test } from "bun:test";
import {
  AutoRefreshLoop,
  CloseAllExecutionSessionsID,
  TerminalAuthError,
  getAvailableAuths,
  isAuthBlockedForModel,
  nextRefreshCheckAt,
  setQuotaCooldownDisabled,
  type RefreshTimers,
} from "../../../src/auth/manager/index.ts";
import { canonicalCredentialMetadataKey, normalizeCredentialMetadata } from "../../../src/store/record.ts";
import { StatusActive, StatusDisabled, type Auth } from "../../../src/auth/types.ts";
import { Hour, MemoryStore, Minute, auth, deferred, fakeExecutor, newManager, opts, registerModels, rejection, req, settle } from "./helpers.ts";

afterEach(() => setQuotaCooldownDisabled(false));

class StatusMessageError extends Error {
  constructor(
    readonly statusCode: number,
    msg: string,
  ) {
    super(`status ${statusCode}: ${msg}`);
  }
}

// --- conductor_refresh_disabled_test.go ---

function oauthErrorManager(err?: unknown) {
  const tm = newManager();
  const executor = fakeExecutor({
    identifier: "test-provider",
    refresh: (a) => {
      if (err) throw err;
      a.metadata.access_token = "new-valid-token";
      return a;
    },
  });
  tm.manager.registerExecutor(executor);
  return { tm, executor };
}

const invalidGrantErr = () => new StatusMessageError(400, `{"error": "invalid_grant", "error_description": "Bad Request"}`);

test("RefreshAuthForRequest_NormalDisabledAuth_RefreshesTokenSuccessfully", async () => {
  const { tm, executor } = oauthErrorManager();
  tm.manager.register(auth({ id: "normal-disabled-auth", provider: "test-provider", disabled: true, status: StatusDisabled, metadata: { access_token: "expired-token", refresh_token: "refresh-1" } }));
  const refreshed = await tm.manager.refreshAuth("normal-disabled-auth");
  expect(executor.refreshCalls).toBe(1);
  expect(refreshed.metadata.access_token).toBe("new-valid-token");
});

test("RefreshAuthForRequest_DisabledAuth_InvalidGrant_NeverRetries", async () => {
  const { tm, executor } = oauthErrorManager(invalidGrantErr());
  tm.manager.register(auth({ id: "disabled-invalid-grant", provider: "test-provider", disabled: true, status: StatusDisabled, metadata: { access_token: "expired-token", refresh_token: "refresh-1" } }));
  await rejection(tm.manager.refreshAuth("disabled-invalid-grant"));
  const current = tm.manager.getById("disabled-invalid-grant")!;
  expect(current.status).toBe(StatusDisabled);
  expect(current.nextRefreshAfter).toBe(0);
  const before = executor.refreshCalls;
  await rejection(tm.manager.refreshAuth("disabled-invalid-grant"));
  expect(executor.refreshCalls).toBe(before);
});

test("RefreshAuthForRequest_EnabledAuth_InvalidGrant_ExponentialBackoff", async () => {
  const { tm } = oauthErrorManager(invalidGrantErr());
  tm.manager.register(auth({ id: "enabled-auth-invalid-grant-exp", provider: "test-provider", status: StatusActive, metadata: { access_token: "expired-token", refresh_token: "refresh-1", expires_at: new Date(tm.clock.now() - Hour).toISOString() } }));
  for (const [attempt, backoff] of [[1, Minute], [2, 2 * Minute], [3, 4 * Minute]] as const) {
    const t = tm.clock.now();
    await rejection(tm.manager.refreshAuth("enabled-auth-invalid-grant-exp"));
    const current = tm.manager.getById("enabled-auth-invalid-grant-exp")!;
    expect(current.status).toBe("error");
    expect(current.refreshFailures).toBe(attempt);
    expect(current.nextRefreshAfter - t).toBe(backoff);
  }
});

test("RefreshAuthForRequest_RawFmtError_RecognizesInvalidGrant", async () => {
  const { tm } = oauthErrorManager(new Error(`token refresh failed with status 400: {"error": "invalid_grant", "error_description": "Bad Request"}`));
  tm.manager.register(auth({ id: "raw-invalid-grant", provider: "test-provider", status: StatusActive, metadata: { access_token: "expired-token", refresh_token: "refresh-1", expires_at: new Date(tm.clock.now() - Hour).toISOString() } }));
  await rejection(tm.manager.refreshAuth("raw-invalid-grant"));
  const current = tm.manager.getById("raw-invalid-grant")!;
  expect(current.refreshFailures).toBe(1);
  expect(current.nextRefreshAfter - tm.clock.now()).toBe(Minute);
});

test("Manager_AutoRefreshLoop_DisabledAuthWithInvalidGrantNeverRefreshes", async () => {
  const { tm, executor } = oauthErrorManager();
  const timers: RefreshTimers = { setTimeout: () => 0, clearTimeout: () => {} };
  const loopManager = newManager({ clock: tm.clock, timers });
  loopManager.manager.registerExecutor(executor);
  loopManager.manager.register(
    auth({
      id: "disabled-invalid-grant-loop",
      provider: "test-provider",
      disabled: true,
      status: StatusDisabled,
      lastError: { httpStatus: 400, message: `{"error": "invalid_grant", "error_description": "Bad Request"}`, retryable: false },
      metadata: { access_token: "expired-token", refresh_token: "refresh-1", expires_at: new Date(tm.clock.now() - Hour).toISOString() },
    }),
  );
  const loop = loopManager.manager.startAutoRefresh(10);
  for (let i = 0; i < 10; i++) {
    await loop.tick(loopManager.clock.now());
    loopManager.clock.advance(10);
  }
  loopManager.manager.stopAutoRefresh();
  expect(executor.refreshCalls).toBe(0);
});

// --- conductor_refresh_executor_key_test.go / request_proxy_refresh_test.go ---

test("RefreshAuthForRequest_UsesExecutorKeyFromAuth", async () => {
  const tm = newManager();
  const executor = fakeExecutor({
    identifier: "plugin-provider",
    refresh: (a) => {
      a.metadata.access_token = "refreshed-token";
      return a;
    },
  });
  tm.manager.registerExecutor(executor);
  tm.manager.register(auth({ id: "compat-oauth", provider: "plugin-provider", attributes: { base_url: "https://compat.example.com/v1" }, metadata: { access_token: "old-token", refresh_token: "refresh-1" } }));
  const refreshed = await tm.manager.refreshAuth("compat-oauth", { failedAccessToken: "old-token" });
  expect(executor.refreshCalls).toBe(1);
  expect(refreshed.metadata.access_token).toBe("refreshed-token");
});

test("RefreshAuthForRequestIgnoresExecutionProxy", async () => {
  const tm = newManager();
  const proxies: Array<string | undefined> = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "request-proxy-refresh",
      execute: (a) => {
        if (a.metadata.access_token === "stale") throw new StatusMessageError(401, "unauthorized");
        return { payload: "ok" };
      },
      refresh: (a) => {
        proxies.push(a.proxyUrl);
        a.metadata.access_token = "fresh";
        return a;
      },
    }),
  );
  registerModels(tm.registry, "request-proxy-auth", "request-proxy-refresh", "m");
  tm.manager.register(auth({ id: "request-proxy-auth", provider: "request-proxy-refresh", status: StatusActive, metadata: { access_token: "stale", refresh_token: "r" } }));
  await tm.manager.execute(["request-proxy-refresh"], req("m"), opts({ proxyUrl: "http://request-proxy.example:8081" }));
  expect(proxies).toEqual([undefined]);
});

// --- conductor_quota_clock_test.go ---

test("QuotaDeadlineUsesWallClock (NextRetryAfter matches Quota.NextRecoverAt)", () => {
  const tm = newManager();
  for (const [id, model, retryAfterMs, credentialScope] of [
    ["quota-clock-model-explicit", "gpt-5", Hour, false],
    ["quota-clock-model-fallback", "gpt-5", undefined, false],
    ["quota-clock-auth-explicit", "gpt-5", Hour, true],
    ["quota-clock-auth-fallback", "", undefined, false],
  ] as const) {
    tm.manager.register(auth({ id, provider: "codex" }), { skipPersist: true });
    tm.manager.markResult({ authId: id, provider: "codex", model, success: false, retryAfterMs, credentialScope, error: { httpStatus: 429, message: "quota exceeded", retryable: false } });
    const updated = tm.manager.getById(id)!;
    const holder = model !== "" && !credentialScope ? updated.modelStates!["gpt-5"]! : updated;
    expect(holder.nextRetryAfter).not.toBe(0);
    expect(holder.nextRetryAfter).toBe(holder.quota.nextRecoverAt);
  }
});

// --- persist_policy_test.go ---

test("WithSkipPersist_DisablesUpdateAndRegisterPersistence", async () => {
  const store = new MemoryStore();
  const { manager } = newManager({ store });
  const target = auth({ id: "auth-1", provider: "claude", metadata: { type: "claude" } });
  manager.register(target, { skipPersist: true });
  await manager.flushPersistence();
  expect(store.saved.length).toBe(0);
  manager.update(target);
  await manager.flushPersistence();
  expect(store.saved.length).toBe(1);
  manager.update(target, { skipPersist: true });
  await manager.flushPersistence();
  expect(store.saved.length).toBe(1);
});

test("Persist_SkipsConfigAPIKeyAuth", async () => {
  const store = new MemoryStore();
  const { manager } = newManager({ store });
  manager.register(auth({ id: "codex:apikey:abc", provider: "codex", attributes: { api_key: "secret", source: "config:codex[abc]" }, metadata: { disable_cooling: true } }));
  manager.markResult({ authId: "codex:apikey:abc", provider: "codex", model: "gpt-5", success: true });
  await manager.flushPersistence();
  expect(store.saved.length).toBe(0);
});

// --- metadata_keys_test.go ---

test("NormalizeCredentialMetadata", () => {
  const metadata: Record<string, unknown> = {
    "api-key": "legacy-key",
    "base-url": "https://legacy.example",
    "disable-cooling": true,
    "excluded-models": ["legacy-model"],
    "model-aliases": [{ name: "upstream", alias: "public" }],
    "proxy-url": "http://legacy-proxy.example",
    "request-retry": 3,
    request_retry: 0,
    "request-scoped-errors": [{ status: 429 }],
    "tool-prefix-disabled": true,
    provider_field: "preserved",
  };
  normalizeCredentialMetadata(metadata);
  expect(metadata).toEqual({
    api_key: "legacy-key",
    base_url: "https://legacy.example",
    disable_cooling: true,
    excluded_models: ["legacy-model"],
    model_aliases: [{ name: "upstream", alias: "public" }],
    proxy_url: "http://legacy-proxy.example",
    request_retry: 0,
    request_scoped_errors: [{ status: 429 }],
    tool_prefix_disabled: true,
    provider_field: "preserved",
  });
  expect(canonicalCredentialMetadataKey("provider-specific-key")).toBe("provider-specific-key");
});

test("ManagerRegisterNormalizesCredentialMetadata", () => {
  const { manager } = newManager();
  const registered = manager.register(auth({ id: "legacy-auth", provider: "codex", metadata: { "request-retry": 2, request_retry: 0 } }));
  expect(registered.metadata.request_retry).toBe(0);
  expect("request-retry" in registered.metadata).toBe(false);
});

// --- conductor_executor_replace_test.go ---

test("ManagerRegisterExecutorClosesReplacedExecutionSessions", () => {
  const { manager } = newManager();
  const closed: Record<string, string[]> = { replaced: [], current: [] };
  const replaced = Object.assign(fakeExecutor({ identifier: "codex" }), { closeExecutionSession: (id: string) => closed.replaced!.push(id) });
  const current = Object.assign(fakeExecutor({ identifier: "codex" }), { closeExecutionSession: (id: string) => closed.current!.push(id) });
  manager.registerExecutor(replaced);
  manager.registerExecutor(current);
  expect(closed.replaced).toEqual([CloseAllExecutionSessionsID]);
  expect(closed.current).toEqual([]);
});

test("ManagerExecutorReturnsRegisteredExecutor", () => {
  const { manager } = newManager();
  const current = fakeExecutor({ identifier: "codex" });
  manager.registerExecutor(current);
  expect(manager.executor("CODEX")).toBe(current);
  expect(manager.executor("unknown")).toBeUndefined();
});

// --- catalog_credential_quota_regression_test.go ---

test("CredentialQuotaKeepsHealthyCatalog (pre-restart half)", () => {
  const tm = newManager();
  const models = ["audit-luna", "audit-sol", "audit-terra"];
  for (const id of ["audit-healthy-api", "audit-quota-oauth"]) {
    tm.manager.register(auth({ id, provider: "codex", status: StatusActive }));
    registerModels(tm.registry, id, "codex", ...models);
  }
  for (const model of models) tm.manager.markResult({ authId: "audit-quota-oauth", provider: "codex", model, success: true });
  tm.manager.markResult({ authId: "audit-quota-oauth", provider: "codex", model: "audit-sol", success: false, retryAfterMs: 3 * Hour, credentialScope: true, error: { httpStatus: 429, code: "usage_limit_reached", message: "quota exceeded", retryable: false } });
  const oauthAuth = tm.manager.getById("audit-quota-oauth")!;
  const listed = new Set(tm.registry.getAvailableModelInfos().map((m) => m.id));
  for (const model of models) {
    const state = oauthAuth.modelStates![model]!;
    expect(state.quota.exceeded).toBe(true);
    expect(state.quota.reason).toBe(model === "audit-sol" ? "quota" : "credential_quota");
    expect(listed.has(model)).toBe(true);
  }
  const healthy = tm.manager.getById("audit-healthy-api")!;
  for (const model of models) expect(isAuthBlockedForModel(healthy, model, tm.clock.now()).blocked).toBe(false);
});

// --- conductor_scheduler_refresh_test.go ---

function unauthorizedRefreshManager() {
  const tm = newManager();
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "codex",
      refresh: () => {
        throw new Error("token refresh failed with status 401: invalid_grant");
      },
    }),
  );
  return tm;
}

test("Manager_RefreshAuthUnauthorizedFailureStopsAutoRefreshRetry", async () => {
  const tm = unauthorizedRefreshManager();
  tm.manager.register(auth({ id: "unauthorized-refresh", provider: "codex", metadata: { email: "x@example.com" } }));
  await rejection(tm.manager.refreshAuth("unauthorized-refresh"));
  const updated = tm.manager.getById("unauthorized-refresh")!;
  expect(updated.lastError?.httpStatus).toBe(401);
  expect(updated.lastError?.code).toBe("unauthorized");
  expect(updated.nextRefreshAfter).toBe(0);
  expect(tm.manager.shouldRefreshAuth(updated)).toBe(false);
  expect(nextRefreshCheckAt(tm.clock.now(), updated, 1000).scheduled).toBe(false);
});

test("Manager_TerminalOAuthFailure_ReturnsTerminalAuthError", async () => {
  const tm = unauthorizedRefreshManager();
  tm.manager.register(auth({ id: "unauthorized-terminal", provider: "codex", metadata: { email: "x@example.com" } }));
  registerModels(tm.registry, "unauthorized-terminal", "codex", "any-model");
  await rejection(tm.manager.refreshAuth("unauthorized-terminal"));
  let err: unknown;
  try {
    tm.manager.selectAuth(["codex"], "any-model", opts());
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TerminalAuthError);
});

test("Manager_QuotaCooldown_DoesNotClassifyAsTerminalAuth", () => {
  const tm = newManager();
  tm.manager.registerExecutor(fakeExecutor({ identifier: "codex" }));
  tm.manager.register(auth({ id: "quota-cooldown-auth", provider: "codex", unavailable: true, quota: { exceeded: true, reason: "credential_quota", nextRecoverAt: tm.clock.now() + Minute } }));
  registerModels(tm.registry, "quota-cooldown-auth", "codex", "model-cooldown");
  let err: unknown;
  try {
    tm.manager.selectAuth(["codex"], "model-cooldown", opts());
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err).not.toBeInstanceOf(TerminalAuthError);
});

test("Manager_RefreshAuthTransientFailure_ExpiredTokenMarkedUnavailableWithRetry / ExpiredAccessTokenBlockedFromSelection", async () => {
  const tm = newManager();
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "codex",
      refresh: () => {
        throw new Error("upstream 503 Service Unavailable");
      },
    }),
  );
  tm.manager.register(auth({ id: "expired", provider: "codex", metadata: { access_token: "a", refresh_token: "r", expired: new Date(tm.clock.now() - Minute).toISOString() } }));
  await rejection(tm.manager.refreshAuth("expired"));
  const updated = tm.manager.getById("expired")!;
  expect(updated.unavailable).toBe(true);
  expect(updated.nextRefreshAfter).toBeGreaterThan(tm.clock.now());
  expect(() => getAvailableAuths([updated], "codex", "", tm.clock.now())).toThrow();
});

test("Manager_RefreshAuth_RestoresStatusFromErrorToActive", async () => {
  const tm = newManager();
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "codex",
      refresh: (a) => {
        a.metadata.access_token = "fresh";
        return a;
      },
    }),
  );
  tm.manager.register(auth({ id: "restore", provider: "codex", status: "error", statusMessage: "token expired", metadata: { access_token: "a", refresh_token: "r" } }));
  const refreshed = await tm.manager.refreshAuth("restore");
  expect(refreshed.status).toBe(StatusActive);
  expect(refreshed.statusMessage).toBeUndefined();
});

// --- auto_refresh_issue6199_test.go ---

function expiredRefreshAuth(id: string, now: number): Auth {
  return auth({
    id,
    provider: "issue6199-refresh",
    status: StatusActive,
    lastRefreshedAt: now - Hour,
    metadata: { access_token: "expired-access", refresh_token: `refresh-${id}`, expires_at: new Date(now - Hour).toISOString(), refresh_interval_seconds: 1 },
  });
}

test("Issue6199AutoRefreshRunningAuthDoesNotStarveHealthyAuth", async () => {
  const release = deferred();
  const refreshed: string[] = [];
  const timers: RefreshTimers = { setTimeout: () => 0, clearTimeout: () => {} };
  const tm = newManager({ timers });
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "issue6199-refresh",
      refresh: async (a) => {
        if (a.id === "blocked") await release.promise;
        refreshed.push(a.id);
        a.metadata.expires_at = new Date(tm.clock.now() + Hour).toISOString();
        return a;
      },
    }),
  );
  tm.manager.register(expiredRefreshAuth("blocked", tm.clock.now()));
  const loop: AutoRefreshLoop = tm.manager.startAutoRefresh(1000);
  const firstTick = loop.tick(tm.clock.now());
  await settle();
  for (let i = 0; i < 3; i++) {
    tm.clock.advance(30_000);
    void loop.tick(tm.clock.now());
  }
  tm.manager.register(expiredRefreshAuth("healthy", tm.clock.now()));
  await loop.tick(tm.clock.now());
  expect(refreshed).toEqual(["healthy"]);
  release.resolve();
  await firstTick;
  expect(refreshed.filter((id) => id === "blocked").length).toBe(1);
  tm.manager.stopAutoRefresh();
});

test("Issue6199AutoRefreshRestartDoesNotDuplicateRunningJob", async () => {
  const release = deferred();
  let calls = 0;
  const timers: RefreshTimers = { setTimeout: () => 0, clearTimeout: () => {} };
  const tm = newManager({ timers });
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "issue6199-refresh",
      refresh: async (a) => {
        calls++;
        await release.promise;
        a.metadata.expires_at = new Date(tm.clock.now() + Hour).toISOString();
        return a;
      },
    }),
  );
  tm.manager.register(expiredRefreshAuth("restart-running", tm.clock.now()));
  const oldLoop = tm.manager.startAutoRefresh(1000);
  const running = oldLoop.tick(tm.clock.now());
  await settle();
  const newLoop = tm.manager.startAutoRefresh(1000);
  tm.clock.advance(60_000);
  const second = newLoop.tick(tm.clock.now());
  await settle();
  expect(calls).toBe(1);
  release.resolve();
  await Promise.all([running, second]);
  expect(calls).toBe(1);
  tm.manager.stopAutoRefresh();
});
