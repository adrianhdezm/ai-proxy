// Ported from: sdk/cliproxy/auth/scheduler_test.go
// Skipped cases: TestSchedulerPick_Weighted* / TestManagerLoad_WeightedRoundRobin* / TestManagerLegacyWeightedRoundRobin* /
// TestSchedulerPickMixed_RetryTriedFilterPreservesSmoothWeightedDistribution / TestManagerWeightedRoundRobin* (weighted
// selector not ported), TestSchedulerPick_*Websocket* (websocket executors not ported), TestSchedulerPick_MixedProviders*Rotation /
// TestManager_PickNextMixed_UsesSchedulerRotation / TestManager_PickNextMixed_UsesWeightedProviderRotation* (per-model provider
// rotation of the incremental scheduler not ported; mixed picks rotate over the id-sorted candidate ring), TestManagerPluginScheduler* /
// TestManagerInactivePluginScheduler* / TestManagerCustomSelector_FallsBackToLegacyPath / TestManager_InitializesSchedulerForBuiltInSelector /
// TestManager_SchedulerTracksRegisterAndUpdate (plugin scheduler / scheduler internals), TestManagerSelectAuthByKind* /
// TestManagerCodexAlphaSearchPolicy* / TestManager_PickNextMixed_DisallowFreeAuthSkipsCodexFreePlan (credential policies not ported),
// TestManagerLegacySelectAuthFailsClosedWhenHomeEnabled / TestSelectHomeAuth* / TestPickNextViaHome* (Home not ported),
// TestReadyViewRoundRobinPreservesSuccessorAcrossRebuild / TestScheduledSuccessorIndex_* (scheduler internals).
import { expect, test } from "bun:test";
import { FillFirstSelector, RoundRobinSelector } from "../../../src/auth/manager/index.ts";
import { StatusError } from "../../../src/auth/types.ts";
import { Hour, auth, fakeExecutor, newManager, opts, registerModels } from "./helpers.ts";

test("SchedulerPick_RoundRobinHighestPriority", () => {
  const { manager } = newManager({ selector: new RoundRobinSelector() });
  manager.registerExecutor(fakeExecutor({ identifier: "gemini" }));
  manager.register(auth({ id: "low", provider: "gemini", attributes: { priority: "0" } }));
  manager.register(auth({ id: "high-b", provider: "gemini", attributes: { priority: "10" } }));
  manager.register(auth({ id: "high-a", provider: "gemini", attributes: { priority: "10" } }));
  for (const want of ["high-a", "high-b", "high-a"]) {
    expect(manager.selectAuth(["gemini"], "", opts()).auth.id).toBe(want);
  }
});

test("SchedulerPick_FillFirstSticksToFirstReady", () => {
  const { manager } = newManager({ selector: new FillFirstSelector() });
  manager.registerExecutor(fakeExecutor({ identifier: "gemini" }));
  for (const id of ["b", "a", "c"]) manager.register(auth({ id, provider: "gemini" }));
  for (let i = 0; i < 3; i++) expect(manager.selectAuth(["gemini"], "", opts()).auth.id).toBe("a");
});

test("SchedulerPick_PromotesExpiredCooldownBeforePick", () => {
  const model = "gemini-2.5-pro";
  const { manager, registry, clock } = newManager({ selector: new RoundRobinSelector() });
  manager.registerExecutor(fakeExecutor({ identifier: "gemini" }));
  registerModels(registry, "cooldown-expired", "gemini", model);
  manager.register(
    auth({
      id: "cooldown-expired",
      provider: "gemini",
      modelStates: { [model]: { status: StatusError, unavailable: true, nextRetryAfter: clock.now() - 1000, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: 0 } },
    }),
  );
  expect(manager.selectAuth(["gemini"], model, opts()).auth.id).toBe("cooldown-expired");
});

test("ManagerRoundRobinPreservesSuccessorAcrossCooldown", () => {
  const { manager, registry } = newManager({ selector: new RoundRobinSelector() });
  manager.registerExecutor(fakeExecutor({ identifier: "gemini" }));
  const model = "test-successor-model";
  const ids = ["successor-auth-a", "successor-auth-b", "successor-auth-c"];
  for (const id of ids) {
    registerModels(registry, id, "gemini", model);
    manager.register(auth({ id, provider: "gemini" }));
  }
  expect(manager.selectAuth(["gemini"], model, opts()).auth.id).toBe("successor-auth-a");
  manager.markResult({ authId: "successor-auth-a", provider: "gemini", model, success: false, error: { httpStatus: 429, message: "rate limit", retryable: false } });
  expect(manager.selectAuth(["gemini"], model, opts()).auth.id).toBe("successor-auth-b");
  manager.markResult({ authId: "successor-auth-b", provider: "gemini", model, success: false, error: { httpStatus: 429, message: "rate limit", retryable: false } });
  expect(manager.selectAuth(["gemini"], model, opts()).auth.id).toBe("successor-auth-c");
});

test("SchedulerPick_MixedProvidersPrefersHighestPriorityTier", () => {
  const model = "gpt-default";
  const { manager, registry } = newManager({ selector: new RoundRobinSelector() });
  for (const provider of ["provider-low", "provider-high-a", "provider-high-b"]) manager.registerExecutor(fakeExecutor({ identifier: provider }));
  registerModels(registry, "low", "provider-low", model);
  registerModels(registry, "high-a", "provider-high-a", model);
  registerModels(registry, "high-b", "provider-high-b", model);
  manager.register(auth({ id: "low", provider: "provider-low", attributes: { priority: "4" } }));
  manager.register(auth({ id: "high-a", provider: "provider-high-a", attributes: { priority: "7" } }));
  manager.register(auth({ id: "high-b", provider: "provider-high-b", attributes: { priority: "7" } }));
  const providers = ["provider-low", "provider-high-a", "provider-high-b"];
  const wantProviders = ["provider-high-a", "provider-high-b", "provider-high-a", "provider-high-b"];
  const wantIDs = ["high-a", "high-b", "high-a", "high-b"];
  for (let index = 0; index < wantProviders.length; index++) {
    const got = manager.selectAuth(providers, model, opts());
    expect(got.provider).toBe(wantProviders[index]!);
    expect(got.auth.id).toBe(wantIDs[index]!);
  }
});

test("Manager_SchedulerSharesThinkingSuffixCooldownAndRegistryState", () => {
  const { manager, registry } = newManager({ selector: new RoundRobinSelector() });
  manager.registerExecutor(fakeExecutor({ identifier: "gemini" }));
  const baseModel = "scheduler-thinking-model";
  registerModels(registry, "thinking-auth-a", "gemini", baseModel);
  registerModels(registry, "thinking-auth-b", "gemini", baseModel);
  manager.register(auth({ id: "thinking-auth-a", provider: "gemini" }));
  manager.register(auth({ id: "thinking-auth-b", provider: "gemini" }));

  manager.markResult({ authId: "thinking-auth-a", provider: "gemini", model: baseModel + "(high)", success: false, error: { httpStatus: 429, message: "quota", retryable: false }, retryAfterMs: Hour });

  const a = manager.getById("thinking-auth-a")!;
  expect(Object.keys(a.modelStates ?? {})).toEqual([baseModel]);
  expect(registry.getModelCount(baseModel)).toBe(1);
  for (const model of [baseModel, baseModel + "(medium)", baseModel + "(low)"]) {
    expect(manager.selectAuth(["gemini"], model, opts()).auth.id).toBe("thinking-auth-b");
  }

  manager.markResult({ authId: "thinking-auth-a", provider: "gemini", model: baseModel + "(low)", success: true });
  const after = manager.getById("thinking-auth-a")!;
  const state = after.modelStates![baseModel]!;
  expect(state.unavailable).toBe(false);
  expect(state.quota.exceeded).toBe(false);
  expect(state.nextRetryAfter).toBe(0);
  expect(registry.getModelCount(baseModel)).toBe(2);
});

test("Manager_PickNextMixed_SkipsProvidersWithoutExecutors", () => {
  const { manager } = newManager({ selector: new RoundRobinSelector() });
  manager.registerExecutor(fakeExecutor({ identifier: "claude" }));
  manager.register(auth({ id: "gemini-a", provider: "gemini" }));
  manager.register(auth({ id: "claude-a", provider: "claude" }));
  const got = manager.selectAuth(["gemini", "claude"], "", opts());
  expect(got.provider).toBe("claude");
  expect(got.auth.id).toBe("claude-a");
});

test("Manager_SchedulerTracksMarkResultCooldownAndRecovery", () => {
  const { manager, registry } = newManager({ selector: new RoundRobinSelector() });
  manager.registerExecutor(fakeExecutor({ identifier: "gemini" }));
  registerModels(registry, "auth-a", "gemini", "test-model");
  registerModels(registry, "auth-b", "gemini", "test-model");
  manager.register(auth({ id: "auth-a", provider: "gemini" }));
  manager.register(auth({ id: "auth-b", provider: "gemini" }));

  manager.markResult({ authId: "auth-a", provider: "gemini", model: "test-model", success: false, error: { httpStatus: 429, message: "quota", retryable: false } });
  expect(manager.selectAuth(["gemini"], "test-model", opts()).auth.id).toBe("auth-b");

  manager.markResult({ authId: "auth-a", provider: "gemini", model: "test-model", success: true });
  const seen = new Set<string>();
  for (let i = 0; i < 2; i++) seen.add(manager.selectAuth(["gemini"], "test-model", opts()).auth.id);
  expect(seen.size).toBe(2);
});
