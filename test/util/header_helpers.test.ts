// Ported from: internal/util/header_helpers_test.go
// Skipped cases: fallback to gin context in request context (Gin has no equivalent; client headers are passed explicitly)
import { afterEach, describe, expect, test } from "bun:test";
import { applyCustomHeadersFromAttrs, setSessionIDResolver } from "../../src/util/header_helpers.ts";

afterEach(() => setSessionIDResolver(undefined));

test("static headers", () => {
  const h = new Headers();
  const applied = applyCustomHeadersFromAttrs(h, { "header:X-Custom-Static": "static-value", "header:Host": "custom.host.com" });
  expect(h.get("X-Custom-Static")).toBe("static-value");
  expect(applied.host).toBe("custom.host.com");
});

describe("magic variable", () => {
  test("present in clientHeaders sets header", () => {
    const h = new Headers();
    const clientHeaders = new Headers({ Abc: "session-abc-456", "X-Claude-Code-Session-Id": "claude-code-uuid-789" });
    applyCustomHeadersFromAttrs(
      h,
      { "header:X-Claude-Code-Session-Id": "$ABC", "header:X-Target-Session": "$X-Claude-Code-Session-Id", "header:Static-Header": "static-123" },
      { clientHeaders },
    );
    expect(h.get("X-Claude-Code-Session-Id")).toBe("session-abc-456");
    expect(h.get("X-Target-Session")).toBe("claude-code-uuid-789");
    expect(h.get("Static-Header")).toBe("static-123");
  });

  test("absent in clientHeaders does not set header", () => {
    const h = new Headers();
    applyCustomHeadersFromAttrs(
      h,
      { "header:X-Claude-Code-Session-Id": "$ABC", "header:X-Other": "$NONEXISTENT", "header:Static-Header": "static-123" },
      { clientHeaders: new Headers({ "Other-Header": "some-value" }) },
    );
    expect(h.has("X-Claude-Code-Session-Id")).toBe(false);
    expect(h.has("X-Other")).toBe(false);
    expect(h.get("Static-Header")).toBe("static-123");
  });

  test("nil clientHeaders does not set variable headers", () => {
    const h = new Headers();
    applyCustomHeadersFromAttrs(h, { "header:X-Claude-Code-Session-Id": "$ABC", "header:Static-Header": "static-123" });
    expect(h.has("X-Claude-Code-Session-Id")).toBe(false);
    expect(h.get("Static-Header")).toBe("static-123");
  });

  test("cpa-session-id resolved from context", () => {
    const h = new Headers();
    applyCustomHeadersFromAttrs(
      h,
      { "header:X-Session-ID": "$CPA-SESSION-ID", "header:X-Auth-Token": "Bearer $CPA-SESSION-ID", "header:X-Lower-Case": "$cpa-session-id", "header:Static-Header": "static-val" },
      { sessionID: "claude:session-xyz-123" },
    );
    expect(h.get("X-Session-ID")).toBe("claude:session-xyz-123");
    expect(h.get("X-Auth-Token")).toBe("Bearer claude:session-xyz-123");
    expect(h.get("X-Lower-Case")).toBe("claude:session-xyz-123");
    expect(h.get("Static-Header")).toBe("static-val");
  });

  test("cpa-session-id cleared via explicit empty session id", () => {
    setSessionIDResolver(() => "resolver-value");
    const h = new Headers();
    applyCustomHeadersFromAttrs(h, { "header:X-Session-ID": "$CPA-SESSION-ID", "header:X-Auth-Token": "Bearer $CPA-SESSION-ID", "header:Static": "ok" }, { sessionID: "" });
    expect(h.has("X-Session-ID")).toBe(false);
    expect(h.has("X-Auth-Token")).toBe(false);
    expect(h.get("Static")).toBe("ok");
  });

  test("cpa-session-id resolved from SessionIDResolver", () => {
    setSessionIDResolver((_ctx, clientHeaders) => {
      const v = clientHeaders?.get("X-Client-Sess");
      return v ? "resolved:" + v : "";
    });
    const h = new Headers();
    applyCustomHeadersFromAttrs(h, { "header:X-Forwarded-Session": "$CPA-SESSION-ID" }, { clientHeaders: new Headers({ "X-Client-Sess": "sess-999" }) });
    expect(h.get("X-Forwarded-Session")).toBe("resolved:sess-999");
  });

  test("cpa-session-id omitted when unresolvable", () => {
    const h = new Headers();
    applyCustomHeadersFromAttrs(h, { "header:X-Session-ID": "$CPA-SESSION-ID", "header:X-Auth-Token": "Bearer $CPA-SESSION-ID", "header:Static": "ok" });
    expect(h.has("X-Session-ID")).toBe(false);
    expect(h.has("X-Auth-Token")).toBe(false);
    expect(h.get("Static")).toBe("ok");
  });

  test("cpa-session-id does not read literal client header CPA-SESSION-ID", () => {
    const h = new Headers();
    applyCustomHeadersFromAttrs(h, { "header:X-Session-ID": "$CPA-SESSION-ID" }, { clientHeaders: new Headers({ "Cpa-Session-Id": "attacker-spoofed-value" }) });
    expect(h.has("X-Session-ID")).toBe(false);
  });

  test("cpa-session-id containing magic variable does not infinite loop", () => {
    const sessionWithToken = "header:$CPA-SESSION-ID";
    const h = new Headers();
    applyCustomHeadersFromAttrs(
      h,
      { "header:X-Session-ID": "$CPA-SESSION-ID", "header:X-Auth-Token": "Bearer $CPA-SESSION-ID", "header:X-Auth-Repeat": "Bearer $cpa-session-id-$CPA-SESSION-ID" },
      { sessionID: sessionWithToken },
    );
    expect(h.get("X-Session-ID")).toBe(sessionWithToken);
    expect(h.get("X-Auth-Token")).toBe("Bearer " + sessionWithToken);
    expect(h.get("X-Auth-Repeat")).toBe("Bearer " + sessionWithToken + "-" + sessionWithToken);
  });
});
