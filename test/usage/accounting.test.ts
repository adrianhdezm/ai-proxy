// Ported from: sdk/cliproxy/usage/accounting_test.go
// Skipped cases: none (overflow cases use Number.MAX_SAFE_INTEGER instead of math.MaxInt64)
import { describe, expect, test } from "bun:test";
import {
  TokenAccountingQualityComplete,
  TokenAccountingQualityInconsistent,
  TokenAccountingQualityUnclassified,
  TokenAccountingSchemaVersion,
  ensureTokenBreakdownForProvider,
  newDetail,
  newIndependentTokenBreakdown,
  newPartialSubsetTokenBreakdown,
  newSeparateReasoningTokenBreakdown,
  newSubsetTokenBreakdown,
  newUnclassifiedTokenBreakdown,
  tokenBreakdownValid,
  type TokenBreakdown,
} from "../../src/usage/accounting.ts";

const MAX = Number.MAX_SAFE_INTEGER;

test("NewSubsetTokenBreakdownAvoidsCacheAndReasoningDoubleCount", () => {
  const b = newSubsetTokenBreakdown(100, 40, 10, 30, 12, 130);
  expect(tokenBreakdownValid(b)).toBe(true);
  expect(b.input.uncachedTokens).toBe(50);
  expect(b.output.nonReasoningTokens).toBe(18);
  expect(b.totalTokens).toBe(130);
});

test("NewPartialSubsetTokenBreakdownPreservesKnownBuckets", () => {
  const b = newPartialSubsetTokenBreakdown(10, 4, 0, 0, 0, 15);
  expect(tokenBreakdownValid(b)).toBe(true);
  expect(b.quality).toBe(TokenAccountingQualityUnclassified);
  expect(b.input.totalTokens).toBe(10);
  expect(b.unclassifiedTokens).toBe(5);
});

test("NewIndependentTokenBreakdownKeepsClaudeCacheBucketsIndependent", () => {
  const b = newIndependentTokenBreakdown(30, 7, 13, 5, 0, 55);
  expect(tokenBreakdownValid(b)).toBe(true);
  expect(b.input.totalTokens).toBe(50);
  expect(b.totalTokens).toBe(55);
});

test("NewSeparateReasoningTokenBreakdownAddsReasoningToOutput", () => {
  const b = newSeparateReasoningTokenBreakdown(20, 5, 0, 7, 3, 30);
  expect(tokenBreakdownValid(b)).toBe(true);
  expect(b.output.totalTokens).toBe(10);
  expect(b.totalTokens).toBe(30);
});

test("TokenBreakdownMarksContradictoryParentsInconsistent", () => {
  const b = newSubsetTokenBreakdown(10, 4, 0, 3, 1, 20);
  expect(tokenBreakdownValid(b)).toBe(true);
  expect(b.quality).toBe(TokenAccountingQualityInconsistent);
  expect(b.unclassifiedTokens).toBe(20);
});

test("NewUnclassifiedTokenBreakdownDoesNotGuessBuckets", () => {
  const b = newUnclassifiedTokenBreakdown(42);
  expect(tokenBreakdownValid(b)).toBe(true);
  expect(b.quality).toBe(TokenAccountingQualityUnclassified);
  expect(b.unclassifiedTokens).toBe(42);
});

describe("EnsureTokenBreakdownForProviderUsesKnownSemantics", () => {
  const detail = () => newDetail({ inputTokens: 100, outputTokens: 30, reasoningTokens: 12, cacheReadTokens: 40, cacheCreationTokens: 10 });
  const cases = [
    { name: "OpenAI subsets cache and reasoning", provider: "openai", executorType: "", wantTotal: 130, wantInput: 100, wantOutput: 30 },
    { name: "OpenAI compatible executor takes precedence", provider: "anthropic", executorType: "OpenAICompatExecutor", wantTotal: 130, wantInput: 100, wantOutput: 30 },
    { name: "Gemini keeps reasoning separate", provider: "gemini", executorType: "", wantTotal: 142, wantInput: 100, wantOutput: 42 },
    { name: "Claude keeps cache and reasoning independent", provider: "anthropic", executorType: "", wantTotal: 192, wantInput: 150, wantOutput: 42 },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const d = ensureTokenBreakdownForProvider(detail(), tc.provider, tc.executorType);
      expect(tokenBreakdownValid(d.tokenBreakdown)).toBe(true);
      expect(d.tokenBreakdown.quality).toBe(TokenAccountingQualityComplete);
      expect(d.totalTokens).toBe(tc.wantTotal);
      expect(d.tokenBreakdown.totalTokens).toBe(tc.wantTotal);
      expect(d.tokenBreakdown.input.totalTokens).toBe(tc.wantInput);
      expect(d.tokenBreakdown.output.totalTokens).toBe(tc.wantOutput);
    });
  }
});

test("EnsureTokenBreakdownForUnknownProviderDoesNotGuessReasoning", () => {
  const d = ensureTokenBreakdownForProvider(newDetail({ inputTokens: 100, outputTokens: 30, reasoningTokens: 12 }), "plugin-provider", "");
  expect(d.totalTokens).toBe(130);
  expect(d.tokenBreakdown.quality).toBe(TokenAccountingQualityUnclassified);
  expect(d.tokenBreakdown.unclassifiedTokens).toBe(130);
});

test("EnsureTokenBreakdownForUnknownProviderPreservesAuxiliaryOnlyUsage", () => {
  const d = ensureTokenBreakdownForProvider(newDetail({ reasoningTokens: 12, cacheReadTokens: 7 }), "plugin-provider", "");
  expect(d.totalTokens).toBe(19);
  expect(d.tokenBreakdown.quality).toBe(TokenAccountingQualityUnclassified);
  expect(d.tokenBreakdown.unclassifiedTokens).toBe(19);
});

test("EnsureTokenBreakdownForGeminiClassifiesReasoningOnlyUsage", () => {
  const d = ensureTokenBreakdownForProvider(newDetail({ reasoningTokens: 12 }), "gemini", "");
  expect(d.totalTokens).toBe(12);
  expect(d.tokenBreakdown.quality).toBe(TokenAccountingQualityComplete);
  expect(d.tokenBreakdown.output.reasoningTokens).toBe(12);
});

test("EnsureTokenBreakdownPreservesLegacyCachedOnlyUsage", () => {
  const d = ensureTokenBreakdownForProvider(newDetail({ cachedTokens: 13 }), "openai", "");
  expect(d.totalTokens).toBe(13);
  expect(d.cacheReadTokens).toBe(13);
  expect(d.tokenBreakdown.quality).toBe(TokenAccountingQualityUnclassified);
  expect(d.tokenBreakdown.unclassifiedTokens).toBe(13);
});

test("EnsureTokenBreakdownDoesNotOverrideCanonicalZeroCacheRead", () => {
  const d = ensureTokenBreakdownForProvider(newDetail({ cachedTokens: 13, cacheCreationTokens: 13 }), "openai", "");
  expect(d.cacheReadTokens).toBe(0);
});

test("TokenBreakdown_Valid_RejectsArithmeticOverflow", () => {
  const b: TokenBreakdown = {
    schemaVersion: TokenAccountingSchemaVersion,
    quality: TokenAccountingQualityComplete,
    totalTokens: 0,
    input: { totalTokens: 0, uncachedTokens: MAX, cacheReadTokens: MAX, cacheWriteTokens: 2 },
    output: { totalTokens: 0, nonReasoningTokens: 0, reasoningTokens: 0 },
    unclassifiedTokens: 0,
  };
  expect(tokenBreakdownValid(b)).toBe(false);
  const bOutput: TokenBreakdown = {
    schemaVersion: TokenAccountingSchemaVersion,
    quality: TokenAccountingQualityComplete,
    totalTokens: 0,
    input: { totalTokens: 0, uncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    output: { totalTokens: -2, nonReasoningTokens: MAX, reasoningTokens: MAX },
    unclassifiedTokens: 0,
  };
  expect(tokenBreakdownValid(bOutput)).toBe(false);
});

test("NewSubsetTokenBreakdown_RejectsArithmeticOverflow", () => {
  const b = newSubsetTokenBreakdown(MAX, MAX, MAX, 0, 0, MAX);
  expect(b.quality).not.toBe(TokenAccountingQualityComplete);
  expect(b.input.uncachedTokens).toBeGreaterThanOrEqual(0);
});

test("NewSeparateReasoningTokenBreakdown_RejectsArithmeticOverflow", () => {
  const b = newSeparateReasoningTokenBreakdown(MAX, MAX, MAX, 0, 0, MAX);
  expect(b.quality).not.toBe(TokenAccountingQualityComplete);
  expect(b.input.uncachedTokens).toBeGreaterThanOrEqual(0);
});
