// Ported from: internal/auth/claude/anthropic_auth_proxy_test.go
// Skipped cases: none. Go inspects the uTLS round tripper's dialer (Go-only transport); here the proxy the
//   Claude auth service hands to fetch is observed instead. "Config proxy" maps to the credential's own
//   proxy_url and the "override" to RefreshOptions.proxyUrl.
import { afterEach, expect, test } from "bun:test";
import { ClaudeAuthenticator, TokenURL, resetClaudeRefreshState } from "../../../src/auth/claude/index.ts";
import { ClaudeAuth } from "../../../src/auth/claude/claude_auth.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { fakeFetch, fixedNow, jsonResponse, noopSleep } from "../helpers.ts";

afterEach(() => resetClaudeRefreshState());

function recordingFetch(seen: Array<string | undefined>) {
  return fakeFetch((req) => {
    if (req.url === TokenURL) seen.push(req.init?.proxy);
    if (req.url === TokenURL) return jsonResponse({ access_token: "new-access", expires_in: 60 });
    return jsonResponse({ error: "down" }, 503);
  });
}

test("TestNewClaudeAuthWithProxyURL_OverrideDirectTakesPrecedence", async () => {
  const seen: Array<string | undefined> = [];
  const auth = newAuth({ id: "claude-proxy.json", provider: "claude", proxyUrl: "socks5://proxy.example.com:1080", metadata: { type: "claude", access_token: "old", refresh_token: "rt" } });
  await new ClaudeAuthenticator().refresh(auth, { fetch: recordingFetch(seen), proxyUrl: "direct", now: fixedNow, sleep: noopSleep });
  expect(seen).toEqual([undefined]);
});

test("TestNewClaudeAuthWithProxyURL_OverrideProxyAppliedWithoutConfig", async () => {
  const seen: Array<string | undefined> = [];
  await new ClaudeAuth({ fetch: recordingFetch(seen), proxyUrl: "socks5://proxy.example.com:1080", now: fixedNow, sleep: noopSleep }).refreshTokens("rt");
  expect(seen).toEqual(["socks5://proxy.example.com:1080"]);
});
