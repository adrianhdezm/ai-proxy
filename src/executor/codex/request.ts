// Request/response payload rules of the Codex executor. Port of
// translateCodexRequestPair(WithUpdateIntent), normalizeCodexInstructions,
// ensureWebSearchToolForHistory, ensureImageGenerationTool,
// normalizeCodexParallelToolCalls (codex_executor_request.go),
// collectCodexOutputItemDone / patchCodexCompletedOutput /
// hydrateCodexCompletedOutputItemIDs (codex_executor_terminal.go),
// SetStringIfDifferent / SetBoolIfDifferent (helps/payload_mutations.go) and
// ParseCodexUsage (helps/usage_helpers.go).
import { FormatClaude, FormatCodex } from "../../translator/types.ts";
import { defaultRegistry } from "../../translator/registry.ts";
import { convertClaudeRequestToCodexWithCompat } from "../../translator/codex/claude/index.ts";
import { getAt, gstr, isArr, isObj } from "../../util/gpath.ts";
import { type JSONObject, tryParse } from "../../util/json.ts";
import { isCodexFreePlanAuth, isCodexResponsesLiteRequest } from "./creds.ts";
import type { Auth } from "../../auth/types.ts";

export const dataTag = "data:";

/** Parses a JSON object body; a non-object body yields an empty object. */
export function parseBodyObject(body: string): JSONObject {
  const parsed = tryParse(body);
  return isObj(parsed) ? parsed : {};
}

/** Updates path only when the value differs from the canonical JSON string (Go: SetStringIfDifferent). */
export function setStringIfDifferent(payload: string, path: string, value: string): string {
  const root = tryParse(payload);
  if (!isObj(root)) return payload;
  if (root[path] === value) return payload;
  root[path] = value;
  return JSON.stringify(root);
}

/** Updates path only when the value differs from the canonical JSON boolean (Go: SetBoolIfDifferent). */
export function setBoolIfDifferent(payload: string, path: string, value: boolean): string {
  const root = tryParse(payload);
  if (!isObj(root)) return payload;
  if (root[path] === value) return payload;
  root[path] = value;
  return JSON.stringify(root);
}

/** Deletes top-level fields (Go: sjson.DeleteBytes). */
export function deleteFields(payload: string, ...fields: string[]): string {
  const root = tryParse(payload);
  if (!isObj(root)) return payload;
  let changed = false;
  for (const field of fields) {
    if (field in root) {
      delete root[field];
      changed = true;
    }
  }
  return changed ? JSON.stringify(root) : payload;
}

export interface TranslatedRequestPair {
  originalTranslated: string;
  body: string;
  /** The translator did not report configuration_update changes (not exposed by the TS registry). */
  updatesChanged: boolean;
}

/**
 * Translates the original and current payloads once each, sharing the result
 * when both are identical (Go: translateCodexRequestPairWithUpdateIntent). The
 * compat variant of the Claude->Codex translator is used when `isCompat` is set.
 */
export function translateCodexRequestPair(from: string, to: string, model: string, originalPayload: string, payload: string, stream: boolean, isCompat = false): TranslatedRequestPair {
  const translate = (raw: string): string => {
    if (isCompat && from === FormatClaude && to === FormatCodex) return convertClaudeRequestToCodexWithCompat(model, raw, stream);
    return defaultRegistry.translateRequest(from, to, model, raw, stream);
  };
  if (originalPayload === payload) {
    const body = translate(payload);
    return { originalTranslated: body, body, updatesChanged: false };
  }
  let originalTranslated = originalPayload;
  try {
    originalTranslated = translate(originalPayload);
  } catch {
    // The original payload is only used for summary intent and translation
    // context; a rejected original falls back to the raw bytes like Go ignores its error.
  }
  const body = translate(payload);
  return { originalTranslated, body, updatesChanged: false };
}

/** Absent/null instructions become "" for non-native requests (Go: normalizeCodexInstructions). */
export function normalizeCodexInstructions(body: string, nativeRequest = false): string {
  if (nativeRequest) return body;
  const root = tryParse(body);
  if (!isObj(root)) return body;
  if (root.instructions === undefined || root.instructions === null) {
    root.instructions = "";
    return JSON.stringify(root);
  }
  return body;
}

export function isCodexWebSearchToolType(toolType: string): boolean {
  switch (toolType.trim()) {
    case "web_search":
    case "web_search_preview":
    case "web_search_preview_2025_03_11":
      return true;
    default:
      return false;
  }
}

/**
 * Reconciles replayed web_search_call input items with the tool declarations
 * so upstream does not fail with "response protection is unavailable". Standard
 * requests get a web_search tool; Responses Lite requests drop the replayed items
 * (Go: ensureWebSearchToolForHistory).
 */
export function ensureWebSearchToolForHistory(body: string, headers: Headers | undefined): string {
  if (!body.includes("web_search_call")) return body;
  const root = tryParse(body);
  if (!isObj(root) || !isArr(root.input)) return body;
  const input = root.input;
  if (!input.some((item) => gstr(getAt(item, "type")).trim() === "web_search_call")) return body;
  const tools = root.tools;
  if (isArr(tools) && tools.some((t) => isCodexWebSearchToolType(gstr(getAt(t, "type"))))) return body;
  if (isCodexResponsesLiteRequest(root, headers)) {
    root.input = input.filter((item) => gstr(getAt(item, "type")).trim() !== "web_search_call");
    return JSON.stringify(root);
  }
  if (!isArr(tools)) root.tools = [{ type: "web_search" }];
  else tools.push({ type: "web_search" });
  return JSON.stringify(root);
}

function isImageGenerationFunctionTool(tool: unknown): boolean {
  switch (gstr(getAt(tool, "type"))) {
    case "function":
      return gstr(getAt(tool, "name")) === "image_gen.imagegen";
    case "namespace": {
      if (gstr(getAt(tool, "name")) !== "image_gen") return false;
      const tools = getAt(tool, "tools");
      if (!isArr(tools)) return false;
      return tools.some((nested) => gstr(getAt(nested, "type")) === "function" && gstr(getAt(nested, "name")) === "imagegen");
    }
    default:
      return false;
  }
}

/**
 * Declares the hosted image_generation tool unless the request is Responses
 * Lite, targets a *spark model, comes from a free plan, or already declares one
 * (Go: ensureImageGenerationTool).
 */
export function ensureImageGenerationTool(body: string, baseModel: string, auth: Auth | undefined, headers: Headers | undefined): string {
  const root = tryParse(body);
  if (!isObj(root)) return body;
  if (isCodexResponsesLiteRequest(root, headers)) return body;
  if (baseModel.endsWith("spark")) return body;
  if (isCodexFreePlanAuth(auth)) return body;
  const imageTool = { type: "image_generation", output_format: "png" };
  const tools = root.tools;
  if (!isArr(tools)) {
    root.tools = [imageTool];
    return JSON.stringify(root);
  }
  if (tools.some((t) => gstr(getAt(t, "type")) === "image_generation" || isImageGenerationFunctionTool(t))) return body;
  tools.push(imageTool);
  return JSON.stringify(root);
}

/** Responses Lite forces parallel_tool_calls=false; otherwise the flag needs tools (Go: normalizeCodexParallelToolCalls). */
export function normalizeCodexParallelToolCalls(body: string, headers: Headers | undefined): string {
  if (isCodexResponsesLiteRequest(body, headers)) return setBoolIfDifferent(body, "parallel_tool_calls", false);
  return normalizeCodexParallelToolCallsForTools(body);
}

/** Drops parallel_tool_calls when the request declares no tools (Go: normalizeCodexParallelToolCallsForTools). */
export function normalizeCodexParallelToolCallsForTools(body: string): string {
  const root = tryParse(body);
  if (!isObj(root) || !("parallel_tool_calls" in root)) return body;
  if (isArr(root.tools) && root.tools.length > 0) return body;
  delete root.parallel_tool_calls;
  return JSON.stringify(root);
}

// ---------------------------------------------------------------------------
// Completed output reconstruction
// ---------------------------------------------------------------------------

/** Output items observed through response.output_item.done, keyed by output_index. */
export interface CollectedOutputItems {
  byIndex: Map<number, unknown>;
  fallback: unknown[];
}

export function newCollectedOutputItems(): CollectedOutputItems {
  return { byIndex: new Map(), fallback: [] };
}

export function collectedOutputItemCount(items: CollectedOutputItems): number {
  return items.byIndex.size + items.fallback.length;
}

/** Records a response.output_item.done item (Go: collectCodexOutputItemDone). */
export function collectCodexOutputItemDone(eventRoot: unknown, items: CollectedOutputItems): void {
  const item = getAt(eventRoot, "item");
  if (!isObj(item) && !isArr(item)) return;
  const outputIndex = getAt(eventRoot, "output_index");
  if (outputIndex !== undefined && outputIndex !== null) {
    const idx = typeof outputIndex === "number" ? Math.trunc(outputIndex) : Number(outputIndex) || 0;
    items.byIndex.set(idx, structuredClone(item));
    return;
  }
  items.fallback.push(structuredClone(item));
}

function hydrateCodexCompletedOutputItemIDs(eventRoot: JSONObject, output: unknown[], items: CollectedOutputItems): JSONObject {
  output.forEach((outputItem, outputIndex) => {
    if (!isObj(outputItem)) return;
    const itemID = outputItem.id;
    if (itemID !== undefined && itemID !== null && (typeof itemID !== "string" || itemID.trim() !== "")) return;
    const completed = items.byIndex.get(outputIndex);
    const completedID = getAt(completed, "id");
    if (typeof completedID !== "string" || completedID.trim() === "") return;
    outputItem.id = completedID;
  });
  return eventRoot;
}

/**
 * Streamed Codex responses may emit response.output_item.done while leaving
 * response.completed.response.output empty: rebuild it from those items, or
 * hydrate missing ids of a non-empty output (Go: patchCodexCompletedOutput).
 * Mutates and returns the parsed event.
 */
export function patchCodexCompletedOutput(eventRoot: JSONObject, items: CollectedOutputItems): JSONObject {
  const response = isObj(eventRoot.response) ? eventRoot.response : undefined;
  const output = response?.output;
  if (isArr(output) && output.length > 0) return hydrateCodexCompletedOutputItemIDs(eventRoot, output, items);
  if (collectedOutputItemCount(items) === 0) return eventRoot;
  const indexes = Array.from(items.byIndex.keys()).sort((a, b) => a - b);
  const rebuilt: unknown[] = indexes.map((idx) => items.byIndex.get(idx));
  rebuilt.push(...items.fallback);
  if (!response) eventRoot.response = { output: rebuilt };
  else response.output = rebuilt;
  return eventRoot;
}

// ---------------------------------------------------------------------------
// Usage (Go: helps.ParseCodexUsage)
// ---------------------------------------------------------------------------

export interface CodexUsageDetail {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  responseServiceTier: string;
}

function numAt(root: unknown, ...paths: string[]): number {
  for (const path of paths) {
    const v = getAt(root, path);
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  }
  return 0;
}

function hasOpenAIStyleUsageTokenFields(usage: unknown): boolean {
  if (!isObj(usage)) return false;
  return [
    "total_tokens",
    "prompt_tokens",
    "input_tokens",
    "completion_tokens",
    "output_tokens",
    "prompt_tokens_details.cached_tokens",
    "input_tokens_details.cached_tokens",
    "completion_tokens_details.reasoning_tokens",
    "output_tokens_details.reasoning_tokens",
    "reasoning_tokens",
  ].some((path) => getAt(usage, path) !== undefined);
}

/** Usage of a response.completed/incomplete event; undefined when it carries none (Go: ParseCodexUsage). */
export function parseCodexUsage(eventRoot: unknown): CodexUsageDetail | undefined {
  const tier = gstr(getAt(eventRoot, "response.service_tier")).trim();
  const usage = getAt(eventRoot, "response.usage");
  if (!hasOpenAIStyleUsageTokenFields(usage)) {
    if (tier === "") return undefined;
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, responseServiceTier: tier };
  }
  const inputTokens = numAt(usage, "prompt_tokens", "input_tokens");
  const outputTokens = numAt(usage, "completion_tokens", "output_tokens");
  let totalTokens = numAt(usage, "total_tokens");
  if (totalTokens === 0) totalTokens = inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: numAt(usage, "prompt_tokens_details.cached_tokens", "input_tokens_details.cached_tokens"),
    reasoningTokens: numAt(usage, "completion_tokens_details.reasoning_tokens", "output_tokens_details.reasoning_tokens", "reasoning_tokens"),
    responseServiceTier: tier,
  };
}
