// Payload helpers for the OpenAI API-key executor. Port of the parts of
// internal/runtime/executor/helps/{payload_mutations.go, openai_compat_max_tokens.go,
// openai_compat_tool_results.go, usage_helpers.go (ParseOpenAIUsage),
// payload_helpers.go (PayloadRequestedModel)} that the chat completions path uses.
//
// Go matched the per-model options against config.OpenAICompatibility.Models.
// This port keeps the same matching rules over the credential's model overrides
// (ModelOverride) extended with the two optional per-model knobs upstream read:
// `useMaxCompletionTokens` and `inputModalities`.
import type { ModelOverride } from "../../config/types.ts";
import { RequestedModelMetadataKey, type ExecOptions } from "../types.ts";
import { parseSuffix } from "../../thinking/index.ts";
import { getAt, gint, isArr, isObj } from "../../util/gpath.ts";
import { tryParse, type JSONObject } from "../../util/json.ts";

export const openAIToolResultImageOmittedText = "[image omitted: unsupported by upstream]";
export const claudeToolResultImageRelayNotice = "Images returned by the preceding tool call(s):";
export const claudeToolResultImagePlaceholder = "[Tool returned image content; the images follow in the next user message.]";

/**
 * Per-model options of an OpenAI-compatible credential (Go: config.OpenAICompatibilityModel).
 * `name` is the upstream model, `alias` the client-facing name.
 */
export interface OpenAICompatModelOption {
  name: string;
  alias?: string;
  /** Send max_completion_tokens instead of max_tokens (Go: use-max-completion-tokens). */
  useMaxCompletionTokens?: boolean;
  /** Accepted input modalities; ["text"] marks a text-only model (Go: input-modalities). */
  inputModalities?: string[];
  /** Compatibility handling for Claude thinking blocks (Go: is-compat). */
  isCompat?: boolean;
}

/** Reads the optional compat knobs off a config ModelOverride (they are additive, loader-agnostic fields). */
export function modelOptionsFromOverrides(overrides: ReadonlyArray<ModelOverride> | undefined): OpenAICompatModelOption[] {
  if (!overrides) return [];
  return overrides.map((override) => {
    const extra = override as ModelOverride & { useMaxCompletionTokens?: unknown; inputModalities?: unknown };
    const option: OpenAICompatModelOption = { name: override.name, alias: override.alias, isCompat: override.isCompat };
    if (typeof extra.useMaxCompletionTokens === "boolean") option.useMaxCompletionTokens = extra.useMaxCompletionTokens;
    if (Array.isArray(extra.inputModalities)) option.inputModalities = extra.inputModalities.filter((m): m is string => typeof m === "string");
    return option;
  });
}

// ---------------------------------------------------------------------------
// payload_mutations.go

/** Updates path only when its value is not already the canonical JSON string (Go: SetStringIfDifferent). */
export function setStringIfDifferent(payload: string, path: string, value: string): string {
  const root = tryParse<unknown>(payload);
  if (!isObj(root)) return payload;
  const current = getAt(root, path);
  if (typeof current === "string" && current === value) return payload;
  setDotted(root, path, value);
  return JSON.stringify(root);
}

/** Updates path only when its value is not already the canonical JSON boolean (Go: SetBoolIfDifferent). */
export function setBoolIfDifferent(payload: string, path: string, value: boolean): string {
  const root = tryParse<unknown>(payload);
  if (!isObj(root)) return payload;
  const current = getAt(root, path);
  if (typeof current === "boolean" && current === value) return payload;
  setDotted(root, path, value);
  return JSON.stringify(root);
}

/** sjson.SetBytes for a dotted object path, creating intermediate objects. */
function setDotted(root: JSONObject, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: JSONObject = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next = cur[key];
    if (!isObj(next)) {
      const created: JSONObject = {};
      cur[key] = created;
      cur = created;
    } else {
      cur = next;
    }
  }
  cur[keys[keys.length - 1]!] = value;
}

/** Go: (*OpenAICompatExecutor).overrideModel. */
export function overrideModel(payload: string, model: string): string {
  if (payload.length === 0 || model === "") return payload;
  return setStringIfDifferent(payload, "model", model);
}

// ---------------------------------------------------------------------------
// openai_compat_max_tokens.go

/**
 * Reports whether the resolved model has use-max-completion-tokens set
 * (Go: ShouldUseMaxCompletionTokensForModel). The upstream model is matched by
 * name first, then the requested model by alias.
 */
export function shouldUseMaxCompletionTokensForModel(models: ReadonlyArray<OpenAICompatModelOption> | undefined, upstreamModel: string, requestedModel: string): boolean {
  if (!models) return false;
  const byUpstream = openAICompatibilityModelUsesMaxCompletionTokens(models, upstreamModel);
  if (byUpstream.matched) return byUpstream.useMCT;
  return openAICompatibilityModelUsesMaxCompletionTokens(models, requestedModel).useMCT;
}

function openAICompatibilityModelUsesMaxCompletionTokens(models: ReadonlyArray<OpenAICompatModelOption>, model: string): { useMCT: boolean; matched: boolean } {
  model = normalizeOpenAICompatibilityModelName(model);
  if (model === "") return { useMCT: false, matched: false };
  for (const m of models) {
    if (equalFold(model, normalizeOpenAICompatibilityModelName(m.name))) return { useMCT: m.useMaxCompletionTokens === true, matched: true };
  }
  for (const m of models) {
    if (equalFold(model, normalizeOpenAICompatibilityModelName(m.alias ?? ""))) return { useMCT: m.useMaxCompletionTokens === true, matched: true };
  }
  return { useMCT: false, matched: false };
}

/**
 * Normalizes max_tokens / max_completion_tokens according to the model's
 * preference (Go: NormalizeOpenAIMaxTokens). A null value is carried over as null.
 */
export function normalizeOpenAIMaxTokens(payload: string, useMaxCompletionTokens: boolean): string {
  if (payload.length === 0) return payload;
  const root = tryParse<unknown>(payload);
  if (!isObj(root)) return payload;
  const hasMaxTokens = "max_tokens" in root;
  const hasMaxCompletionTokens = "max_completion_tokens" in root;
  if (!hasMaxTokens && !hasMaxCompletionTokens) return payload;

  if (useMaxCompletionTokens) {
    if (hasMaxTokens && !hasMaxCompletionTokens) root.max_completion_tokens = root.max_tokens;
    if (hasMaxTokens) delete root.max_tokens;
  } else {
    if (hasMaxCompletionTokens && !hasMaxTokens) root.max_tokens = root.max_completion_tokens;
    if (hasMaxCompletionTokens) delete root.max_completion_tokens;
  }
  return JSON.stringify(root);
}

// ---------------------------------------------------------------------------
// openai_compat_tool_results.go

/**
 * Reports whether the selected model explicitly excludes image input through
 * its input-modalities configuration (Go: ShouldNormalizeOpenAIToolResultsForModel).
 */
export function shouldNormalizeOpenAIToolResultsForModel(models: ReadonlyArray<OpenAICompatModelOption> | undefined, upstreamModel: string, requestedModel: string): boolean {
  if (!models) return false;
  const byUpstream = openAICompatibilityModelExcludesImages(models, upstreamModel);
  if (byUpstream.matched) return byUpstream.normalize;
  return openAICompatibilityModelExcludesImages(models, requestedModel).normalize;
}

function openAICompatibilityModelExcludesImages(models: ReadonlyArray<OpenAICompatModelOption>, model: string): { normalize: boolean; matched: boolean } {
  model = normalizeOpenAICompatibilityModelName(model);
  if (model === "") return { normalize: false, matched: false };
  for (const m of models) {
    if (equalFold(model, normalizeOpenAICompatibilityModelName(m.name))) return { normalize: inputModalitiesExcludeImages(m.inputModalities), matched: true };
  }
  let matched = false;
  let excludesImages = true;
  for (const m of models) {
    if (!equalFold(model, normalizeOpenAICompatibilityModelName(m.alias ?? ""))) continue;
    matched = true;
    if (!inputModalitiesExcludeImages(m.inputModalities)) excludesImages = false;
  }
  return { normalize: excludesImages && matched, matched };
}

function inputModalitiesExcludeImages(modalities: string[] | undefined): boolean {
  if (!modalities || modalities.length === 0) return false;
  let hasText = false;
  for (const raw of modalities) {
    switch (raw.trim().toLowerCase()) {
      case "image":
        return false;
      case "text":
        hasText = true;
        break;
    }
  }
  return hasText;
}

function normalizeOpenAICompatibilityModelName(model: string): string {
  model = model.trim();
  if (model === "") return "";
  return parseSuffix(model).modelName.trim();
}

function equalFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Converts tool message content to strings and strips relayed tool result
 * images for text-only compatibility models (Go: NormalizeOpenAIToolResultsTextOnly).
 * Text parts are preserved and image parts are replaced with a short marker.
 */
export function normalizeOpenAIToolResultsTextOnly(payload: string): string {
  const root = tryParse<unknown>(payload);
  if (!isObj(root)) return payload;
  const messages = root.messages;
  if (!isArr(messages) || messages.length === 0) return payload;

  const newMessages: JSONObject[] = [];
  let replacedPlaceholderInCurrentTurn = false;

  for (const raw of messages) {
    if (!isObj(raw)) {
      newMessages.push(raw as JSONObject);
      continue;
    }
    const msg: JSONObject = { ...raw };
    const role = typeof msg.role === "string" ? msg.role : "";
    switch (role) {
      case "tool": {
        const content = msg.content;
        if (content !== undefined && typeof content !== "string") {
          msg.content = flattenOpenAIToolResultContent(content);
        } else if (typeof content === "string" && content === claudeToolResultImagePlaceholder) {
          msg.content = openAIToolResultImageOmittedText;
          replacedPlaceholderInCurrentTurn = true;
        }
        newMessages.push(msg);
        break;
      }
      case "user": {
        const content = msg.content;
        if (isArr(content)) {
          const remainingParts: unknown[] = [];
          let hasRelayNotice = false;
          let hasImages = false;
          for (const part of content) {
            if (isObj(part)) {
              if (part.type === "text" && part.text === claudeToolResultImageRelayNotice) {
                hasRelayNotice = true;
                continue;
              }
              if (isOpenAIImageToolResultPart(part)) {
                hasImages = true;
                continue;
              }
            }
            remainingParts.push(part);
          }
          if (hasRelayNotice && hasImages) {
            if (!replacedPlaceholderInCurrentTurn) {
              for (let j = newMessages.length - 1; j >= 0; j--) {
                const prev = newMessages[j]!;
                if (prev.role !== "tool") break;
                const prevContent = typeof prev.content === "string" ? prev.content : prev.content === undefined || prev.content === null ? "" : String(prev.content);
                if (!prevContent.includes(openAIToolResultImageOmittedText)) {
                  prev.content = prevContent === "" ? openAIToolResultImageOmittedText : prevContent + "\n\n" + openAIToolResultImageOmittedText;
                }
                break;
              }
            }
            replacedPlaceholderInCurrentTurn = false;
            if (remainingParts.length === 0) {
              // Synthetic relay message contained only relayed images; omit entirely.
              continue;
            }
            msg.content = remainingParts;
          }
        }
        newMessages.push(msg);
        break;
      }
      default:
        replacedPlaceholderInCurrentTurn = false;
        newMessages.push(msg);
    }
  }
  root.messages = newMessages;
  return JSON.stringify(root);
}

function flattenOpenAIToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (isArr(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const text = openAIToolResultPartText(item);
      if (text !== undefined) parts.push(text);
    }
    return parts.join("\n\n");
  }
  if (isObj(content)) {
    if (isOpenAIImageToolResultPart(content)) return openAIToolResultImageOmittedText;
    if (typeof content.text === "string") return content.text;
  }
  return rawJSON(content);
}

function openAIToolResultPartText(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  if (isObj(item)) {
    if (isOpenAIImageToolResultPart(item)) return openAIToolResultImageOmittedText;
    if (typeof item.text === "string") return item.text;
  }
  const raw = rawJSON(item);
  if (raw === "") return undefined;
  return raw;
}

function isOpenAIImageToolResultPart(item: unknown): boolean {
  if (!isObj(item)) return false;
  switch ((typeof item.type === "string" ? item.type : "").trim().toLowerCase()) {
    case "image":
    case "image_url":
    case "input_image":
      return true;
  }
  return item.image_url !== undefined || item.input_image !== undefined;
}

/** gjson Result.Raw of a parsed value (compact JSON), "" for undefined. */
function rawJSON(v: unknown): string {
  if (v === undefined) return "";
  const s = JSON.stringify(v);
  return s === undefined ? "" : s;
}

// ---------------------------------------------------------------------------
// usage_helpers.go (ParseOpenAIUsage)

/** Token usage read from an OpenAI-style response (subset of Go usage.Detail). */
export interface OpenAIUsageDetail {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  responseServiceTier: string;
  /** Whether the response carried a usage object with token fields. */
  present: boolean;
}

/** Parses the `usage` object of a chat completion (Go: ParseOpenAIUsage). */
export function parseOpenAIUsage(data: string): OpenAIUsageDetail {
  const root = tryParse<unknown>(data);
  const responseServiceTier = typeof getAt(root, "service_tier") === "string" ? (getAt(root, "service_tier") as string) : "";
  const usageNode = getAt(root, "usage");
  if (!hasOpenAIStyleUsageTokenFields(usageNode)) return { ...emptyUsageDetail(), responseServiceTier };
  const detail = parseOpenAIStyleUsageNode(usageNode);
  detail.responseServiceTier = responseServiceTier;
  return detail;
}

/** Parses the usage of one streaming line ("data: {...}"), if it carries token fields (Go: ParseOpenAIStreamUsage). */
export function parseOpenAIStreamUsage(line: string): OpenAIUsageDetail | undefined {
  let payload = line.trim();
  if (payload.startsWith("data:")) payload = payload.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return undefined;
  const root = tryParse<unknown>(payload);
  if (root === undefined) return undefined;
  const usageNode = getAt(root, "usage");
  if (!hasOpenAIStyleUsageTokenFields(usageNode)) return undefined;
  return parseOpenAIStyleUsageNode(usageNode);
}

function emptyUsageDetail(): OpenAIUsageDetail {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, responseServiceTier: "", present: false };
}

function hasOpenAIStyleUsageTokenFields(usageNode: unknown): boolean {
  if (!isObj(usageNode)) return false;
  return getAt(usageNode, "total_tokens") !== undefined || hasOpenAIStyleUsageBucketFields(usageNode);
}

function hasOpenAIStyleUsageBucketFields(usageNode: unknown): boolean {
  const paths = [
    "prompt_tokens",
    "input_tokens",
    "completion_tokens",
    "output_tokens",
    "prompt_tokens_details.cached_tokens",
    "input_tokens_details.cached_tokens",
    "prompt_tokens_details.cache_write_tokens",
    "prompt_tokens_details.cache_creation_tokens",
    "input_tokens_details.cache_write_tokens",
    "input_tokens_details.cache_creation_tokens",
    "completion_tokens_details.reasoning_tokens",
    "output_tokens_details.reasoning_tokens",
    "reasoning_tokens",
  ];
  return paths.some((p) => getAt(usageNode, p) !== undefined);
}

function parseOpenAIStyleUsageNode(usageNode: unknown): OpenAIUsageDetail {
  const detail = emptyUsageDetail();
  detail.present = true;
  let inputNode = getAt(usageNode, "prompt_tokens");
  if (inputNode === undefined) inputNode = getAt(usageNode, "input_tokens");
  let outputNode = getAt(usageNode, "completion_tokens");
  if (outputNode === undefined) outputNode = getAt(usageNode, "output_tokens");
  detail.inputTokens = gint(inputNode);
  detail.outputTokens = gint(outputNode);
  detail.totalTokens = gint(getAt(usageNode, "total_tokens"));
  let cached = getAt(usageNode, "prompt_tokens_details.cached_tokens");
  if (cached === undefined) cached = getAt(usageNode, "input_tokens_details.cached_tokens");
  if (cached !== undefined) {
    detail.cachedTokens = gint(cached);
    detail.cacheReadTokens = gint(cached);
  }
  for (const path of ["input_tokens_details.cache_creation_tokens", "input_tokens_details.cache_write_tokens", "prompt_tokens_details.cache_creation_tokens", "prompt_tokens_details.cache_write_tokens"]) {
    const node = getAt(usageNode, path);
    if (node !== undefined) {
      detail.cacheCreationTokens = gint(node);
      break;
    }
  }
  let reasoning = getAt(usageNode, "completion_tokens_details.reasoning_tokens");
  if (reasoning === undefined) reasoning = getAt(usageNode, "output_tokens_details.reasoning_tokens");
  if (reasoning === undefined) reasoning = getAt(usageNode, "reasoning_tokens");
  if (reasoning !== undefined) detail.reasoningTokens = gint(reasoning);
  if (detail.totalTokens === 0) detail.totalTokens = detail.inputTokens + detail.outputTokens;
  return detail;
}

// ---------------------------------------------------------------------------
// payload_helpers.go (PayloadRequestedModel)

/** The client's requested model from the execution metadata, or `fallback` (Go: PayloadRequestedModel). */
export function payloadRequestedModel(opts: ExecOptions, fallback: string): string {
  fallback = fallback.trim();
  const raw = opts.metadata?.[RequestedModelMetadataKey];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? fallback : trimmed;
  }
  return fallback;
}
