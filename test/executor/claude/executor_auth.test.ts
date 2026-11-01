// Ported from: internal/runtime/executor/claude_executor_auth_test.go
// Skipped cases: TestClaudeExecutorPrepareRequestAuthPopulatesCredentialIdentity, PrepareRequestAuthMigratesFiveDevicesToOne,
// PrepareRequestAuthIgnoresFreshTimestampWithoutIdentity, PrepareRequestAuthSetupTokenBypassesProfile,
// PrepareRequestAuth403ScopeFallback, PrepareRequestAuthSkipAccountProfileConfig,
// PrepareRequestAuthEmptyAccountUUIDInProfileFallback (the OAuth profile prefetch / PrepareRequestAuth hook is not
// ported; credential identity comes from the stored metadata or is derived on the fly). The refresh cases at the bottom
// cover the executor's delegation to ClaudeAuthenticator.refresh, which this slice owns.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { type FetchLike, createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { hasDuplicateTopLevelJSONKey } from "../../../src/executor/claude/identity.ts";
import { claudeOpts, expectStatusError } from "./helpers.ts";

describe("duplicate metadata", () => {
  for (const mode of ["execute", "stream"] as const) {
    test(`ClaudeExecutorDuplicateMetadataIsRequestScoped/${mode}`, async () => {
      let upstreamCalled = false;
      const fetch: FetchLike = async () => {
        upstreamCalled = true;
        throw new Error("unexpected upstream request");
      };
      const exec = createClaudeExecutor({ fetch });
      const auth = newAuth({
        id: "dup",
        provider: "claude",
        attributes: { api_key: "sk-ant-oat-duplicate-metadata", auth_kind: "oauth" },
        metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)] },
      });
      const req = { model: "claude-opus-5", payload: `{"model":"claude-opus-5","messages":[{"role":"user","content":"hello"}],"metadata":{"user_id":"{}"},"metadata":{"user_id":"{}"}}`, format: "claude" as const };
      const err = await expectStatusError(mode === "execute" ? exec.execute(auth, req, claudeOpts()) : exec.executeStream(auth, req, claudeOpts({ stream: true })));
      expect(upstreamCalled).toBe(false);
      expect(err.requestScoped).toBe(true);
      expect(err.statusCode).toBe(400);
    });
  }

  test("hasDuplicateTopLevelJSONKey only counts top-level members", () => {
    expect(hasDuplicateTopLevelJSONKey(`{"metadata":{},"metadata":{}}`, "metadata")).toBe(true);
    expect(hasDuplicateTopLevelJSONKey(`{"metadata":{"metadata":1},"x":{"metadata":2}}`, "metadata")).toBe(false);
    expect(hasDuplicateTopLevelJSONKey(`{"a":"\\"metadata\\"","metadata":{}}`, "metadata")).toBe(false);
    expect(hasDuplicateTopLevelJSONKey(`[{"metadata":1},{"metadata":2}]`, "metadata")).toBe(false);
  });
});

describe("refresh", () => {
  test("API-key credentials are returned unchanged without a network call", async () => {
    let called = false;
    const exec = createClaudeExecutor({
      fetch: async () => {
        called = true;
        return new Response("{}");
      },
    });
    const auth = newAuth({ id: "key", provider: "claude", attributes: { api_key: "key-refresh" } });
    expect(await exec.refresh(auth)).toBe(auth);
    expect(called).toBe(false);
  });

  test("OAuth credentials refresh through the Claude authenticator", async () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const seen: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push(url);
      if (url.includes("/token")) {
        const body = JSON.parse(String(init?.body));
        expect(body.grant_type).toBe("refresh_token");
        expect(body.refresh_token).toBe("rt-old");
        return new Response(`{"access_token":"sk-ant-oat-new","refresh_token":"rt-new","expires_in":3600}`, { headers: { "Content-Type": "application/json" } });
      }
      return new Response(`{"account":{"uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"user@example.com"},"organization":{"uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"Org"}}`, { headers: { "Content-Type": "application/json" } });
    };
    const exec = createClaudeExecutor({ fetch, now: () => now });
    const auth = newAuth({ id: "oauth", provider: "claude", metadata: { access_token: "sk-ant-oat-old", refresh_token: "rt-old", type: "claude" } });
    const updated = await exec.refresh(auth);
    expect(seen.some((u) => u.includes("/token"))).toBe(true);
    expect(updated.metadata.access_token).toBe("sk-ant-oat-new");
    expect(updated.metadata.refresh_token).toBe("rt-new");
    expect(updated.lastRefreshedAt).toBe(now);
    expect(auth.metadata.access_token).toBe("sk-ant-oat-old");
  });
});
