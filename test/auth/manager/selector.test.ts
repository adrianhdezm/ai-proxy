// Ported from: sdk/cliproxy/auth/selector_test.go
// Skipped cases: TestWeightedRoundRobinSelectorPick_* / TestAuthWeight_* / TestPickSmoothWeightedAuth_* /
// TestSmoothWeightedStatePrepare_* (weighted selector not ported), TestRoundRobinSelectorPick_Concurrent
// (goroutine race; single threaded here), TestExtractSessionID* / TestSessionAffinitySelector* /
// TestSessionCache* / TestExtractExplicitSessionIDs_* (session affinity not ported),
// TestManagerSetSelector* (selector swapping not ported).
import { expect, test } from "bun:test";
import { FillFirstSelector, ModelCooldownError, RoundRobinSelector, isAuthBlockedForModel, successorIndex } from "../../../src/auth/manager/index.ts";
import { StatusActive, StatusError } from "../../../src/auth/types.ts";
import { Hour, Minute, auth, baseNow, opts } from "./helpers.ts";

const now = baseNow;

test("FillFirstSelectorPick_Deterministic", () => {
  const selector = new FillFirstSelector();
  const got = selector.pick("gemini", "", opts(), [auth({ id: "b" }), auth({ id: "a" }), auth({ id: "c" })], now);
  expect(got.id).toBe("a");
});

test("RoundRobinSelectorPick_CyclesDeterministic", () => {
  const selector = new RoundRobinSelector();
  const auths = [auth({ id: "b" }), auth({ id: "a" }), auth({ id: "c" })];
  const want = ["a", "b", "c", "a", "b"];
  for (const id of want) expect(selector.pick("gemini", "", opts(), auths, now).id).toBe(id);
});

test("RoundRobinSelectorPick_PriorityBuckets", () => {
  const selector = new RoundRobinSelector();
  const auths = [
    auth({ id: "c", attributes: { priority: "0" } }),
    auth({ id: "a", attributes: { priority: "10" } }),
    auth({ id: "b", attributes: { priority: "10" } }),
  ];
  for (const id of ["a", "b", "a", "b"]) expect(selector.pick("mixed", "", opts(), auths, now).id).toBe(id);
});

test("FillFirstSelectorPick_PriorityFallbackCooldown", () => {
  const model = "test-model";
  const high = auth({
    id: "high",
    attributes: { priority: "10" },
    modelStates: {
      [model]: { status: StatusActive, unavailable: true, nextRetryAfter: now + 30 * Minute, quota: { exceeded: true, nextRecoverAt: 0 }, updatedAt: 0 },
    },
  });
  const low = auth({ id: "low", attributes: { priority: "0" } });
  expect(new FillFirstSelector().pick("mixed", model, opts(), [high, low], now).id).toBe("low");
});

test("SelectorPick_AllCooldownReturnsModelCooldownError", () => {
  const model = "test-model";
  const next = now + 60_000;
  const state = () => ({ status: StatusActive, unavailable: true, nextRetryAfter: next, quota: { exceeded: true, nextRecoverAt: next }, updatedAt: 0 });
  const auths = [auth({ id: "a", modelStates: { [model]: state() } }), auth({ id: "b", modelStates: { [model]: state() } })];

  // mixed provider redacts provider field
  let err: unknown;
  try {
    new FillFirstSelector().pick("mixed", model, opts(), auths, now);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ModelCooldownError);
  const mce = err as ModelCooldownError;
  expect(mce.statusCode).toBe(429);
  expect(mce.headers().get("Retry-After")).toBe("60");
  const payload = JSON.parse(mce.message) as { error: Record<string, unknown> };
  expect(payload.error.code).toBe("model_cooldown");
  expect("provider" in payload.error).toBe(false);

  // non-mixed provider includes provider field
  let err2: unknown;
  try {
    new FillFirstSelector().pick("gemini", model, opts(), auths, now);
  } catch (e) {
    err2 = e;
  }
  const payload2 = JSON.parse((err2 as ModelCooldownError).message) as { error: Record<string, unknown> };
  expect(payload2.error.provider).toBe("gemini");
});

test("IsAuthBlockedForModel_UnavailableWithoutNextRetryIsBlocked", () => {
  const model = "test-model";
  const a = auth({ id: "a", modelStates: { [model]: { status: StatusActive, unavailable: true, nextRetryAfter: 0, quota: { exceeded: true, nextRecoverAt: 0 }, updatedAt: 0 } } });
  const block = isAuthBlockedForModel(a, model, now);
  expect(block).toEqual({ blocked: true, reason: "other", next: 0 });
});

test("IsAuthBlockedForModel_AuthQuotaExceededWithoutRecoveryIsBlocked", () => {
  const a = auth({ id: "a", quota: { exceeded: true, nextRecoverAt: 0 } });
  for (const model of ["", "test-model"]) {
    expect(isAuthBlockedForModel(a, model, now)).toEqual({ blocked: true, reason: "other", next: 0 });
  }
});

test("IsAuthBlockedForModel_ExpiredRecoveryIsAvailable", () => {
  const a = auth({ id: "a", unavailable: true, nextRetryAfter: now - Minute, quota: { exceeded: true, nextRecoverAt: now - 1000 } });
  expect(isAuthBlockedForModel(a, "", now)).toEqual({ blocked: false, reason: "none", next: 0 });
});

test("FillFirstSelectorPick_ThinkingSuffixFallsBackToBaseModelState", () => {
  const high = auth({
    id: "high",
    attributes: { priority: "10" },
    modelStates: { "test-model": { status: StatusActive, unavailable: true, nextRetryAfter: now + 30 * Minute, quota: { exceeded: true, nextRecoverAt: 0 }, updatedAt: 0 } },
  });
  const low = auth({ id: "low", attributes: { priority: "0" } });
  expect(new FillFirstSelector().pick("mixed", "test-model(high)", opts(), [high, low], now).id).toBe("low");
});

test("IsAuthBlockedForModel_ThinkingSuffixStatesBlockCanonicalModel", () => {
  const laterRetry = now + 2 * Hour;
  const a = auth({
    id: "a",
    modelStates: {
      "test-model(high)": { status: StatusError, unavailable: true, nextRetryAfter: now + Hour, quota: { exceeded: true, nextRecoverAt: now + Hour }, updatedAt: 0 },
      "test-model(low)": { status: StatusError, unavailable: true, nextRetryAfter: laterRetry, quota: { exceeded: true, nextRecoverAt: laterRetry }, updatedAt: 0 },
    },
  });
  for (const model of ["test-model", "test-model(medium)", "test-model(low)"]) {
    expect(isAuthBlockedForModel(a, model, now)).toEqual({ blocked: true, reason: "cooldown", next: laterRetry });
  }
});

test("RoundRobinSelectorPick_ThinkingSuffixSharesCursor", () => {
  const selector = new RoundRobinSelector();
  const auths = [auth({ id: "b" }), auth({ id: "a" })];
  expect(selector.pick("gemini", "test-model(high)", opts(), auths, now).id).toBe("a");
  expect(selector.pick("gemini", "test-model(low)", opts(), auths, now).id).toBe("b");
});

test("RoundRobinSelectorPick_ResumesRotationAcrossRetryExclusions", () => {
  const ids = ["aaa", "bbb", "ccc", "ddd", "eee"];
  const auths = ids.map((id) => auth({ id }));
  const selector = new RoundRobinSelector();
  const requests = 50;
  const firstAttempt: Record<string, number> = {};
  const allAttempts: Record<string, number> = {};
  for (let index = 0; index < requests; index++) {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidates = auths.filter((a) => !tried.has(a.id));
      const got = selector.pick("gemini", "model", opts(), candidates, now);
      if (attempt === 0) firstAttempt[got.id] = (firstAttempt[got.id] ?? 0) + 1;
      allAttempts[got.id] = (allAttempts[got.id] ?? 0) + 1;
      tried.add(got.id);
    }
  }
  for (const id of ids) {
    expect(firstAttempt[id]).toBe(requests / ids.length);
    expect(allAttempts[id]).toBe((requests * 3) / ids.length);
  }
});

test("SuccessorIndex_WrapsAndSkipsFilteredCandidates", () => {
  const available = [auth({ id: "aaa" }), auth({ id: "ccc" }), auth({ id: "eee" })];
  expect(successorIndex(available, "")).toBe(0);
  expect(successorIndex(available, "aaa")).toBe(1);
  expect(successorIndex(available, "bbb")).toBe(1);
  expect(successorIndex(available, "eee")).toBe(0);
  expect(successorIndex(available, "zzz")).toBe(0);
});

test("RoundRobinSelectorPick_CursorKeyCap", () => {
  const selector = new RoundRobinSelector({ maxKeys: 2 });
  const auths = [auth({ id: "a" })];
  selector.pick("gemini", "m1", opts(), auths, now);
  selector.pick("gemini", "m2", opts(), auths, now);
  selector.pick("gemini", "m3", opts(), auths, now);
  expect(selector.cursors().size).toBe(1);
  expect(selector.cursors().has("gemini:m3")).toBe(true);
});
