// Ported from: sdk/proxyutil/proxy_test.go
// Skipped cases: every TestBuildHTTPTransport* and TestBuildDialer* case (Go http.Transport / SOCKS5 / HTTP CONNECT
// dialer construction, HTTP/2 negotiation and TLS handshake timeouts; Bun's fetch takes the proxy URL as its `proxy`
// option, so only the setting interpretation and redaction are ported).
import { describe, expect, test } from "bun:test";
import { parseProxySetting, redactProxyURL, validRequestProxy, type ProxyMode } from "../../src/util/proxy.ts";

describe("TestParse", () => {
  const cases: [string, string, ProxyMode, boolean][] = [
    ["inherit", "", "inherit", false],
    ["direct", "direct", "direct", false],
    ["none", "none", "direct", false],
    ["http", "http://proxy.example.com:8080", "proxy", false],
    ["https", "https://proxy.example.com:8443", "proxy", false],
    ["socks5", "socks5://proxy.example.com:1080", "proxy", false],
    ["socks5h", "socks5h://proxy.example.com:1080", "proxy", false],
    ["invalid", "bad-value", "invalid", true],
  ];
  for (const [name, input, mode, wantErr] of cases) {
    test(name, () => {
      const { setting, error } = parseProxySetting(input);
      expect(error !== undefined).toBe(wantErr);
      expect(setting.mode).toBe(mode);
    });
  }
  test("unsupported scheme is invalid", () => {
    expect(parseProxySetting("ftp://proxy.example.com:21").setting.mode).toBe("invalid");
  });
});

test("TestRedactProxyURL", () => {
  expect(redactProxyURL("http://user:pass@proxy.example.com:8080/path?token=secret")).toBe("http://redacted@proxy.example.com:8080");
  expect(redactProxyURL("socks5://proxy.example.com:1080")).toBe("socks5://proxy.example.com:1080");
  expect(redactProxyURL("bad-value")).toBe("<invalid proxy URL>");
});

test("TestParseErrorDoesNotExposeProxyCredentials", () => {
  const input = "http://user:secret%@proxy.example.com:8080";
  const { error } = parseProxySetting(input);
  expect(error).toBeDefined();
  expect(error).not.toContain(input);
  expect(error).not.toContain("user");
  expect(error).not.toContain("secret");
});

test("ValidRequestProxy (helper used by the Go request-proxy override)", () => {
  expect(validRequestProxy("http://proxy.example.com:8080")).toBe(true);
  expect(validRequestProxy("http://proxy.example.com")).toBe(true);
  expect(validRequestProxy("http://proxy.example.com:0")).toBe(false);
  expect(validRequestProxy("http://proxy.example.com:70000")).toBe(false);
  expect(validRequestProxy("direct")).toBe(false);
});
