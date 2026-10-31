// Port of internal/signature/claude_messages_sanitize.go.
import { deleteAt, getAt, gstr, isObj, setAt } from "../util/gpath.ts";
import { isEmptyClaudeThinkingPlaceholder } from "./claude.ts";
import {
  decideSignatureCompatibilityForModel,
  normalizeSignatureTargetProvider,
  SignatureActionDropSignature,
  SignatureActionPreserve,
  SignatureActionReplaceWithGeminiBypass,
  SignatureBlockKindClaudeThinking,
  SignatureBlockKindGeminiFunctionCall,
  SignatureBlockKindGPTReasoning,
  type SignatureBlockKind,
  type SignatureCompatibilityDecision,
  SignatureProviderClaude,
  signatureProviderFromModelName,
  SignatureProviderGPT,
  SignatureProviderUnknown,
  type SignatureProvider,
} from "./provider_compatibility.ts";

export interface ClaudeMessagesSignatureSanitizeOptions {
  targetProvider?: SignatureProvider;
  targetModel?: string;
  dropEmptyMessages?: boolean;
  dropToolSignatures?: boolean;
  dropEmptyThinkingPlaceholders?: boolean;
  /** Preserves compatibility-mode thinking blocks together with their original signatures. */
  preserveEmptyThinkingBlocks?: boolean;
}

/**
 * The CLIProxyAPI-internal marker carried in the signature field of the Claude
 * thinking block that relays a Codex commentary message. Never forwarded upstream.
 */
export const codexCommentarySignatureMarker = "cpa:commentary:v1";

/** Whether rawSignature is exactly the internal commentary marker (ignoring surrounding whitespace). */
export function isCodexCommentarySignatureMarker(rawSignature: string): boolean {
  return rawSignature.trim() === codexCommentarySignatureMarker;
}

function parseMessages(payload: string): { root: Record<string, unknown>; messages: unknown[] } | undefined {
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isObj(root) || !Array.isArray(root.messages)) return undefined;
  return { root, messages: root.messages };
}

/**
 * Rewrites every assistant thinking block that carries the internal commentary
 * marker as a plain assistant text block and reports how many were restored.
 * Blocks with empty thinking text are dropped. Unchanged payloads are returned as-is.
 */
export function restoreCodexCommentaryMarkers(payload: string): { payload: string; restored: number } {
  const parsed = parseMessages(payload);
  if (!parsed) return { payload, restored: 0 };
  let restored = 0;
  const keptMessages: unknown[] = [];
  for (const message of parsed.messages) {
    const content = getAt(message, "content");
    if (!Array.isArray(content)) {
      keptMessages.push(message);
      continue;
    }
    const keptParts: unknown[] = [];
    let messageModified = false;
    for (const part of content) {
      if (gstr(getAt(part, "type")) !== "thinking" || !isCodexCommentarySignatureMarker(gstr(getAt(part, "signature")))) {
        keptParts.push(part);
        continue;
      }
      restored++;
      messageModified = true;
      const text = gstr(getAt(part, "thinking"));
      if (text !== "") keptParts.push({ type: "text", text });
    }
    if (!messageModified) {
      keptMessages.push(message);
      continue;
    }
    if (keptParts.length === 0) continue;
    keptMessages.push({ ...(message as Record<string, unknown>), content: keptParts });
  }
  if (restored === 0) return { payload, restored: 0 };
  return { payload: JSON.stringify({ ...parsed.root, messages: keptMessages }), restored };
}

export interface SignatureSanitizeReport {
  targetProvider: SignatureProvider;
  preserved: number;
  droppedBlocks: number;
  droppedSignatures: number;
  replacedSignatures: number;
  decisions: SignatureCompatibilityDecision[];
}

export interface SanitizedClaudeMessages {
  payload: string;
  report: SignatureSanitizeReport;
}

/** Removes or preserves Claude /v1/messages signed history according to the provider family implied by targetModel. */
export function sanitizeClaudeMessagesSignaturesForModel(payload: string, targetModel: string): SanitizedClaudeMessages {
  return sanitizeClaudeMessagesSignaturesForTarget(payload, {
    targetProvider: signatureProviderFromModelName(targetModel),
    targetModel,
    dropEmptyMessages: true,
  });
}

/**
 * Prepares a Claude /v1/messages body for Claude-compatible upstreams: valid Claude
 * signatures are normalized to E-form, CAIS signatures kept, incompatible thinking
 * blocks dropped, and tool_use blocks keep only their tool-call payload.
 */
export function sanitizeClaudeMessagesForClaudeUpstream(payload: string, targetModel: string, preserveEmptyThinkingBlocks = false): SanitizedClaudeMessages {
  return sanitizeClaudeMessagesSignaturesForTarget(payload, {
    targetProvider: SignatureProviderClaude,
    targetModel,
    dropEmptyMessages: true,
    dropToolSignatures: true,
    dropEmptyThinkingPlaceholders: !preserveEmptyThinkingBlocks,
    preserveEmptyThinkingBlocks,
  });
}

/** Applies provider-aware signature compatibility rules to Claude /v1/messages history. */
export function sanitizeClaudeMessagesSignaturesForTarget(payload: string, opts: ClaudeMessagesSignatureSanitizeOptions): SanitizedClaudeMessages {
  let targetProvider = normalizeSignatureTargetProvider(opts.targetProvider ?? SignatureProviderUnknown);
  if (targetProvider === SignatureProviderUnknown && opts.targetModel) targetProvider = signatureProviderFromModelName(opts.targetModel);
  const targetModel = opts.targetModel ?? "";
  const report: SignatureSanitizeReport = { targetProvider, preserved: 0, droppedBlocks: 0, droppedSignatures: 0, replacedSignatures: 0, decisions: [] };

  const parsed = parseMessages(payload);
  if (!parsed) return { payload, report };
  const keptMessages: unknown[] = [];
  let modified = false;

  parsed.messages.forEach((message, i) => {
    const content = getAt(message, "content");
    if (!Array.isArray(content)) {
      keptMessages.push(message);
      return;
    }
    const keptParts: unknown[] = [];
    let messageModified = false;

    content.forEach((part, j) => {
      const partType = gstr(getAt(part, "type"));
      if (partType === "tool_use") {
        if (opts.dropToolSignatures) {
          const { part: updated, changed } = stripClaudeToolUseSignatureFields(part);
          if (changed) {
            messageModified = true;
            report.droppedSignatures++;
          }
          keptParts.push(updated);
          return;
        }
        const { part: updated, changed, decisions } = sanitizeClaudeToolUseSignature(part, targetProvider, targetModel, i, j);
        report.decisions.push(...decisions);
        if (changed) messageModified = true;
        for (const decision of decisions) {
          if (decision.action === SignatureActionPreserve) report.preserved++;
          else if (decision.action === SignatureActionReplaceWithGeminiBypass) report.replacedSignatures++;
          else report.droppedSignatures++;
        }
        keptParts.push(updated);
        return;
      }
      if (partType !== "thinking") {
        keptParts.push(part);
        return;
      }
      const rawSignature = gstr(getAt(part, "signature"));
      if (isCodexCommentarySignatureMarker(rawSignature)) {
        const text = gstr(getAt(part, "thinking"));
        if (text !== "") {
          keptParts.push({ type: "text", text });
          report.droppedSignatures++;
          messageModified = true;
          return;
        }
        report.droppedBlocks++;
        messageModified = true;
        return;
      }
      if (opts.preserveEmptyThinkingBlocks) {
        report.preserved++;
        keptParts.push(part);
        return;
      }
      if (targetProvider === SignatureProviderClaude && isEmptyClaudeThinkingPlaceholder(part) && !opts.dropEmptyThinkingPlaceholders) {
        keptParts.push(part);
        return;
      }
      const decision = decideSignatureCompatibilityForModel(targetProvider, targetModel, rawSignature, SignatureBlockKindClaudeThinking);
      decision.reason = `messages[${i}].content[${j}]: ${decision.reason}`;
      report.decisions.push(decision);
      switch (decision.action) {
        case SignatureActionPreserve:
          report.preserved++;
          if (decision.normalizedSignature !== "" && decision.normalizedSignature !== rawSignature) {
            keptParts.push({ ...(part as Record<string, unknown>), signature: decision.normalizedSignature });
            messageModified = true;
            return;
          }
          keptParts.push(part);
          return;
        case SignatureActionReplaceWithGeminiBypass:
          report.replacedSignatures++;
          keptParts.push({ ...(part as Record<string, unknown>), signature: decision.replacementSignature });
          messageModified = true;
          return;
        case SignatureActionDropSignature: {
          report.droppedSignatures++;
          const copy = { ...(part as Record<string, unknown>) };
          delete copy.signature;
          keptParts.push(copy);
          messageModified = true;
          return;
        }
        default:
          report.droppedBlocks++;
          messageModified = true;
      }
    });

    if (messageModified) {
      modified = true;
      if (keptParts.length === 0 && opts.dropEmptyMessages) return;
      keptMessages.push({ ...(message as Record<string, unknown>), content: keptParts });
      return;
    }
    keptMessages.push(message);
  });

  if (!modified) return { payload, report };
  return { payload: JSON.stringify({ ...parsed.root, messages: keptMessages }), report };
}

function clonePart(part: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(part)) as Record<string, unknown>;
}

function stripClaudeToolUseSignatureFields(part: unknown): { part: unknown; changed: boolean } {
  const updated = clonePart(part);
  let changed = false;
  for (const sigPath of claudeToolUseProvenancePaths()) {
    if (getAt(updated, sigPath) === undefined) continue;
    deleteAt(updated, sigPath);
    changed = true;
  }
  if (deleteEmptyJSONObjectPath(updated, "extra_content.google")) changed = true;
  if (deleteEmptyJSONObjectPath(updated, "extra_content")) changed = true;
  return { part: changed ? updated : part, changed };
}

function sanitizeClaudeToolUseSignature(
  part: unknown,
  targetProvider: SignatureProvider,
  targetModel: string,
  messageIdx: number,
  partIdx: number,
): { part: unknown; changed: boolean; decisions: SignatureCompatibilityDecision[] } {
  let updated: unknown = clonePart(part);
  let changed = false;
  const decisions: SignatureCompatibilityDecision[] = [];
  for (const sigPath of claudeToolUseSignaturePaths()) {
    const sigResult = getAt(part, sigPath);
    if (sigResult === undefined) continue;
    let blockKind: SignatureBlockKind = SignatureBlockKindGeminiFunctionCall;
    if (targetProvider === SignatureProviderClaude) blockKind = SignatureBlockKindClaudeThinking;
    else if (targetProvider === SignatureProviderGPT) blockKind = SignatureBlockKindGPTReasoning;
    const decision = decideSignatureCompatibilityForModel(targetProvider, targetModel, gstr(sigResult), blockKind);
    decision.reason = `messages[${messageIdx}].content[${partIdx}].${sigPath}: ${decision.reason}`;
    decisions.push(decision);
    switch (decision.action) {
      case SignatureActionPreserve:
        if (decision.normalizedSignature !== "" && decision.normalizedSignature !== gstr(sigResult)) {
          updated = setAt(updated, sigPath, decision.normalizedSignature);
          changed = true;
        }
        break;
      case SignatureActionReplaceWithGeminiBypass:
        updated = setAt(updated, sigPath, decision.replacementSignature);
        changed = true;
        break;
      default:
        deleteAt(updated, sigPath);
        changed = true;
    }
  }
  if (deleteEmptyJSONObjectPath(updated, "extra_content.google")) changed = true;
  if (deleteEmptyJSONObjectPath(updated, "extra_content")) changed = true;
  return { part: changed ? updated : part, changed, decisions };
}

function claudeToolUseSignaturePaths(): string[] {
  return ["signature", "thoughtSignature", "thought_signature", "extra_content.google.thought_signature"];
}

function claudeToolUseProvenancePaths(): string[] {
  return [...claudeToolUseSignaturePaths(), "model"];
}

function deleteEmptyJSONObjectPath(raw: unknown, path: string): boolean {
  const result = getAt(raw, path);
  if (!isObj(result) || Object.keys(result).length !== 0) return false;
  return deleteAt(raw, path);
}
