// Ported from: sdk/cliproxy/auth/conductor_selection_cooldown_test.go
// Skipped cases: TestMixedUnavailableErrorLocked_GlobalModelErrorPriorityAcrossShards (scheduler shards not ported),
// TestErrorWithCause_IsDoesNotPanicOnNonComparableError / TestErrorWithCause_ErrorDirectFormat (errorWithCause wrapper not
// ported; causes ride on Error.cause), TestExtractUpstreamErrorSummary_AuthPackageDirectSanitization (the 400-case path/secret
// sanitiser table; only the JSON summary extraction and the token/key redactions are ported).
import { expect, test } from "bun:test";
import { AuthManagerError, FillFirstSelector, ModelCooldownError, RoundRobinSelector, extractUpstreamErrorSummary, getAvailableAuths, safeResponseHeaders } from "../../../src/auth/manager/index.ts";
import { StatusError } from "../../../src/auth/types.ts";
import { Hour, Minute, auth, baseNow, opts } from "./helpers.ts";

function pickError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

// Upstream hands the built-in selectors an empty model (selectionArgForSelector) and restores the route
// model on the error afterwards; the port passes the route model straight through, so the credential-wide
// cooldown is expressed without an unrelated model state here.
test("BuiltInSelectorCooldownErrorPreservesRouteModel", () => {
  const routeModel = "client-opus(high)";
  const next = baseNow + Hour;
  const a = auth({ id: "cooling-auth", unavailable: true, nextRetryAfter: next, quota: { exceeded: true, nextRecoverAt: next } });
  for (const selector of [new RoundRobinSelector(), new FillFirstSelector()]) {
    const err = pickError(() => selector.pick("mixed", routeModel, opts(), [a], baseNow));
    expect(err).toBeInstanceOf(ModelCooldownError);
    expect((err as ModelCooldownError).model).toBe(routeModel);
  }
});

test("AvailableAuthsForRouteModel_AttachesUpstreamErrorWhenCandidatesCooling", () => {
  const routeModel = "gpt-5.6-sol";
  const next = baseNow + Minute;
  const upstreamErrorMsg = `{"type":"error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","sequence_number":0}`;
  const lastError = { code: "auth_unavailable", message: upstreamErrorMsg, retryable: false, httpStatus: 503 };
  const a = auth({
    id: "codex-auth-1",
    provider: "codex",
    unavailable: true,
    nextRetryAfter: next,
    status: StatusError,
    statusMessage: upstreamErrorMsg,
    quota: { exceeded: true, nextRecoverAt: next },
    lastError,
    modelStates: { [routeModel]: { status: StatusError, unavailable: true, nextRetryAfter: next, statusMessage: upstreamErrorMsg, quota: { exceeded: true, nextRecoverAt: next }, lastError, updatedAt: 0 } },
  });
  const err = pickError(() => getAvailableAuths([a], "codex", routeModel, baseNow));
  expect(err).toBeInstanceOf(ModelCooldownError);
  const cooldownErr = err as ModelCooldownError;
  expect(cooldownErr.cause).toBeDefined();
  expect((cooldownErr.cause as Error).message).toContain("server_is_overloaded");
  expect(cooldownErr.message).toContain("server_is_overloaded");
  expect(extractUpstreamErrorSummary(upstreamErrorMsg)).toBe("server_is_overloaded: Our servers are currently overloaded. Please try again later.");
});

test("AvailableAuthsForRouteModel_PicksLatestCandidateError", () => {
  const routeModel = "gpt-5.6-sol";
  const now = baseNow;
  const mk = (id: string, message: string, updatedAt: number) =>
    auth({
      id,
      provider: "codex",
      unavailable: true,
      status: StatusError,
      statusMessage: message,
      updatedAt,
      modelStates: { [routeModel]: { status: StatusError, unavailable: true, nextRetryAfter: 0, statusMessage: message, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt } },
    });
  const auth1 = mk("codex-auth-1", "older error: quota exceeded", now - 10 * Minute);
  const auth2 = mk("codex-auth-2", "newer error: server is overloaded", now - 10_000);
  const err = pickError(() => getAvailableAuths([auth1, auth2], "codex", routeModel, now)) as AuthManagerError;
  expect((err.cause as Error).message).toContain("newer error");
});

test("AvailableAuthsForRouteModel_ModelErrorPrioritizedOverGlobalAuthError", () => {
  const routeModel = "gpt-5.6-sol";
  const now = baseNow;
  const a = auth({
    id: "codex-auth-1",
    provider: "codex",
    unavailable: true,
    status: StatusError,
    statusMessage: "global error: unrelated failure",
    updatedAt: now,
    modelStates: { [routeModel]: { status: StatusError, unavailable: true, nextRetryAfter: 0, statusMessage: "model error: model rate limited", quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: now - 10 * Minute } },
  });
  const err = pickError(() => getAvailableAuths([a], "codex", routeModel, now)) as AuthManagerError;
  expect((err.cause as Error).message).toContain("model rate limited");
});

test("AvailableAuthsForRouteModel_FallbackToGlobalAuthErrorWhenNoModelState", () => {
  const a = auth({ id: "codex-auth-1", provider: "codex", unavailable: true, status: StatusError, statusMessage: "global error: credential exhausted", updatedAt: baseNow });
  const err = pickError(() => getAvailableAuths([a], "codex", "gpt-5.6-sol", baseNow)) as AuthManagerError;
  expect((err.cause as Error).message).toContain("credential exhausted");
});

test("AvailableAuthsForRouteModel_CrossCandidateModelErrorPrioritizedOverNewerAuthError", () => {
  const routeModel = "gpt-5.6-sol";
  const now = baseNow;
  const authA = auth({
    id: "codex-auth-A",
    provider: "codex",
    unavailable: true,
    status: StatusError,
    statusMessage: "older global status A",
    updatedAt: now - 10 * Minute,
    modelStates: { [routeModel]: { status: StatusError, unavailable: true, nextRetryAfter: 0, statusMessage: "model error on candidate A: quota exceeded", quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: now - 10 * Minute } },
  });
  const authB = auth({ id: "codex-auth-B", provider: "codex", unavailable: true, status: StatusError, statusMessage: "global auth error on candidate B: connection reset", updatedAt: now - 10_000 });
  const err = pickError(() => getAvailableAuths([authA, authB], "codex", routeModel, now)) as AuthManagerError;
  expect((err.cause as Error).message).toContain("quota exceeded");
});

test("SafeResponseHeaders_IncludesModelCooldownRetryAfter", () => {
  const err = new ModelCooldownError("gpt-5.6-sol", "codex", 15_000);
  expect(safeResponseHeaders(err)?.get("Retry-After")).toBe("15");
});
