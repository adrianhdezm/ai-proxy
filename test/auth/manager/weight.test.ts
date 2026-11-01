// Ported from: sdk/cliproxy/auth/weight_test.go, sdk/cliproxy/auth/conductor_weight_validation_test.go
// Ported from: sdk/cliproxy/auth/selector_test.go
// Ported from: sdk/cliproxy/auth/scheduler_test.go
// Skipped cases: this file adds the weighted cases that selector.test.ts / scheduler.test.ts skipped:
// TestWeightedRoundRobinSelectorPick_* , TestAuthWeight_*, TestSmoothWeightedStatePrepare_* and the
// manager-level TestSchedulerPick_WeightedRoundRobin* / TestManagerLoad_WeightedRoundRobinUsesPersistedMetadataWeight
// (run through AuthManager.selectAuth; there is no incremental scheduler). Skipped:
// TestPickSmoothWeightedAuth_SaturatesCorruptState (int64 saturating arithmetic, a Go-only mechanic),
// TestSchedulerPick_WeightedWebsocket* (websocket preference not ported), the mixed-provider weighted rotation and
// alias-prefixed / disallow-free / by-kind weighted cases (provider rotation, OAuth aliases and credential policies
// not ported), TestSessionAffinitySelector_Weighted* (session affinity not ported).
import { expect, test } from "bun:test";
import {
  MaxSmoothWeightedStateEntries,
  SmoothWeightedState,
  WeightedRoundRobinSelector,
  authWeight,
  selectorForStrategy,
  FillFirstSelector,
  RoundRobinSelector,
  validateAuthWeight,
} from "../../../src/auth/manager/index.ts";
import { AttributeWeight, type Auth } from "../../../src/auth/types.ts";
import { Hour, MemoryStore, auth, baseNow, fakeExecutor, newManager, opts } from "./helpers.ts";

const now = baseNow;

test("ValidateAuthWeight", () => {
  const cases: Array<{ name: string; auth: Auth; wantErr: boolean }> = [
    { name: "omitted", auth: auth({ id: "a" }), wantErr: false },
    { name: "positive attribute", auth: auth({ id: "a", attributes: { [AttributeWeight]: "7" } }), wantErr: false },
    { name: "zero metadata", auth: auth({ id: "a", metadata: { [AttributeWeight]: 0 } }), wantErr: false },
    { name: "negative attribute", auth: auth({ id: "a", attributes: { [AttributeWeight]: "-2" } }), wantErr: false },
    { name: "fraction metadata", auth: auth({ id: "a", metadata: { [AttributeWeight]: 1.5 } }), wantErr: true },
    { name: "above maximum attribute", auth: auth({ id: "a", attributes: { [AttributeWeight]: "1000001" } }), wantErr: true },
    // json.Number("9223372036854775808") decodes to a float beyond the maximum here.
    { name: "overflow metadata", auth: auth({ id: "a", metadata: { [AttributeWeight]: JSON.parse("9223372036854775808") } }), wantErr: true },
    { name: "nonnumeric attribute", auth: auth({ id: "a", attributes: { [AttributeWeight]: "invalid" } }), wantErr: true },
    { name: "valid attribute does not hide invalid metadata", auth: auth({ id: "a", attributes: { [AttributeWeight]: "2" }, metadata: { [AttributeWeight]: 1.5 } }), wantErr: true },
  ];
  for (const tc of cases) {
    let err: unknown;
    try {
      validateAuthWeight(tc.auth);
    } catch (e) {
      err = e;
    }
    expect({ name: tc.name, failed: err !== undefined }).toEqual({ name: tc.name, failed: tc.wantErr });
  }
});

test("ManagerLoadSkipsInvalidExplicitWeights", async () => {
  const store = new MemoryStore();
  store.items = [
    auth({ id: "omitted", provider: "test" }),
    auth({ id: "zero", provider: "test", metadata: { [AttributeWeight]: 0 } }),
    auth({ id: "fraction", provider: "test", metadata: { [AttributeWeight]: 1.5 } }),
    auth({ id: "overflow", provider: "test", attributes: { [AttributeWeight]: "9223372036854775808" } }),
  ];
  const { manager } = newManager({ store });
  await manager.load();
  expect(manager.getById("omitted")).toBeDefined();
  expect(manager.getById("zero")).toBeDefined();
  expect(manager.getById("fraction")).toBeUndefined();
  expect(manager.getById("overflow")).toBeUndefined();
});

test("ManagerRegisterAndUpdateRejectInvalidExplicitWeights", async () => {
  const store = new MemoryStore();
  const { manager } = newManager({ store });
  const invalid = auth({ id: "invalid", provider: "test", metadata: { [AttributeWeight]: "nonnumeric" } });
  expect(() => manager.register(invalid)).toThrow();
  expect(manager.getById("invalid")).toBeUndefined();
  await manager.flushPersistence();
  expect(store.saved.length).toBe(0);

  const valid = auth({ id: "valid", provider: "test", attributes: { [AttributeWeight]: "2" }, metadata: { type: "test" } });
  manager.register(valid);
  const invalidUpdate = structuredClone(valid);
  invalidUpdate.attributes[AttributeWeight] = "1000001";
  expect(() => manager.update(invalidUpdate)).toThrow();
  expect(manager.getById("valid")!.attributes[AttributeWeight]).toBe("2");
  await manager.flushPersistence();
  expect(store.saved.length).toBe(1);
});

function pickCounts(selector: WeightedRoundRobinSelector, auths: Auth[], times: number, model = "model", provider = "gemini"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < times; i++) {
    const got = selector.pick(provider, model, opts(), auths, now);
    counts[got.id] = (counts[got.id] ?? 0) + 1;
  }
  return counts;
}

test("WeightedRoundRobinSelectorPick_DistributesAndSkipsNonPositiveWeights", () => {
  const auths = [
    auth({ id: "a", attributes: { [AttributeWeight]: "5" } }),
    auth({ id: "b", attributes: { [AttributeWeight]: "3" } }),
    auth({ id: "c", attributes: { [AttributeWeight]: "2" } }),
    auth({ id: "disabled-by-weight", attributes: { [AttributeWeight]: "0" } }),
  ];
  expect(pickCounts(new WeightedRoundRobinSelector(), auths, 100)).toEqual({ a: 50, b: 30, c: 20 });
});

test("WeightedRoundRobinSelectorPick_ResetsCreditsWhenWeightsChange", () => {
  const selector = new WeightedRoundRobinSelector();
  const authA = auth({ id: "a", attributes: { [AttributeWeight]: "1000000" } });
  const authB = auth({ id: "b", attributes: { [AttributeWeight]: "1" } });
  pickCounts(selector, [authA, authB], 1000);
  authA.attributes[AttributeWeight] = "1";
  expect(pickCounts(selector, [authA, authB], 20)).toEqual({ a: 10, b: 10 });
});

test("WeightedRoundRobinSelectorPick_RebalancesWhenHighestWeightUnavailable", () => {
  const auths = [
    auth({ id: "a", disabled: true, attributes: { [AttributeWeight]: "5" } }),
    auth({ id: "b", attributes: { [AttributeWeight]: "3" } }),
    auth({ id: "c", attributes: { [AttributeWeight]: "2" } }),
  ];
  expect(pickCounts(new WeightedRoundRobinSelector(), auths, 100)).toEqual({ b: 60, c: 40 });
});

test("WeightedRoundRobinSelectorPick_SkipsUnavailableAndQuotaExceededWithoutRecovery", () => {
  const model = "test-model";
  const selector = new WeightedRoundRobinSelector();
  const auths = [
    auth({ id: "model-unavailable", modelStates: { [model]: { status: "active", unavailable: true, nextRetryAfter: 0, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: 0 } } }),
    auth({ id: "quota-exceeded", quota: { exceeded: true, nextRecoverAt: 0 } }),
    auth({ id: "available" }),
  ];
  expect(selector.pick("gemini", model, opts(), auths, now).id).toBe("available");
  for (let i = 0; i < 4; i++) expect(selector.pick("gemini", "", opts(), auths, now).id).not.toBe("quota-exceeded");
});

test("AuthWeight_MetadataFallbackAndAttributePrecedence", () => {
  expect(authWeight(auth({ id: "a", metadata: { [AttributeWeight]: 7 } }))).toBe(7);
  expect(authWeight(auth({ id: "a", attributes: { [AttributeWeight]: "3" }, metadata: { [AttributeWeight]: 7 } }))).toBe(3);
});

test("AuthWeight_InvalidAndOverflowValuesAreExcluded", () => {
  for (const raw of ["1.5", "1000001", "9223372036854775807", "9223372036854775808"]) {
    expect(authWeight(auth({ id: "a", attributes: { [AttributeWeight]: raw } }))).toBe(0);
  }
  expect(authWeight(auth({ id: "a", metadata: { [AttributeWeight]: 1.5 } }))).toBe(0);
  expect(authWeight(auth({ id: "a", attributes: { [AttributeWeight]: "-1" } }))).toBe(0);
});

test("WeightedRoundRobinSelectorPick_RecoveredAuthReturnsWithoutAccumulatedCredit", () => {
  const selector = new WeightedRoundRobinSelector();
  const authA = auth({ id: "a", attributes: { [AttributeWeight]: "5" } });
  const authB = auth({ id: "b", attributes: { [AttributeWeight]: "1" } });
  pickCounts(selector, [authA, authB], 6);
  authA.unavailable = true;
  authA.nextRetryAfter = now + Hour;
  for (let i = 0; i < 6; i++) expect(selector.pick("gemini", "model", opts(), [authA, authB], now).id).toBe("b");
  authA.unavailable = false;
  authA.nextRetryAfter = 0;
  expect(pickCounts(selector, [authA, authB], 6)).toEqual({ a: 5, b: 1 });
});

test("WeightedRoundRobinSelectorPick_DefaultWeightIsOne", () => {
  expect(pickCounts(new WeightedRoundRobinSelector(), [auth({ id: "a" }), auth({ id: "b" }), auth({ id: "c" })], 30)).toEqual({ a: 10, b: 10, c: 10 });
});

test("WeightedRoundRobinSelectorPick_SubsetFilteringDoesNotResetAccumulatorOrFavorFirstAlphabetical", () => {
  const subset = [auth({ id: "auth-b" }), auth({ id: "auth-c" }), auth({ id: "auth-d" })];
  expect(pickCounts(new WeightedRoundRobinSelector(), subset, 30, "model", "provider")).toEqual({ "auth-b": 10, "auth-c": 10, "auth-d": 10 });
});

test("SmoothWeightedStatePrepare_KeepsCreditsForTransientSubsetsAndBoundsGrowth", () => {
  const state = new SmoothWeightedState();
  state.prepare(new Map([["a", 1], ["b", 1]]));
  state.current!.set("a", -2);
  state.current!.set("b", 1);
  state.prepare(new Map([["b", 1]]));
  expect(state.current!.get("a")).toBe(-2);
  expect(state.current!.get("b")).toBe(1);
  state.prepare(new Map([["b", 5]]));
  expect(state.current!.size).toBe(0);
  for (let i = 0; i < MaxSmoothWeightedStateEntries * 3; i++) state.prepare(new Map([[`churn-${i}`, 5]]));
  expect(state.current!.size).toBeLessThanOrEqual(MaxSmoothWeightedStateEntries);
  expect(state.weights!.size).toBeLessThanOrEqual(MaxSmoothWeightedStateEntries);
});

test("WeightedRoundRobinSelectorPick_KeepsWeightRatiosWhenCandidatesAreExcluded", () => {
  const selector = new WeightedRoundRobinSelector();
  const authA = auth({ id: "auth-a", attributes: { [AttributeWeight]: "5" } });
  const authB = auth({ id: "auth-b", attributes: { [AttributeWeight]: "3" } });
  const authC = auth({ id: "auth-c", attributes: { [AttributeWeight]: "1" } });
  pickCounts(selector, [authA, authB, authC], 9, "model", "codex");
  expect(pickCounts(selector, [authB, authC], 400, "model", "codex")).toEqual({ "auth-b": 300, "auth-c": 100 });
});

// --- manager-level weighted selection (scheduler_test.go) ---

function weightedManager(...auths: Auth[]) {
  const tm = newManager({ selector: new WeightedRoundRobinSelector() });
  tm.manager.registerExecutor(fakeExecutor({ identifier: "gemini" }));
  for (const a of auths) tm.manager.register(a);
  return tm;
}

function managerCounts(manager: ReturnType<typeof weightedManager>["manager"], times: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < times; i++) {
    const { auth: got } = manager.selectAuth(["gemini"], "", opts());
    counts[got.id] = (counts[got.id] ?? 0) + 1;
  }
  return counts;
}

test("SchedulerPick_WeightedRoundRobin", () => {
  const { manager } = weightedManager(
    auth({ id: "a", provider: "gemini", attributes: { [AttributeWeight]: "5" } }),
    auth({ id: "b", provider: "gemini", attributes: { [AttributeWeight]: "3" } }),
    auth({ id: "c", provider: "gemini", attributes: { [AttributeWeight]: "2" } }),
  );
  expect(managerCounts(manager, 100)).toEqual({ a: 50, b: 30, c: 20 });
});

test("ManagerLoad_WeightedRoundRobinUsesPersistedMetadataWeight", async () => {
  const store = new MemoryStore();
  store.items = [auth({ id: "a", provider: "gemini", metadata: { [AttributeWeight]: 5 } }), auth({ id: "b", provider: "gemini", metadata: { [AttributeWeight]: 1 } })];
  const tm = newManager({ store, selector: new WeightedRoundRobinSelector() });
  tm.manager.registerExecutor(fakeExecutor({ identifier: "gemini" }));
  await tm.manager.load();
  expect(managerCounts(tm.manager, 60)).toEqual({ a: 50, b: 10 });
});

test("SchedulerPick_WeightedRoundRobinResetsCreditsWhenWeightsChange", () => {
  const authA = auth({ id: "a", provider: "gemini", attributes: { [AttributeWeight]: "1000000" } });
  const { manager } = weightedManager(authA, auth({ id: "b", provider: "gemini", attributes: { [AttributeWeight]: "1" } }));
  managerCounts(manager, 1000);
  const updated = manager.getById("a")!;
  updated.attributes[AttributeWeight] = "1";
  manager.update(updated);
  expect(managerCounts(manager, 20)).toEqual({ a: 10, b: 10 });
});

test("SchedulerPick_WeightedRoundRobinSkipsNonPositiveWeightPriorityTier", () => {
  const { manager } = weightedManager(
    auth({ id: "excluded", provider: "gemini", attributes: { priority: "10", [AttributeWeight]: "0" } }),
    auth({ id: "available", provider: "gemini", attributes: { priority: "0", [AttributeWeight]: "1" } }),
  );
  expect(manager.selectAuth(["gemini"], "", opts()).auth.id).toBe("available");
});

test("selectorForStrategy maps routing.strategy to the selector (builder.go)", () => {
  expect(selectorForStrategy("weighted-round-robin")).toBeInstanceOf(WeightedRoundRobinSelector);
  expect(selectorForStrategy("fill-first")).toBeInstanceOf(FillFirstSelector);
  expect(selectorForStrategy("round-robin")).toBeInstanceOf(RoundRobinSelector);
  expect(selectorForStrategy(undefined)).toBeInstanceOf(RoundRobinSelector);
});
