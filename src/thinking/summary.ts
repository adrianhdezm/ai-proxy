// Port of internal/thinking/summary.go: provider-neutral reasoning-summary visibility intent
// (kept formats: openai, openai-response/codex, claude, gemini).
import type { ModelInfo } from "../registry/types.ts";
import { lookupModelInfo } from "../registry/model_registry.ts";
import { Doc, gjsonInt, gjsonString, isEmptyObject, validJSON } from "./json.ts";
import { parseSuffix } from "./suffix.ts";

/** Whether the client explicitly requested reasoning summaries (Go: SummaryMode). */
export type SummaryMode = "unspecified" | "disabled" | "enabled";

export const SummaryUnspecified: SummaryMode = "unspecified";
export const SummaryDisabled: SummaryMode = "disabled";
export const SummaryEnabled: SummaryMode = "enabled";

/** Summary visibility intent; detail preserves auto/concise/detailed for protocols that distinguish them. */
export interface SummaryConfig {
  mode: SummaryMode;
  detail?: string;
}

export function emptySummaryConfig(): SummaryConfig {
  return { mode: SummaryUnspecified };
}

const enabledAuto = (): SummaryConfig => ({ mode: SummaryEnabled, detail: "auto" });
const disabled = (): SummaryConfig => ({ mode: SummaryDisabled });

/**
 * Reads protocol-specific summary visibility intent (Go: ExtractSummaryConfig).
 *
 * OpenAI Chat is the one protocol where effort implies summaries: it has no summary field and
 * clients sending reasoning_effort have always received summaries here. Every other protocol
 * carries a dedicated summary field, so effort alone means nothing.
 */
export function extractSummaryConfig(body: string, format: string): SummaryConfig {
  const normalized = format.trim().toLowerCase();
  if (!summaryFormatSupported(normalized) || !validJSON(body)) return emptySummaryConfig();
  const doc = new Doc(body);
  if (!doc.valid) return emptySummaryConfig();

  switch (normalized) {
    case "openai": {
      const explicit = extractOpenAIExplicitSummaryConfig(doc);
      if (explicit) return explicit;
      const effort = doc.get("reasoning_effort");
      if (typeof effort === "string") {
        const value = effort.trim().toLowerCase();
        if (value === "") return emptySummaryConfig();
        if (value === "none") return disabled();
        return enabledAuto();
      }
      break;
    }
    case "openai-response":
    case "codex": {
      return responsesSummaryConfig(doc, "reasoning.summary") ?? responsesSummaryConfig(doc, "reasoning.generate_summary") ?? emptySummaryConfig();
    }
    case "claude": {
      // Anthropic only accepts display alongside active adaptive/manual thinking.
      if (!claudeThinkingAcceptsDisplay(doc)) return emptySummaryConfig();
      return claudeSummaryConfig(doc, "thinking.display") ?? emptySummaryConfig();
    }
    case "gemini": {
      return (
        firstSummaryBoolConfig(doc, [
          "generationConfig.thinkingConfig.includeThoughts",
          "generationConfig.thinkingConfig.include_thoughts",
          "generation_config.thinking_config.include_thoughts",
          "generation_config.thinking_config.includeThoughts",
        ]) ?? emptySummaryConfig()
      );
    }
  }
  return emptySummaryConfig();
}

/**
 * Reads only explicit visibility controls; OpenAI Chat reasoning_effort is not treated as a
 * summary proxy (Go: ExtractExplicitSummaryConfig).
 */
export function extractExplicitSummaryConfig(body: string, format: string): SummaryConfig {
  const normalized = format.trim().toLowerCase();
  if (normalized !== "openai") return extractSummaryConfig(body, normalized);
  if (!validJSON(body)) return emptySummaryConfig();
  const doc = new Doc(body);
  if (!doc.valid) return emptySummaryConfig();
  return extractOpenAIExplicitSummaryConfig(doc) ?? emptySummaryConfig();
}

/**
 * Reads source visibility intent for a source/target pair. OpenAI Chat reasoning_effort
 * controls depth, not Claude display visibility, so it is ignored only for Chat-to-Claude.
 */
export function extractTranslatedSummaryConfig(body: string, sourceFormat: string, targetFormat: string): SummaryConfig {
  const source = sourceFormat.trim().toLowerCase();
  const target = targetFormat.trim().toLowerCase();
  if (target === "claude" && source === "openai") return extractExplicitSummaryConfig(body, source);
  return extractSummaryConfig(body, source);
}

/** Copies an explicit source visibility choice onto a Claude body (Go: ApplyTranslatedSummaryToClaude). */
export function applyTranslatedSummaryToClaude(out: string, source: string, sourceFormat: string, model: string): string {
  const config = extractTranslatedSummaryConfig(source, sourceFormat, "claude");
  if (config.mode === SummaryUnspecified) return out;
  return applySummaryConfigForModel(out, "claude", model, config);
}

/** Writes canonical summary intent in the target protocol (Go: ApplySummaryConfig). */
export function applySummaryConfig(body: string, format: string, config: SummaryConfig): string {
  return applySummaryConfigForModel(body, format, "", config);
}

/**
 * Writes summary intent using target model capabilities when a valid target request must
 * activate thinking before it can request summaries (Go: ApplySummaryConfigForModel).
 */
export function applySummaryConfigForModel(body: string, format: string, model: string, config: SummaryConfig): string {
  return applySummaryConfigForProvider(body, format, model, "", undefined, config);
}

/**
 * Writes summary intent with the resolved model definition and execution provider identity
 * (Go: applySummaryConfigForProvider).
 */
export function applySummaryConfigForProvider(body: string, format: string, model: string, provider: string, modelInfo: ModelInfo | undefined, config: SummaryConfig): string {
  const normalized = format.trim().toLowerCase();
  if (config.mode === SummaryUnspecified || !summaryFormatSupported(normalized) || !validJSON(body)) return body;
  const doc = new Doc(body);
  if (!doc.valid) return body;

  const enabled = config.mode === SummaryEnabled;
  switch (normalized) {
    case "openai":
      applyOpenAIChatSummaryConfig(doc, provider, enabled);
      break;
    case "claude": {
      // Anthropic rejects display with thinking.type=disabled and requires it alongside adaptive
      // or enabled thinking. Model defaults differ (newer models think by default, older ones do
      // not), so a missing thinking block is kept absent to preserve the model default. Only an
      // enabled summary may activate a valid target thinking mode so summarized text can be
      // returned; a disabled summary only adds omitted to an already-active target mode.
      if (enabled && !doc.exists("thinking.type")) enableClaudeThinkingForSummary(doc, model, modelInfo);
      if (!claudeThinkingAcceptsDisplay(doc)) return doc.toString();
      doc.set("thinking.display", enabled ? "summarized" : "omitted");
      break;
    }
    case "gemini":
      doc.set("generationConfig.thinkingConfig.includeThoughts", enabled);
      for (const path of ["generationConfig.thinkingConfig.include_thoughts", "generation_config.thinking_config.include_thoughts", "generation_config.thinking_config.includeThoughts"]) {
        doc.del(path);
      }
      break;
    case "openai-response":
    case "codex":
      if (enabled) {
        doc.set("reasoning.summary", normalizedSummaryDetail(config.detail ?? ""));
        doc.del("reasoning.generate_summary");
        break;
      }
      // Omitting the field is the documented way to disable summaries; an explicit null is not
      // accepted by every Responses-compatible backend.
      doc.del("reasoning.summary");
      doc.del("reasoning.generate_summary");
      if (isEmptyObject(doc.get("reasoning"))) doc.del("reasoning");
      break;
  }
  return doc.toString();
}

/** Whether a protocol carries summary visibility intent this package can read or write. */
export function summaryFormatSupported(format: string): boolean {
  switch (format) {
    case "openai":
    case "openai-response":
    case "codex":
    case "claude":
    case "gemini":
      return true;
    default:
      return false;
  }
}

/** Whether the body carries an active thinking block that can hold a display field. */
export function claudeThinkingAcceptsDisplay(body: string | Doc): boolean {
  const doc = typeof body === "string" ? new Doc(body) : body;
  switch (gjsonString(doc.get("thinking.type")).trim().toLowerCase()) {
    case "adaptive":
      return true;
    case "enabled": {
      // This runs before applyThinking normalises the request, so a missing budget_tokens is an
      // unfinished body rather than inactive thinking. -1 is the compatibility value for auto.
      const budget = doc.get("thinking.budget_tokens");
      if (typeof budget !== "number") return true;
      return budget === -1 || budget > 0;
    }
    default:
      return false;
  }
}

/**
 * OpenAI Chat Completions exposes reasoning_effort but no summary/visibility parameter, so
 * summary intent must never invent or overwrite effort. OpenAI-compatible dialects that carry
 * `reasoning.exclude` or the legacy `include_reasoning` boolean get those updated in place.
 */
function applyOpenAIChatSummaryConfig(doc: Doc, _provider: string, enabled: boolean): void {
  if (typeof doc.get("reasoning.exclude") === "boolean") doc.set("reasoning.exclude", !enabled);
  if (typeof doc.get("include_reasoning") === "boolean") doc.set("include_reasoning", enabled);
}

function extractOpenAIExplicitSummaryConfig(doc: Doc): SummaryConfig | undefined {
  // Google's documented Chat Completions extension is the authoritative explicit visibility
  // control when present, ahead of compatibility aliases and the reasoning_effort fallback.
  const boolPaths = [
    "extra_body.google.thinking_config.include_thoughts",
    "extra_body.google.thinking_config.includeThoughts",
    "extra_body.google.thinkingConfig.include_thoughts",
    "extra_body.google.thinkingConfig.includeThoughts",
    "extra_body.extra_body.google.thinking_config.include_thoughts",
    "extra_body.extra_body.google.thinking_config.includeThoughts",
    "google.thinking_config.include_thoughts",
    "google.thinking_config.includeThoughts",
    "thinking.includeThoughts",
    "thinking.include_thoughts",
    "reasoning.includeThoughts",
    "reasoning.include_thoughts",
    "generationConfig.thinkingConfig.includeThoughts",
    "generationConfig.thinkingConfig.include_thoughts",
    "generation_config.thinking_config.include_thoughts",
    "generation_config.thinking_config.includeThoughts",
  ];
  const fromBool = firstSummaryBoolConfig(doc, boolPaths);
  if (fromBool) return fromBool;
  for (const path of ["reasoning.summary", "reasoning.generate_summary"]) {
    const config = responsesSummaryConfig(doc, path);
    if (config) return config;
  }
  // reasoning.exclude is the "reason but hide" bit of some Chat dialects; include_reasoning is
  // its legacy inverse alias. Only actual JSON booleans are accepted.
  const exclude = doc.get("reasoning.exclude");
  if (typeof exclude === "boolean") return exclude ? disabled() : enabledAuto();
  const include = doc.get("include_reasoning");
  if (typeof include === "boolean") return include ? enabledAuto() : disabled();
  // reasoning.enabled turns reasoning on "with no exclusions", so it also decides visibility.
  const reasoningEnabled = doc.get("reasoning.enabled");
  if (typeof reasoningEnabled === "boolean") return reasoningEnabled ? enabledAuto() : disabled();
  return undefined;
}

function firstSummaryBoolConfig(doc: Doc, paths: string[]): SummaryConfig | undefined {
  for (const path of paths) {
    const value = doc.get(path);
    if (value === true) return enabledAuto();
    if (value === false) return disabled();
  }
  return undefined;
}

function responsesSummaryConfig(doc: Doc, path: string): SummaryConfig | undefined {
  const value = doc.get(path);
  if (value === undefined) return undefined;
  if (value === null) return disabled();
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toLowerCase();
  switch (raw) {
    case "auto":
    case "concise":
    case "detailed":
      return { mode: SummaryEnabled, detail: raw };
    case "none":
      // Compatibility with clients that expose a none enum; the wire representation omits the field.
      return disabled();
    default:
      return undefined;
  }
}

function claudeSummaryConfig(doc: Doc, path: string): SummaryConfig | undefined {
  const value = doc.get(path);
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "summarized":
      return enabledAuto();
    case "omitted":
      return disabled();
    default:
      return undefined;
  }
}

/**
 * Removes a globally inferred adaptive mode when the selected API-key model supports only
 * manual extended thinking (Go: stripInferredClaudeSummaryActivation).
 */
export function stripInferredClaudeSummaryActivation(body: string, modelInfo: ModelInfo | undefined): string {
  const support = modelInfo?.thinking;
  if (!support || (support.levels?.length ?? 0) > 0 || (support.min ?? 0) <= 0) return body;
  const doc = new Doc(body);
  if (gjsonString(doc.get("thinking.type")).trim().toLowerCase() !== "adaptive") return body;
  for (const path of ["thinking.type", "thinking.budget_tokens", "thinking.display", "output_config.effort"]) doc.del(path);
  for (const path of ["thinking", "output_config"]) doc.deleteIfEmptyObject(path);
  return doc.toString();
}

function enableClaudeThinkingForSummary(doc: Doc, model: string, resolvedModelInfo: ModelInfo | undefined): void {
  let modelInfo = resolvedModelInfo;
  if (!modelInfo) {
    let baseModel = parseSuffix(model).modelName;
    if (baseModel === "") baseModel = parseSuffix(gjsonString(doc.get("model"))).modelName;
    modelInfo = lookupModelInfo(baseModel, "claude");
  }
  const support = modelInfo?.thinking;
  if (!support) return;
  if ((support.levels?.length ?? 0) > 0) {
    doc.set("thinking.type", "adaptive");
    doc.del("thinking.budget_tokens");
    return;
  }
  const budget = support.min ?? 0;
  if (budget <= 0) return;
  const maxTokens = doc.get("max_tokens");
  if (maxTokens !== undefined && gjsonInt(maxTokens) <= budget) return;
  doc.set("thinking.type", "enabled");
  doc.set("thinking.budget_tokens", budget);
}

function normalizedSummaryDetail(detail: string): string {
  switch (detail.trim().toLowerCase()) {
    case "concise":
      return "concise";
    case "detailed":
      return "detailed";
    default:
      return "auto";
  }
}
