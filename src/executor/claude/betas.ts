// Anthropic-Beta assembly. Port of the beta constants, claudeCodeCLIBetas and
// the withClaude*Beta helpers of internal/runtime/executor/claude_executor_request.go.
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import {
  claudeModelHasPerTurnEffort,
  claudeModelHasPerTurnTiming,
  claudeModelUsesProgressDisplay,
  isClaudeHaikuModel,
  isClaudeSonnet5Model,
} from "./model.ts";
import { type Payload, claudePayloadHas1hTTL, claudeUsesLegacySystemReminder, isClaudeProbeOrHelperRequest, isClaudeSubagentRequest, parsePayload } from "./request_shape.ts";

export const claudeTokenCountingBeta = "token-counting-2024-11-01";
export const claudeFastModeBeta = "fast-mode-2026-02-01";
export const claudeOAuthBeta = "oauth-2025-04-20";
export const claudeCodeBeta = "claude-code-20250219";
export const claudeContext1MBeta = "context-1m-2025-08-07";
export const claudeMidConvSystemBeta = "mid-conversation-system-2026-04-07";
export const claudePerTurnControlBeta = "per-turn-control-2026-07-01";
export const claudePerTurnTimingBeta = "timing-2026-09-09";
export const claudeMidConvToolChangesBeta = "mid-conversation-tool-changes-2026-07-01";
export const claudeInlineToolsBeta = "inline-tools-2026-09-15";
export const claudeMidConvSystemClearAtBeta = "mid-conversation-system-clear-at-2026-08-21";
export const claudeDangerousToolUseBeta = "dangerous-tool-use-2026-09-03";
export const claudeAdvisorToolBeta = "advisor-tool-2026-03-01";
export const claudeAdvancedToolUseBeta = "advanced-tool-use-2025-11-20";
export const claudeEffortBeta = "effort-2025-11-24";
export const claudeServerSideFallbackBeta = "server-side-fallback-2026-06-01";
export const claudeFallbackCreditBeta = "fallback-credit-2026-06-01";
export const claudeStructuredOutputsBeta = "structured-outputs-2025-12-15";
export const claudeThinkingDisplayUpdatesBeta = "thinking-display-updates-2026-08-18";
export const claudeThinkingBindingBeta = "thinking-binding-controls-2026-08-01";
export const claudeThinkingResumptionBeta = "thinking-resumption-2026-07-17";
export const claudeExtendedCacheTTLBeta = "extended-cache-ttl-2025-04-11";
export const claudePromptCachingEvictBeta = "prompt-caching-evict-2026-05-12";
export const claudeCacheDiagnosisBeta = "cache-diagnosis-2026-04-07";
export const claudeRedactThinkingBeta = "redact-thinking-2026-02-12";
export const claudeAFKModeBeta = "afk-mode-2026-01-31";

/** Betas Claude Code sends on every /v1/messages request from the cli entrypoint, in wire order. */
export const claudeCodeCLIConstantBetas = [
  "interleaved-thinking-2025-05-14",
  claudeRedactThinkingBeta,
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];

/** Caller-supplied betas real Claude Code emits after effort-2025-11-24, in that relative order. */
export const claudeCodeTrailingBetas = [claudeServerSideFallbackBeta, claudeFallbackCreditBeta, claudeStructuredOutputsBeta];

const claudeManagedBetaSet: ReadonlySet<string> = new Set([
  claudeTokenCountingBeta,
  claudeFastModeBeta,
  claudeOAuthBeta,
  claudeCodeBeta,
  claudeContext1MBeta,
  claudeMidConvSystemBeta,
  claudePerTurnControlBeta,
  claudePerTurnTimingBeta,
  claudeMidConvToolChangesBeta,
  claudeInlineToolsBeta,
  claudeMidConvSystemClearAtBeta,
  claudeDangerousToolUseBeta,
  claudeAdvisorToolBeta,
  claudeAdvancedToolUseBeta,
  claudeEffortBeta,
  claudeServerSideFallbackBeta,
  claudeFallbackCreditBeta,
  claudeStructuredOutputsBeta,
  claudeThinkingDisplayUpdatesBeta,
  claudeThinkingBindingBeta,
  claudeThinkingResumptionBeta,
  claudeExtendedCacheTTLBeta,
  claudePromptCachingEvictBeta,
  claudeCacheDiagnosisBeta,
  claudeRedactThinkingBeta,
  claudeAFKModeBeta,
  ...claudeCodeCLIConstantBetas,
  ...claudeCodeTrailingBetas,
]);

/** Whether the proxy itself assembles or gates this beta (Go: isManagedClaudeBeta). */
export function isManagedClaudeBeta(beta: string): boolean {
  return claudeManagedBetaSet.has(beta.trim());
}

export type RequestedBetas = ReadonlySet<string>;

/** Collects every beta the caller asked for, from the header and from body-lifted betas (Go: claudeRequestedBetas). */
export function claudeRequestedBetas(incomingBetas: string, extraBetas: string[] | undefined): Set<string> {
  const requested = new Set<string>();
  for (const beta of incomingBetas.split(",")) {
    const b = beta.trim();
    if (b !== "") requested.add(b);
  }
  for (const beta of extraBetas ?? []) {
    const b = beta.trim();
    if (b !== "") requested.add(b);
  }
  return requested;
}

function has(requested: RequestedBetas | undefined, beta: string): boolean {
  return !!requested && requested.has(beta);
}

function modelOf(root: unknown): string {
  return gstr(getAt(root, "model"));
}

function messagesOf(root: unknown): unknown[] {
  const messages = getAt(root, "messages");
  return Array.isArray(messages) ? messages : [];
}

function toolsOf(root: unknown): unknown[] | undefined {
  const tools = getAt(root, "tools");
  return Array.isArray(tools) ? tools : undefined;
}

/** Whether the request carries a thinking.display value (Go: claudeThinkingDisplaySet). */
export function claudeThinkingDisplaySet(payload: Payload): boolean {
  const display = getAt(parsePayload(payload), "thinking.display");
  return typeof display === "string" && display.trim() !== "";
}

export function claudeThinkingDisplayUpdates(payload: Payload): boolean {
  const display = getAt(parsePayload(payload), "thinking.display");
  return typeof display === "string" && display.trim().toLowerCase() === "updates";
}

export function claudeIncludePerTurnControl(payload: Payload, requested?: RequestedBetas): boolean {
  if (has(requested, claudePerTurnControlBeta)) return true;
  return claudeModelHasPerTurnEffort(modelOf(parsePayload(payload)));
}

export function claudeIncludePerTurnTiming(payload: Payload, requested?: RequestedBetas): boolean {
  if (has(requested, claudePerTurnTimingBeta)) return true;
  const root = parsePayload(payload);
  if (!claudeModelHasPerTurnTiming(modelOf(root))) return false;
  if (getAt(root, "output_config.timing") !== undefined) return true;
  for (const msg of messagesOf(root)) if (getAt(msg, "output_config.timing") !== undefined) return true;
  return false;
}

export function claudeIncludeInlineTools(payload: Payload, requested?: RequestedBetas): boolean {
  if (has(requested, claudeInlineToolsBeta)) return true;
  for (const msg of messagesOf(parsePayload(payload))) {
    const content = getAt(msg, "content");
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (gstr(getAt(block, "type")).trim().toLowerCase() === "tool_addition" && getAt(block, "tool.definition") !== undefined) return true;
    }
  }
  return false;
}

export function claudeIncludeMidConvClearAt(payload: Payload, requested?: RequestedBetas): boolean {
  const root = parsePayload(payload);
  if (has(requested, claudeMidConvSystemClearAtBeta) || claudeModelUsesProgressDisplay(modelOf(root))) return true;
  for (const msg of messagesOf(root)) if (getAt(msg, "clear_at") !== undefined) return true;
  return false;
}

/** Whether effort-2025-11-24 belongs on the request (Go: claudeRequestSupportsEffort). */
export function claudeRequestSupportsEffort(payload: Payload, requested?: RequestedBetas): boolean {
  const root = parsePayload(payload);
  if (root !== undefined) {
    if (isClaudeProbeOrHelperRequest(root)) return false;
    if (isClaudeHaikuModel(modelOf(root).trim().toLowerCase())) return false;
    if (gstr(getAt(root, "thinking.type")).trim().toLowerCase() === "disabled") return false;
  }
  if (has(requested, claudeEffortBeta)) return true;
  return true;
}

/** Whether the request needs advanced-tool-use-2025-11-20 (Go: claudeBodyUsesAdvancedToolUse). */
export function claudeBodyUsesAdvancedToolUse(payload: Payload): boolean {
  const tools = toolsOf(parsePayload(payload));
  if (!tools) return false;
  for (const tool of tools) {
    const toolType = gstr(getAt(tool, "type")).trim().toLowerCase();
    if (toolType.startsWith("tool_search_tool_")) return true;
    const defer = getAt(tool, "defer_loading");
    if (defer === true || getAt(tool, "input_examples") !== undefined || getAt(tool, "allowed_callers") !== undefined) return true;
  }
  return false;
}

/** Whether the request body declares an advisor server tool (Go: claudeBodyHasAdvisorTool). */
export function claudeBodyHasAdvisorTool(payload: Payload): boolean {
  const tools = toolsOf(parsePayload(payload));
  if (!tools) return false;
  for (const tool of tools) {
    if (gstr(getAt(tool, "type")).trim().toLowerCase().startsWith("advisor_")) return true;
  }
  return false;
}

/** Whether the request selects the fast service tier (Go: claudeRequestUsesFastMode). */
export function claudeRequestUsesFastMode(payload: Payload, requested?: RequestedBetas): boolean {
  if (has(requested, claudeFastModeBeta)) return true;
  const speed = getAt(parsePayload(payload), "speed");
  return typeof speed === "string" && speed.trim().toLowerCase() === "fast";
}

/**
 * Assembles the Anthropic-Beta baseline the way Claude Code 2.1.280 does: the
 * list is per-request, not a fixed string (Go: claudeCodeCLIBetas). `requested`
 * holds the betas the caller asked for, which decide the capability flags.
 */
export function claudeCodeCLIBetas(payload: Payload, requested: RequestedBetas | undefined, oauthToken: boolean): string {
  const root = parsePayload(payload);
  const body = typeof payload === "string" ? payload : JSON.stringify(root ?? {});
  const betas: string[] = [claudeCodeBeta];
  if (oauthToken) betas.push(claudeOAuthBeta);
  if (has(requested, claudeContext1MBeta)) betas.push(claudeContext1MBeta);
  const redactThinking = !claudeThinkingDisplaySet(root);
  for (const beta of claudeCodeCLIConstantBetas) {
    if (beta === claudeRedactThinkingBeta && !redactThinking) continue;
    betas.push(beta);
  }
  const legacy = claudeUsesLegacySystemReminder(root);
  if (!legacy) {
    betas.push(claudeMidConvSystemBeta);
    if (claudeIncludePerTurnControl(root, requested)) betas.push(claudePerTurnControlBeta);
    if (claudeIncludePerTurnTiming(root, requested)) betas.push(claudePerTurnTimingBeta);
    if (!isClaudeSonnet5Model(modelOf(root))) betas.push(claudeMidConvToolChangesBeta);
    if (claudeIncludeInlineTools(root, requested)) betas.push(claudeInlineToolsBeta);
  } else {
    if (claudeIncludePerTurnControl(root, requested)) betas.push(claudePerTurnControlBeta);
    if (claudeIncludePerTurnTiming(root, requested)) betas.push(claudePerTurnTimingBeta);
  }
  if (has(requested, claudeAdvisorToolBeta) || claudeBodyHasAdvisorTool(root)) betas.push(claudeAdvisorToolBeta);
  if (has(requested, claudeAdvancedToolUseBeta) || claudeBodyUsesAdvancedToolUse(root)) betas.push(claudeAdvancedToolUseBeta);
  if (!legacy && claudeIncludeMidConvClearAt(root, requested)) betas.push(claudeMidConvSystemClearAtBeta);
  if (has(requested, claudeDangerousToolUseBeta) || getAt(root, "safeguards") !== undefined) betas.push(claudeDangerousToolUseBeta);
  if (claudeRequestSupportsEffort(root, requested)) betas.push(claudeEffortBeta);
  const isProbeOrHelper = isClaudeProbeOrHelperRequest(root);
  if (!isProbeOrHelper && (has(requested, claudeServerSideFallbackBeta) || getAt(root, "fallbacks") !== undefined)) betas.push(claudeServerSideFallbackBeta);
  const includeFallbackCredit =
    has(requested, claudeFallbackCreditBeta) || getAt(root, "fallback_credit_token") !== undefined || (oauthToken && getAt(root, "fallbacks") !== undefined);
  if (includeFallbackCredit) betas.push(claudeFallbackCreditBeta);
  for (const beta of claudeCodeTrailingBetas) {
    if (beta === claudeServerSideFallbackBeta || beta === claudeFallbackCreditBeta) continue;
    if (has(requested, beta)) betas.push(beta);
  }
  const thinkingType = gstr(getAt(root, "thinking.type"));
  if (
    has(requested, claudeThinkingBindingBeta) ||
    getAt(root, "thinking.block_binding") !== undefined ||
    (claudeModelUsesProgressDisplay(modelOf(root)) && thinkingType === "adaptive")
  ) {
    betas.push(claudeThinkingBindingBeta);
  }
  if (!isProbeOrHelper && thinkingType !== "disabled" && (has(requested, claudeThinkingDisplayUpdatesBeta) || claudeThinkingDisplayUpdates(root))) {
    betas.push(claudeThinkingDisplayUpdatesBeta);
  }
  if (has(requested, claudeThinkingResumptionBeta)) betas.push(claudeThinkingResumptionBeta);
  if (claudeRequestUsesFastMode(root, requested)) betas.push(claudeFastModeBeta);
  if (has(requested, claudeAFKModeBeta)) betas.push(claudeAFKModeBeta);
  if (!isProbeOrHelper) {
    const includeExtended = (oauthToken && !isClaudeSubagentRequest(undefined, root)) || has(requested, claudeExtendedCacheTTLBeta) || claudePayloadHas1hTTL(root);
    if (includeExtended) betas.push(claudeExtendedCacheTTLBeta);
  }
  if (has(requested, claudePromptCachingEvictBeta) || body.includes(`"evict_on_complete"`)) betas.push(claudePromptCachingEvictBeta);
  if (isObj(getAt(root, "diagnostics"))) betas.push(claudeCacheDiagnosisBeta);
  return betas.join(",");
}

/** The fixed profile Claude Code 2.1.220 sends to /v1/messages/count_tokens. */
const claudeCountTokensBetas = [claudeCodeBeta, "interleaved-thinking-2025-05-14", "context-management-2025-06-27", claudeTokenCountingBeta];

export function claudeCountTokensBetasForCredential(oauthToken: boolean): string {
  const betas = [claudeCodeBeta];
  if (oauthToken) betas.push(claudeOAuthBeta);
  betas.push(...claudeCountTokensBetas.slice(1));
  return betas.join(",");
}

function dedupe(betas: string, drop?: string): { parts: string[]; seen: Set<string> } {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of betas.split(",")) {
    const beta = raw.trim();
    if (beta === "" || beta === drop || seen.has(beta)) continue;
    parts.push(beta);
    seen.add(beta);
  }
  return { parts, seen };
}

function insertAfterClaudeCode(parts: string[], beta: string): void {
  const insertAt = parts.length > 0 && parts[0] === claudeCodeBeta ? 1 : 0;
  parts.splice(insertAt, 0, beta);
}

export function withClaudeCountTokensOAuthBeta(betas: string): string {
  const { parts, seen } = dedupe(betas);
  if (seen.has(claudeOAuthBeta)) return parts.join(",");
  insertAfterClaudeCode(parts, claudeOAuthBeta);
  return parts.join(",");
}

/**
 * Restores the credential-scoped betas that describe the selected upstream OAuth
 * account rather than caller capability (Go: withClaudeOAuthCredentialBetas).
 */
export function withClaudeOAuthCredentialBetas(betas: string, includeExtendedCacheTTL: boolean): string {
  const { parts, seen } = dedupe(betas);
  if (!seen.has(claudeOAuthBeta)) insertAfterClaudeCode(parts, claudeOAuthBeta);
  if (includeExtendedCacheTTL && !seen.has(claudeExtendedCacheTTLBeta)) parts.push(claudeExtendedCacheTTLBeta);
  return parts.join(",");
}

export function withoutClaudeBeta(betas: string, removeBeta: string): string {
  return betas
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== removeBeta)
    .join(",");
}

/** Appends beta at the end unless it is already present (Go: withClaudeBetaAppended). */
export function withClaudeBetaAppended(betas: string, beta: string): string {
  const b = beta.trim();
  if (b === "") return betas;
  for (const existing of betas.split(",")) if (existing.trim() === b) return betas;
  if (betas.trim() === "") return b;
  return betas + "," + b;
}

export function withClaudeExtendedCacheTTLBeta(betas: string): string {
  const { parts, seen } = dedupe(betas);
  if (!seen.has(claudeExtendedCacheTTLBeta)) parts.push(claudeExtendedCacheTTLBeta);
  return parts.join(",");
}

/** Ensures advisor-tool-2026-03-01 is present at its observed wire position (Go: withClaudeAdvisorToolBeta). */
export function withClaudeAdvisorToolBeta(betas: string): string {
  if (betas.trim() === "") return claudeAdvisorToolBeta;
  const { parts } = dedupe(betas, claudeAdvisorToolBeta);
  let insertAt = parts.length;
  const boundaries = new Set([
    claudeAdvancedToolUseBeta,
    claudeEffortBeta,
    claudeServerSideFallbackBeta,
    claudeFallbackCreditBeta,
    claudeStructuredOutputsBeta,
    claudeFastModeBeta,
    claudeAFKModeBeta,
    claudeExtendedCacheTTLBeta,
    claudeCacheDiagnosisBeta,
  ]);
  for (let i = 0; i < parts.length; i++) {
    if (boundaries.has(parts[i]!)) {
      insertAt = i;
      break;
    }
  }
  parts.splice(insertAt, 0, claudeAdvisorToolBeta);
  return parts.join(",");
}

/**
 * Extracts the "betas" array from the body and removes it (Go: extractAndRemoveBetas).
 * Returns the extracted betas and the modified body.
 */
export function extractAndRemoveBetas(body: string): { betas: string[]; body: string } {
  const root = tryParse<Record<string, unknown>>(body);
  if (!isObj(root) || !("betas" in root)) return { betas: [], body };
  const value = root.betas;
  const betas: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = gstr(item).trim();
      if (s !== "") betas.push(s);
    }
  } else {
    const s = gstr(value).trim();
    if (s !== "") betas.push(s);
  }
  delete root.betas;
  return { betas, body: JSON.stringify(root) };
}
