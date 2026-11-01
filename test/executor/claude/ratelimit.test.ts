// Ported from: internal/runtime/executor/helps/claude_ratelimit_test.go
// Skipped cases: none (durations are milliseconds, the fuzz is disabled through parseClaudeRateLimitResetWithFuzz(…, 0, 0)).
import { describe, expect, test } from "bun:test";
import { claudeHeadersIndicateUnifiedRateLimitRejection, parseClaudeRateLimitReset, parseClaudeRateLimitResetWithFuzz } from "../../../src/executor/claude/ratelimit.ts";
import { DAY, HOUR, SECOND } from "./helpers.ts";

const unix = (ms: number) => String(Math.floor(ms / 1000));

describe("ParseClaudeRateLimitReset all cases", () => {
  const now = Date.now();

  test("nil headers returns nil", () => {
    expect(parseClaudeRateLimitReset(undefined, now)).toBeUndefined();
  });

  test("empty headers returns nil", () => {
    expect(parseClaudeRateLimitReset(new Headers(), now)).toBeUndefined();
  });

  test("retry-after only seconds", () => {
    const h = new Headers({ "Retry-After": "60" });
    expect(parseClaudeRateLimitResetWithFuzz(h, now, 0, 0)).toBe(60 * SECOND);
  });

  test("retry-after HTTP date", () => {
    const future = new Date(Math.floor((now + 90 * SECOND) / 1000) * 1000);
    const h = new Headers({ "Retry-After": future.toUTCString() });
    const got = parseClaudeRateLimitResetWithFuzz(h, now, 0, 0);
    expect(got).toBeDefined();
    expect(got!).toBeGreaterThanOrEqual(89 * SECOND);
    expect(got!).toBeLessThanOrEqual(91 * SECOND);
  });

  test("5h rejected and 7d allowed with unified reset", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Reset": unix(now + 5 * HOUR),
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Reset": unix(now + 7 * DAY),
      "Anthropic-Ratelimit-Unified-Reset": unix(now + 5 * HOUR),
    });
    const got = parseClaudeRateLimitResetWithFuzz(h, now, 0, 0)!;
    expect(got).toBeGreaterThanOrEqual(5 * HOUR - 5 * SECOND);
    expect(got).toBeLessThanOrEqual(5 * HOUR + 5 * SECOND);
  });

  test("7d rejected and 5h allowed", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-5h-Reset": unix(now + 5 * HOUR),
      "Anthropic-Ratelimit-Unified-7d-Status": "rejected",
      "Anthropic-Ratelimit-Unified-7d-Reset": unix(now + 7 * DAY),
    });
    const got = parseClaudeRateLimitResetWithFuzz(h, now, 0, 0)!;
    expect(got).toBeGreaterThanOrEqual(7 * DAY - 5 * SECOND);
    expect(got).toBeLessThanOrEqual(7 * DAY + 5 * SECOND);
  });

  test("both 5h and 7d rejected chooses longest", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Reset": unix(now + 5 * HOUR),
      "Anthropic-Ratelimit-Unified-7d-Status": "rejected",
      "Anthropic-Ratelimit-Unified-7d-Reset": unix(now + 7 * DAY),
    });
    const got = parseClaudeRateLimitResetWithFuzz(h, now, 0, 0)!;
    expect(got).toBeGreaterThanOrEqual(7 * DAY - 5 * SECOND);
    expect(got).toBeLessThanOrEqual(7 * DAY + 5 * SECOND);
  });

  test("all allowed returns nil", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-Status": "allowed",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-5h-Reset": unix(now + 5 * HOUR),
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Reset": unix(now + 7 * DAY),
    });
    expect(parseClaudeRateLimitReset(h, now)).toBeUndefined();
  });

  test("fable-only rejection with 7d_oi reset and retry-after returns nil for exponential backoff", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
      "Anthropic-Ratelimit-Unified-7d_oi-Reset": unix(now + 7 * DAY),
      "Anthropic-Ratelimit-Unified-Reset": unix(now + 7 * DAY),
      "Retry-After": "60",
    });
    expect(parseClaudeRateLimitResetWithFuzz(h, now, 0, 0)).toBeUndefined();
  });

  test("fable-only rejection with 7d_oi reset only returns nil for exponential backoff", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
      "Anthropic-Ratelimit-Unified-7d_oi-Reset": unix(now + 7 * DAY),
      "Anthropic-Ratelimit-Unified-Reset": unix(now + 7 * DAY),
    });
    expect(parseClaudeRateLimitReset(h, now)).toBeUndefined();
  });

  test("fable-only rejection with allowed_warning on shared window returns nil for exponential backoff", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed_warning",
      "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
      "Anthropic-Ratelimit-Unified-7d_oi-Reset": unix(now + 7 * DAY),
      "Anthropic-Ratelimit-Unified-Reset": unix(now + 7 * DAY),
      "Retry-After": "60",
    });
    expect(parseClaudeRateLimitResetWithFuzz(h, now, 0, 0)).toBeUndefined();
  });

  test("missing unified status with allowed_warning shared windows ignores unified reset and uses retry-after", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed_warning",
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed_warning",
      "Anthropic-Ratelimit-Unified-Reset": unix(now + 7 * DAY),
      "Retry-After": "60",
    });
    expect(parseClaudeRateLimitResetWithFuzz(h, now, 0, 0)).toBe(60 * SECOND);
  });

  test("non-fable combined rejection with 7d_oi reset keeps longer duration", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Reset": unix(now + 5 * HOUR),
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
      "Anthropic-Ratelimit-Unified-7d_oi-Reset": unix(now + 7 * DAY),
    });
    const got = parseClaudeRateLimitResetWithFuzz(h, now, 0, 0)!;
    expect(got).toBeGreaterThanOrEqual(7 * DAY - 5 * SECOND);
    expect(got).toBeLessThanOrEqual(7 * DAY + 5 * SECOND);
  });

  test("past timestamp returns nil", () => {
    const h = new Headers({
      "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Reset": unix(now - 5 * HOUR),
    });
    expect(parseClaudeRateLimitReset(h, now)).toBeUndefined();
  });

  test("fuzz is bounded and non-negative", () => {
    const h = new Headers({ "Retry-After": "100" });
    for (let i = 0; i < 50; i++) {
      const got = parseClaudeRateLimitReset(h, now)!;
      const diff = got - 100 * SECOND;
      expect(diff).toBeGreaterThanOrEqual(1 * SECOND);
      expect(diff).toBeLessThanOrEqual(30 * SECOND);
    }
  });
});

describe("ClaudeHeadersIndicateUnifiedRateLimitRejection allowed_warning", () => {
  const cases: Array<{ name: string; headers: Record<string, string>; expected: boolean }> = [
    {
      name: "both shared windows allowed, 7d_oi rejected is fable-only",
      headers: { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "allowed", "Anthropic-Ratelimit-Unified-7d-Status": "allowed", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected" },
      expected: false,
    },
    {
      name: "7d allowed_warning and 5h allowed with 7d_oi rejected is fable-only",
      headers: { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "allowed", "Anthropic-Ratelimit-Unified-7d-Status": "allowed_warning", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected" },
      expected: false,
    },
    {
      name: "5h allowed_warning and 7d allowed with 7d_oi rejected is fable-only",
      headers: { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "allowed_warning", "Anthropic-Ratelimit-Unified-7d-Status": "allowed", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected" },
      expected: false,
    },
    {
      name: "both shared windows allowed_warning with 7d_oi rejected is fable-only",
      headers: { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "allowed_warning", "Anthropic-Ratelimit-Unified-7d-Status": "allowed_warning", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected" },
      expected: false,
    },
    {
      name: "5h rejected even if 7d allowed_warning is unified rejection",
      headers: { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "rejected", "Anthropic-Ratelimit-Unified-7d-Status": "allowed_warning", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected" },
      expected: true,
    },
    {
      name: "7d rejected even if 5h allowed_warning is unified rejection",
      headers: { "Anthropic-Ratelimit-Unified-Status": "rejected", "Anthropic-Ratelimit-Unified-5h-Status": "allowed_warning", "Anthropic-Ratelimit-Unified-7d-Status": "rejected", "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected" },
      expected: true,
    },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      expect(claudeHeadersIndicateUnifiedRateLimitRejection(new Headers(tt.headers))).toBe(tt.expected);
    });
  }
});

test("overage rejection with healthy 7d window is model scoped (Issue 5915)", () => {
  const headers = new Headers({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Representative-Claim": "seven_day_overage_included",
    "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.69",
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.00",
    "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
    "Anthropic-Ratelimit-Unified-7d_oi-Utilization": "1.02",
    "Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Overage-Disabled-Reason": "org_spend_cap_reached",
    "Retry-After": "121180",
  });
  expect(claudeHeadersIndicateUnifiedRateLimitRejection(headers)).toBe(false);
});

describe("overage rejection utilization boundaries", () => {
  const base = () => ({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Representative-Claim": "seven_day_overage_included",
    "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.69",
    "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Overage-Disabled-Reason": "org_spend_cap_reached",
  });
  const cases = [
    { name: "healthy zero utilization", utilization: "0.00", wantUnified: false },
    { name: "healthy partial utilization", utilization: "0.50", wantUnified: false },
    { name: "missing utilization", utilization: "", wantUnified: true },
    { name: "invalid text", utilization: "invalid", wantUnified: true },
    { name: "NaN", utilization: "NaN", wantUnified: true },
    { name: "+Inf", utilization: "+Inf", wantUnified: true },
    { name: "-Inf", utilization: "-Inf", wantUnified: true },
    { name: "negative utilization", utilization: "-0.1", wantUnified: true },
    { name: "exact 1.0 utilization", utilization: "1.0", wantUnified: true },
    { name: "exceeded utilization", utilization: "1.05", wantUnified: true },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const h = new Headers(base());
      if (tt.utilization !== "") h.set("Anthropic-Ratelimit-Unified-5h-Utilization", tt.utilization);
      expect(claudeHeadersIndicateUnifiedRateLimitRejection(h)).toBe(tt.wantUnified);
    });
  }
});

const issue6465Now = Date.UTC(2026, 9, 7, 20, 46, 4);

test("overage claim without shared windows does not cool until billing reset (Issue 6465)", () => {
  const headers = new Headers({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Representative-Claim": "overage",
    "Anthropic-Ratelimit-Unified-Reset": "1793491200",
    "Anthropic-Ratelimit-Unified-Overage-Status": "allowed",
    "Anthropic-Ratelimit-Unified-Overage-Reset": "1793491200",
    "Anthropic-Ratelimit-Unified-Overage-Utilization": "0.11",
  });
  expect(claudeHeadersIndicateUnifiedRateLimitRejection(headers)).toBe(false);
  expect(parseClaudeRateLimitResetWithFuzz(headers, issue6465Now, 0, 0)).toBeUndefined();
});

test("rejected five hour window ignores monthly unified reset (Issue 6465)", () => {
  const headers = new Headers({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
    "Anthropic-Ratelimit-Unified-5h-Reset": unix(issue6465Now + 5 * HOUR),
    "Anthropic-Ratelimit-Unified-Reset": "1793491200",
    "Anthropic-Ratelimit-Unified-Representative-Claim": "five_hour",
  });
  const got = parseClaudeRateLimitResetWithFuzz(headers, issue6465Now, 0, 0)!;
  expect(got).toBeGreaterThanOrEqual(5 * HOUR - SECOND);
  expect(got).toBeLessThanOrEqual(5 * HOUR + SECOND);
});

test("unified reset matching overage reset does not override retry-after (Issue 6465)", () => {
  const now = Date.UTC(2026, 9, 29);
  const billingReset = unix(now + 48 * HOUR);
  const headers = new Headers({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Representative-Claim": "overage",
    "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.69",
    "Anthropic-Ratelimit-Unified-Reset": billingReset,
    "Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Overage-Reset": billingReset,
    "Retry-After": "60",
  });
  expect(claudeHeadersIndicateUnifiedRateLimitRejection(headers)).toBe(true);
  expect(parseClaudeRateLimitResetWithFuzz(headers, now, 0, 0)).toBe(60 * SECOND);
});

test("five hour claim with overage disabled reason stays credential scoped (Issue 6465)", () => {
  const headers = new Headers({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Representative-Claim": "five_hour",
    "Anthropic-Ratelimit-Unified-Overage-Disabled-Reason": "org_level_disabled",
    "Retry-After": "10800",
  });
  expect(claudeHeadersIndicateUnifiedRateLimitRejection(headers)).toBe(true);
  expect(parseClaudeRateLimitResetWithFuzz(headers, issue6465Now, 0, 0)).toBe(3 * HOUR);
});

test("overage claim with exhausted shared utilization stays credential scoped (Issue 6465)", () => {
  const headers = new Headers({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Representative-Claim": "overage",
    "Anthropic-Ratelimit-Unified-5h-Utilization": "1.0",
    "Retry-After": "10800",
  });
  expect(claudeHeadersIndicateUnifiedRateLimitRejection(headers)).toBe(true);
  expect(parseClaudeRateLimitResetWithFuzz(headers, issue6465Now, 0, 0)).toBe(3 * HOUR);
});

test("overage claim with healthy utilization stays model scoped (Issue 6465)", () => {
  const headers = new Headers({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-Representative-Claim": "overage",
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.00",
    "Anthropic-Ratelimit-Unified-Reset": "1793491200",
    "Anthropic-Ratelimit-Unified-Overage-Reset": "1793491200",
    "Retry-After": "10800",
  });
  expect(claudeHeadersIndicateUnifiedRateLimitRejection(headers)).toBe(false);
  expect(parseClaudeRateLimitResetWithFuzz(headers, issue6465Now, 0, 0)).toBeUndefined();
});

test("retry-after beyond seven days falls back (Issue 6465)", () => {
  const headers = new Headers({
    "Anthropic-Ratelimit-Unified-Status": "rejected",
    "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
    "Retry-After": "2034192",
  });
  expect(parseClaudeRateLimitResetWithFuzz(headers, issue6465Now, 0, 0)).toBeUndefined();
});

describe("allowed unified overage claim keeps short retry-after (Issue 6465)", () => {
  for (const unifiedStatus of ["allowed", ""]) {
    test(unifiedStatus || "(missing)", () => {
      const headers = new Headers({
        "Anthropic-Ratelimit-Unified-Representative-Claim": "overage",
        "Anthropic-Ratelimit-Unified-Overage-Status": "allowed",
        "Retry-After": "30",
      });
      if (unifiedStatus !== "") headers.set("Anthropic-Ratelimit-Unified-Status", unifiedStatus);
      expect(claudeHeadersIndicateUnifiedRateLimitRejection(headers)).toBe(false);
      expect(parseClaudeRateLimitResetWithFuzz(headers, issue6465Now, 0, 0)).toBe(30 * SECOND);
    });
  }
});
