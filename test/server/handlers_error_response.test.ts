// Ported from: sdk/api/handlers/handlers_error_response_test.go
// Skipped cases: TestWriteErrorResponseDirectResponse / TestExecutionErrorMessagePreservesMarkedResponseBodyExactly /
// TestExecutionErrorMessageDoesNotTrustResponseBodyWithoutMarker (RequestTerminatedError / direct-response marker
// interface not ported), TestInternalConcurrencyBusyWritesRetryAfterWithoutPassthrough /
// TestWriteErrorResponseHomeBusyNormalAndStreamHeaders (Home concurrency errors not ported),
// TestBuildErrorResponseBodyWithError_* / TestBuildErrorResponseBody_CompactsPrettyPrintedJSON (OpenAI error envelope;
// this port serves the Claude envelope only), TestEnrichAuthSelectionError_PropagatesTerminalAuth (covered by the
// TerminalAuthError branch in DefaultsTo503), TestExtractUpstreamErrorSummary_SanitizationAndTruncation (ported with the
// auth manager), TestExecutionErrorMessage_UnsupportedPartKeepsNameAnd400 (translator error type lives in another slice).
import { expect, test } from "bun:test";
import { AuthManagerError, ModelCooldownError, TerminalAuthError } from "../../src/auth/manager/index.ts";
import { StatusError } from "../../src/executor/types.ts";
import { ClaudeCodeAPIHandler } from "../../src/server/claude_handlers.ts";
import { StatusClientClosedRequest, claudeErrorResponse, enrichAuthSelectionError, executionErrorMessage, httpStatusFromError } from "../../src/server/errors.ts";
import { fakeExecutor, messagesBody, messagesRequest, newTestManager, registerFakeAuth, testAuth } from "./helpers.ts";

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

function timeoutError(): Error {
  return new DOMException("The operation timed out.", "TimeoutError");
}

test("WriteErrorResponse_AddonHeadersDisabledByDefault", async () => {
  const response = claudeErrorResponse({
    statusCode: 429,
    error: new Error("rate limit"),
    addon: new Headers({ "Retry-After": "30", "X-Request-Id": "req-1" }),
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBeNull();
  expect(response.headers.get("X-Request-Id")).toBeNull();
});

test("WriteErrorResponse_AddonHeadersEnabled", async () => {
  const addon = new Headers();
  addon.set("Retry-After", "30");
  addon.append("X-Request-Id", "new-1");
  addon.append("X-Request-Id", "new-2");
  addon.set("x-cpa-trace-id", "upstream-trace");
  addon.set("Access-Control-Expose-Headers", "upstream-header");
  const response = claudeErrorResponse({ statusCode: 429, error: new Error("rate limit"), addon }, { passthroughHeaders: true });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("30");
  expect(response.headers.get("X-Request-Id")).toBe("new-1, new-2");
  expect(response.headers.get("x-cpa-trace-id")).toBeNull();
  // The proxy's own CORS header is written by the server layer, never from upstream.
  expect(response.headers.get("Access-Control-Expose-Headers")).toBeNull();
});

test("EnrichAuthSelectionError_DefaultsTo503WithContext", () => {
  const out = enrichAuthSelectionError(new AuthManagerError("auth_not_found", "no auth available"), ["claude"], "claude-sonnet-4-6");
  expect(out).toBeInstanceOf(AuthManagerError);
  const got = out as AuthManagerError;
  expect(got.statusCode).toBe(503);
  expect(got.message).toContain("providers=claude");
  expect(got.message).toContain("model=claude-sonnet-4-6");
  expect(got.message).toContain("Claude auth/key session");

  const terminal = enrichAuthSelectionError(new TerminalAuthError("auth_unavailable", "no auth available", { httpStatus: 503 }), ["claude"], "claude-sonnet-4-6");
  expect(terminal).toBeInstanceOf(TerminalAuthError);
});

test("EnrichAuthSelectionError_PreservesExplicitStatus", () => {
  const out = enrichAuthSelectionError(new AuthManagerError("auth_unavailable", "no auth available", { httpStatus: 429 }), ["gemini"], "gemini-2.5-pro");
  expect((out as AuthManagerError).statusCode).toBe(429);
});

test("EnrichAuthSelectionError_IgnoresOtherErrors", () => {
  const input = new Error("boom");
  expect(enrichAuthSelectionError(input, ["claude"], "claude-sonnet-4-6")).toBe(input);
});

test("EnrichAuthSelectionError_IncludesUpstreamErrorFromCause", () => {
  const input = new AuthManagerError("auth_unavailable", "no auth available", {
    cause: new Error(`{"type":"error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","sequence_number":0}`),
  });
  const got = enrichAuthSelectionError(input, ["codex"], "gpt-5.6-sol") as AuthManagerError;
  expect(got.statusCode).toBe(503);
  expect(got.message).toContain("providers=codex");
  expect(got.message).toContain("model=gpt-5.6-sol");
  expect(got.message.includes("Our servers are currently overloaded. Please try again later.") || got.message.includes("server_is_overloaded")).toBe(true);
});

test("EnrichAuthSelectionError_DoesNotModifyModelCooldownError", async () => {
  const { manager, registry } = newTestManager();
  manager.registerExecutor(fakeExecutor({ identifier: "codex" }));
  const next = manager.now() + 60_000;
  manager.register(
    testAuth({
      id: "auth-cool",
      provider: "codex",
      unavailable: true,
      nextRetryAfter: next,
      quota: { exceeded: true, nextRecoverAt: next },
      lastError: { code: "auth_unavailable", message: "no auth available", retryable: true },
    }),
  );
  registry.registerClient("auth-cool", "codex", [{ id: "gpt-5.6-sol", type: "openai" }]);
  let errPick: unknown;
  try {
    await manager.execute(["codex"], { model: "gpt-5.6-sol", payload: "{}", format: "claude" }, { stream: false, sourceFormat: "claude" });
  } catch (err) {
    errPick = err;
  }
  expect(errPick).toBeInstanceOf(ModelCooldownError);
  expect(enrichAuthSelectionError(errPick, ["codex"], "gpt-5.6-sol")).toBe(errPick);
  expect(httpStatusFromError(errPick)).toBe(429);

  // And the handler surfaces it as a 429 rate_limit_error with Retry-After.
  const handler = new ClaudeCodeAPIHandler({ manager, registry });
  const response = await handler.claudeMessages(messagesRequest("gpt-5.6-sol", false), messagesBody("gpt-5.6-sol", false));
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  const body = (await response.json()) as { error: { type: string } };
  expect(body.error.type).toBe("rate_limit_error");
});

test("ExecutionErrorMessageMapsContextStatuses", () => {
  const cases: { name: string; err: Error; want: number }[] = [
    { name: "canceled", err: abortError(), want: StatusClientClosedRequest },
    { name: "deadline", err: timeoutError(), want: 504 },
    { name: "wrapped canceled", err: new Error("Post https://example.com", { cause: abortError() }), want: StatusClientClosedRequest },
    { name: "plain error defaults to 500", err: new Error("boom"), want: 500 },
    { name: "explicit status wins", err: new AuthManagerError("rate_limited", "slow down", { httpStatus: 429 }), want: 429 },
    { name: "status error", err: new StatusError(402, "billing"), want: 402 },
  ];
  for (const tc of cases) {
    const msg = executionErrorMessage(tc.err);
    expect(msg.statusCode).toBe(tc.want);
    expect(msg.error).toBe(tc.err);
  }
});

test("StatusFromErrorMapsContextStatuses", () => {
  expect(httpStatusFromError(abortError())).toBe(StatusClientClosedRequest);
  expect(httpStatusFromError(timeoutError())).toBe(504);
  expect(httpStatusFromError(new Error("Post https://example.com", { cause: abortError() }))).toBe(StatusClientClosedRequest);
  expect(httpStatusFromError(new Error("boom"))).toBe(0);
});

test("WriteErrorResponse_ContextCanceledUses499", async () => {
  const response = claudeErrorResponse(executionErrorMessage(abortError()));
  expect(response.status).toBe(StatusClientClosedRequest);
});
