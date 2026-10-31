// Executor helpers for the OpenAI Responses response format. Port of
// internal/runtime/executor/helps/responses_usage_helpers.go (EnsureResponsesUsageDetails)
// and the apply_patch stream helpers of helps/apply_patch.go
// (ApplyPatchUpstreamErrorMessage, ApplyPatchTranslationError,
// FinalizeApplyPatchStream, CanFinalizeResponseStream, ApplyPatchRequested,
// InitializeApplyPatchStream, ApplyPatchOriginalRequest). The usage-reporter
// halves of those helpers are not ported (usage is recorded at the HTTP layer).
import { isApplyPatchCustomTool } from "../translator/common/apply_patch_tool.ts";
import { defaultRegistry } from "../translator/registry.ts";
import { FormatOpenAIResponse, type Format, type TranslateContext, type TranslatorState } from "../translator/types.ts";
import { collectResponsesToolWinners } from "../util/responses_tools.ts";
import { tryParse } from "../util/json.ts";
import { RawNumber, parseRawJSON, stringifyRawJSON } from "./codex/rawjson.ts";
import { StatusError, type ExecOptions, type ExecRequest } from "./types.ts";

/** Deliberately excludes upstream JSON and patch text (Go: ApplyPatchUpstreamErrorMessage). */
export const applyPatchUpstreamErrorMessage = "Invalid apply_patch tool arguments received from upstream.";

/** The sanitised 502 an apply_patch translation failure surfaces as. */
export function applyPatchUpstreamError(): StatusError {
  return new StatusError(502, applyPatchUpstreamErrorMessage);
}

type JSONObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RawNumber);
}

function ensureUsageDetailsAt(root: JSONObject, path: string[]): boolean {
  let usage: unknown = root;
  for (const key of path) {
    if (!isPlainObject(usage)) return false;
    usage = usage[key];
  }
  if (!isPlainObject(usage)) return false;
  let changed = false;
  const output = usage.output_tokens_details;
  if (!isPlainObject(output)) {
    usage.output_tokens_details = { reasoning_tokens: 0 };
    changed = true;
  } else if (output.reasoning_tokens === undefined || output.reasoning_tokens === null) {
    output.reasoning_tokens = 0;
    changed = true;
  }
  const input = usage.input_tokens_details;
  if (!isPlainObject(input)) {
    usage.input_tokens_details = { cached_tokens: 0 };
    changed = true;
  } else if (input.cached_tokens === undefined || input.cached_tokens === null) {
    input.cached_tokens = 0;
    changed = true;
  }
  return changed;
}

function ensureJSON(text: string): string | undefined {
  let root: unknown;
  try {
    root = parseRawJSON(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(root)) return undefined;
  if (root.object === "response.compaction") return undefined;
  const a = ensureUsageDetailsAt(root, ["response", "usage"]);
  const b = ensureUsageDetailsAt(root, ["usage"]);
  return a || b ? stringifyRawJSON(root) : undefined;
}

/**
 * Makes sure Responses usage objects carry output_tokens_details.reasoning_tokens
 * and input_tokens_details.cached_tokens (default 0), in a plain JSON body or in
 * the data lines of SSE text; response.compaction objects are left alone
 * (Go: EnsureResponsesUsageDetails). Unchanged input is returned as is.
 */
export function ensureResponsesUsageDetails(payload: string): string {
  // Fast path: nothing to patch without a usage object.
  if (!payload.includes('"usage"')) return payload;
  const trimmed = payload.trim();
  if (trimmed.length === 0) return payload;
  if (trimmed[0] === "{") return ensureJSON(trimmed) ?? payload;
  if (!payload.includes("data:")) return payload;
  const lines = payload.split("\n");
  let modified = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("data:")) continue;
    let prefixLen = 0;
    if (line.startsWith("data: ")) prefixLen = 6;
    else if (line.startsWith("data:")) prefixLen = 5;
    else continue;
    const data = line.slice(prefixLen).trim();
    if (data.length === 0 || data[0] !== "{") continue;
    const updated = ensureJSON(data);
    if (updated !== undefined) {
      lines[i] = line.slice(0, prefixLen) + updated;
      modified = true;
    }
  }
  return modified ? lines.join("\n") : payload;
}

/** The retained apply_patch translation failure of a translator state (Go: ApplyPatchTranslationError). */
export function applyPatchTranslationError(state: TranslatorState): Error | undefined {
  const value = state.value as { toolInputError?: () => Error | undefined } | undefined;
  return value && typeof value.toolInputError === "function" ? value.toolInputError() : undefined;
}

/** Notifies the translator state of the transport ending; returns the frames it emits (Go: FinalizeApplyPatchStream). */
export function finalizeApplyPatchStream(state: TranslatorState): string[] {
  const value = state.value as { finalizeToolInput?: () => string[] } | undefined;
  return value && typeof value.finalizeToolInput === "function" ? value.finalizeToolInput() : [];
}

/** Whether EOF may synthesize the missing source terminator (Go: CanFinalizeResponseStream). */
export function canFinalizeResponseStream(state: TranslatorState): boolean {
  const value = state.value as { canFinalizeResponseStream?: () => boolean } | undefined;
  return !!value && typeof value.canFinalizeResponseStream === "function" && value.canFinalizeResponseStream();
}

/** Whether the original Responses request declares a winning custom apply_patch tool (Go: ApplyPatchRequested). */
export function applyPatchRequested(original: string): boolean {
  const root = tryParse<unknown>(original);
  if (root === undefined) return false;
  for (const descriptor of collectResponsesToolWinners(root).values()) {
    if (isApplyPatchCustomTool(descriptor.tool)) return true;
  }
  return false;
}

/**
 * Prepares the translator state before the first chunk so an empty EOF can
 * still be finalized (Go: InitializeApplyPatchStream).
 */
export function initializeApplyPatchStream(ctx: TranslateContext, from: Format, to: Format, model: string, original: string, effective: string, state: TranslatorState): void {
  if (to !== FormatOpenAIResponse || !applyPatchRequested(original)) return;
  defaultRegistry.translateStream(ctx, from, to, model, original, effective, "", state);
}

/** The source declarations, also when callers omit originalRequest (Go: ApplyPatchOriginalRequest). */
export function applyPatchOriginalRequest(req: ExecRequest, opts: ExecOptions): string {
  return opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
}
