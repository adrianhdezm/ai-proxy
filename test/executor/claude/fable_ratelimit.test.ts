// Ported from: internal/runtime/executor/claude_executor_fable_ratelimit_test.go
// Skipped cases: none. "Not credential-scoped" is StatusError.credentialScoped === false; RetryAfter() is retryAfterMs;
// wall-clock comparisons use the clock shared by the executor and the AuthManager.
import { describe, expect, test } from "bun:test";
import { AuthManager } from "../../../src/auth/manager/index.ts";
import { type Auth, newAuth } from "../../../src/auth/types.ts";
import { classifyClaudeUpstreamError, classifyClaudeUpstreamErrorWithCooling } from "../../../src/executor/claude/errors.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { ModelRegistry } from "../../../src/registry/index.ts";
import { DAY, claudeOpts, expectStatusError, jsonResponse, withUpstream } from "./helpers.ts";

const baseNow = Date.parse("2026-10-28T12:00:00Z");
const MINUTE = 60_000;
const unix = (ms: number) => String(Math.floor(ms / 1000));
const fableBody = `{"type":"error","error":{"type":"rate_limit_error","message":"Fable usage window rejected."}}`;
const spendBody = `{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's monthly spend limit. Please try again later."}}`;

const classify = (headers: Record<string, string>, body = fableBody) => classifyClaudeUpstreamError(429, new Headers(headers), body, baseNow);

const issue5915Headers = {
  "Anthropic-Ratelimit-Unified-Status": "rejected",
  "Anthropic-Ratelimit-Unified-Representative-Claim": "seven_day_overage_included",
  "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
  "Anthropic-Ratelimit-Unified-7d-Utilization": "0.69",
  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.00",
  "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
  "Anthropic-Ratelimit-Unified-7d_oi-Utilization": "1.02",
  "Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
  "Anthropic-Ratelimit-Unified-Overage-Disabled-Reason": "org_spend_cap_reached",
  "Retry-After": "121180",
};

const issue5920Headers = {
  "Anthropic-Ratelimit-Unified-Status": "rejected",
  "Anthropic-Ratelimit-Unified-Representative-Claim": "seven_day_overage_included",
  "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
  "Anthropic-Ratelimit-Unified-7d-Utilization": "0.73",
  "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.23",
  "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
  "Anthropic-Ratelimit-Unified-7d_oi-Utilization": "1.02",
  "Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
  "Anthropic-Ratelimit-Unified-Overage-Disabled-Reason": "org_spend_cap_reached",
  "Retry-After": "97273",
};

describe("classifyClaudeUpstreamError scope", () => {
  test("FableOnlyRejectionIsModelScoped", () => {
    const err = classify({ "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "allowed", "Anthropic-Ratelimit-Unified-7d-Status": "allowed", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected", "Retry-After": "120" });
    expect(err.credentialScoped).toBe(false);
  });

  test("FableOnlyAllowedWarningIsModelScoped", () => {
    const err = classify({ "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "allowed", "Anthropic-Ratelimit-Unified-7d-Status": "allowed_warning", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected", "Retry-After": "120" });
    expect(err.credentialScoped).toBe(false);
  });

  test("OverageRejectionIsModelScoped_Issue5915", () => {
    expect(classify(issue5915Headers).credentialScoped).toBe(false);
  });

  test("ModelLevelCoolingForcesModelScope", () => {
    const headers = new Headers({ "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "rejected", "Retry-After": "60" });
    const body = `{"type":"error","error":{"type":"rate_limit_error"}}`;
    expect(classifyClaudeUpstreamErrorWithCooling(429, headers, body, false, baseNow).credentialScoped).toBe(true);
    expect(classifyClaudeUpstreamErrorWithCooling(429, headers, body, true, baseNow).credentialScoped).toBe(false);
  });

  const ambiguous: Array<{ name: string; headers: Record<string, string> }> = [
    { name: "explicit 5h rejection", headers: { "Anthropic-Ratelimit-Unified-5h-Status": "rejected", "Anthropic-Ratelimit-Unified-7d-Status": "allowed" } },
    { name: "explicit shared 7d rejection", headers: { "Anthropic-Ratelimit-Unified-5h-Status": "allowed", "Anthropic-Ratelimit-Unified-7d-Status": "rejected" } },
    { name: "aggregate rejection with shared statuses missing", headers: { "Anthropic-Ratelimit-Unified-Status": "rejected" } },
    { name: "aggregate rejection with shared statuses malformed", headers: { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "unknown", "Anthropic-Ratelimit-Unified-7d-Status": "invalid" } },
  ];
  for (const tc of ambiguous) {
    test(`SharedOrAmbiguousRejectionRemainsCredentialScoped/${tc.name}`, () => {
      expect(classify(tc.headers, `{"type":"error","error":{"type":"rate_limit_error","message":"Shared usage window rejected."}}`).credentialScoped).toBe(true);
    });
  }

  test("FableRetryDuration/retry-after header is skipped for overage rejection", () => {
    const err = classify({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
      "Anthropic-Ratelimit-Unified-7d_oi-Reset": unix(baseNow + 7 * DAY),
      "Retry-After": "120",
    });
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("FableRetryDuration/7d_oi reset only does not set week-long retry duration", () => {
    const err = classify({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
      "Anthropic-Ratelimit-Unified-7d_oi-Reset": unix(baseNow + 7 * DAY),
    });
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("OverageRejectionWithRetryAfter_Issue5920", () => {
    const err = classify(issue5920Headers, spendBody);
    expect(err.credentialScoped).toBe(false);
    expect(err.retryAfterMs).toBeUndefined();
  });
});

class Clock {
  t = baseNow;
  now = (): number => this.t;
}

function setup(url: string, id: string, models: string[], cfg: Parameters<typeof createClaudeExecutor>[0] = {}) {
  const clock = new Clock();
  const registry = new ModelRegistry({ now: clock.now });
  const manager = new AuthManager({ now: clock.now, registry, sleep: async () => {}, random: () => 0 });
  manager.setRetryConfig(0, 0, 0);
  manager.registerExecutor(createClaudeExecutor({ now: clock.now, ...cfg }));
  const auth: Auth = newAuth({ id, provider: "claude", attributes: { api_key: "sanitized-test-key", base_url: url } });
  registry.registerClient(id, "claude", models.map((m) => ({ id: m, type: "claude" })));
  manager.register(auth);
  const run = (model: string) =>
    manager.execute(["claude"], { model, payload: `{"model":"${model}","messages":[{"role":"user","content":[{"type":"text","text":"test"}]}]}`, format: "claude" }, claudeOpts()).then(
      () => undefined,
      (e: unknown) => e ?? new Error("rejected"),
    );
  return { clock, manager, run };
}

const rejected = (headers: Record<string, string>, body: string) => new Response(body, { status: 429, headers: { "Content-Type": "application/json", ...headers } });
const opusOK = () => jsonResponse(`{"id":"msg-opus-ok","type":"message","model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"ok"}]}`);

function routeByModel(fableModel: string, fable: () => Response, other = "claude-opus-5") {
  const counts = { fable: 0, other: 0 };
  const handler = (seen: { body: string }) => {
    if (seen.body.includes(`"model":"${fableModel}"`)) {
      counts.fable++;
      return fable();
    }
    if (seen.body.includes(`"model":"${other}"`)) {
      counts.other++;
      return opusOK();
    }
    return new Response("unexpected sanitized test model", { status: 400 });
  };
  return { counts, handler };
}

describe("AuthManager scope through the executor", () => {
  test("FableOnlyRejectionDoesNotBlockOpus", async () => {
    const reset = unix(baseNow + 7 * DAY);
    const r = routeByModel("claude-fable-5", () =>
      rejected({ "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "allowed", "Anthropic-Ratelimit-Unified-7d-Status": "allowed", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected", "Anthropic-Ratelimit-Unified-7d_oi-Reset": reset, "Retry-After": "120" }, fableBody),
    );
    await withUpstream(r.handler, async (upstream) => {
      const { clock, manager, run } = setup(upstream.url, "fable-model-scope", ["claude-fable-5", "claude-opus-5"]);
      expect(await run("claude-fable-5")).toBeDefined();
      expect(r.counts.fable).toBe(1);
      const fableState = manager.getById("fable-model-scope")!.modelStates?.["claude-fable-5"];
      expect(fableState).toBeDefined();
      expect(fableState!.quota.nextRecoverAt).toBeLessThanOrEqual(clock.t + 5 * MINUTE);
      expect(await run("claude-opus-5")).toBeUndefined();
      expect(r.counts.other).toBe(1);
    });
  });

  test("OverageSpendCapReachedDoesNotBlockOpus_Issue5915", async () => {
    const r = routeByModel("claude-fable-5-1", () => rejected(issue5915Headers, fableBody));
    await withUpstream(r.handler, async (upstream) => {
      const { manager, run } = setup(upstream.url, "overage-model-scope", ["claude-fable-5-1", "claude-opus-5"]);
      expect(await run("claude-opus-5")).toBeUndefined();
      expect(await run("claude-fable-5-1")).toBeDefined();
      expect(r.counts.fable).toBe(1);
      const a = manager.getById("overage-model-scope")!;
      expect(a.unavailable).toBe(false);
      expect(a.quota.reason).not.toBe("credential_quota");
      expect(a.nextRetryAfter).toBe(0);
      const fableState = a.modelStates?.["claude-fable-5-1"];
      expect(fableState?.unavailable).toBe(true);
      expect(fableState?.nextRetryAfter ?? 0).toBeGreaterThan(0);
      expect(a.modelStates?.["claude-opus-5"]?.unavailable).toBe(false);
      expect(await run("claude-opus-5")).toBeUndefined();
      expect(r.counts.other).toBe(2);
    });
  });

  test("ModelLevelCoolingConfigScopesSharedRejection", async () => {
    const r = routeByModel("claude-3-5-sonnet", () =>
      rejected({ "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "rejected", "Retry-After": "60" }, `{"type":"error","error":{"type":"rate_limit_error","message":"5h rate limit exceeded."}}`),
    );
    await withUpstream(r.handler, async (upstream) => {
      const { manager, run } = setup(upstream.url, "claude-model-cooling-cfg", ["claude-3-5-sonnet", "claude-opus-5"], { modelLevelCooling: true });
      expect(await run("claude-3-5-sonnet")).toBeDefined();
      expect(r.counts.fable).toBe(1);
      expect(manager.getById("claude-model-cooling-cfg")!.quota.reason).not.toBe("credential_quota");
      expect(await run("claude-opus-5")).toBeUndefined();
      expect(r.counts.other).toBe(1);
    });
  });

  test("ExecuteStream_OverageRejectionIsModelScoped", async () => {
    await withUpstream(
      () => rejected(issue5915Headers, fableBody),
      async (upstream) => {
        const auth = newAuth({ id: "stream-overage", provider: "claude", attributes: { api_key: "sanitized-test-key", base_url: upstream.url } });
        const err = await expectStatusError(
          createClaudeExecutor().executeStream(auth, { model: "claude-fable-5-1", payload: `{"model":"claude-fable-5-1","stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`, format: "claude" }, claudeOpts({ stream: true })),
        );
        expect(err.credentialScoped).toBe(false);
      },
    );
  });

  for (const opusFirst of [true, false]) {
    test(opusFirst ? "OverageSpendCapWithRetryAfter_Issue5920" : "OverageSpendCapFirstRequestAllowsOpus_Issue5920", async () => {
      const r = routeByModel("claude-fable-5-1", () => rejected(issue5920Headers, spendBody));
      await withUpstream(r.handler, async (upstream) => {
        const { clock, manager, run } = setup(upstream.url, "issue-5920-overage", ["claude-fable-5-1", "claude-opus-5"]);
        if (opusFirst) expect(await run("claude-opus-5")).toBeUndefined();
        expect(await run("claude-fable-5-1")).toBeDefined();
        expect(r.counts.fable).toBe(1);
        const a = manager.getById("issue-5920-overage")!;
        if (opusFirst) {
          expect(a.unavailable).toBe(false);
          expect(a.nextRetryAfter).toBe(0);
        }
        const recoverAt = a.modelStates?.["claude-fable-5-1"]?.quota.nextRecoverAt ?? 0;
        expect(recoverAt).toBeGreaterThan(clock.t);
        expect(recoverAt).toBeLessThanOrEqual(clock.t + 10 * MINUTE);
        expect(await run("claude-opus-5")).toBeUndefined();
        expect(r.counts.other).toBe(opusFirst ? 2 : 1);
      });
    });
  }
});
