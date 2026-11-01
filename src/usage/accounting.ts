// Canonical token accounting. Port of sdk/cliproxy/usage/accounting.go plus the
// Detail type of sdk/cliproxy/usage/manager.go. Go used int64 with explicit
// overflow checks; here token counts are JS numbers and "overflow" means leaving
// the safe-integer range.

/** Identifies the canonical token accounting contract (Go: TokenAccountingSchemaVersion). */
export const TokenAccountingSchemaVersion = 2;

export type TokenAccountingQuality = "complete" | "inconsistent" | "unclassified";
export const TokenAccountingQualityComplete: TokenAccountingQuality = "complete";
export const TokenAccountingQualityInconsistent: TokenAccountingQuality = "inconsistent";
export const TokenAccountingQualityUnclassified: TokenAccountingQuality = "unclassified";

/** Mutually exclusive input token buckets. */
export interface TokenInputBreakdown {
  totalTokens: number;
  uncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Mutually exclusive output token buckets. */
export interface TokenOutputBreakdown {
  totalTokens: number;
  nonReasoningTokens: number;
  reasoningTokens: number;
}

/** The canonical, non-overlapping token accounting contract. */
export interface TokenBreakdown {
  schemaVersion: number;
  quality: TokenAccountingQuality | "";
  totalTokens: number;
  input: TokenInputBreakdown;
  output: TokenOutputBreakdown;
  unclassifiedTokens: number;
}

/** Token usage breakdown of one request (Go: usage.Detail). */
export interface Detail {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  tokenBreakdown: TokenBreakdown;
  responseServiceTier: string;
}

export function emptyTokenBreakdown(): TokenBreakdown {
  return {
    schemaVersion: 0,
    quality: "",
    totalTokens: 0,
    input: { totalTokens: 0, uncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    output: { totalTokens: 0, nonReasoningTokens: 0, reasoningTokens: 0 },
    unclassifiedTokens: 0,
  };
}

/** A zero Detail with optional fields set. */
export function newDetail(partial: Partial<Detail> = {}): Detail {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    responseServiceTier: "",
    ...partial,
    tokenBreakdown: partial.tokenBreakdown ?? emptyTokenBreakdown(),
  };
}

/** Reports whether the breakdown satisfies the v2 accounting invariants (Go: TokenBreakdown.Valid). */
export function tokenBreakdownValid(b: TokenBreakdown): boolean {
  if (b.schemaVersion !== TokenAccountingSchemaVersion || !validTokenAccountingQuality(b.quality)) return false;
  if (
    b.totalTokens < 0 ||
    b.unclassifiedTokens < 0 ||
    b.input.totalTokens < 0 ||
    b.input.uncachedTokens < 0 ||
    b.input.cacheReadTokens < 0 ||
    b.input.cacheWriteTokens < 0 ||
    b.output.totalTokens < 0 ||
    b.output.nonReasoningTokens < 0 ||
    b.output.reasoningTokens < 0
  ) {
    return false;
  }
  const inputSum = nonNegativeSum(b.input.uncachedTokens, b.input.cacheReadTokens, b.input.cacheWriteTokens);
  if (inputSum === undefined || b.input.totalTokens !== inputSum) return false;
  const outputSum = nonNegativeSum(b.output.nonReasoningTokens, b.output.reasoningTokens);
  if (outputSum === undefined || b.output.totalTokens !== outputSum) return false;
  const totalSum = nonNegativeSum(b.input.totalTokens, b.output.totalTokens, b.unclassifiedTokens);
  if (totalSum === undefined || b.totalTokens !== totalSum) return false;
  if (b.quality === TokenAccountingQualityComplete && b.unclassifiedTokens !== 0) return false;
  return true;
}

function validTokenAccountingQuality(quality: string): boolean {
  return quality === TokenAccountingQualityComplete || quality === TokenAccountingQualityInconsistent || quality === TokenAccountingQualityUnclassified;
}

function breakdown(quality: TokenAccountingQuality, total: number, input: TokenInputBreakdown, output: TokenOutputBreakdown, unclassified = 0): TokenBreakdown {
  return { schemaVersion: TokenAccountingSchemaVersion, quality, totalTokens: total, input, output, unclassifiedTokens: unclassified };
}

/** Protocols where cache tokens are inside the input total and reasoning inside the output total (Go: NewSubsetTokenBreakdown). */
export function newSubsetTokenBreakdown(inputTotal: number, cacheRead: number, cacheWrite: number, outputTotal: number, reasoning: number, total: number): TokenBreakdown {
  const cacheTotal = nonNegativeSum(cacheRead, cacheWrite);
  const expectedTotal = nonNegativeSum(inputTotal, outputTotal);
  if (cacheTotal === undefined || expectedTotal === undefined || reasoning < 0 || cacheTotal > inputTotal || reasoning > outputTotal) {
    return inconsistentTokenBreakdown(total, expectedTotal ?? 0);
  }
  const resolved = resolveAccountingTotal(total, expectedTotal);
  if (resolved === undefined) return inconsistentTokenBreakdown(total, expectedTotal);
  return breakdown(
    TokenAccountingQualityComplete,
    resolved,
    { totalTokens: inputTotal, uncachedTokens: inputTotal - cacheTotal, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    { totalTokens: outputTotal, nonReasoningTokens: outputTotal - reasoning, reasoningTokens: reasoning },
  );
}

/** Keeps the known subset buckets and puts an authoritative remainder into unclassified (Go: NewPartialSubsetTokenBreakdown). */
export function newPartialSubsetTokenBreakdown(inputTotal: number, cacheRead: number, cacheWrite: number, outputTotal: number, reasoning: number, total: number): TokenBreakdown {
  const cacheTotal = nonNegativeSum(cacheRead, cacheWrite);
  const expectedTotal = nonNegativeSum(inputTotal, outputTotal);
  if (
    cacheTotal === undefined ||
    expectedTotal === undefined ||
    inputTotal < 0 ||
    outputTotal < 0 ||
    reasoning < 0 ||
    cacheTotal > inputTotal ||
    reasoning > outputTotal ||
    total < 0
  ) {
    return inconsistentTokenBreakdown(total, expectedTotal ?? 0);
  }
  const resolved = total === 0 ? expectedTotal : total;
  if (resolved < expectedTotal) return inconsistentTokenBreakdown(total, expectedTotal);
  const unclassified = resolved - expectedTotal;
  return breakdown(
    unclassified > 0 ? TokenAccountingQualityUnclassified : TokenAccountingQualityComplete,
    resolved,
    { totalTokens: inputTotal, uncachedTokens: inputTotal - cacheTotal, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    { totalTokens: outputTotal, nonReasoningTokens: outputTotal - reasoning, reasoningTokens: reasoning },
    unclassified,
  );
}

/** Protocols where uncached input, cache reads/writes, output and reasoning are separate (Claude) (Go: NewIndependentTokenBreakdown). */
export function newIndependentTokenBreakdown(uncachedInput: number, cacheRead: number, cacheWrite: number, nonReasoningOutput: number, reasoning: number, total: number): TokenBreakdown {
  const inputTotal = nonNegativeSum(uncachedInput, cacheRead, cacheWrite);
  const outputTotal = nonNegativeSum(nonReasoningOutput, reasoning);
  const expectedTotal = inputTotal !== undefined && outputTotal !== undefined ? nonNegativeSum(inputTotal, outputTotal) : undefined;
  if (inputTotal === undefined || outputTotal === undefined || expectedTotal === undefined) return inconsistentTokenBreakdown(total, expectedTotal ?? 0);
  const resolved = resolveAccountingTotal(total, expectedTotal);
  if (resolved === undefined) return inconsistentTokenBreakdown(total, expectedTotal);
  return breakdown(
    TokenAccountingQualityComplete,
    resolved,
    { totalTokens: inputTotal, uncachedTokens: uncachedInput, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    { totalTokens: outputTotal, nonReasoningTokens: nonReasoningOutput, reasoningTokens: reasoning },
  );
}

/** Protocols where cache tokens are inside the input total but reasoning is separate from output (Gemini) (Go: NewSeparateReasoningTokenBreakdown). */
export function newSeparateReasoningTokenBreakdown(inputTotal: number, cacheRead: number, cacheWrite: number, nonReasoningOutput: number, reasoning: number, total: number): TokenBreakdown {
  const cacheTotal = nonNegativeSum(cacheRead, cacheWrite);
  if (cacheTotal === undefined || inputTotal < 0 || cacheTotal > inputTotal) return inconsistentTokenBreakdown(total, 0);
  const outputTotal = nonNegativeSum(nonReasoningOutput, reasoning);
  const expectedTotal = outputTotal !== undefined ? nonNegativeSum(inputTotal, outputTotal) : undefined;
  if (outputTotal === undefined || expectedTotal === undefined) return inconsistentTokenBreakdown(total, expectedTotal ?? 0);
  const resolved = resolveAccountingTotal(total, expectedTotal);
  if (resolved === undefined) return inconsistentTokenBreakdown(total, expectedTotal);
  return breakdown(
    TokenAccountingQualityComplete,
    resolved,
    { totalTokens: inputTotal, uncachedTokens: inputTotal - cacheTotal, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    { totalTokens: outputTotal, nonReasoningTokens: nonReasoningOutput, reasoningTokens: reasoning },
  );
}

/** Keeps an authoritative total without guessing its partition (Go: NewUnclassifiedTokenBreakdown). */
export function newUnclassifiedTokenBreakdown(total: number): TokenBreakdown {
  if (total <= 0) {
    const b = emptyTokenBreakdown();
    b.schemaVersion = TokenAccountingSchemaVersion;
    b.quality = total < 0 ? TokenAccountingQualityInconsistent : TokenAccountingQualityComplete;
    return b;
  }
  const b = emptyTokenBreakdown();
  b.schemaVersion = TokenAccountingSchemaVersion;
  b.quality = TokenAccountingQualityUnclassified;
  b.totalTokens = total;
  b.unclassifiedTokens = total;
  return b;
}

/** Attaches a valid v2 breakdown without provider knowledge (Go: EnsureTokenBreakdown). */
export function ensureTokenBreakdown(detail: Detail): Detail {
  return ensureTokenBreakdownForProvider(detail, "", "");
}

type Semantics = "unknown" | "subset" | "independent" | "separate-reasoning";

/**
 * Attaches a valid v2 breakdown using the known provider's token semantics;
 * unknown providers stay unclassified (Go: EnsureTokenBreakdownForProvider).
 * Returns a new Detail; the input is not mutated.
 */
export function ensureTokenBreakdownForProvider(input: Detail, provider: string, executorType: string): Detail {
  const detail: Detail = { ...input };
  if (!tokenBreakdownValid(detail.tokenBreakdown)) {
    const semantics = tokenAccountingSemanticsFor(provider, executorType);
    if (
      detail.cacheReadTokens === 0 &&
      detail.cachedTokens > 0 &&
      detail.inputTokens === 0 &&
      detail.outputTokens === 0 &&
      detail.reasoningTokens === 0 &&
      detail.cacheCreationTokens === 0 &&
      detail.totalTokens === 0 &&
      (semantics === "subset" || semantics === "separate-reasoning")
    ) {
      detail.cacheReadTokens = detail.cachedTokens;
    }
    detail.tokenBreakdown = tokenBreakdownForSemantics(detail, semantics);
  }
  if (detail.totalTokens === 0) detail.totalTokens = detail.tokenBreakdown.totalTokens;
  return detail;
}

function tokenBreakdownForSemantics(detail: Detail, semantics: Semantics): TokenBreakdown {
  if (detail.totalTokens === 0 && detail.inputTokens === 0 && detail.outputTokens === 0) {
    const total = unclassifiedTokenLowerBound(detail);
    if (total === undefined) return inconsistentTokenBreakdown(detail.totalTokens, 0);
    if (
      total > 0 &&
      (semantics === "unknown" ||
        semantics === "subset" ||
        (semantics === "separate-reasoning" && (detail.cacheReadTokens > 0 || detail.cacheCreationTokens > 0 || detail.cachedTokens > 0)))
    ) {
      return newUnclassifiedTokenBreakdown(total);
    }
  }
  switch (semantics) {
    case "subset":
      return newSubsetTokenBreakdown(detail.inputTokens, detail.cacheReadTokens, detail.cacheCreationTokens, detail.outputTokens, detail.reasoningTokens, detail.totalTokens);
    case "independent":
      return newIndependentTokenBreakdown(detail.inputTokens, detail.cacheReadTokens, detail.cacheCreationTokens, detail.outputTokens, detail.reasoningTokens, detail.totalTokens);
    case "separate-reasoning":
      return newSeparateReasoningTokenBreakdown(detail.inputTokens, detail.cacheReadTokens, detail.cacheCreationTokens, detail.outputTokens, detail.reasoningTokens, detail.totalTokens);
    default: {
      let total = detail.totalTokens;
      if (total === 0) {
        const bound = unclassifiedTokenLowerBound(detail);
        if (bound === undefined) return inconsistentTokenBreakdown(detail.totalTokens, 0);
        total = bound;
      }
      return newUnclassifiedTokenBreakdown(total);
    }
  }
}

function unclassifiedTokenLowerBound(detail: Detail): number | undefined {
  const cacheTokens = nonNegativeSum(detail.cacheReadTokens, detail.cacheCreationTokens);
  if (cacheTokens === undefined || detail.inputTokens < 0 || detail.outputTokens < 0 || detail.reasoningTokens < 0 || detail.cachedTokens < 0) return undefined;
  const inputTotal = Math.max(detail.inputTokens, cacheTokens, detail.cachedTokens);
  const outputTotal = Math.max(detail.outputTokens, detail.reasoningTokens);
  return nonNegativeSum(inputTotal, outputTotal);
}

function tokenAccountingSemanticsFor(provider: string, executorType: string): Semantics {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedExecutor = executorType.trim().toLowerCase();
  const value = `${normalizedProvider} ${normalizedExecutor}`.trim();
  if (value === "" || value === "unknown" || value === "unknown unknown") return "unknown";
  if (normalizedExecutor === "openaicompatexecutor" || normalizedProvider === "openai-compatibility" || normalizedProvider.startsWith("openai-compatible-")) return "subset";
  if (value.includes("claude") || value.includes("anthropic")) return "independent";
  for (const marker of ["gemini", "aistudio", "antigravity", "vertex", "interaction"]) {
    if (value.includes(marker)) return "separate-reasoning";
  }
  for (const marker of ["openai", "codex", "xai", "grok", "kimi", "qwen", "deepseek", "openrouter"]) {
    if (value.includes(marker)) return "subset";
  }
  return "unknown";
}

export function inconsistentTokenBreakdown(total: number, fallback: number): TokenBreakdown {
  let resolved = total;
  if (resolved <= 0) resolved = fallback;
  if (resolved < 0) resolved = 0;
  const b = emptyTokenBreakdown();
  b.schemaVersion = TokenAccountingSchemaVersion;
  b.quality = TokenAccountingQualityInconsistent;
  b.totalTokens = resolved;
  b.unclassifiedTokens = resolved;
  return b;
}

function resolveAccountingTotal(total: number, expected: number): number | undefined {
  if (total < 0 || expected < 0) return undefined;
  if (total === 0) return expected;
  return total === expected ? total : undefined;
}

/** Sum of non-negative integers, or undefined on a negative value or when leaving the safe-integer range (Go: nonNegativeSum). */
export function nonNegativeSum(...values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (value < 0 || total > Number.MAX_SAFE_INTEGER - value) return undefined;
    total += value;
  }
  return total;
}
