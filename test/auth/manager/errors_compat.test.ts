// Ported from: sdk/cliproxy/auth/errors_compat_test.go
// Skipped cases: none (the unkeyed Go literal becomes the positional constructor).
import { expect, test } from "bun:test";
import { AuthManagerError } from "../../../src/auth/manager/index.ts";
import { statusCodeOf } from "../../../src/executor/types.ts";

test("ErrorLegacyUnkeyedLiteralCompatibility", () => {
  const err = new AuthManagerError("code", "message", { retryable: false, httpStatus: 408 });
  expect(err.code).toBe("code");
  expect(err.message).toBe("message");
  expect(err.retryable).toBe(false);
  expect(err.httpStatus).toBe(408);
  expect(statusCodeOf(err)).toBe(408);
  expect(err.toAuthError()).toEqual({ code: "code", message: "message", retryable: false, httpStatus: 408 });
});
