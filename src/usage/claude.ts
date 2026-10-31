// Claude Messages usage parsing. Port of the Claude parts of
// internal/runtime/executor/helps/usage_helpers.go (ParseClaudeUsage,
// ParseClaudeStreamUsage, parseClaudeUsageNode, StreamUsageBuffer.ObserveClaudeStream,
// jsonPayload) and the independent-semantics branch of MergeStreamUsageDetail
// from plugin_executor_usage.go. Every response this server sends is
// Claude-shaped, so these parsers are the only ones the port needs.
import { isObject, tryParse, type JSONObject } from "../util/json.ts";
import { newDetail, newIndependentTokenBreakdown, type Detail } from "./accounting.ts";

/** Usage from a non-stream Claude Messages JSON body (Go: ParseClaudeUsage). */
export function parseClaudeUsage(body: string): Detail {
  const root = tryParse(body);
  if (!isObject(root) || !isObject(root.usage)) return newDetail();
  return parseClaudeUsageNode(root.usage);
}

/** Usage from one Claude SSE line (`data: {...}` or a bare JSON line): `usage` or `message.usage` (Go: ParseClaudeStreamUsage). */
export function parseClaudeStreamUsage(line: string): Detail | undefined {
  const payload = jsonPayload(line);
  if (payload === undefined) return undefined;
  const parsed = tryParse(payload);
  if (!isObject(parsed)) return undefined;
  return claudeStreamUsageFromObject(parsed);
}

function claudeStreamUsageFromObject(parsed: JSONObject): Detail | undefined {
  let node = parsed.usage;
  if (node === undefined && isObject(parsed.message)) node = parsed.message.usage;
  if (node === undefined) return undefined;
  return parseClaudeUsageNode(isObject(node) ? node : {});
}

/** Go: parseClaudeUsageNode. Cache fields are independent from input_tokens; thinking is a subset of output_tokens. */
export function parseClaudeUsageNode(node: JSONObject): Detail {
  const cacheReadTokens = intOf(node.cache_read_input_tokens);
  const cacheCreationTokens = intOf(node.cache_creation_input_tokens);
  const rawOutputTokens = intOf(node.output_tokens);
  const details = isObject(node.output_tokens_details) ? node.output_tokens_details : undefined;
  let reasoningTokens = 0;
  if (details && details.thinking_tokens !== undefined) reasoningTokens = intOf(details.thinking_tokens);
  else if (details && details.reasoning_tokens !== undefined) reasoningTokens = intOf(details.reasoning_tokens);
  else if (node.thinking_tokens !== undefined) reasoningTokens = intOf(node.thinking_tokens);
  if (reasoningTokens < 0) reasoningTokens = 0;
  let nonReasoningOutput = rawOutputTokens;
  if (reasoningTokens > 0 && reasoningTokens <= rawOutputTokens) nonReasoningOutput = rawOutputTokens - reasoningTokens;
  else if (reasoningTokens > rawOutputTokens) nonReasoningOutput = 0;

  const detail = newDetail({
    inputTokens: intOf(node.input_tokens),
    outputTokens: rawOutputTokens,
    reasoningTokens,
    cachedTokens: cacheReadTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });
  // usage.speed ("fast" / "standard") is carried as the response service tier.
  if (typeof node.speed === "string" && node.speed.trim() !== "") detail.responseServiceTier = node.speed.trim();
  if (detail.cachedTokens === 0) detail.cachedTokens = detail.cacheCreationTokens;
  detail.totalTokens = detail.inputTokens + rawOutputTokens + detail.cacheReadTokens + detail.cacheCreationTokens;
  detail.tokenBreakdown = newIndependentTokenBreakdown(detail.inputTokens, detail.cacheReadTokens, detail.cacheCreationTokens, nonReasoningOutput, detail.reasoningTokens, detail.totalTokens);
  return detail;
}

/**
 * Merges a newer stream usage update into the earlier one: zero fields keep
 * the earlier value (message_delta usually carries only output_tokens) and the
 * total is recomputed with Claude's independent cache buckets
 * (Go: MergeStreamUsageDetail, independent branch).
 */
export function mergeClaudeStreamUsageDetail(existing: Detail, update: Detail): Detail {
  const merged: Detail = { ...update };
  if (merged.inputTokens === 0 && existing.inputTokens > 0) merged.inputTokens = existing.inputTokens;
  if (merged.cachedTokens === 0 && existing.cachedTokens > 0) merged.cachedTokens = existing.cachedTokens;
  if (merged.cacheReadTokens === 0 && existing.cacheReadTokens > 0) merged.cacheReadTokens = existing.cacheReadTokens;
  if (merged.cacheCreationTokens === 0 && existing.cacheCreationTokens > 0) merged.cacheCreationTokens = existing.cacheCreationTokens;
  if (merged.outputTokens === 0 && existing.outputTokens > 0) merged.outputTokens = existing.outputTokens;
  if (merged.reasoningTokens === 0 && existing.reasoningTokens > 0) merged.reasoningTokens = existing.reasoningTokens;
  if (merged.responseServiceTier === "") merged.responseServiceTier = existing.responseServiceTier;

  let cached = merged.cacheReadTokens + merged.cacheCreationTokens;
  if (cached === 0) cached = merged.cachedTokens;
  const calculatedTotal = merged.inputTokens + merged.outputTokens + cached;
  if (merged.totalTokens === 0 || merged.totalTokens < calculatedTotal) merged.totalTokens = calculatedTotal;
  const nonReasoningOutput = Math.max(0, merged.outputTokens - merged.reasoningTokens);
  merged.tokenBreakdown = newIndependentTokenBreakdown(merged.inputTokens, merged.cacheReadTokens, merged.cacheCreationTokens, nonReasoningOutput, merged.reasoningTokens, merged.totalTokens);
  return merged;
}

/** HTTP status for a Claude error type, used when a stream ends with an `error` event. */
export function statusFromClaudeErrorType(type: string): number {
  switch (type) {
    case "invalid_request_error":
      return 400;
    case "authentication_error":
      return 401;
    case "billing_error":
      return 402;
    case "permission_error":
      return 403;
    case "not_found_error":
      return 404;
    case "request_too_large":
      return 413;
    case "rate_limit_error":
      return 429;
    case "timeout_error":
      return 504;
    case "overloaded_error":
      return 529;
    default:
      return 500;
  }
}

/**
 * Observes the Claude SSE chunks of one response (Go: StreamUsageBuffer with
 * ObserveClaudeStream, plus the terminal-event bookkeeping the usage record
 * needs). Chunks may split lines anywhere; complete lines are parsed.
 */
export class ClaudeStreamUsageObserver {
  private detail: Detail | undefined;
  private lineBuf = "";
  private currentEvent = "";
  /** Model reported by message_start (Go: extractClaudeResponseModelEvent). */
  responseModel = "";
  sawMessageStop = false;
  sawErrorEvent = false;
  /** Claude error type of the first error event. */
  errorType = "";

  observeChunk(chunk: string): void {
    if (chunk.length === 0) return;
    let start = 0;
    for (;;) {
      const idx = chunk.indexOf("\n", start);
      if (idx === -1) {
        this.lineBuf += chunk.slice(start);
        return;
      }
      this.observeLine(this.lineBuf + chunk.slice(start, idx));
      this.lineBuf = "";
      start = idx + 1;
    }
  }

  /** Processes a trailing line that was never newline-terminated. */
  flush(): void {
    if (this.lineBuf.length > 0) {
      const line = this.lineBuf;
      this.lineBuf = "";
      this.observeLine(line);
    }
  }

  /** The merged usage observed so far, if any. */
  usage(): Detail | undefined {
    return this.detail;
  }

  /** Feeds a parsed usage detail (Go: ObserveMergedStreamUsage). */
  observeUsage(update: Detail): void {
    this.detail = this.detail ? mergeClaudeStreamUsageDetail(this.detail, update) : update;
  }

  /** Go: ObserveClaudeStream for one line. */
  observeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") {
      this.currentEvent = "";
      return;
    }
    if (trimmed.startsWith("event:")) {
      this.currentEvent = trimmed.slice("event:".length).trim();
      return;
    }
    const payload = jsonPayload(trimmed);
    if (payload === undefined) return;
    const parsed = tryParse(payload);
    if (!isObject(parsed)) return;
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "message_start" && this.responseModel === "" && isObject(parsed.message) && typeof parsed.message.model === "string") {
      this.responseModel = parsed.message.model.trim();
    }
    if (type === "message_stop") this.sawMessageStop = true;
    if (type === "message" && !trimmed.startsWith("data:") && typeof parsed.stop_reason === "string" && parsed.stop_reason.trim() !== "") {
      this.sawMessageStop = true;
      if (this.responseModel === "" && typeof parsed.model === "string") this.responseModel = parsed.model.trim();
    }
    if (type === "error" || (this.currentEvent === "error" && parsed.error !== undefined)) {
      if (!this.sawErrorEvent) {
        this.sawErrorEvent = true;
        const err = parsed.error;
        if (isObject(err) && typeof err.type === "string") this.errorType = err.type;
      }
      return;
    }
    const detail = claudeStreamUsageFromObject(parsed);
    if (detail) this.observeUsage(detail);
  }
}

/** Strips `data:` and returns a JSON object payload, or undefined for event lines, [DONE] and non-objects (Go: jsonPayload). */
export function jsonPayload(line: string): string | undefined {
  let trimmed = line.trim();
  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return undefined;
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice("data:".length).trim();
  if (trimmed === "" || trimmed[0] !== "{") return undefined;
  return trimmed;
}

/** gjson Result.Int() for the shapes usage fields take. */
function intOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === "string") {
    const n = Number.parseFloat(value.trim());
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}
