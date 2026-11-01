// Gemini usage parsing. Port of ParseGeminiUsage / ParseGeminiStreamUsage /
// parseGeminiFamilyUsageDetail (current internal/runtime/executor/helps/usage_helpers.go)
// and ParseGeminiCLIUsage / ParseGeminiCLIStreamUsage (v7.0.12), with the token
// breakdown of sdk/cliproxy/usage/accounting.go (NewSeparateReasoningTokenBreakdown)
// reduced to the fields this port reports.
import { getAt, gint, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { jsonPayload } from "./errors.ts";

export type TokenAccountingQuality = "complete" | "inconsistent";

/** Port of usage.TokenBreakdown (subset). */
export interface GeminiTokenBreakdown {
  quality: TokenAccountingQuality;
  totalTokens: number;
  inputTotalTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTotalTokens: number;
  nonReasoningOutputTokens: number;
  reasoningTokens: number;
  unclassifiedTokens: number;
}

/** Port of usage.Detail (subset). */
export interface GeminiUsageDetail {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  tokenBreakdown: GeminiTokenBreakdown;
}

const maxInt = Number.MAX_SAFE_INTEGER;

/** Port of safeUsageTokenSum/nonNegativeSum: undefined on a negative value or overflow. */
function safeSum(...values: number[]): number | undefined {
  let total = 0;
  for (const v of values) {
    if (v < 0 || v > maxInt || total > maxInt - v) return undefined;
    total += v;
  }
  return total;
}

function emptyBreakdown(): GeminiTokenBreakdown {
  return {
    quality: "complete",
    totalTokens: 0,
    inputTotalTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTotalTokens: 0,
    nonReasoningOutputTokens: 0,
    reasoningTokens: 0,
    unclassifiedTokens: 0,
  };
}

function inconsistentBreakdown(total: number, fallback = 0): GeminiTokenBreakdown {
  let resolved = total;
  if (resolved <= 0) resolved = fallback;
  if (resolved < 0) resolved = 0;
  return { ...emptyBreakdown(), quality: "inconsistent", totalTokens: resolved, unclassifiedTokens: resolved };
}

function separateReasoningBreakdown(inputTotal: number, cacheRead: number, cacheWrite: number, nonReasoningOutput: number, reasoning: number, total: number): GeminiTokenBreakdown {
  const cacheTotal = safeSum(cacheRead, cacheWrite);
  if (cacheTotal === undefined || inputTotal < 0 || cacheTotal > inputTotal) return inconsistentBreakdown(total);
  const outputTotal = safeSum(nonReasoningOutput, reasoning);
  const expected = outputTotal === undefined ? undefined : safeSum(inputTotal, outputTotal);
  if (outputTotal === undefined || expected === undefined) return inconsistentBreakdown(total, expected ?? 0);
  if (total < 0) return inconsistentBreakdown(total, expected);
  const resolved = total === 0 ? expected : total;
  if (total !== 0 && total !== expected) return inconsistentBreakdown(total, expected);
  return {
    quality: "complete",
    totalTokens: resolved,
    inputTotalTokens: inputTotal,
    uncachedInputTokens: inputTotal - cacheTotal,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTotalTokens: outputTotal,
    nonReasoningOutputTokens: nonReasoningOutput,
    reasoningTokens: reasoning,
    unclassifiedTokens: 0,
  };
}

export function emptyGeminiUsageDetail(): GeminiUsageDetail {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenBreakdown: emptyBreakdown() };
}

function firstExisting(root: unknown, ...paths: string[]): unknown {
  for (const p of paths) {
    const v = getAt(root, p);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Port of parseGeminiFamilyUsageDetail. */
export function parseGeminiFamilyUsageDetail(node: unknown): GeminiUsageDetail {
  const cachedTokens = gint(getAt(node, "cachedContentTokenCount"));
  const toolUseTokens = gint(firstExisting(node, "toolUsePromptTokenCount", "tool_use_prompt_token_count"));
  const input = safeSum(gint(getAt(node, "promptTokenCount")), toolUseTokens);
  const detail: GeminiUsageDetail = {
    inputTokens: input ?? 0,
    outputTokens: gint(getAt(node, "candidatesTokenCount")),
    reasoningTokens: gint(getAt(node, "thoughtsTokenCount")),
    totalTokens: gint(getAt(node, "totalTokenCount")),
    cachedTokens,
    cacheReadTokens: cachedTokens,
    cacheCreationTokens: 0,
    tokenBreakdown: emptyBreakdown(),
  };
  if (input === undefined) {
    detail.tokenBreakdown = inconsistentBreakdown(detail.totalTokens);
    return detail;
  }
  if (detail.totalTokens === 0) {
    const total = safeSum(detail.inputTokens, detail.outputTokens, detail.reasoningTokens);
    if (total === undefined) {
      detail.totalTokens = 0;
      detail.tokenBreakdown = inconsistentBreakdown(0);
      return detail;
    }
    detail.totalTokens = total;
  }
  detail.tokenBreakdown = separateReasoningBreakdown(detail.inputTokens, detail.cacheReadTokens, detail.cacheCreationTokens, detail.outputTokens, detail.reasoningTokens, detail.totalTokens);
  return detail;
}

function hasNonZeroTokenUsage(d: GeminiUsageDetail): boolean {
  return d.inputTokens !== 0 || d.outputTokens !== 0 || d.reasoningTokens !== 0 || d.cachedTokens !== 0 || d.cacheReadTokens !== 0 || d.cacheCreationTokens !== 0 || d.totalTokens !== 0 || d.tokenBreakdown.totalTokens !== 0;
}

function hasGeminiFamilyUsageTokenFields(node: unknown): boolean {
  if (!isObj(node)) return false;
  return ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount", "cachedContentTokenCount"].some((k) => node[k] !== undefined);
}

/** Usage of a complete generateContent body (Go: ParseGeminiUsage). */
export function parseGeminiUsage(data: string): GeminiUsageDetail {
  const node = firstExisting(tryParse<unknown>(data), "usageMetadata", "usage_metadata");
  if (node === undefined) return emptyGeminiUsageDetail();
  return parseGeminiFamilyUsageDetail(node);
}

/** Usage of one stream line; undefined when absent or an all-zero placeholder (Go: ParseGeminiStreamUsage). */
export function parseGeminiStreamUsage(line: string): GeminiUsageDetail | undefined {
  const payload = jsonPayload(line);
  if (payload === "") return undefined;
  const root = tryParse<unknown>(payload);
  if (root === undefined) return undefined;
  const node = firstExisting(root, "usageMetadata", "usage_metadata");
  if (node === undefined) return undefined;
  const detail = parseGeminiFamilyUsageDetail(node);
  return hasNonZeroTokenUsage(detail) ? detail : undefined;
}

/** Usage of a Code Assist body, wrapped in {"response":...} or bare (v7 ParseGeminiCLIUsage). */
export function parseGeminiCLIUsage(data: string): GeminiUsageDetail {
  const node = firstExisting(tryParse<unknown>(data), "response.usageMetadata", "response.usage_metadata", "usageMetadata", "usage_metadata");
  if (node === undefined) return emptyGeminiUsageDetail();
  return parseGeminiFamilyUsageDetail(node);
}

/** Usage of one Code Assist stream line (v7 ParseGeminiCLIStreamUsage). */
export function parseGeminiCLIStreamUsage(line: string): GeminiUsageDetail | undefined {
  const payload = jsonPayload(line);
  if (payload === "") return undefined;
  const root = tryParse<unknown>(payload);
  if (root === undefined) return undefined;
  const node = firstExisting(root, "response.usageMetadata", "response.usage_metadata", "usageMetadata", "usage_metadata");
  if (node === undefined || !hasGeminiFamilyUsageTokenFields(node)) return undefined;
  return parseGeminiFamilyUsageDetail(node);
}
