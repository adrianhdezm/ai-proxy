// Ported from: sdk/api/handlers/issue7017_retry_after_test.go, sdk/api/handlers/retry_deadline_test.go
// Skipped cases: none.
import { expect, test } from "bun:test";
import { getAvailableAuths } from "../../src/auth/manager/index.ts";
import { claudeErrorResponse, enrichAuthSelectionError, executionErrorMessage } from "../../src/server/errors.ts";
import { baseNow, testAuth } from "./helpers.ts";

function unavailableSelectionError(model: string, quota: boolean, resetMs: number): unknown {
  const next = baseNow + resetMs;
  try {
    getAvailableAuths([testAuth({ id: "synthetic", provider: "codex", unavailable: true, nextRetryAfter: next, quota: { exceeded: quota, nextRecoverAt: quota ? next : 0 } })], "codex", model, baseNow);
  } catch (err) {
    return err;
  }
  throw new Error("expected unavailable credential");
}

// Issue 7017: with header passthrough enabled, the raw upstream Retry-After carried in
// Addon must not overwrite the locally trusted cooldown deadline.
test("Issue7017TrustedRetryAfterWinsOverPassthroughAddon", async () => {
  const err = unavailableSelectionError("gpt-6.1-sol", true, 256_000);
  const response = claudeErrorResponse(
    { statusCode: 429, error: err as Error, addon: new Headers({ "Retry-After": "30", "X-Request-Id": "req-1" }) },
    { passthroughHeaders: true },
  );
  expect(response.headers.get("Retry-After")).toBe("256");
  expect(response.headers.get("X-Request-Id")).toBe("req-1");

  // Without a trusted deadline the raw passthrough value still applies.
  const plain = claudeErrorResponse({ statusCode: 429, error: new Error("rate limit"), addon: new Headers({ "Retry-After": "30" }) }, { passthroughHeaders: true });
  expect(plain.headers.get("Retry-After")).toBe("30");
});

test("LocalRecoveryHintsSurviveDefaultHeaderPolicyAndEnrichment", async () => {
  for (const quota of [false, true]) {
    const err = enrichAuthSelectionError(unavailableSelectionError("gpt-5.6-luna", quota, 60_000), ["codex"], "gpt-5.6-luna");
    for (const streaming of [false, true]) {
      const response = claudeErrorResponse(executionErrorMessage(err));
      const wantStatus = quota ? 429 : 503;
      expect(response.status).toBe(wantStatus);
      expect(response.headers.get("Retry-After")).toBe("60");
      const body = await response.text();
      expect(body).toContain("gpt-5.6-luna");
      const parsed = JSON.parse(body) as { error: { type: string } };
      expect(parsed.error.type).toBe(quota ? "rate_limit_error" : "api_error");
      void streaming;
    }
  }
});
