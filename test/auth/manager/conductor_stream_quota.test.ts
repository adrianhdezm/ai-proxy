// Ported from: sdk/cliproxy/auth/conductor_stream_quota_test.go
// Skipped cases: the weighted=true sub-cases (weighted selector not ported).
import { expect, test } from "bun:test";
import { RoundRobinSelector, isAuthBlockedForModel } from "../../../src/auth/manager/index.ts";
import { Hour, Minute, auth, drain, fakeExecutor, newManager, opts, registerModels, req, statusError, streamOf } from "./helpers.ts";

test("ExecuteStreamQuotaFailurePreservesCooldownAndScope", async () => {
  for (const credentialScoped of [true, false]) {
    const tm = newManager({ selector: new RoundRobinSelector() });
    tm.manager.setRetryConfig(3, 30_000, 0);
    const model = "stream-quota-model";
    const siblingModel = "stream-quota-sibling";
    const highID = `stream-quota-high-${credentialScoped}`;
    const lowID = `stream-quota-low-${credentialScoped}`;
    for (const candidate of [auth({ id: highID, provider: "codex", attributes: { priority: "4" } }), auth({ id: lowID, provider: "codex", attributes: { priority: "3" } })]) {
      registerModels(tm.registry, candidate.id, "codex", model, siblingModel);
      tm.manager.register(candidate);
    }
    const retryAfter = Hour;
    const quotaErr = statusError(
      429,
      credentialScoped ? `{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}` : `{"error":{"type":"rate_limit_error","message":"Model rate limit exceeded"}}`,
      { retryAfterMs: retryAfter, credentialScoped },
    );
    const attempts: string[] = [];
    tm.manager.registerExecutor(
      fakeExecutor({
        stream: (selected) => {
          attempts.push(selected.id);
          return streamOf([`data: {"type":"response.created"}\n\n`, quotaErr]);
        },
      }),
    );
    const before = tm.clock.now();
    const result = await tm.manager.executeStream(["codex"], req(model), opts({ stream: true }));
    const drained = await drain(result);
    expect(drained.chunks).toHaveLength(1);
    expect(drained.error).toBe(quotaErr);
    expect(attempts).toEqual([highID]);

    const high = tm.manager.getById(highID)!;
    const state = high.modelStates![model]!;
    expect(state.nextRetryAfter).toBeGreaterThanOrEqual(before + retryAfter);
    if (credentialScoped) {
      expect(high.quota.reason).toBe("credential_quota");
      expect(high.quota.nextRecoverAt).toBeGreaterThanOrEqual(before + retryAfter);
    }
    for (const requestedModel of [model, siblingModel]) {
      const wantID = requestedModel === siblingModel && !credentialScoped ? highID : lowID;
      expect(tm.manager.selectAuth(["codex"], requestedModel, opts()).auth.id, `${requestedModel} scoped=${credentialScoped}`).toBe(wantID);
    }
    expect(isAuthBlockedForModel(high, model, before + Minute).blocked).toBe(true);
  }
});
