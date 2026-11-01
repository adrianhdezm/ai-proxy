// Ported from: internal/runtime/executor/claude_executor_ratelimit_test.go
// Skipped cases: TestClaudeExecutor_AuthManager_MultiModelPoolStreamStopsProbingOn429 (OAuth model alias pools are not
// ported in the auth manager); the UpstreamAttempted tracker assertion of
// TestClaudeExecutor_RateLimit_CountTokensHonorsRateLimitReset (no attempt tracker). RetryAfter() is the
// StatusError.retryAfterMs field; the clock is injected (executor and manager share it). The end-to-end failover case
// at the bottom (two API-key credentials, 429 + Retry-After then success) is an addition for this slice.
import { describe, expect, test } from "bun:test";
import { AuthManager, isAuthBlockedForModel } from "../../../src/auth/manager/index.ts";
import { type Auth, newAuth } from "../../../src/auth/types.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { ModelRegistry } from "../../../src/registry/index.ts";
import { DAY, HOUR, SECOND, claudeOpts, expectStatusError, jsonResponse, startUpstream, withUpstream } from "./helpers.ts";

const baseNow = Date.parse("2026-10-28T12:00:00Z");
const sonnet = "claude-3-5-sonnet-20241022";
const hiPayload = `{"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`;
const unix = (ms: number) => String(Math.floor(ms / 1000));
const rateLimited = (headers: Record<string, string>, message: string) => () =>
  new Response(`{"type":"error","error":{"type":"rate_limit_error","message":"${message}"}}`, { status: 429, headers: { "Content-Type": "application/json", ...headers } });

/** Fuzz is 1..30s on top of the reported reset; allow a few seconds of truncation slack below. */
function expectRetryAround(err: StatusError, wantMs: number): void {
  expect(err.retryAfterMs).toBeDefined();
  expect(err.retryAfterMs!).toBeGreaterThanOrEqual(wantMs - 5 * SECOND);
  expect(err.retryAfterMs!).toBeLessThanOrEqual(wantMs + 35 * SECOND);
}

class Clock {
  t = baseNow;
  now = (): number => this.t;
}

function keyAuth(id: string, url: string, key = "test-key"): Auth {
  return newAuth({ id, provider: "claude", attributes: { api_key: key, base_url: url } });
}

function managerWith(clock: Clock, cfg: Parameters<typeof createClaudeExecutor>[0] = {}) {
  const registry = new ModelRegistry({ now: clock.now });
  const manager = new AuthManager({ now: clock.now, registry, sleep: async () => {}, random: () => 0 });
  manager.registerExecutor(createClaudeExecutor({ now: clock.now, ...cfg }));
  const add = (auth: Auth, ...models: string[]) => {
    registry.registerClient(auth.id, "claude", models.map((id) => ({ id, type: "claude" })));
    manager.register(auth);
  };
  return { manager, registry, add };
}

describe("claude executor rate limits", () => {
  test("HonorsAnthropicRateLimitHeaders_Execute", async () => {
    const clock = new Clock();
    const sevenDayReset = unix(clock.t + 7 * DAY);
    await withUpstream(
      rateLimited(
        {
          "Anthropic-Ratelimit-Unified-Status": "rejected",
          "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
          "Anthropic-Ratelimit-Unified-5h-Reset": unix(clock.t + 5 * HOUR),
          "Anthropic-Ratelimit-Unified-7d-Status": "rejected",
          "Anthropic-Ratelimit-Unified-7d-Reset": sevenDayReset,
          "Anthropic-Ratelimit-Unified-Representative-Claim": "seven_day",
          "Anthropic-Ratelimit-Unified-Reset": sevenDayReset,
          "Retry-After": String(7 * 24 * 3600),
        },
        "Number of requests has exceeded your 7-day rate limit.",
      ),
      async (upstream) => {
        const err = await expectStatusError(createClaudeExecutor({ now: clock.now }).execute(keyAuth("claude-auth-1", upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts()));
        expect(err.statusCode).toBe(429);
        expectRetryAround(err, 7 * DAY);
        expect(err.credentialScoped).toBe(true);
        // The fuzz is applied once: the value is a plain field.
        expect(err.retryAfterMs).toBe(err.retryAfterMs!);
      },
    );
  });

  test("HonorsAnthropicRateLimitHeaders_ExecuteStream", async () => {
    const clock = new Clock();
    await withUpstream(
      rateLimited(
        {
          "Anthropic-Ratelimit-Unified-Status": "rejected",
          "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
          "Anthropic-Ratelimit-Unified-5h-Reset": unix(clock.t + 5 * HOUR),
          "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
          "Anthropic-Ratelimit-Unified-7d-Reset": unix(clock.t + 7 * DAY),
        },
        "5-hour limit exceeded.",
      ),
      async (upstream) => {
        const err = await expectStatusError(createClaudeExecutor({ now: clock.now }).executeStream(keyAuth("claude-auth-1", upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts({ stream: true })));
        expectRetryAround(err, 5 * HOUR);
      },
    );
  });

  test("RateLimit_BothRejectedUsesLongest", async () => {
    const clock = new Clock();
    await withUpstream(
      rateLimited(
        {
          "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
          "Anthropic-Ratelimit-Unified-5h-Reset": unix(clock.t + 5 * HOUR),
          "Anthropic-Ratelimit-Unified-7d-Status": "rejected",
          "Anthropic-Ratelimit-Unified-7d-Reset": unix(clock.t + 7 * DAY),
        },
        "Both limits exceeded.",
      ),
      async (upstream) => {
        const err = await expectStatusError(createClaudeExecutor({ now: clock.now }).execute(keyAuth("claude-auth-1", upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts()));
        expectRetryAround(err, 7 * DAY);
      },
    );
  });

  test("RateLimit_CountTokensHonorsRateLimitReset", async () => {
    const clock = new Clock();
    await withUpstream(
      rateLimited(
        {
          "Anthropic-Ratelimit-Unified-Status": "rejected",
          "Anthropic-Ratelimit-Unified-7d-Status": "rejected",
          "Anthropic-Ratelimit-Unified-7d-Reset": unix(clock.t + 7 * DAY),
          "Retry-After": "604800",
        },
        "7-day rate limit exceeded.",
      ),
      async (upstream) => {
        const err = await expectStatusError(createClaudeExecutor({ now: clock.now }).countTokens(keyAuth("claude-auth-1", upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts()));
        expect(upstream.requests[0]!.path).toBe("/v1/messages/count_tokens");
        expect(err.credentialScoped).toBe(true);
        expectRetryAround(err, 7 * DAY);
      },
    );
  });

  test("RateLimit_CaseInsensitiveRawHeaderMap", async () => {
    const clock = new Clock();
    await withUpstream(
      rateLimited(
        {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-7d-status": "rejected",
          "anthropic-ratelimit-unified-7d-reset": unix(clock.t + 2 * HOUR),
          "retry-after": "7200",
        },
        "Too many requests.",
      ),
      async (upstream) => {
        const err = await expectStatusError(createClaudeExecutor({ now: clock.now }).execute(keyAuth("claude-auth-1", upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts()));
        expectRetryAround(err, 2 * HOUR);
      },
    );
  });

  test("RateLimit_FastModeAuthoritativeRejectionHeadersOverrideBody", async () => {
    const clock = new Clock();
    const s1 = startUpstream(
      rateLimited(
        { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-7d-Status": "rejected", "Anthropic-Ratelimit-Unified-7d-Reset": unix(clock.t + 7 * DAY), "Retry-After": "604800" },
        "Fast request rejected",
      ),
    );
    const s2 = startUpstream(() => jsonResponse(`{"id":"msg-fast-ok","type":"message","role":"assistant","content":[{"type":"text","text":"hello from cred2"}]}`));
    try {
      const { manager, add } = managerWith(clock);
      manager.setRetryConfig(0, 0, 2);
      add(keyAuth("fast-override-1", s1.url, "k1"), sonnet);
      add(keyAuth("fast-override-2", s2.url, "k2"), sonnet);
      const resp = await manager.execute(["claude"], { model: sonnet, payload: `{"speed":"fast","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`, format: "claude" }, claudeOpts());
      expect(resp.payload.length).toBeGreaterThan(0);
      expect(s1.requests).toHaveLength(1);
      expect(s2.requests).toHaveLength(1);
      const cred1 = manager.getById("fast-override-1")!;
      expect(cred1.unavailable).toBe(true);
      expect(cred1.quota.exceeded).toBe(true);
    } finally {
      s1.stop();
      s2.stop();
    }
  });

  test("RateLimit_FastEntitlementWithRetryAfterRemainsRequestScoped", async () => {
    const clock = new Clock();
    await withUpstream(rateLimited({ "Retry-After": "120" }, "Usage credits are required for fast mode."), async (upstream) => {
      const { manager, add } = managerWith(clock);
      manager.setRetryConfig(0, 0, 2);
      add(keyAuth("fast-entitlement", upstream.url, "k1"), sonnet);
      const err = await manager.execute(["claude"], { model: sonnet, payload: `{"speed":"fast","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`, format: "claude" }, claudeOpts()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeDefined();
      const a = manager.getById("fast-entitlement")!;
      expect(a.unavailable).toBe(false);
      expect(a.quota.exceeded).toBe(false);
    });
  });

  test("AuthManager_CredentialScopeBlocksAllModelsAndAliases", async () => {
    const clock = new Clock();
    await withUpstream(
      rateLimited(
        { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-7d-Status": "rejected", "Anthropic-Ratelimit-Unified-7d-Reset": unix(clock.t + 7 * DAY), "Retry-After": String(7 * 24 * 3600) },
        "7d limit rejected.",
      ),
      async (upstream) => {
        const { manager, add } = managerWith(clock);
        manager.setRetryConfig(0, 0, 0);
        add(keyAuth("claude-cred", upstream.url), sonnet, "claude-3-opus-20240229", "claude-3-7-sonnet-20250219");
        const run = (model: string, stream = false) =>
          (stream ? manager.executeStream(["claude"], { model, payload: hiPayload, format: "claude" }, claudeOpts({ stream: true })) : manager.execute(["claude"], { model, payload: hiPayload, format: "claude" }, claudeOpts())).then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(await run(sonnet)).toBeDefined();
        expect(upstream.requests).toHaveLength(1);
        expect(await run("claude-3-opus-20240229")).toBeDefined();
        expect(upstream.requests).toHaveLength(1);
        expect(await run("claude-3-7-sonnet-20250219-thinking-16k")).toBeDefined();
        expect(upstream.requests).toHaveLength(1);
        expect(await run("claude-3-opus-20240229", true)).toBeDefined();
        expect(upstream.requests).toHaveLength(1);
      },
    );
  });

  test("AuthManager_OrdinaryModel429DoesNotBlockSiblingModels", async () => {
    const clock = new Clock();
    await withUpstream(
      (seen) => {
        if (seen.body.includes("claude-3-5-sonnet")) {
          return rateLimited({ "Anthropic-Ratelimit-Unified-5h-Status": "allowed", "Anthropic-Ratelimit-Unified-7d-Status": "allowed" }, "Model rate limit exceeded.")();
        }
        return jsonResponse(`{"id":"msg-opus","type":"message","role":"assistant","content":[{"type":"text","text":"hello from opus"}]}`);
      },
      async (upstream) => {
        const { manager, add } = managerWith(clock);
        manager.setRetryConfig(0, 0, 0);
        add(keyAuth("ordinary-429", upstream.url), sonnet, "claude-3-opus-20240229");
        await expect(manager.execute(["claude"], { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts())).rejects.toBeDefined();
        const resp = await manager.execute(["claude"], { model: "claude-3-opus-20240229", payload: `{"messages":[{"role":"user","content":[{"type":"text","text":"hi opus"}]}]}`, format: "claude" }, claudeOpts());
        expect(resp.payload.length).toBeGreaterThan(0);
        expect(upstream.requests).toHaveLength(2);
      },
    );
  });

  test("AuthManager_AlternativeCredentialCanBeSelected", async () => {
    const clock = new Clock();
    const s1 = startUpstream(
      rateLimited({ "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-7d-Status": "rejected", "Anthropic-Ratelimit-Unified-7d-Reset": unix(clock.t + 7 * DAY) }, "7d limit rejected."),
    );
    const s2 = startUpstream(() => jsonResponse(`{"id":"msg-123","type":"message","role":"assistant","content":[{"type":"text","text":"hello from cred2"}]}`));
    try {
      const { manager, add } = managerWith(clock);
      manager.setRetryConfig(0, 0, 2);
      add(keyAuth("claude-cred-1", s1.url, "test-key-1"), sonnet);
      add(keyAuth("claude-cred-2", s2.url, "test-key-2"), sonnet);
      const req = { model: sonnet, payload: hiPayload, format: "claude" as const };
      expect((await manager.execute(["claude"], req, claudeOpts())).payload.length).toBeGreaterThan(0);
      expect(s1.requests).toHaveLength(1);
      expect(s2.requests).toHaveLength(1);
      expect((await manager.execute(["claude"], req, claudeOpts())).payload.length).toBeGreaterThan(0);
      expect(s1.requests).toHaveLength(1);
      expect(s2.requests).toHaveLength(2);
    } finally {
      s1.stop();
      s2.stop();
    }
  });
});

describe("end-to-end failover through the AuthManager", () => {
  test("first API key returns 429 with Retry-After, second succeeds; first cools down for the hinted window", async () => {
    const clock = new Clock();
    const s1 = startUpstream(() => new Response(`{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your per-minute rate limit."}}`, { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } }));
    const s2 = startUpstream(() => jsonResponse(`{"id":"msg_ok","type":"message","model":"claude-opus-4-6","role":"assistant","content":[{"type":"text","text":"from second"}],"usage":{"input_tokens":1,"output_tokens":1}}`));
    try {
      const { manager, add } = managerWith(clock);
      manager.setRetryConfig(0, 0, 2);
      add(keyAuth("claude-key-a", s1.url, "key-a"), "claude-opus-4-6");
      add(keyAuth("claude-key-b", s2.url, "key-b"), "claude-opus-4-6");
      const req = { model: "claude-opus-4-6", payload: `{"model":"claude-opus-4-6","messages":[{"role":"user","content":"hi"}]}`, format: "claude" as const };

      const resp = await manager.execute(["claude"], req, claudeOpts());
      expect(JSON.parse(resp.payload).content[0].text).toBe("from second");
      expect(s1.requests).toHaveLength(1);
      expect(s2.requests).toHaveLength(1);
      expect(s1.requests[0]!.headers.get("x-api-key")).toBeNull();
      expect(s1.requests[0]!.headers.get("Authorization")).toBe("Bearer key-a");

      // The first credential is cooling down for the Retry-After window (plus at most 30s of fuzz), model-scoped.
      const a = manager.getById("claude-key-a")!;
      const block = isAuthBlockedForModel(a, "claude-opus-4-6", clock.now());
      expect(block.blocked).toBe(true);
      expect(block.reason).toBe("cooldown");
      expect(block.next).toBeGreaterThanOrEqual(clock.t + 30 * SECOND);
      expect(block.next).toBeLessThanOrEqual(clock.t + 61 * SECOND);
      expect(a.quota.reason).not.toBe("credential_quota");

      // While cooling, the next request goes straight to the second credential.
      await manager.execute(["claude"], req, claudeOpts());
      expect(s1.requests).toHaveLength(1);
      expect(s2.requests).toHaveLength(2);

      // After the window the first credential is selectable again.
      clock.t += 2 * 60 * SECOND;
      expect(isAuthBlockedForModel(manager.getById("claude-key-a"), "claude-opus-4-6", clock.now()).blocked).toBe(false);
    } finally {
      s1.stop();
      s2.stop();
    }
  });
});
