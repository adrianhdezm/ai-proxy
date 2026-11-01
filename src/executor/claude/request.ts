// Request body preparation helpers for the Claude upstream. Port of
// SetStringIfDifferent / SetBoolIfDifferent (helps/payload_mutations.go),
// NormalizeClaudeToolChoice (helps/claude_tool_choice.go),
// disableThinkingIfToolChoiceForced / normalizeClaudeSamplingForUpstream
// (claude_executor_request.go), ensureModelMaxTokens (claude_executor_cloaking.go),
// sanitizeClaudeWebSearchDomains / sanitizeClaudeMessagesForClaudeUpstreamWithDebug
// (claude_executor.go), NormalizeClaudeToolCallIDs (helps/tool_call_ids.go) and
// ApplyRequestThinking (helps/model_capabilities.go + helps/thinking.go).
import { log } from "../../log.ts";
import { getGlobalRegistry } from "../../registry/model_registry.ts";
import { SignatureProviderClaude, signatureProviderFromModelName } from "../../signature/provider_compatibility.ts";
import { restoreCodexCommentaryMarkers, sanitizeClaudeMessagesForClaudeUpstream } from "../../signature/claude_messages_sanitize.ts";
import {
  SummaryUnspecified,
  type SummaryConfig,
  applySummaryConfigForModel,
  applyThinkingWithFallbackModelInfoAndSummary,
  emptySummaryConfig,
  extractExplicitSummaryConfig,
  extractSummaryConfig,
  extractTranslatedSummaryConfig,
  parseSuffix,
} from "../../thinking/index.ts";
import { hasRequestTransformer } from "../../translator/registry.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import type { ExecOptions, ExecRequest } from "../types.ts";
import { claude55ModelPattern } from "./model.ts";

/** Anthropic-compatible upstreams may reject Claude requests without max_tokens. */
export const defaultModelMaxTokens = 1024;

/** Updates path only when its value is not already that string (Go: SetStringIfDifferent). */
export function setStringIfDifferent(payload: string, path: string, value: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root)) return payload;
  if (root[path] === value) return payload;
  root[path] = value;
  return JSON.stringify(root);
}

/** Updates path only when its value is not already that boolean (Go: SetBoolIfDifferent). */
export function setBoolIfDifferent(payload: string, path: string, value: boolean): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root)) return payload;
  if (root[path] === value) return payload;
  root[path] = value;
  return JSON.stringify(root);
}

/** Downgrades forced tool use on Claude 5.5 to auto (Go: NormalizeClaudeToolChoice). */
export function normalizeClaudeToolChoice(provider: string, model: string, payload: string): string {
  if (provider !== "claude") return payload;
  const m = parseSuffix(model.trim()).modelName.toLowerCase();
  if (!claude55ModelPattern.test(m)) return payload;
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || !isObj(root.tool_choice)) return payload;
  const type = gstr(root.tool_choice.type);
  if (type !== "any" && type !== "tool") return payload;
  root.tool_choice.type = "auto";
  delete root.tool_choice.name;
  return JSON.stringify(root);
}

export function claudeToolChoiceForcesToolUse(payload: string | unknown): boolean {
  const root = typeof payload === "string" ? tryParse(payload) : payload;
  const type = gstr(getAt(root, "tool_choice.type"));
  return type === "any" || type === "tool";
}

/** Anthropic does not allow thinking when tool_choice forces tool use (Go: disableThinkingIfToolChoiceForced). */
export function disableThinkingIfToolChoiceForced(payload: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || !claudeToolChoiceForcesToolUse(root)) return payload;
  delete root.thinking;
  if (isObj(root.output_config)) {
    delete root.output_config.effort;
    if (Object.keys(root.output_config).length === 0) delete root.output_config;
  }
  return JSON.stringify(root);
}

/**
 * Keeps Anthropic message requests valid (Go: normalizeClaudeSamplingForUpstream).
 * Translated and cloaked callers lose temperature/top_p (and top_k with thinking);
 * a confirmed native caller keeps its wire and loses only what Anthropic rejects.
 */
export function normalizeClaudeSamplingForUpstream(payload: string, nativeOwned: boolean): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root)) return payload;
  const thinkingType = gstr(getAt(root, "thinking.type")).trim().toLowerCase();
  const thinkingActive = thinkingType === "enabled" || thinkingType === "adaptive" || thinkingType === "auto";
  if (!nativeOwned) {
    delete root.temperature;
    delete root.top_p;
    if (thinkingActive) delete root.top_k;
    return JSON.stringify(root);
  }
  if (thinkingActive) {
    if (root.temperature !== undefined && root.temperature !== 1) delete root.temperature;
    if (root.top_p !== undefined && (typeof root.top_p !== "number" || root.top_p < 0.95)) delete root.top_p;
    delete root.top_k;
    return JSON.stringify(root);
  }
  if (root.temperature !== undefined && root.top_p !== undefined) delete root.top_p;
  return JSON.stringify(root);
}

/** Fills max_tokens for registered Claude models from their definition (Go: ensureModelMaxTokens). */
export function ensureModelMaxTokens(payload: string, modelID: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || root.max_tokens !== undefined) return payload;
  const id = modelID.trim();
  const registry = getGlobalRegistry();
  for (const provider of registry.getModelProviders(id)) {
    if (provider.toLowerCase() !== "claude") continue;
    const info = registry.getModelInfo(id, "claude");
    root.max_tokens = info && (info.maxCompletionTokens ?? 0) > 0 ? info.maxCompletionTokens : defaultModelMaxTokens;
    return JSON.stringify(root);
  }
  return payload;
}

/** Removes empty allowed_domains/blocked_domains from built-in web_search tools (Go: sanitizeClaudeWebSearchDomains). */
export function sanitizeClaudeWebSearchDomains(payload: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || !Array.isArray(root.tools)) return payload;
  let changed = false;
  for (const tool of root.tools) {
    if (!isObj(tool) || !gstr(tool.type).startsWith("web_search_")) continue;
    for (const field of ["allowed_domains", "blocked_domains"]) {
      if (Array.isArray(tool[field]) && (tool[field] as unknown[]).length === 0) {
        delete tool[field];
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(root) : payload;
}

const portableToolCallID = /^[A-Za-z0-9_-]+$/;

/**
 * Repairs tool_use.id / tool_result.tool_use_id values Anthropic rejects
 * (Go: NormalizeClaudeToolCallIDs). Legal IDs are never rewritten; illegal ones
 * get a deterministic replacement, with an underscore prefix on collision.
 */
export function normalizeClaudeToolCallIDs(payload: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || !Array.isArray(root.messages)) return payload;
  const used = new Set<string>();
  const fields: Array<{ block: Record<string, unknown>; field: string; id: string }> = [];
  for (const message of root.messages) {
    const content = getAt(message, "content");
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObj(block)) continue;
      const field = block.type === "tool_use" ? "id" : block.type === "tool_result" ? "tool_use_id" : "";
      if (field === "") continue;
      const value = block[field];
      if (typeof value !== "string" || value === "") continue;
      if (portableToolCallID.test(value)) used.add(value);
      else fields.push({ block, field, id: value });
    }
  }
  if (fields.length === 0) return payload;
  const mapped = new Map<string, string>();
  for (const f of fields) {
    let id = mapped.get(f.id);
    if (!id) {
      id = "cpa_tid_v1_" + Buffer.from(f.id, "utf8").toString("base64url");
      while (used.has(id)) id = "_" + id;
      mapped.set(f.id, id);
      used.add(id);
    }
    f.block[f.field] = id;
  }
  return JSON.stringify(root);
}

export function shouldSanitizeClaudeMessagesForUpstream(baseModel: string): boolean {
  return signatureProviderFromModelName(baseModel) === SignatureProviderClaude;
}

/**
 * Prepares the Messages history for the Claude upstream: restores the internal
 * commentary marker, sanitises signed thinking history for Claude-family models,
 * drops empty web-search domain lists and repairs tool call ids
 * (Go: sanitizeClaudeMessagesForClaudeUpstreamWithDebug).
 */
export function sanitizeClaudeMessagesForClaudeUpstreamWithDebug(body: string, baseModel: string, preserveEmptyThinkingBlocks = false): string {
  let sanitized = restoreCodexCommentaryMarkers(body).payload;
  if (shouldSanitizeClaudeMessagesForUpstream(baseModel) || preserveEmptyThinkingBlocks) {
    const result = sanitizeClaudeMessagesForClaudeUpstream(body, baseModel, preserveEmptyThinkingBlocks);
    sanitized = result.payload;
    const report = result.report;
    if (report.droppedBlocks > 0 || report.droppedSignatures > 0 || report.replacedSignatures > 0) {
      log.debug("claude executor: sanitized signature history before upstream", {
        target_model: baseModel,
        preserved: report.preserved,
        dropped_blocks: report.droppedBlocks,
        dropped_signatures: report.droppedSignatures,
        replaced_signatures: report.replacedSignatures,
      });
    }
  }
  return normalizeClaudeToolCallIDs(sanitizeClaudeWebSearchDomains(sanitized));
}

/**
 * Summary visibility for a translated body: the translated target wins, the
 * sources are consulted only when the body no longer carries the intent
 * (Go: translatedRequestSummaryConfig).
 */
export function translatedRequestSummaryConfig(body: string, currentSourcePayload: string, originalSourcePayload: string, model: string, fromFormat: string, toFormat: string): SummaryConfig {
  const from = fromFormat.trim().toLowerCase();
  const to = toFormat.trim().toLowerCase();
  const targetSummary = from === to ? extractSummaryConfig(body, to) : extractExplicitSummaryConfig(body, to);
  if (targetSummary.mode !== SummaryUnspecified) return targetSummary;
  const currentSummary = extractTranslatedSummaryConfig(currentSourcePayload, from, to);
  const originalSummary = extractTranslatedSummaryConfig(originalSourcePayload, from, to);
  if (currentSummary.mode === SummaryUnspecified) return originalSummary;
  if (!hasRequestTransformer(from, to)) return emptySummaryConfig();
  const candidate = applySummaryConfigForModel(body, to, model, currentSummary);
  if (extractExplicitSummaryConfig(candidate, to).mode !== SummaryUnspecified) return emptySummaryConfig();
  return currentSummary;
}

/** Applies the thinking configuration to the translated body (Go: ApplyRequestThinking). Throws ThinkingError (400). */
export function applyRequestThinking(body: string, req: ExecRequest, opts: ExecOptions, fromFormat: string, toFormat: string, provider: string): string {
  const originalSource = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
  const source = req.payload.length > 0 ? req.payload : (opts.originalRequest ?? "");
  const summary = translatedRequestSummaryConfig(body, req.payload, originalSource, req.model, fromFormat, toFormat);
  return applyThinkingWithFallbackModelInfoAndSummary(body, source, req.model, fromFormat, toFormat, provider, undefined, summary);
}
