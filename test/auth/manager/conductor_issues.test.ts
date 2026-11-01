// Ported from: sdk/cliproxy/auth/conductor_issue6415_test.go, sdk/cliproxy/auth/conductor_issue6416_test.go
// Ported from: sdk/cliproxy/auth/conductor_issue6417_test.go, sdk/cliproxy/auth/conductor_issue6503_test.go
// Ported from: sdk/cliproxy/auth/conductor_issue6643_test.go, sdk/cliproxy/auth/file_snapshot_cooldown_seq_test.go
// Skipped cases: 6415 MarkRejectedAccessToken_AdvancesGeneration / UpdateWithoutCredentialChange_PreservesRejectedAccessToken /
// RefreshSuccessWithUnchangedToken_ClearsRejectedAccessToken (the persistent Auth.RejectedAccessToken field and scheduler
// generations are not ported; the port keeps a manager-side pending-refresh mark that the remaining 6415 cases cover);
// 6416 DirectMarkResult_StaleRegistrationEpochIgnored and LateResultBeforeCredentialUpdate_PreservesSessionAffinity
// (registration epochs and session affinity not ported); 6643 RestoreKeepsCooldownWatermark (cooldown state store not
// ported); file_snapshot_cooldown_seq TestFileSnapshotKeepsCooldownWatermark (file snapshot binding not ported; its
// credential-quota-carry case is ported). Credential versions live in the manager (credentialVersion(id)), not on Auth.
// The "antigravity" provider of 6417/6643 is replaced by "claude".
import { afterEach, expect, test } from "bun:test";
import { authAccessToken, isAuthBlockedForModel, setQuotaCooldownDisabled } from "../../../src/auth/manager/index.ts";
import { StatusError, type ExecRequest } from "../../../src/executor/types.ts";
import { StatusActive, type Auth } from "../../../src/auth/types.ts";
import { Hour, MemoryStore, Minute, auth, deferred, drain, fakeExecutor, newManager, opts, registerModels, rejection, req, settle, statusError, streamOf, type TestManager } from "./helpers.ts";

afterEach(() => setQuotaCooldownDisabled(false));

// ---------------------------------------------------------------------------
// Issue 6415: a 401 rejected token is not selected while its refresh runs
// ---------------------------------------------------------------------------

function unauthorizedFixture() {
  const model = "gpt-5.5";
  const primary = auth({ id: "aa-primary", provider: "codex", metadata: { access_token: "stale-access-token", refresh_token: "primary-refresh-token" } });
  const backup = auth({ id: "bb-backup", provider: "codex", metadata: { access_token: "backup-access-token", refresh_token: "backup-refresh-token" } });
  const control: { refreshErr?: unknown; refreshTokens: Record<string, string>; onRefresh?: () => Promise<void> } = { refreshTokens: { [primary.id]: "fresh-access-token" } };
  const executor = fakeExecutor({
    identifier: "codex",
    execute: (a) => {
      const token = authAccessToken(a);
      if (token === "stale-access-token") throw statusError(401, "token invalidated");
      return { payload: `${a.id}:${token}` };
    },
    refresh: async (a) => {
      if (control.onRefresh) await control.onRefresh();
      if (control.refreshErr) throw control.refreshErr;
      a.metadata.access_token = control.refreshTokens[a.id] ?? "refreshed-access-token";
      return a;
    },
  });
  const tm = newManager();
  tm.manager.registerExecutor(executor);
  registerModels(tm.registry, primary.id, "codex", model);
  registerModels(tm.registry, backup.id, "codex", model);
  tm.manager.register(primary);
  tm.manager.register(backup);
  return { tm, executor, control, primary, backup, model };
}

test("Manager_Issue6415_RefreshPending_DoesNotSelectRejectedCredential", async () => {
  const { tm, executor, control, primary, backup, model } = unauthorizedFixture();
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  control.onRefresh = async () => {
    refreshStarted.resolve();
    await releaseRefresh.promise;
  };
  const first = tm.manager.execute(["codex"], req(model), opts());
  await refreshStarted.promise;

  expect(tm.manager.isSelectable(primary.id, model)).toBe(false);
  const callsBefore = executor.executeCalls.length;
  const second = await tm.manager.execute(["codex"], req(model), opts());
  expect(second.payload).toBe(`${backup.id}:backup-access-token`);
  expect(executor.executeCalls.slice(callsBefore)).not.toContain(primary.id);

  releaseRefresh.resolve();
  expect((await first).payload).toBe(`${primary.id}:fresh-access-token`);
  expect(tm.manager.isSelectable(primary.id, model)).toBe(true);
});

test("Manager_Issue6415_NonTerminalRefreshFailure_MarksCredentialUnavailable", async () => {
  const { tm, control, primary } = unauthorizedFixture();
  control.refreshErr = new Error("upstream 503 Service Unavailable");
  await rejection(tm.manager.refreshAuth(primary.id, { failedAccessToken: authAccessToken(primary) }));
  const updated = tm.manager.getById(primary.id)!;
  expect(updated.unavailable).toBe(true);
  expect(updated.status).toBe("error");
});

test("Manager_Issue6415_RefreshSuccess_PreservesActiveQuotaCooldown", async () => {
  const { tm, primary, model } = unauthorizedFixture();
  const quotaRecover = tm.clock.now() + 30 * Minute;
  const current = tm.manager.getById(primary.id)!;
  current.modelStates = {
    [model]: { status: "error", statusMessage: "unauthorized", unavailable: true, nextRetryAfter: quotaRecover, quota: { exceeded: true, reason: "quota", nextRecoverAt: quotaRecover }, lastError: { httpStatus: 401, message: "unauthorized", retryable: false }, updatedAt: 0 },
  };
  tm.manager.update(current);
  await tm.manager.forceRefresh(primary.id);
  const state = tm.manager.getById(primary.id)!.modelStates![model]!;
  expect(state.quota.exceeded).toBe(true);
  expect(state.quota.nextRecoverAt).toBe(quotaRecover);
});

test("Manager_Issue6415_ExecuteRetrySuccess_PreservesActiveQuotaCooldown", async () => {
  const { tm, executor, primary, model } = unauthorizedFixture();
  const sibling = "gpt-5-mini";
  registerModels(tm.registry, primary.id, "codex", model, sibling);
  const quotaRecover = tm.clock.now() + 45 * Minute;
  const current = tm.manager.getById(primary.id)!;
  current.modelStates = {
    [sibling]: { status: "error", statusMessage: "quota_exceeded", unavailable: true, nextRetryAfter: quotaRecover, quota: { exceeded: true, reason: "quota", nextRecoverAt: quotaRecover }, lastError: { httpStatus: 429, message: "429 rate limited", retryable: false }, updatedAt: 0 },
  };
  tm.manager.update(current);
  const resp = await tm.manager.execute(["codex"], req(model), opts());
  expect(resp.payload).toBe(`${primary.id}:fresh-access-token`);
  expect(executor.refreshCalls).toBe(1);
  const state = tm.manager.getById(primary.id)!.modelStates![sibling]!;
  expect(state.quota.exceeded).toBe(true);
  expect(state.quota.nextRecoverAt).toBe(quotaRecover);
});

test("Manager_Issue6415_RefreshCanceled_ReschedulesRefresh", async () => {
  const { tm, control, primary } = unauthorizedFixture();
  control.refreshErr = new DOMException("The operation was aborted.", "AbortError");
  const err = await rejection(tm.manager.refreshAuth(primary.id, { failedAccessToken: authAccessToken(primary) }));
  expect((err as Error).name).toBe("AbortError");
  const updated = tm.manager.getById(primary.id)!;
  expect(updated.nextRefreshAfter).not.toBe(0);
  // A cancellation records no failure.
  expect(updated.lastError).toBeUndefined();
  expect(updated.unavailable).toBe(false);
});

// ---------------------------------------------------------------------------
// Issue 6416: a late result from a replaced credential does not cool the new one
// ---------------------------------------------------------------------------

function issue6416Executor(hold: { gate?: Promise<void>; started?: () => void }) {
  return fakeExecutor({
    identifier: "codex",
    execute: async (a) => {
      hold.started?.();
      if (hold.gate) await hold.gate;
      const token = authAccessToken(a) || (a.attributes.api_key ?? "");
      if (token === "old-access-token" || token === "old-api-key") throw statusError(429, "rate limited on old credential");
      if (token === "invalid-old-token") throw statusError(401, "unauthorized on old token");
      return { payload: `${a.id}:${token}` };
    },
    stream: async (a) => {
      hold.started?.();
      if (hold.gate) await hold.gate;
      const token = authAccessToken(a);
      return streamOf(["chunk-1", token === "old-access-token" ? statusError(429, "rate limited on old token") : "chunk-2"]);
    },
  });
}

async function runLateResult(tm: TestManager, authId: string, model: string, mutate: (current: Auth) => Auth, stream = false): Promise<void> {
  const started = deferred();
  const gate = deferred();
  tm.manager.registerExecutor(issue6416Executor({ gate: gate.promise, started: () => started.resolve() }));
  const pending = stream
    ? tm.manager.executeStream(["codex"], req(model), opts({ stream: true })).then(async (result) => {
        await drain(result);
      })
    : tm.manager.execute(["codex"], req(model), opts()).catch(() => undefined);
  await started.promise;
  tm.manager.update(mutate(tm.manager.getById(authId)!));
  gate.resolve();
  await pending;
}

function expectNotCooled(tm: TestManager, authId: string, model: string): void {
  const fresh = tm.manager.getById(authId)!;
  expect(fresh.unavailable).toBe(false);
  const state = fresh.modelStates?.[model];
  if (state) {
    expect(state.quota.exceeded).toBe(false);
    expect(state.unavailable).toBe(false);
    expect(state.nextRetryAfter).toBe(0);
  }
}

test("Manager_Issue6416_LateResultBeforeCredentialUpdate_DoesNotCooldownNewCredential", async () => {
  const tm = newManager();
  registerModels(tm.registry, "auth-issue-6416-exec", "codex", "gpt-5");
  tm.manager.register(auth({ id: "auth-issue-6416-exec", provider: "codex", metadata: { access_token: "old-access-token" } }));
  await runLateResult(tm, "auth-issue-6416-exec", "gpt-5", (current) => ({ ...current, metadata: { access_token: "new-access-token" } }));
  expectNotCooled(tm, "auth-issue-6416-exec", "gpt-5");
});

test("Manager_Issue6416_LateStreamResultBeforeCredentialUpdate_DoesNotCooldownNewCredential", async () => {
  const tm = newManager();
  registerModels(tm.registry, "auth-issue-6416-stream", "codex", "gpt-5");
  tm.manager.register(auth({ id: "auth-issue-6416-stream", provider: "codex", metadata: { access_token: "old-access-token" } }));
  await runLateResult(tm, "auth-issue-6416-stream", "gpt-5", (current) => ({ ...current, metadata: { access_token: "new-access-token" } }), true);
  expectNotCooled(tm, "auth-issue-6416-stream", "gpt-5");
});

test("Manager_Issue6416_LoadInitializesCredentialVersion", async () => {
  const store = new MemoryStore();
  store.items = [auth({ id: "auth-issue-6416-load", provider: "codex", metadata: { access_token: "old-access-token" } })];
  const tm = newManager({ store });
  registerModels(tm.registry, "auth-issue-6416-load", "codex", "gpt-5");
  await tm.manager.load();
  expect(tm.manager.credentialVersion("auth-issue-6416-load")).toBe(1);
  await runLateResult(tm, "auth-issue-6416-load", "gpt-5", (current) => ({ ...current, metadata: { access_token: "new-access-token" } }));
  expect(tm.manager.credentialVersion("auth-issue-6416-load")).toBe(2);
  expectNotCooled(tm, "auth-issue-6416-load", "gpt-5");
});

test("Manager_Issue6416_Late401ResultBeforeCredentialUpdate_DoesNotInvalidateNewCredential", async () => {
  const tm = newManager();
  registerModels(tm.registry, "auth-issue-6416-401", "codex", "gpt-5");
  tm.manager.register(auth({ id: "auth-issue-6416-401", provider: "codex", status: StatusActive, metadata: { access_token: "invalid-old-token" } }));
  await runLateResult(tm, "auth-issue-6416-401", "gpt-5", (current) => ({ ...current, metadata: { access_token: "valid-new-token" } }));
  const fresh = tm.manager.getById("auth-issue-6416-401")!;
  expect(fresh.unavailable).toBe(false);
  expect(fresh.status).not.toBe("error");
  expect(fresh.modelStates?.["gpt-5"]?.unavailable ?? false).toBe(false);
});

test("Manager_Issue6416_APIKeyRotation_LateResultDoesNotCooldownNewAPIKey", async () => {
  const tm = newManager();
  registerModels(tm.registry, "auth-issue-6416-apikey", "codex", "gpt-5");
  tm.manager.register(auth({ id: "auth-issue-6416-apikey", provider: "codex", attributes: { api_key: "old-api-key" } }));
  expect(tm.manager.credentialVersion("auth-issue-6416-apikey")).toBe(1);
  await runLateResult(tm, "auth-issue-6416-apikey", "gpt-5", (current) => ({ ...current, attributes: { api_key: "new-api-key" } }));
  expect(tm.manager.credentialVersion("auth-issue-6416-apikey")).toBe(2);
  expectNotCooled(tm, "auth-issue-6416-apikey", "gpt-5");
});

test("Manager_Issue6416_DirectMarkResult_StaleCredentialVersionIgnored", () => {
  const tm = newManager();
  const id = "auth-direct-stale-version";
  registerModels(tm.registry, id, "codex", "gpt-5");
  tm.manager.register(auth({ id, provider: "codex", metadata: { access_token: "token-v1" } }));
  expect(tm.manager.credentialVersion(id)).toBe(1);
  tm.manager.update({ ...tm.manager.getById(id)!, metadata: { access_token: "token-v2" } });
  expect(tm.manager.credentialVersion(id)).toBe(2);
  const fail = (credentialVersion: number, message: string) =>
    tm.manager.markResult({ authId: id, provider: "codex", model: "gpt-5", success: false, credentialVersion, error: { httpStatus: 429, message, retryable: false } });
  fail(1, "stale 429");
  expect(tm.manager.getById(id)!.unavailable).toBe(false);
  expect(tm.manager.getById(id)!.modelStates?.["gpt-5"]?.quota.exceeded ?? false).toBe(false);
  fail(0, "stale 429 v0");
  expect(tm.manager.getById(id)!.unavailable).toBe(false);
  expect(tm.manager.getById(id)!.modelStates?.["gpt-5"]?.quota.exceeded ?? false).toBe(false);
  fail(2, "current 429");
  expect(tm.manager.getById(id)!.modelStates!["gpt-5"]!.quota.exceeded).toBe(true);
});

test("Manager_Issue6416_NonSecretUpdate_PreservesVersionAndAppliesCooldown", async () => {
  const tm = newManager();
  const id = "auth-nonsecret-update";
  registerModels(tm.registry, id, "codex", "gpt-5");
  tm.manager.register(auth({ id, provider: "codex", label: "initial-label", metadata: { access_token: "old-access-token" } }));
  await runLateResult(tm, id, "gpt-5", (current) => ({ ...current, label: "updated-label" }));
  expect(tm.manager.credentialVersion(id)).toBe(1);
  expect(tm.manager.getById(id)!.modelStates!["gpt-5"]!.quota.exceeded).toBe(true);
});

// ---------------------------------------------------------------------------
// Issue 6417: a refresh result never overwrites credentials committed meanwhile
// ---------------------------------------------------------------------------

test("Manager_RefreshAuth_DropsStaleConcurrentCredential", async () => {
  const store = new MemoryStore();
  const tm = newManager({ store });
  const started = deferred();
  const release = deferred();
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "claude",
      refresh: async (a) => {
        started.resolve();
        await release.promise;
        a.metadata.access_token = "access-token-a-refreshed";
        a.metadata.refresh_token = "refresh-token-a-refreshed";
        a.metadata.expired = new Date(tm.clock.now() + Hour).toISOString();
        return a;
      },
    }),
  );
  tm.manager.register(
    auth({ id: "issue-6417-auth", provider: "claude", status: StatusActive, metadata: { access_token: "access-token-a", refresh_token: "refresh-token-a", expired: new Date(tm.clock.now() - Hour).toISOString() } }),
  );
  const refresh = tm.manager.refreshAuth("issue-6417-auth");
  await started.promise;
  const current = tm.manager.getById("issue-6417-auth")!;
  current.metadata.access_token = "access-token-b";
  current.metadata.refresh_token = "refresh-token-b";
  tm.manager.update(current);
  release.resolve();
  await refresh;
  const updated = tm.manager.getById("issue-6417-auth")!;
  expect(updated.metadata.access_token).toBe("access-token-b");
  expect(updated.metadata.refresh_token).toBe("refresh-token-b");
  await tm.manager.flushPersistence();
  const persisted = store.saved.filter((a) => a.id === "issue-6417-auth").at(-1)!;
  expect(persisted.metadata.access_token).toBe("access-token-b");
  expect(persisted.metadata.refresh_token).toBe("refresh-token-b");
});

// ---------------------------------------------------------------------------
// Issue 6503: an upstream quota failure is recorded even when the client went away
// ---------------------------------------------------------------------------

const issue6503QuotaError = () => statusError(429, "usage_limit_reached", { credentialScoped: true, retryAfterMs: 10 * Minute });

function issue6503Manager(stream: (a: Auth, r: ExecRequest, controller: AbortController) => unknown, metadata: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "issue6503",
      stream: async (a, r) => stream(a, r, controller) as never,
      refresh: (a) => {
        a.metadata.access_token = "refreshed";
        return a;
      },
    }),
  );
  registerModels(tm.registry, "issue6503-auth", "issue6503", "issue6503-model");
  tm.manager.register(auth({ id: "issue6503-auth", provider: "issue6503", status: StatusActive, metadata }));
  return { tm, controller };
}

test("ManagerExecuteStreamRecordsQuotaCooldownWhenContextCanceled", async () => {
  const { tm, controller } = issue6503Manager((_a, _r, c) => {
    c.abort();
    throw issue6503QuotaError();
  });
  const err = await rejection(tm.manager.executeStream(["issue6503"], req("issue6503-model"), opts({ signal: controller.signal })));
  expect((err as Error).name).toBe("AbortError");
  const current = tm.manager.getById("issue6503-auth")!;
  expect(current.unavailable).toBe(true);
  expect(current.nextRetryAfter).toBeGreaterThan(tm.clock.now() + 5 * Minute);
});

test("ManagerExecuteStreamPlainCancellationDoesNotCoolCredential", async () => {
  const { tm, controller } = issue6503Manager((_a, _r, c) => {
    c.abort();
    throw new DOMException("The operation was aborted.", "AbortError");
  });
  const err = await rejection(tm.manager.executeStream(["issue6503"], req("issue6503-model"), opts({ signal: controller.signal })));
  expect((err as Error).name).toBe("AbortError");
  const current = tm.manager.getById("issue6503-auth")!;
  expect(current.unavailable).toBe(false);
  expect(current.nextRetryAfter).toBe(0);
  const state = current.modelStates?.["issue6503-model"];
  if (state) {
    expect(state.unavailable).toBe(false);
    expect(state.quota.exceeded).toBe(false);
  }
});

test("ManagerExecuteStreamRecordsQuotaCooldownFromCanceledBootstrapChunk", async () => {
  const { tm, controller } = issue6503Manager((_a, _r, c) => {
    c.abort();
    return streamOf([issue6503QuotaError()]);
  });
  const err = await rejection(tm.manager.executeStream(["issue6503"], req("issue6503-model"), opts({ signal: controller.signal })));
  expect((err as Error).name).toBe("AbortError");
  const current = tm.manager.getById("issue6503-auth")!;
  expect(current.unavailable).toBe(true);
  expect(current.nextRetryAfter).toBeGreaterThan(tm.clock.now() + 5 * Minute);
});

test("ManagerExecuteStreamRecordsQuotaCooldownFromCanceledRefreshRetry", async () => {
  let calls = 0;
  const { tm, controller } = issue6503Manager(
    (_a, _r, c) => {
      calls++;
      if (calls > 1) {
        c.abort();
        throw issue6503QuotaError();
      }
      return streamOf([new StatusError(401, "token invalidated")]);
    },
    { access_token: "stale", refresh_token: "refresh" },
  );
  const err = await rejection(tm.manager.executeStream(["issue6503"], req("issue6503-model"), opts({ signal: controller.signal })));
  expect((err as Error).name).toBe("AbortError");
  const current = tm.manager.getById("issue6503-auth")!;
  expect(current.unavailable).toBe(true);
  expect(current.nextRetryAfter).toBeGreaterThan(tm.clock.now() + 5 * Minute);
});

// ---------------------------------------------------------------------------
// Issue 6643: successes dispatched before a cooldown cannot clear it
// ---------------------------------------------------------------------------

const quotaFailure = (authId: string, model: string, executionSeq: number) => ({
  authId,
  provider: "claude",
  model,
  success: false,
  executionSeq,
  error: { code: "quota_exhausted", message: "QUOTA_EXHAUSTED", retryable: true, httpStatus: 429 },
});

function issue6643Manager(authId: string): TestManager {
  const tm = newManager();
  tm.manager.register(auth({ id: authId, provider: "claude", status: StatusActive }), { skipPersist: true });
  return tm;
}

test("Manager_Issue6643_SuccessDispatchedAfterCooldownClearsIt", () => {
  const model = "gemini-4-argon-high";
  const tm = issue6643Manager("issue6643-after-auth");
  const staleSeq = tm.manager.nextExecutionSeq();
  tm.manager.markResult(quotaFailure("issue6643-after-auth", model, tm.manager.nextExecutionSeq()));
  expect(tm.manager.getById("issue6643-after-auth")!.modelStates![model]!.quota.exceeded).toBe(true);
  tm.manager.markResult({ authId: "issue6643-after-auth", provider: "claude", model, success: true, executionSeq: staleSeq });
  let state = tm.manager.getById("issue6643-after-auth")!.modelStates![model]!;
  expect(state.unavailable && state.quota.exceeded && state.nextRetryAfter > tm.clock.now()).toBe(true);
  tm.manager.markResult({ authId: "issue6643-after-auth", provider: "claude", model, success: true, executionSeq: tm.manager.nextExecutionSeq() });
  state = tm.manager.getById("issue6643-after-auth")!.modelStates![model]!;
  expect(state.unavailable || state.quota.exceeded || state.nextRetryAfter !== 0).toBe(false);
});

test("Manager_Issue6643_UnstampedSuccessKeepsLegacyClearBehavior", () => {
  const model = "gemini-4-argon-high";
  const tm = issue6643Manager("issue6643-unstamped-auth");
  tm.manager.markResult(quotaFailure("issue6643-unstamped-auth", model, tm.manager.nextExecutionSeq()));
  tm.manager.markResult({ authId: "issue6643-unstamped-auth", provider: "claude", model, success: true });
  const state = tm.manager.getById("issue6643-unstamped-auth")!.modelStates![model]!;
  expect(state.unavailable || state.quota.exceeded).toBe(false);
});

test("Manager_Issue6643_StaleAuthLevelSuccessKeepsCooldown", () => {
  const tm = issue6643Manager("issue6643-auth-level-auth");
  const staleSeq = tm.manager.nextExecutionSeq();
  tm.manager.markResult(quotaFailure("issue6643-auth-level-auth", "", tm.manager.nextExecutionSeq()));
  let updated = tm.manager.getById("issue6643-auth-level-auth")!;
  expect(updated.quota.exceeded && updated.nextRetryAfter > tm.clock.now()).toBe(true);
  tm.manager.markResult({ authId: "issue6643-auth-level-auth", provider: "claude", model: "", success: true, executionSeq: staleSeq });
  updated = tm.manager.getById("issue6643-auth-level-auth")!;
  expect(updated.quota.exceeded && updated.nextRetryAfter > tm.clock.now()).toBe(true);
  tm.manager.markResult({ authId: "issue6643-auth-level-auth", provider: "claude", model: "", success: true, executionSeq: tm.manager.nextExecutionSeq() });
  updated = tm.manager.getById("issue6643-auth-level-auth")!;
  expect(updated.quota.exceeded).toBe(false);
  expect(updated.nextRetryAfter).toBe(0);
});

test("Manager_Issue6643_InFlightSuccessesKeepFreshQuotaCooldown", async () => {
  const model = "gemini-4-argon-high";
  const requests = 6;
  const quotaRecorded = deferred();
  let exhausted = false;
  let dispatched = 0;
  let callsAfterExhaustion = 0;
  const quota = () => new StatusError(429, "QUOTA_EXHAUSTED: Resets in 140h36m");
  const tm = newManager();
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "claude",
      execute: async () => {
        if (exhausted) {
          callsAfterExhaustion++;
          throw quota();
        }
        dispatched++;
        if (dispatched < requests) {
          await quotaRecorded.promise;
          return { payload: "ok" };
        }
        exhausted = true;
        // Release the earlier dispatches only after the manager recorded this failure.
        setTimeout(() => quotaRecorded.resolve(), 0);
        throw quota();
      },
    }),
  );
  registerModels(tm.registry, "issue6643-auth", "claude", model);
  tm.manager.register(auth({ id: "issue6643-auth", provider: "claude", status: StatusActive }), { skipPersist: true });
  const outcomes = await Promise.allSettled(Array.from({ length: requests }, () => tm.manager.execute(["claude"], req(model, "ping"), opts())));
  expect(outcomes.filter((o) => o.status === "rejected").length).toBe(1);
  expect(callsAfterExhaustion).toBe(0);
  const updated = tm.manager.getById("issue6643-auth")!;
  const state = updated.modelStates![model]!;
  expect(state.unavailable && state.quota.exceeded && state.nextRetryAfter > tm.clock.now()).toBe(true);
  expect(isAuthBlockedForModel(updated, model, tm.clock.now()).blocked).toBe(true);
});

// file_snapshot_cooldown_seq_test.go: TestManager_Issue6643_CredentialQuotaCarryKeepsCooldownWatermark
test("Manager_Issue6643_CredentialQuotaCarryKeepsCooldownWatermark", () => {
  const tm = issue6643Manager("issue6643-carry-auth");
  const staleSeq = tm.manager.nextExecutionSeq();
  tm.manager.markResult({ ...quotaFailure("issue6643-carry-auth", "model-a", tm.manager.nextExecutionSeq()), credentialScope: true, retryAfterMs: Hour });
  // A credential update (no credential change) carries the live credential quota.
  tm.manager.update(tm.manager.getById("issue6643-carry-auth")!);
  tm.manager.markResult({ authId: "issue6643-carry-auth", provider: "claude", model: "model-a", success: true, executionSeq: staleSeq });
  const updated = tm.manager.getById("issue6643-carry-auth")!;
  expect(updated.quota.reason).toBe("credential_quota");
  expect(updated.quota.nextRecoverAt).toBeGreaterThan(tm.clock.now());
  expect(updated.modelStates!["model-a"]!.quota.exceeded).toBe(true);
});

void settle;
