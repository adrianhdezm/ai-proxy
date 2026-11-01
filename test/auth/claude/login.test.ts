// New (no upstream test): end-to-end ClaudeAuthenticator.login against the local
// callback server (port 0) with a fake token endpoint, plus refresh() metadata updates.
import { afterEach, describe, expect, test } from "bun:test";
import { ClaudeAuthenticator, ClaudeRefreshLeadMs, ProfileURL, RolesURL, TokenURL, isAuthenticationError, isOAuthError, resetClaudeRefreshState } from "../../../src/auth/claude/index.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { fakeFetch, fixedNow, jsonResponse, noopSleep } from "../helpers.ts";

afterEach(() => resetClaudeRefreshState());

function upstream() {
  return fakeFetch((req) => {
    switch (req.url) {
      case TokenURL:
        return jsonResponse({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          account: { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email_address: "user@example.com" },
          organization: { uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Example Org" },
        });
      case ProfileURL:
        return jsonResponse({ account: { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "user@example.com" }, organization: { uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Example Org" } });
      case RolesURL:
        return jsonResponse({ roles: [] });
      default:
        throw new Error(`unexpected upstream ${req.url}`);
    }
  });
}

/** Drives the browser side: hits the local callback with the given query. */
function browser(query: (state: string) => string) {
  return (url: string, port: number) => {
    const state = new URL(url).searchParams.get("state") ?? "";
    void fetch(`http://127.0.0.1:${port}/callback?${query(state)}`, { redirect: "manual" }).catch(() => undefined);
  };
}

const quiet = { print: () => undefined, now: fixedNow, sleep: noopSleep, callbackHostname: "127.0.0.1" };

describe("ClaudeAuthenticator.login", () => {
  test("produces the upstream-compatible auth record", async () => {
    const fetchFn = upstream();
    const auth = await new ClaudeAuthenticator().login({
      noBrowser: true,
      callbackPort: 0,
      hooks: { ...quiet, fetch: fetchFn, onAuthorizationUrl: browser((s) => `code=the-code&state=${s}`) },
    });
    expect(auth.provider).toBe("claude");
    expect(auth.id).toBe("claude-00f765af-user@example.com.json");
    expect(auth.metadata).toMatchObject({
      type: "claude",
      access_token: "access",
      refresh_token: "refresh",
      email: "user@example.com",
      account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organization_uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      organization_name: "Example Org",
      expired: "2026-10-28T13:00:00Z",
      last_refresh: "2026-10-28T12:00:00Z",
    });
    expect((auth.metadata.claude_device_ids as string[]).length).toBe(1);
    const exchange = fetchFn.calls.find((c) => c.url === TokenURL)!;
    expect(JSON.parse(exchange.body).code).toBe("the-code");
  });

  test("rejects a state mismatch", async () => {
    const err = await new ClaudeAuthenticator()
      .login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, fetch: upstream(), onAuthorizationUrl: browser(() => "code=c&state=wrong") } })
      .catch((e) => e);
    expect(isAuthenticationError(err)).toBe(true);
    expect(err.type).toBe("invalid_state");
  });

  test("surfaces an OAuth error from the callback", async () => {
    const err = await new ClaudeAuthenticator()
      .login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, fetch: upstream(), onAuthorizationUrl: browser(() => "error=access_denied") } })
      .catch((e) => e);
    expect(isOAuthError(err)).toBe(true);
    expect(err.code).toBe("access_denied");
  });

  test("times out waiting for the callback", async () => {
    const err = await new ClaudeAuthenticator()
      .login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, fetch: upstream(), callbackTimeoutMs: 20 } })
      .catch((e) => e);
    expect(isAuthenticationError(err)).toBe(true);
    expect(err.type).toBe("callback_timeout");
  });

  test("accepts a pasted callback URL from the prompt", async () => {
    let authUrl = "";
    const auth = await new ClaudeAuthenticator().login({
      noBrowser: true,
      callbackPort: 0,
      prompt: () => {
        const state = new URL(authUrl).searchParams.get("state") ?? "";
        return `http://localhost:54545/callback?code=pasted&state=${state}`;
      },
      hooks: { ...quiet, fetch: upstream(), manualPromptDelayMs: 1, onAuthorizationUrl: (url) => (authUrl = url) },
    });
    expect(auth.metadata.access_token).toBe("access");
  });

  test("reports a port in use", async () => {
    const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    try {
      const err = await new ClaudeAuthenticator().login({ noBrowser: true, callbackPort: blocker.port, hooks: { ...quiet, fetch: upstream() } }).catch((e) => e);
      expect(isAuthenticationError(err)).toBe(true);
      expect(err.type).toBe("port_in_use");
    } finally {
      await blocker.stop(true);
    }
  });
});

describe("ClaudeAuthenticator.refresh", () => {
  test("rewrites the token metadata and keeps identity when the profile lookup fails", async () => {
    const fetchFn = fakeFetch((req) => {
      if (req.url === TokenURL) return jsonResponse({ access_token: "new-access", expires_in: 60 });
      return jsonResponse({ error: "down" }, 503);
    });
    const auth = newAuth({ id: "claude-x.json", provider: "claude", metadata: { type: "claude", access_token: "old", refresh_token: "rt", email: "user@example.com", account_uuid: "acc", prefix: "team" } });
    const updated = await new ClaudeAuthenticator().refresh(auth, { fetch: fetchFn, now: fixedNow, sleep: noopSleep });
    expect(updated).not.toBe(auth);
    expect(auth.metadata.access_token).toBe("old");
    expect(updated.metadata).toMatchObject({ access_token: "new-access", refresh_token: "rt", email: "user@example.com", account_uuid: "acc", prefix: "team", expired: "2026-10-28T12:01:00Z", last_refresh: "2026-10-28T12:00:00Z", type: "claude" });
    expect(updated.lastRefreshedAt).toBe(fixedNow());
  });

  test("returns the auth unchanged without a refresh token", async () => {
    const auth = newAuth({ id: "claude-x.json", provider: "claude", metadata: { access_token: "a" } });
    expect(await new ClaudeAuthenticator().refresh(auth, { fetch: fakeFetch(() => jsonResponse("{}")) })).toBe(auth);
  });

  test("refresh lead is four hours", () => {
    expect(new ClaudeAuthenticator().refreshLead()).toBe(ClaudeRefreshLeadMs);
    expect(ClaudeRefreshLeadMs).toBe(4 * 60 * 60 * 1000);
  });
});
