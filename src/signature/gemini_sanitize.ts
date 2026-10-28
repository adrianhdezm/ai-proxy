// Port of internal/signature/gemini_sanitize.go.
import { log } from "../log.ts";
import { deleteAt, getAt, gbool, gstr, isObj, setAt } from "../util/gpath.ts";
import {
  geminiPartThoughtSignature,
  geminiPartThoughtSignaturePaths,
  geminiSkipThoughtSignatureValidator,
  hasNormalizedGeminiPartThoughtSignature,
  isGeminiThoughtSignatureBypass,
  isGeminiVertexBareTinkSignature,
} from "./gemini_validation.ts";
import {
  decideSignatureCompatibility,
  detectSignatureProviderForBlock,
  SignatureActionDropBlock,
  SignatureActionDropSignature,
  SignatureActionPreserve,
  SignatureActionReplaceWithGeminiBypass,
  SignatureBlockKindGeminiFunctionCall,
  SignatureBlockKindGeminiModelPart,
  type SignatureBlockKind,
  type SignatureCompatibilityAction,
  type SignatureCompatibilityDecision,
  signaturePayloadWithoutProviderPrefix,
  SignatureProviderGemini,
  SignatureProviderGeminiBypass,
  type SignatureProvider,
} from "./provider_compatibility.ts";

interface GeminiSanitizeOptions {
  /** Treats Vertex bare-Tink signatures as incompatible (Antigravity, AI Studio). */
  rejectBareTink?: boolean;
}

/**
 * Returns a Gemini-replayable thoughtSignature: compatible Gemini signatures are
 * normalized and preserved; missing, unknown or cross-provider signatures become
 * the bypass sentinel.
 */
export function geminiReplaySignatureOrBypass(rawSignature: string, blockKind: SignatureBlockKind): string {
  return geminiReplaySignatureOrBypassImpl(rawSignature, blockKind, {});
}

function geminiReplaySignatureOrBypassImpl(rawSignature: string, blockKind: SignatureBlockKind, opts: GeminiSanitizeOptions): string {
  const decision = geminiSanitizeDecision(rawSignature, blockKind, opts);
  if (decision.compatible && decision.normalizedSignature !== "") return decision.normalizedSignature;
  if (decision.action === SignatureActionReplaceWithGeminiBypass && decision.replacementSignature !== "") return decision.replacementSignature;
  return geminiSkipThoughtSignatureValidator;
}

function geminiSanitizeDecision(rawSignature: string, blockKind: SignatureBlockKind, opts: GeminiSanitizeOptions): SignatureCompatibilityDecision {
  const decision = decideSignatureCompatibility(SignatureProviderGemini, rawSignature, blockKind);
  if (!opts.rejectBareTink || !decision.compatible || !isGeminiVertexBareTinkSignature(rawSignature)) return decision;
  decision.compatible = false;
  decision.normalizedSignature = "";
  decision.action = SignatureActionReplaceWithGeminiBypass;
  decision.replacementSignature = geminiSkipThoughtSignatureValidator;
  decision.reason = "Vertex bare-Tink signature is not accepted by this Gemini endpoint";
  return decision;
}

/**
 * Applies Gemini replay policy to a Gemini-shaped request (JSON string). Only a
 * missing or incompatible first functionCall in each parallel-call group gets the
 * bypass sentinel; unsigned siblings stay unsigned; functionResponse parts never
 * carry signatures; server-side toolCall/toolResponse blocks are untouched.
 * Vertex bare-Tink signatures are preserved (see the NonVertex variant).
 */
export function sanitizeGeminiRequestThoughtSignatures(payload: string, contentsPath: string): string {
  return sanitizeGeminiRequestThoughtSignaturesImpl(payload, contentsPath, {});
}

/** The same policy for Gemini endpoints other than Vertex AI: bare-Tink signatures are treated as incompatible. */
export function sanitizeNonVertexGeminiRequestThoughtSignatures(payload: string, contentsPath: string): string {
  return sanitizeGeminiRequestThoughtSignaturesImpl(payload, contentsPath, { rejectBareTink: true });
}

interface SanitizeLogKey {
  action: SignatureCompatibilityAction;
  reason: string;
  blockKind: SignatureBlockKind;
  detectedProvider: SignatureProvider;
}

function sanitizeGeminiRequestThoughtSignaturesImpl(payload: string, contentsPath: string, opts: GeminiSanitizeOptions): string {
  contentsPath = contentsPath.trim();
  if (contentsPath === "") contentsPath = "contents";
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    return payload;
  }
  const contents = getAt(root, contentsPath);
  if (!Array.isArray(contents) || !geminiContentsThoughtSignaturesNeedSanitize(contents, opts)) return payload;

  let contentsChanged = false;
  const sanitizeCounts = new Map<string, { key: SanitizeLogKey; count: number }>();
  const countSanitize = (decision: SignatureCompatibilityDecision): void => {
    const key: SanitizeLogKey = { action: decision.action, reason: decision.reason, blockKind: decision.blockKind, detectedProvider: decision.detectedProvider };
    const id = JSON.stringify(key);
    const entry = sanitizeCounts.get(id);
    if (entry) entry.count++;
    else sanitizeCounts.set(id, { key, count: 1 });
  };

  const contentItems = contents.map((content) => {
    const parts = getAt(content, "parts");
    if (!Array.isArray(parts)) return content;
    const isModelTurn = gstr(getAt(content, "role")) === "model";
    let firstFunctionCallSeen = false;
    let partsChanged = false;
    const partItems = parts.map((part) => {
      const { signature: rawSignature, has: hasSignature } = geminiPartThoughtSignature(part);
      if (getAt(part, "functionResponse") !== undefined) {
        if (hasSignature) {
          partsChanged = true;
          countSanitize({
            targetProvider: SignatureProviderGemini,
            detectedProvider: detectSignatureProviderForBlock(rawSignature, SignatureBlockKindGeminiModelPart),
            blockKind: SignatureBlockKindGeminiModelPart,
            compatible: false,
            action: SignatureActionDropSignature,
            replacementSignature: "",
            normalizedSignature: "",
            reason: "tool responses cannot carry signatures",
          });
          return deleteGeminiPartThoughtSignatureFields(part);
        }
        return part;
      }
      if (!isModelTurn) return part;
      if (getAt(part, "toolCall") !== undefined || getAt(part, "tool_call") !== undefined || getAt(part, "toolResponse") !== undefined || getAt(part, "tool_response") !== undefined) return part;

      const hasFunctionCall = getAt(part, "functionCall") !== undefined;
      const isFirstFunctionCall = hasFunctionCall && !firstFunctionCallSeen;
      if (hasFunctionCall || !gbool(getAt(part, "thought"))) firstFunctionCallSeen = hasFunctionCall;
      if (!hasFunctionCall && !hasSignature) return part;

      const blockKind = hasFunctionCall ? SignatureBlockKindGeminiFunctionCall : SignatureBlockKindGeminiModelPart;
      const decision = geminiSanitizeDecision(rawSignature, blockKind, opts);
      let replaySignature = "";
      if (isFirstFunctionCall) {
        replaySignature = geminiReplaySignatureOrBypassImpl(rawSignature, blockKind, opts);
        if (decision.action === SignatureActionReplaceWithGeminiBypass) decision.reason = "missing or incompatible signature";
      } else if (hasSignature && decision.action === SignatureActionPreserve && !isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(rawSignature))) {
        replaySignature = decision.normalizedSignature;
      } else if (hasSignature) {
        decision.action = SignatureActionDropSignature;
        decision.replacementSignature = "";
        decision.reason = hasFunctionCall ? "sibling calls must be unsigned" : "text parts cannot carry signatures";
      }

      let partJSON: unknown = part;
      let partChanged = false;
      if (replaySignature !== "") {
        if (!hasNormalizedGeminiPartThoughtSignature(part, replaySignature)) {
          partJSON = setAt(deleteGeminiPartThoughtSignatureFields(part), "thoughtSignature", replaySignature);
          partChanged = true;
        }
      } else if (hasSignature) {
        partJSON = deleteGeminiPartThoughtSignatureFields(part);
        partChanged = true;
      }
      if (partChanged) {
        partsChanged = true;
        if (decision.action !== SignatureActionPreserve) countSanitize(decision);
      }
      return partJSON;
    });
    if (partsChanged) {
      contentsChanged = true;
      return { ...(content as Record<string, unknown>), parts: partItems };
    }
    return content;
  });

  if (!contentsChanged) return payload;
  const updated = setAt(root, contentsPath, contentItems);
  for (const { key, count } of sanitizeCounts.values()) {
    const noun = count > 1 ? "thoughtSignatures" : "thoughtSignature";
    log.debug(
      `gemini request: sanitized ${count} ${noun} action=${sanitizeActionName(key.action)} part=${sanitizeKindName(key.blockKind)} sig_type=${sanitizeSigTypeName(key.detectedProvider)} path=${contentsPath} reason=${JSON.stringify(key.reason)}`,
    );
  }
  return JSON.stringify(updated);
}

function sanitizeActionName(action: SignatureCompatibilityAction): string {
  switch (action) {
    case SignatureActionDropSignature:
      return "drop";
    case SignatureActionReplaceWithGeminiBypass:
      return "replace_bypass";
    case SignatureActionDropBlock:
      return "drop_block";
    default:
      return action;
  }
}

function sanitizeKindName(kind: SignatureBlockKind): string {
  switch (kind) {
    case SignatureBlockKindGeminiFunctionCall:
      return "function_call";
    case SignatureBlockKindGeminiModelPart:
      return "model_part";
    default:
      return kind.startsWith("gemini_") ? kind.slice("gemini_".length) : kind;
  }
}

function sanitizeSigTypeName(provider: SignatureProvider): string {
  return provider === SignatureProviderGeminiBypass ? "bypass" : provider;
}

function geminiContentsThoughtSignaturesNeedSanitize(contents: unknown[], opts: GeminiSanitizeOptions): boolean {
  for (const content of contents) {
    const parts = getAt(content, "parts");
    if (!Array.isArray(parts)) continue;
    const isModelTurn = gstr(getAt(content, "role")) === "model";
    let firstFunctionCallSeen = false;
    for (const part of parts) {
      const { signature: rawSignature, has: hasSignature } = geminiPartThoughtSignature(part);
      if (getAt(part, "functionResponse") !== undefined) {
        if (hasSignature) return true;
        continue;
      }
      if (!isModelTurn) continue;
      if (getAt(part, "toolCall") !== undefined || getAt(part, "tool_call") !== undefined || getAt(part, "toolResponse") !== undefined || getAt(part, "tool_response") !== undefined) continue;
      const hasFunctionCall = getAt(part, "functionCall") !== undefined;
      const isFirstFunctionCall = hasFunctionCall && !firstFunctionCallSeen;
      if (hasFunctionCall || !gbool(getAt(part, "thought"))) firstFunctionCallSeen = hasFunctionCall;
      if (isFirstFunctionCall) {
        const replaySignature = geminiReplaySignatureOrBypassImpl(rawSignature, SignatureBlockKindGeminiFunctionCall, opts);
        if (!hasNormalizedGeminiPartThoughtSignature(part, replaySignature)) return true;
        continue;
      }
      if (!hasSignature) continue;
      const blockKind = hasFunctionCall ? SignatureBlockKindGeminiFunctionCall : SignatureBlockKindGeminiModelPart;
      const decision = geminiSanitizeDecision(rawSignature, blockKind, opts);
      if (decision.action !== SignatureActionPreserve || isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(rawSignature))) return true;
      if (!hasNormalizedGeminiPartThoughtSignature(part, decision.normalizedSignature)) return true;
    }
  }
  return false;
}

/** Returns a copy of part with every known thought-signature field removed. */
export function deleteGeminiPartThoughtSignatureFields(part: unknown): unknown {
  if (!isObj(part)) return part;
  const copy = JSON.parse(JSON.stringify(part)) as Record<string, unknown>;
  for (const path of geminiPartThoughtSignaturePaths) deleteAt(copy, path);
  return copy;
}
