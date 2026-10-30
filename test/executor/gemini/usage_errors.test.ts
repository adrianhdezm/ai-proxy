// Ported from: internal/runtime/executor/helps/usage_helpers_test.go, internal/runtime/executor/antigravity_executor_credits_test.go, internal/runtime/executor/gemini_executor_test.go
// Skipped cases: every non-Gemini row of usage_helpers_test.go (Claude/OpenAI/Codex/Interactions parsers, usage reporter, stream buffer);
// antigravity_executor_credits_test.go: everything except TestParseRetryDelay_HumanReadableDuration (Antigravity credits, out of scope);
// gemini_executor_test.go here only TestCapGeminiMaxOutputTokens* and the geminiPromptBlockErrorMessage sub-case (executor cases live in aistudio.test.ts).
// The usage_helpers rows come from both the current file (ParseGeminiUsage/ParseGeminiStreamUsage) and v7.0.12 (ParseGeminiCLIUsage/ParseGeminiCLIStreamUsage).
// New (no upstream test): the remaining parseRetryDelay / newGeminiStatusErr / geminiStreamHasFinishSignal / parseGoDuration cases.
import { describe, expect, test } from "bun:test";
import {
  capGeminiMaxOutputTokens,
  geminiPromptBlockErrorMessage,
  geminiStreamHasFinishSignal,
  newGeminiStatusErr,
  normalizeAIStudioThinkingLevel,
  parseGeminiCLIStreamUsage,
  parseGeminiCLIUsage,
  parseGeminiStreamUsage,
  parseGeminiUsage,
  parseGoDuration,
  parseRetryDelay,
} from "../../../src/executor/gemini/index.ts";
import { StatusError } from "../../../src/executor/types.ts";

describe("parseGeminiUsage (helps/usage_helpers_test.go)", () => {
  test("TestParseGeminiUsageNormalizesCachedContent", () => {
    const d = parseGeminiUsage(`{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"cachedContentTokenCount":4,"totalTokenCount":12}}`);
    expect(d.cachedTokens).toBe(4);
    expect(d.cacheReadTokens).toBe(4);
    expect(d.tokenBreakdown.uncachedInputTokens).toBe(6);
    expect(d.tokenBreakdown.totalTokens).toBe(12);
  });

  test("TestParseGeminiUsageIncludesToolUsePromptTokens", () => {
    const d = parseGeminiUsage(`{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3,"toolUsePromptTokenCount":5,"totalTokenCount":20}}`);
    expect(d.inputTokens).toBe(15);
    expect(d.totalTokens).toBe(20);
    expect(d.tokenBreakdown.quality).toBe("complete");
    expect(d.tokenBreakdown.uncachedInputTokens).toBe(15);
    expect(d.tokenBreakdown.reasoningTokens).toBe(3);
  });

  test("TestParseGeminiStreamUsageSkipsZeroPlaceholder", () => {
    const lines = [
      `data: {"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0,"thoughtsTokenCount":0,"totalTokenCount":0}}`,
      `data: {"usageMetadata":{"promptTokenCount":17984,"candidatesTokenCount":2668,"thoughtsTokenCount":1028,"totalTokenCount":21680}}`,
    ];
    const accepted = lines.map(parseGeminiStreamUsage).filter((d) => d !== undefined);
    expect(accepted.length).toBe(1);
    expect(accepted[0]).toMatchObject({ inputTokens: 17984, outputTokens: 2668, reasoningTokens: 1028, totalTokens: 21680 });
  });

  for (const [name, payload] of [
    ["negative", `{"usageMetadata":{"promptTokenCount":10,"toolUsePromptTokenCount":-1,"totalTokenCount":10}}`],
    ["overflow", `{"usageMetadata":{"promptTokenCount":9223372036854775807,"toolUsePromptTokenCount":1,"totalTokenCount":9223372036854775807}}`],
  ] as const) {
    test(`TestParseGeminiUsageRejectsInvalidToolUseSums/${name}`, () => {
      const d = parseGeminiUsage(payload);
      expect(d.inputTokens).toBeGreaterThanOrEqual(0);
      expect(d.tokenBreakdown.quality).toBe("inconsistent");
    });
  }
});

describe("parseGeminiCLIUsage (v7.0.12 helps/usage_helpers_test.go)", () => {
  test("TestParseGeminiCLIUsage_TopLevelUsageMetadata", () => {
    const d = parseGeminiCLIUsage(`{"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":7,"thoughtsTokenCount":3,"totalTokenCount":21,"cachedContentTokenCount":5}}`);
    expect(d).toMatchObject({ inputTokens: 11, outputTokens: 7, reasoningTokens: 3, totalTokens: 21, cachedTokens: 5 });
  });

  test("TestParseGeminiCLIStreamUsage_ResponseSnakeCaseUsageMetadata", () => {
    const d = parseGeminiCLIStreamUsage(`data: {"response":{"usage_metadata":{"promptTokenCount":13,"candidatesTokenCount":2,"totalTokenCount":15}}}`);
    expect(d).toMatchObject({ inputTokens: 13, outputTokens: 2, totalTokens: 15 });
  });

  test("TestParseGeminiCLIStreamUsage_IgnoresTrafficTypeOnlyUsageMetadata", () => {
    expect(parseGeminiCLIStreamUsage(`data: {"response":{"usageMetadata":{"trafficType":"ON_DEMAND"}}}`)).toBeUndefined();
  });

  test("wrapped Code Assist body", () => {
    const d = parseGeminiCLIUsage(`{"response":{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}}}`);
    expect(d).toMatchObject({ inputTokens: 4, outputTokens: 1, totalTokens: 5 });
  });
});

describe("parseRetryDelay / newGeminiStatusErr", () => {
  test("TestParseRetryDelay_HumanReadableDuration (v7 antigravity_executor_credits_test.go)", () => {
    const body = `{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 1h43m56s."}}`;
    expect(parseRetryDelay(body)).toBe((3600 + 43 * 60 + 56) * 1000);
  });

  test("RetryInfo.retryDelay wins", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "Resource exhausted. Your quota will reset after 99s.",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quotaResetDelay: "373.801628ms" } },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.847655010s" },
        ],
      },
    });
    expect(parseRetryDelay(body)).toBeCloseTo(847.65501, 5);
  });

  test("ErrorInfo.metadata.quotaResetDelay fallback", () => {
    const body = JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quotaResetDelay: "373.801628ms" } }] } });
    expect(parseRetryDelay(body)).toBeCloseTo(373.801628, 6);
  });

  test("message 'after Ns.' fallback and none", () => {
    expect(parseRetryDelay(`{"error":{"message":"Your quota will reset after 42s."}}`)).toBe(42_000);
    expect(parseRetryDelay(`{"error":{"message":"quota exhausted"}}`)).toBeUndefined();
    expect(parseRetryDelay(`not json`)).toBeUndefined();
  });

  test("malformed RetryInfo delay yields no hint (upstream returns an error)", () => {
    const body = JSON.stringify({ error: { message: "after 5s.", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "soon" }] } });
    expect(parseRetryDelay(body)).toBeUndefined();
  });

  test("Go durations", () => {
    expect(parseGoDuration("1h2m3.5s")).toBe(3_723_500);
    expect(parseGoDuration("1500us")).toBe(1.5);
    expect(parseGoDuration("0")).toBe(0);
    expect(parseGoDuration("5")).toBeUndefined();
    expect(parseGoDuration("")).toBeUndefined();
  });

  test("429 carries retryAfterMs, other statuses do not", () => {
    const body = JSON.stringify({ error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2s" }] } });
    const err = newGeminiStatusErr(429, body);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.message).toBe(body);
    expect(newGeminiStatusErr(500, body).retryAfterMs).toBeUndefined();
    expect(newGeminiStatusErr(429, `{"error":{}}`).retryAfterMs).toBeUndefined();
  });
});

describe("prompt block / finish signal", () => {
  test("candidates_with_promptFeedback_not_blocked (gemini_executor_test.go)", () => {
    const withCandidate = `{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"promptFeedback":{"blockReason":"SAFETY"}}`;
    expect(geminiPromptBlockErrorMessage(withCandidate)).toBeUndefined();
    expect(geminiPromptBlockErrorMessage(`{"response":{"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"blocked"}}}`)).toBe("upstream blocked the prompt: SAFETY - blocked");
    expect(geminiPromptBlockErrorMessage(`{"candidates":[],"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}`)).toBe("upstream blocked the prompt: PROHIBITED_CONTENT");
  });

  test("geminiStreamHasFinishSignal", () => {
    expect(geminiStreamHasFinishSignal(`{"candidates":[{"content":{}},{"finishReason":"STOP"}]}`)).toBe(true);
    expect(geminiStreamHasFinishSignal(`{"response":{"candidates":[{"finishReason":"MAX_TOKENS"}]}}`)).toBe(true);
    expect(geminiStreamHasFinishSignal(`{"promptFeedback":{"blockReason":"SAFETY"}}`)).toBe(true);
    expect(geminiStreamHasFinishSignal(`{"candidates":[{"content":{"parts":[{"text":"x"}]}}]}`)).toBe(false);
    expect(geminiStreamHasFinishSignal(`{"candidates":[{"finishReason":"  "}]}`)).toBe(false);
    expect(geminiStreamHasFinishSignal("")).toBe(false);
  });
});

describe("capGeminiMaxOutputTokens (gemini_executor_test.go)", () => {
  test("TestCapGeminiMaxOutputTokensUsesOutputTokenLimit", () => {
    const out = JSON.parse(capGeminiMaxOutputTokens(`{"generationConfig":{"maxOutputTokens":500000,"temperature":0.2},"contents":[]}`, "gemini-3.1-pro-preview"));
    expect(out.generationConfig.maxOutputTokens).toBe(65536);
    expect(out.generationConfig.temperature).toBe(0.2);
  });

  test("TestCapGeminiMaxOutputTokensLeavesAllowedOrUnknown/allowed value", () => {
    const out = JSON.parse(capGeminiMaxOutputTokens(`{"generationConfig":{"maxOutputTokens":64000}}`, "gemini-3.1-pro-preview"));
    expect(out.generationConfig.maxOutputTokens).toBe(64000);
  });

  test("TestCapGeminiMaxOutputTokensLeavesAllowedOrUnknown/unknown model", () => {
    const out = JSON.parse(capGeminiMaxOutputTokens(`{"generationConfig":{"maxOutputTokens":500000}}`, "custom-gemini-model"));
    expect(out.generationConfig.maxOutputTokens).toBe(500000);
  });
});

describe("normalizeAIStudioThinkingLevel (aistudio_executor_test.go TestNormalizeAIStudioThinkingLevel)", () => {
  const cases: { name: string; levelJSON: string; want: unknown; unchanged?: boolean }[] = [
    { name: "minimal", levelJSON: `"minimal"`, want: "MINIMAL" },
    { name: "low", levelJSON: `"low"`, want: "LOW" },
    { name: "medium", levelJSON: `"medium"`, want: "MEDIUM" },
    { name: "mixed case high", levelJSON: `"hIgH"`, want: "HIGH" },
    { name: "already uppercase", levelJSON: `"HIGH"`, want: "HIGH", unchanged: true },
    { name: "none", levelJSON: `"none"`, want: "none", unchanged: true },
    { name: "xhigh", levelJSON: `"xhigh"`, want: "xhigh", unchanged: true },
    { name: "max", levelJSON: `"max"`, want: "max", unchanged: true },
    { name: "custom", levelJSON: `"custom"`, want: "custom", unchanged: true },
    { name: "non-string", levelJSON: `1`, want: 1, unchanged: true },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const input = `{"generationConfig":{"thinkingConfig":{"thinkingLevel":${tc.levelJSON}}},"marker":true}`;
      const output = normalizeAIStudioThinkingLevel(input);
      expect(JSON.parse(output).generationConfig.thinkingConfig.thinkingLevel).toBe(tc.want);
      if (tc.unchanged) expect(output).toBe(input);
    });
  }
});
