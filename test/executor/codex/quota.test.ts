// Ported from: internal/runtime/executor/helps/codex_quota_test.go
// Skipped cases: TestParseCodexQuotaEventHeadersNonQuotaEventDoesNotAllocate and
//   TestParseCodexQuotaEventHeadersLargeNonQuotaFrameDoesNotAllocate (allocation counting; kept as
//   "returns nothing" checks), TestGenericWebsocketEntryPointDoesNotObserveCodexQuota and
//   TestMergeWebsocketQuotaHeaders (websocket request-log plumbing is not ported).
import { expect, test } from "bun:test";
import { parseCodexQuotaEventHeaders } from "../../../src/executor/codex/index.ts";

function expectHeaders(headers: Headers | undefined, want: Record<string, string>): void {
  expect(headers).toBeDefined();
  for (const [key, value] of Object.entries(want)) expect(`${key}=${headers!.get(key)}`).toBe(`${key}=${value}`);
}

test("TestParseCodexQuotaEventHeadersPreservesActiveLimit", () => {
  const headers = parseCodexQuotaEventHeaders(`{
		"type":"codex.rate_limits",
		"plan_type":"pro",
		"metered_limit_name":"codex_bengalfox",
		"rate_limits":{
			"primary":{"used_percent":2,"window_minutes":10080,"reset_at":1782951970},
			"secondary":null
		}
	}`);
  expectHeaders(headers, {
    "X-Codex-Active-Limit": "codex_bengalfox",
    "X-Codex-Primary-Used-Percent": "2",
    "X-Codex-Primary-Window-Minutes": "10080",
    "X-Codex-Primary-Reset-At": "1782951970",
    "X-Codex-Plan-Type": "pro",
  });
});

test("TestParseCodexQuotaEventHeadersPreservesAdditionalLimitsAndCredits", () => {
  const headers = parseCodexQuotaEventHeaders(`{
		"type":"codex.rate_limits",
		"plan_type":"pro",
		"rate_limits":{
			"allowed":true,
			"limit_reached":false,
			"primary":{"used_percent":48,"window_minutes":10080,"reset_after_seconds":523210,"reset_at":1786677299},
			"secondary":null
		},
		"additional_rate_limits":{
			"GPT-5.3-Codex-Spark":{
				"allowed":true,
				"limit_reached":false,
				"primary":{"used_percent":3,"window_minutes":300,"reset_after_seconds":10148,"reset_at":1787231961},
				"secondary":{"used_percent":63,"window_minutes":10080,"reset_after_seconds":75420,"reset_at":1787290791}
			}
		},
		"credits":{"has_credits":false,"unlimited":false,"balance":"0"}
	}`);
  expectHeaders(headers, {
    "X-Codex-Primary-Used-Percent": "48",
    "X-Codex-Primary-Window-Minutes": "10080",
    "X-Codex-Primary-Reset-After-Seconds": "523210",
    "X-Codex-Additional-GPT-5.3-Codex-Spark-Limit-Name": "GPT-5.3-Codex-Spark",
    "X-Codex-Additional-GPT-5.3-Codex-Spark-Primary-Used-Percent": "3",
    "X-Codex-Additional-GPT-5.3-Codex-Spark-Primary-Window-Minutes": "300",
    "X-Codex-Additional-GPT-5.3-Codex-Spark-Secondary-Used-Percent": "63",
    "X-Codex-Credits-Has-Credits": "false",
    "X-Codex-Credits-Unlimited": "false",
    "X-Codex-Credits-Balance": "0",
  });
});

test("TestParseCodexQuotaEventHeadersReadsQuotaHeadersFromErrorFrames", () => {
  const headers = parseCodexQuotaEventHeaders(`{
		"type":"error",
		"status_code":429,
		"headers":{
			"X-Codex-Primary-Used-Percent":"100",
			"X-Codex-Primary-Window-Minutes":"10080",
			"X-Codex-Primary-Reset-After-Seconds":"437380",
			"X-Codex-Credits-Balance":"0",
			"X-Codex-Turn-State":"must-not-be-observed",
			"Set-Cookie":"must-not-be-observed"
		}
	}`);
  expectHeaders(headers, { "X-Codex-Primary-Used-Percent": "100", "X-Codex-Primary-Reset-After-Seconds": "437380", "X-Codex-Credits-Balance": "0" });
  expect(headers!.get("Set-Cookie")).toBeNull();
  expect(headers!.get("X-Codex-Turn-State")).toBeNull();
});

test("TestParseCodexQuotaEventHeadersDoesNotInventActiveLimitAndRejectsIncompleteWindows", () => {
  let headers = parseCodexQuotaEventHeaders(`{
		"type":"codex.rate_limits",
		"rate_limits":{"primary":{"used_percent":42,"window_minutes":300,"reset_after_seconds":60}}
	}`);
  expect(headers!.get("X-Codex-Active-Limit")).toBeNull();
  expect(headers!.get("X-Codex-Primary-Reset-After-Seconds")).toBe("60");
  expect(parseCodexQuotaEventHeaders(`{"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":42}}}`)).toBeUndefined();

  headers = parseCodexQuotaEventHeaders(`{
		"type":"codex.rate_limits",
		"rate_limits":{
			"primary":{"used_percent":42,"window_minutes":300},
			"secondary":{"used_percent":17,"window_minutes":10080,"reset_after_seconds":60}
		}
	}`);
  expect(headers!.get("X-Codex-Primary-Used-Percent")).toBeNull();
  expect(headers!.get("X-Codex-Secondary-Used-Percent")).toBe("17");
});

test("TestParseCodexQuotaEventHeadersSupportsAdditionalArrayAndCamelCase", () => {
  const headers = parseCodexQuotaEventHeaders(`{
		"type":"codex.rate_limits",
		"planType":"pro",
		"meteredLimitName":"premium",
		"rateLimit":{
			"allowed":true,
			"limitReached":false,
			"primary":{"usedPercent":71,"windowMinutes":10080,"resetAfterSeconds":60}
		},
		"additionalRateLimits":[{
			"limitName":"GPT-5.3-Codex-Spark",
			"rateLimit":{
				"primary":{"usedPercent":13,"windowMinutes":300,"resetAt":1787399817},
				"secondary":{"usedPercent":51,"windowMinutes":10080,"resetAfterSeconds":120}
			}
		}]
	}`);
  expectHeaders(headers, {
    "X-Codex-Active-Limit": "premium",
    "X-Codex-Plan-Type": "pro",
    "X-Codex-Primary-Used-Percent": "71",
    "X-Codex-Additional-GPT-5.3-Codex-Spark-Limit-Name": "GPT-5.3-Codex-Spark",
    "X-Codex-Additional-GPT-5.3-Codex-Spark-Primary-Used-Percent": "13",
    "X-Codex-Additional-GPT-5.3-Codex-Spark-Secondary-Reset-After-Seconds": "120",
  });
});

test("TestParseCodexQuotaEventHeadersKeepsOnlySafeErrorHeaders", () => {
  const headers = parseCodexQuotaEventHeaders(`{
		"type":"error",
		"headers":{
			"X-Ratelimit-Remaining-Requests":"7",
			"Retry-After":"60",
			"X-Codex-Primary-Over-Secondary-Limit-Percent":"0",
			"X-Codex-Turn-State":"secret",
			"Authorization":"Bearer secret"
		}
	}`);
  expectHeaders(headers, { "X-Ratelimit-Remaining-Requests": "7", "Retry-After": "60", "X-Codex-Primary-Over-Secondary-Limit-Percent": "0" });
  expect(headers!.get("X-Codex-Turn-State")).toBeNull();
  expect(headers!.get("Authorization")).toBeNull();
});

test("non-quota events produce no headers (allocation tests reduced to their result)", () => {
  expect(parseCodexQuotaEventHeaders(`{"type":"response.output_text.delta","delta":"hello"}`)).toBeUndefined();
  const big = "x".repeat(4096);
  expect(parseCodexQuotaEventHeaders(`{"sequence_number":7,"type":"response.output_text.delta","delta":"${big}"}`)).toBeUndefined();
});

test("TestParseCodexQuotaEventHeadersLargeRateLimitsFrameIsParsed", () => {
  const padding = "p".repeat(4096);
  const payload = `{"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":42,"limit_percent":100,"window_minutes":10080,"reset_after_seconds":3600,"used_minutes":120},"secondary":{"used_percent":1,"limit_percent":100,"window_minutes":300,"reset_after_seconds":60,"used_minutes":2},"active_limit":"primary","credits":{"total_credits":"10","available_credits":"5","pct_remaining":"50"}},"padding":"${padding}"}`;
  const headers = parseCodexQuotaEventHeaders(payload);
  expect(headers!.get("X-Codex-Primary-Used-Percent")).toBe("42");
});

test("TestParseCodexQuotaEventHeadersRejectsInvalidAndEmptyEvents", () => {
  for (const payload of [
    ``,
    `{"type":"response.completed"}`,
    `{"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":101,"window_minutes":300,"reset_after_seconds":60}}}`,
  ]) {
    expect(parseCodexQuotaEventHeaders(payload)).toBeUndefined();
  }
});

test("TestParseCodexQuotaEventHeadersKeepsWindowsWhenActiveLimitIsInvalid", () => {
  const headers = parseCodexQuotaEventHeaders(`{
		"type":"codex.rate_limits",
		"metered_limit_name":"bad limit",
		"rate_limits":{"primary":{"used_percent":1,"window_minutes":300,"reset_after_seconds":60}}
	}`);
  expect(headers!.get("X-Codex-Primary-Used-Percent")).toBe("1");
  expect(headers!.get("X-Codex-Active-Limit")).toBeNull();
});

test("TestParseCodexQuotaEventHeadersObservedProductionEvent", () => {
  const headers = parseCodexQuotaEventHeaders(`{
		"type":"codex.rate_limits",
		"plan_type":"pro",
		"rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":81,"window_minutes":10080,"reset_after_seconds":137160,"reset_at":1787588999},"secondary":null},
		"code_review_rate_limits":{"primary":{"used_percent":4,"window_minutes":300,"reset_after_seconds":900}},
		"additional_rate_limits":{"GPT-5.3-Codex-Spark":{"allowed":true,"limit_reached":false,"primary":{"used_percent":0,"window_minutes":300,"reset_after_seconds":18000}}},
		"credits":{"has_credits":false,"unlimited":false,"balance":"0"},
		"promo":null
	}`);
  expectHeaders(headers, {
    "X-Codex-Plan-Type": "pro",
    "X-Codex-Primary-Used-Percent": "81",
    "X-Codex-Primary-Reset-At": "1787588999",
    "X-Codex-Code-Review-Primary-Used-Percent": "4",
    "X-Codex-Additional-Gpt-5.3-Codex-Spark-Limit-Name": "GPT-5.3-Codex-Spark",
    "X-Codex-Additional-Gpt-5.3-Codex-Spark-Primary-Used-Percent": "0",
    "X-Codex-Credits-Balance": "0",
    "X-Codex-Credits-Has-Credits": "false",
  });
  expect(headers!.get("X-Codex-Secondary-Used-Percent")).toBeNull();
});

test("TestParseCodexQuotaEventHeadersRejectsControlCharactersInLimitName", () => {
  const headers = parseCodexQuotaEventHeaders(`{
		"type":"codex.rate_limits",
		"additional_rate_limits":[{"limit_name":"evil\\r\\nX-Injected: 1","primary":{"used_percent":3,"window_minutes":300,"reset_after_seconds":60}}]
	}`);
  expect(headers).toBeDefined();
  for (const [, value] of headers!) expect(/[\r\n]/.test(value)).toBe(false);
});
