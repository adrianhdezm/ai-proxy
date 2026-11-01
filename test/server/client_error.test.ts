// Ported from: internal/clienterror/client_error_test.go
// Skipped cases: TestIsRequestFault* / TestIsClaudeThreadNotFound* / TestIsItemNotPersisted* / TestIsClientCancellation*
// (classification helpers ported with the auth manager; see test/auth/manager), the url.Error / fmt.Errorf wrapping
// sub-cases of TestHTTPStatusFromError (Go error wrapping; the TS port walks `cause`).
import { expect, test } from "bun:test";
import { AuthManagerError } from "../../src/auth/manager/index.ts";
import { StatusError } from "../../src/executor/types.ts";
import { StatusClientClosedRequest, httpStatusFromError, httpStatusFromErrorOr } from "../../src/server/errors.ts";

const canceled = () => new DOMException("canceled", "AbortError");
const deadline = () => new DOMException("deadline", "TimeoutError");

test("HTTPStatusFromError", () => {
  const cases: { name: string; err: unknown; want: number }[] = [
    { name: "nil", err: undefined, want: 0 },
    { name: "plain error", err: new Error("boom"), want: 0 },
    { name: "context canceled", err: canceled(), want: StatusClientClosedRequest },
    { name: "context deadline exceeded", err: deadline(), want: 504 },
    { name: "wrapped canceled via cause", err: new Error("upstream", { cause: canceled() }), want: StatusClientClosedRequest },
    { name: "wrapped deadline via cause", err: new Error("upstream", { cause: deadline() }), want: 504 },
    { name: "explicit status code wins", err: new StatusError(429, "rate limited"), want: 429 },
    { name: "explicit status wins over canceled cause", err: new StatusError(429, "rate limited", { cause: canceled() }), want: 429 },
    { name: "zero status code falls through to canceled cause", err: new AuthManagerError("x", "canceled", { cause: canceled() }), want: StatusClientClosedRequest },
    { name: "zero status code without cause stays unknown", err: new AuthManagerError("x", "canceled"), want: 0 },
    { name: "wrapped status code via cause", err: new Error("execute failed", { cause: new StatusError(401, "unauthorized") }), want: 401 },
  ];
  for (const tc of cases) expect(httpStatusFromError(tc.err)).toBe(tc.want);

  expect(httpStatusFromErrorOr(new Error("boom"), 502)).toBe(502);
  expect(httpStatusFromErrorOr(canceled(), 502)).toBe(StatusClientClosedRequest);
});
