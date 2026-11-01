// Ported from: internal/logging/diagnostic_test.go
// Skipped cases: none (url.Error in TestSafeErrorDiagnosticDoesNotExtractURLQueryValues is modelled as an Error whose
// message carries the URL and whose cause is the EOF error).
import { describe, expect, test } from "bun:test";
import { DiagnosticLogRuneLimit, safeDiagnosticForLog, safeErrorDiagnostic } from "../../src/util/diagnostic.ts";

describe("safeDiagnosticForLog", () => {
  test("TestSafeDiagnosticForLogPreservesAccessTokenExpiredAndRedactsCredentials", () => {
    const diagnostic =
      "access token expired\n" +
      `access_token=access-secret refresh token: refresh-secret Authorization=Bearer bearer-secret ` +
      `Post "https://user:password@oauth.example/token?access_token=query-secret" via socks5://proxy-user:proxy-password@127.0.0.1:1080`;
    const got = safeDiagnosticForLog(diagnostic);
    expect(got).toContain("access token expired");
    for (const secret of ["access-secret", "refresh-secret", "bearer-secret", "query-secret", "user:password", "proxy-user", "proxy-password"]) expect(got).not.toContain(secret);
    expect(/[\r\n]/.test(got)).toBe(false);
    expect(got).toContain("[REDACTED]");
  });

  test("TestSafeDiagnosticForLogKeepsPlainAccessTokenExpiredMessage", () => {
    expect(safeDiagnosticForLog("access token expired")).toBe("access token expired");
  });

  test("TestSafeDiagnosticForLogBoundsLargeMessageAndRetainsTrailingSignal", () => {
    const got = safeDiagnosticForLog("upstream context ".repeat(1000) + "access token expired\nforged log line");
    expect(Array.from(got).length).toBeLessThanOrEqual(DiagnosticLogRuneLimit + 3);
    expect(got).toContain("access token expired");
    expect(/[\r\n]/.test(got)).toBe(false);
    expect(got.endsWith("...")).toBe(true);
  });

  test("TestSafeDiagnosticForLogBoundsLargeGenericMessage", () => {
    const got = safeDiagnosticForLog("x".repeat(900));
    expect(Array.from(got).length).toBe(DiagnosticLogRuneLimit + 3);
    expect(got.endsWith("...")).toBe(true);
  });
});

describe("safeErrorDiagnostic", () => {
  test("TestSafeErrorDiagnosticExtractsOnlyAllowlistedSignals", () => {
    const cases: [string, Error, string[]][] = [
      ["EOF", new Error("EOF"), ["EOF"]],
      ["SOCKS refused", new Error("socks connect with unlabeled-secret: connection refused"), ["proxy=socks", "connection_refused"]],
      ["OAuth response", new Error(`upstream status 400 error="invalid_request" request_id="req-123" unlabeled-secret`), ["status=400"]],
      ["unknown", new Error("unlabeled-secret"), []],
    ];
    for (const [, err, want] of cases) {
      const got = safeErrorDiagnostic(err);
      for (const part of want) expect(got).toContain(part);
      expect(got).not.toContain("unlabeled-secret");
    }
  });

  test("TestSafeErrorDiagnosticDoesNotExtractURLQueryValues", () => {
    const err = new Error(`Post "https://oauth.example/token?code=oauth-secret&error=error-secret&request_id=request-secret": EOF`, { cause: new Error("EOF") });
    const got = safeErrorDiagnostic(err);
    expect(got).toContain("EOF");
    for (const secret of ["oauth-secret", "error-secret", "request-secret"]) expect(got).not.toContain(secret);
    for (const field of ["oauth_error=", "request_id="]) expect(got).not.toContain(field);
  });
});
