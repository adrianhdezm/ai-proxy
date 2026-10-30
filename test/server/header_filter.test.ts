// Ported from: sdk/api/handlers/header_filter_test.go
// Skipped cases: none.
import { expect, test } from "bun:test";
import { filterUpstreamHeaders, forwardableInboundHeaders, isCPAReservedResponseHeader, writeUpstreamHeaders } from "../../src/server/headers.ts";

test("FilterUpstreamHeaders_RemovesConnectionScopedHeaders", () => {
  const src = new Headers();
  src.append("Connection", "keep-alive, x-hop-a, x-hop-b");
  src.append("Connection", "x-hop-c");
  src.set("Keep-Alive", "timeout=5");
  src.set("X-Hop-A", "a");
  src.set("X-Hop-B", "b");
  src.set("X-Hop-C", "c");
  src.set("X-Request-Id", "req-1");
  src.set("Set-Cookie", "session=secret");
  src.set("x-cpa-trace-id", "upstream-trace");
  src.set("Access-Control-Expose-Headers", "upstream-header");
  src.set("x-litellm-version", "1.0");

  const filtered = filterUpstreamHeaders(src);
  expect(filtered).toBeDefined();
  expect(filtered?.get("X-Request-Id")).toBe("req-1");
  for (const key of ["Connection", "Keep-Alive", "X-Hop-A", "X-Hop-B", "X-Hop-C", "Set-Cookie", "x-cpa-trace-id", "Access-Control-Expose-Headers", "x-litellm-version"]) {
    expect(filtered?.get(key)).toBeNull();
  }
});

test("FilterUpstreamHeaders_ReturnsNilWhenAllHeadersBlocked", () => {
  const src = new Headers();
  src.append("Connection", "x-hop-a");
  src.set("X-Hop-A", "a");
  src.set("Set-Cookie", "session=secret");
  expect(filterUpstreamHeaders(src)).toBeUndefined();
  expect(filterUpstreamHeaders(undefined)).toBeUndefined();
});

test("IsCPAReservedResponseHeader and WriteUpstreamHeaders (new)", () => {
  expect(isCPAReservedResponseHeader("access-control-allow-origin")).toBe(true);
  expect(isCPAReservedResponseHeader("X-Cpa-Trace-Id")).toBe(true);
  expect(isCPAReservedResponseHeader("X-Request-Id")).toBe(false);

  const dst = new Headers({ "Content-Type": "application/json" });
  writeUpstreamHeaders(dst, new Headers({ "Content-Type": "text/plain", "X-Request-Id": "req-1" }));
  expect(dst.get("Content-Type")).toBe("application/json");
  expect(dst.get("X-Request-Id")).toBe("req-1");
});

test("forwardableInboundHeaders keeps protocol headers and drops credentials (new)", () => {
  const inbound = new Headers({
    Authorization: "Bearer inbound-secret",
    "x-api-key": "inbound-secret",
    "x-goog-api-key": "inbound-secret",
    Host: "proxy.test",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "tools-2024-04-04",
    "user-agent": "claude-cli/1.0",
    "x-stainless-lang": "js",
    "x-app": "cli",
    "content-length": "12",
  });
  const forwarded = forwardableInboundHeaders(inbound);
  expect(forwarded.get("Authorization")).toBeNull();
  expect(forwarded.get("x-api-key")).toBeNull();
  expect(forwarded.get("x-goog-api-key")).toBeNull();
  expect(forwarded.get("Host")).toBeNull();
  expect(forwarded.get("content-length")).toBeNull();
  expect(forwarded.get("anthropic-version")).toBe("2023-06-01");
  expect(forwarded.get("anthropic-beta")).toBe("tools-2024-04-04");
  expect(forwarded.get("user-agent")).toBe("claude-cli/1.0");
  expect(forwarded.get("x-stainless-lang")).toBe("js");
  expect(forwarded.get("x-app")).toBe("cli");
});
