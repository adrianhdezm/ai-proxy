// Ported from: internal/runtime/executor/codex_executor_retry_test.go
// Ported from: internal/runtime/executor/codex_turn_rate_limit_issue7017_test.go
// Skipped cases: the "websocket*" sub-cases of TestCodexQuotaErrorCredentialScope / TestCodexQuotaErrorModelLevelCooling
//   and TestIssue7017TurnRateLimitWebsocket (websockets not ported). The Go error interfaces
//   (IsCredentialScoped, IsTransientRateLimit, RetryAfter, StatusCode) map to the StatusError fields
//   credentialScoped, transientRateLimit, retryAfterMs and statusCode.
import { describe, expect, test } from "bun:test";
import {
  codexTerminalStreamErr,
  codexTerminalStreamErrWithCooling,
  isCodexOverloadBootstrapFailure,
  isCodexUsageLimitError,
  newCodexStatusErr,
  newCodexStatusErrWithCooling,
  newCodexStatusErrWithHeaders,
  parseCodexRetryAfter,
} from "../../../src/executor/codex/index.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { codexErrorCode } from "./helpers.ts";

const Second = 1000;
const Minute = 60 * Second;
const Hour = 60 * Minute;

describe("TestCodexQuotaErrorCredentialScope", () => {
  const quota = `{"type":"usage_limit_reached","message":"You've hit your usage limit.","resets_in_seconds":3600}`;
  const cases: Array<{ name: string; path: string; body: string; want?: boolean }> = [
    { name: "http usage limit", path: "http", body: `{"error":${quota}}`, want: true },
    { name: "http top-level usage limit", path: "http", body: quota, want: true },
    { name: "http usage limit without reset", path: "http", body: `{"error":{"type":"usage_limit_reached"}}`, want: true },
    { name: "sse error", path: "terminal", body: `{"type":"error","error":${quota}}`, want: true },
    { name: "sse response failed", path: "terminal", body: `{"type":"response.failed","response":{"error":${quota}}}`, want: true },
    { name: "model capacity", path: "http", body: `{"error":{"message":"Selected model is at capacity. Please try a different model."}}` },
    { name: "transient rate limit", path: "http", body: `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}` },
    { name: "generic provider error", path: "generic", body: `{"error":${quota}}` },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      let err: StatusError;
      if (tc.path === "http") err = newCodexStatusErr(429, tc.body);
      else if (tc.path === "terminal") {
        const terminal = codexTerminalStreamErr(tc.body);
        expect(terminal).toBeDefined();
        err = terminal!.error;
      } else err = new StatusError(429, tc.body);
      expect(err.credentialScoped).toBe(tc.want === true);
      if (tc.want && tc.body.includes("resets_in_seconds")) expect(err.retryAfterMs).toBe(Hour);
    });
  }
});

describe("TestCodexQuotaErrorModelLevelCooling", () => {
  const quota = `{"type":"usage_limit_reached","message":"You've hit your usage limit.","resets_in_seconds":3600}`;
  const cases = [
    { name: "http usage limit", path: "http", body: `{"error":${quota}}` },
    { name: "http top-level usage limit", path: "http", body: quota },
    { name: "http usage limit without reset", path: "http", body: `{"error":{"type":"usage_limit_reached"}}` },
    { name: "sse error", path: "terminal", body: `{"type":"error","error":${quota}}` },
    { name: "sse response failed", path: "terminal", body: `{"type":"response.failed","response":{"error":${quota}}}` },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const err = tc.path === "http" ? newCodexStatusErrWithCooling(429, tc.body, true) : codexTerminalStreamErrWithCooling(tc.body, true)!.error;
      expect(err.credentialScoped).toBe(false);
      if (tc.body.includes("resets_in_seconds")) expect(err.retryAfterMs).toBe(Hour);
    });
  }
});

describe("TestParseCodexRetryAfterQuotaLayouts", () => {
  const now = 1_700_000_000 * 1000;
  const cases: Array<{ name: string; body: string; want?: number }> = [
    { name: "relative reset", body: `{"type":"usage_limit_reached","resets_in_seconds":3600}`, want: Hour },
    { name: "absolute reset wins", body: `{"type":"usage_limit_reached","resets_at":1700000300,"resets_in_seconds":1}`, want: 5 * Minute },
    { name: "expired absolute reset falls back", body: `{"type":"usage_limit_reached","resets_at":1699999940,"resets_in_seconds":77}`, want: 77 * Second },
    { name: "type matching agrees with quota classification", body: `{"type":" USAGE_LIMIT_REACHED ","resets_in_seconds":30}`, want: 30 * Second },
    { name: "missing reset", body: `{"type":"usage_limit_reached"}` },
    { name: "expired reset", body: `{"type":"usage_limit_reached","resets_at":1699999940}` },
    { name: "nonpositive reset", body: `{"type":"usage_limit_reached","resets_at":0,"resets_in_seconds":-1}` },
    { name: "transient limit", body: `{"type":"rate_limit_error","resets_in_seconds":30}` },
  ];
  for (const layout of ["nested", "top-level"]) {
    for (const tc of cases) {
      test(`${layout}/${tc.name}`, () => {
        const body = layout === "nested" ? `{"error":${tc.body}}` : tc.body;
        expect(parseCodexRetryAfter(429, body, now)).toBe(tc.want);
      });
    }
  }
});

describe("TestParseCodexRetryAfter", () => {
  const now = 1_700_000_000 * 1000;
  test("resets_in_seconds", () => {
    expect(parseCodexRetryAfter(429, `{"error":{"type":"usage_limit_reached","resets_in_seconds":123}}`, now)).toBe(123 * Second);
  });
  test("prefers resets_at", () => {
    const resetAt = (now + 5 * Minute) / 1000;
    expect(parseCodexRetryAfter(429, `{"error":{"type":"usage_limit_reached","resets_at":${resetAt},"resets_in_seconds":1}}`, now)).toBe(5 * Minute);
  });
  test("fallback when resets_at is past", () => {
    const resetAt = (now - Minute) / 1000;
    expect(parseCodexRetryAfter(429, `{"error":{"type":"usage_limit_reached","resets_at":${resetAt},"resets_in_seconds":77}}`, now)).toBe(77 * Second);
  });
  test("non-429 status code", () => {
    expect(parseCodexRetryAfter(400, `{"error":{"type":"usage_limit_reached","resets_in_seconds":30}}`, now)).toBeUndefined();
  });
  test("non usage_limit_reached error type", () => {
    expect(parseCodexRetryAfter(429, `{"error":{"type":"server_error","resets_in_seconds":30}}`, now)).toBeUndefined();
  });
});

test("TestNewCodexStatusErrTreatsCapacityAsRetryableRateLimit", () => {
  const err = newCodexStatusErr(400, `{"error":{"message":"Selected model is at capacity. Please try a different model."}}`);
  expect(err.statusCode).toBe(429);
  expect(err.retryAfterMs).toBeUndefined();
  expect(err.transientRateLimit).toBe(true);
});

test("TestNewCodexStatusErrTreatsUsageLimitAsRetryableRateLimit", () => {
  const err = newCodexStatusErr(400, `{"error":{"type":"usage_limit_reached","message":"You've hit your usage limit.","resets_in_seconds":120}}`);
  expect(err.statusCode).toBe(429);
  expect(err.retryAfterMs).toBe(120 * Second);
});

describe("TestIsCodexUsageLimitError", () => {
  const cases = [
    { name: "nested usage_limit_reached", body: `{"error":{"type":"usage_limit_reached","resets_in_seconds":30}}`, want: true },
    { name: "top-level usage_limit_reached", body: `{"type":"usage_limit_reached"}`, want: true },
    { name: "transient rate limit is excluded", body: `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}`, want: false },
    { name: "empty body", body: ``, want: false },
  ];
  for (const tc of cases) test(tc.name, () => expect(isCodexUsageLimitError(tc.body)).toBe(tc.want));
});

describe("TestNewCodexStatusErrClassifiesKnownCodexFailures", () => {
  const cases = [
    {
      name: "context length status",
      statusCode: 413,
      body: `{"error":{"message":"context length exceeded","type":"invalid_request_error","code":"context_length_exceeded"}}`,
      wantStatus: 413,
      wantType: "invalid_request_error",
      wantCode: "context_too_large",
    },
    {
      name: "thinking signature",
      statusCode: 400,
      body: `{"error":{"message":"Invalid signature in thinking block","type":"invalid_request_error","code":"invalid_request_error"}}`,
      wantStatus: 400,
      wantType: "invalid_request_error",
      wantCode: "thinking_signature_invalid",
    },
    {
      name: "previous response missing",
      statusCode: 400,
      body: `{"error":{"message":"No response found for previous_response_id resp_123","type":"invalid_request_error","code":"previous_response_not_found"}}`,
      wantStatus: 400,
      wantType: "invalid_request_error",
      wantCode: "previous_response_not_found",
    },
    {
      name: "auth unavailable",
      statusCode: 401,
      body: `{"error":{"message":"invalid or expired token","type":"authentication_error","code":"invalid_api_key"}}`,
      wantStatus: 401,
      wantType: "authentication_error",
      wantCode: "auth_unavailable",
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const err = newCodexStatusErr(tc.statusCode, tc.body);
      expect(err.statusCode).toBe(tc.wantStatus);
      expect(codexErrorCode(err.message)).toEqual({ type: tc.wantType, code: tc.wantCode });
    });
  }
});

test("TestNewCodexStatusErrPreservesUnclassifiedErrors", () => {
  const body = `{"error":{"message":"documentation mentions too many tokens, but this is a billing configuration failure","type":"server_error","code":"billing_config_error"}}`;
  const err = newCodexStatusErr(502, body);
  expect(err.statusCode).toBe(502);
  expect(err.message).toBe(body);
});

// ---------------------------------------------------------------------------
// Issue 7017: per-turn admission rejection (codex_turn_rate_limit_issue7017_test.go)
// ---------------------------------------------------------------------------

const issue7017TurnRateLimitBody = `{"error":{"type":"rate_limit_error","code":"turn_rate_limit_exceeded","message":"Codex is at capacity, please try again later"}}`;

function assertTransient(err: StatusError, wantHintMs: number | undefined): void {
  expect(err.statusCode).toBe(429);
  expect(err.transientRateLimit).toBe(true);
  expect(err.credentialScoped).toBe(false);
  expect(err.retryAfterMs).toBe(wantHintMs);
}

test("TestIssue7017TurnRateLimitHTTPHonorsRetryAfterHeader", () => {
  assertTransient(newCodexStatusErrWithHeaders(429, new Headers({ "Retry-After": "256" }), issue7017TurnRateLimitBody), 256 * Second);
});

describe("TestIssue7017TurnRateLimitHeaderFallbacks", () => {
  test("zero is explicit immediate retry", () => {
    assertTransient(newCodexStatusErrWithHeaders(429, new Headers({ "Retry-After": "0" }), issue7017TurnRateLimitBody), 0);
  });
  test("past http date clamps to zero", () => {
    const past = new Date(Date.now() - Hour).toUTCString();
    assertTransient(newCodexStatusErrWithHeaders(429, new Headers({ "Retry-After": past }), issue7017TurnRateLimitBody), 0);
  });
  test("invalid header yields no hint", () => {
    assertTransient(newCodexStatusErrWithHeaders(429, new Headers({ "Retry-After": "soon" }), issue7017TurnRateLimitBody), undefined);
  });
  test("missing header still transient without hint", () => {
    assertTransient(newCodexStatusErrWithHeaders(429, undefined, issue7017TurnRateLimitBody), undefined);
  });
  test("nested body usage limit hint wins and stays quota", () => {
    const body = `{"body":{"error":{"type":"usage_limit_reached","code":"turn_rate_limit_exceeded","message":"usage","resets_in_seconds":3600}}}`;
    const err = newCodexStatusErrWithHeaders(429, new Headers({ "Retry-After": "30" }), body);
    expect(err.retryAfterMs).toBe(Hour);
    expect(err.credentialScoped).toBe(true);
    expect(err.transientRateLimit).toBe(false);
  });
  test("huge retry-after seconds clamp", () => {
    const err = newCodexStatusErrWithHeaders(429, new Headers({ "Retry-After": "18446744074" }), issue7017TurnRateLimitBody);
    expect(err.retryAfterMs).toBeGreaterThan(0);
  });
  test("usage limit hint wins over header and stays quota", () => {
    const body = `{"error":{"type":"usage_limit_reached","code":"turn_rate_limit_exceeded","message":"usage","resets_in_seconds":3600}}`;
    const err = newCodexStatusErrWithHeaders(429, new Headers({ "Retry-After": "30" }), body);
    expect(err.retryAfterMs).toBe(Hour);
    expect(err.credentialScoped).toBe(true);
    expect(err.transientRateLimit).toBe(false);
  });
});

describe("TestIssue7017CapacityClassificationBoundaries", () => {
  const cases = [
    { name: "exact turn code", body: issue7017TurnRateLimitBody, want: true },
    { name: "code only", body: `{"error":{"code":"turn_rate_limit_exceeded"}}`, want: true },
    { name: "top level code", body: `{"code":"turn_rate_limit_exceeded"}`, want: true },
    { name: "wrapped body code", body: `{"body":{"error":{"code":"turn_rate_limit_exceeded"}}}`, want: true },
    { name: "code case and whitespace", body: `{"error":{"code":" Turn_Rate_Limit_Exceeded "}}`, want: true },
    { name: "code in message text only", body: `{"error":{"type":"server_error","message":"docs mention turn_rate_limit_exceeded"}}`, want: false },
    { name: "generic rate limit exceeded", body: `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"Too many requests"}}`, want: false },
    { name: "rate limit type with capacity message", body: `{"error":{"type":"rate_limit_error","message":"Codex is at capacity, please try again later"}}`, want: true },
    { name: "other explicit code blocks message fallback", body: `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"Codex is at capacity"}}`, want: false },
    {
      name: "other code blocks legacy model capacity via raw body",
      body: `{"model":"gpt-6.1-sol","error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"Codex is at capacity"}}`,
      want: false,
    },
    { name: "explicit model capacity code", body: `{"error":{"code":"model_at_capacity","message":"busy"}}`, want: true },
    { name: "capacity message without rate type", body: `{"error":{"type":"server_error","message":"Codex is at capacity"}}`, want: false },
    { name: "message in nested param", body: `{"error":{"type":"rate_limit_error","param":"Codex is at capacity"}}`, want: false },
    { name: "selected model at capacity stays model capacity", body: `{"error":{"message":"Selected model is at capacity. Please try a different model."}}`, want: true },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const err = newCodexStatusErr(429, tc.body);
      expect(err.transientRateLimit).toBe(tc.want);
      if (tc.want) expect(err.statusCode).toBe(429);
    });
  }
});

test("TestIssue7017TurnRateLimitTerminalAndBootstrap", () => {
  for (const payload of [
    `{"type":"error","error":{"type":"rate_limit_error","code":"turn_rate_limit_exceeded","message":"Codex is at capacity, please try again later"}}`,
    `{"type":"response.failed","response":{"error":{"type":"rate_limit_error","code":"turn_rate_limit_exceeded","message":"Codex is at capacity, please try again later"}}}`,
  ]) {
    const terminal = codexTerminalStreamErr(payload);
    expect(terminal).toBeDefined();
    assertTransient(terminal!.error, undefined);
    expect(isCodexOverloadBootstrapFailure(terminal!.body)).toBe(true);
  }
});
