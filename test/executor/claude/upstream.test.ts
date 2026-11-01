// Ported from: internal/runtime/executor/helps/claude_upstream_test.go
// Skipped cases: none.
import { expect, test } from "bun:test";
import { isAnthropicUpstreamURL } from "../../../src/executor/claude/upstream.ts";

test("IsAnthropicUpstreamURL", () => {
  const cases = [
    { name: "default HTTPS port", targetURL: "https://api.anthropic.com/v1/messages", want: true },
    { name: "explicit HTTPS port", targetURL: "https://api.anthropic.com:443/v1/messages", want: true },
    { name: "case insensitive host", targetURL: "https://API.ANTHROPIC.COM/v1/messages", want: true },
    { name: "HTTP", targetURL: "http://api.anthropic.com/v1/messages", want: false },
    { name: "custom port", targetURL: "https://api.anthropic.com:8443/v1/messages", want: false },
    { name: "userinfo", targetURL: "https://caller@api.anthropic.com/v1/messages", want: false },
    { name: "lookalike host", targetURL: "https://api.anthropic.com.example/v1/messages", want: false },
  ];
  for (const tc of cases) {
    expect(isAnthropicUpstreamURL(new URL(tc.targetURL))).toBe(tc.want);
  }
  expect(isAnthropicUpstreamURL(undefined)).toBe(false);
});
