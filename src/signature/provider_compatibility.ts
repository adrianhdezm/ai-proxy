// Port of internal/signature/provider_compatibility.go.
import { inspectClaudeCAISSignature, isValidClaudeCAISSignature, isValidClaudeThinkingSignature, normalizeClaudeProviderNativeThinkingSignature, normalizeClaudeThinkingSignature } from "./claude_validation.ts";
import { geminiSkipThoughtSignatureValidator, isGeminiThoughtSignatureBypass, isValidGeminiThoughtSignature } from "./gemini_validation.ts";
import { isValidGPTReasoningSignature } from "./gpt_validation.ts";
import { isValidGrokEncryptedContent } from "./grok_validation.ts";
import { isValidKimiThinkingSignature } from "./kimi_validation.ts";
import { isValidMetaReasoningSignature } from "./meta_validation.ts";

export type SignatureProvider = "unknown" | "claude" | "gemini" | "gemini_bypass" | "gpt" | "kimi" | "grok" | "swe" | "meta";

export const SignatureProviderUnknown: SignatureProvider = "unknown";
export const SignatureProviderClaude: SignatureProvider = "claude";
export const SignatureProviderGemini: SignatureProvider = "gemini";
export const SignatureProviderGeminiBypass: SignatureProvider = "gemini_bypass";
export const SignatureProviderGPT: SignatureProvider = "gpt";
/** Identified by fixed signature size rather than by an envelope. */
export const SignatureProviderKimi: SignatureProvider = "kimi";
/** A target-only family: detection never returns it. */
export const SignatureProviderGrok: SignatureProvider = "grok";
export const SignatureProviderSWE: SignatureProvider = "swe";
export const SignatureProviderMeta: SignatureProvider = "meta";

export type SignatureBlockKind = "unknown" | "claude_thinking" | "gemini_model_part" | "gemini_function_call" | "gpt_reasoning";

export const SignatureBlockKindUnknown: SignatureBlockKind = "unknown";
export const SignatureBlockKindClaudeThinking: SignatureBlockKind = "claude_thinking";
export const SignatureBlockKindGeminiModelPart: SignatureBlockKind = "gemini_model_part";
export const SignatureBlockKindGeminiFunctionCall: SignatureBlockKind = "gemini_function_call";
export const SignatureBlockKindGPTReasoning: SignatureBlockKind = "gpt_reasoning";

export type SignatureCompatibilityAction = "preserve" | "drop_block" | "drop_signature" | "replace_with_gemini_bypass" | "no_compatible_replacement" | "";

export const SignatureActionPreserve: SignatureCompatibilityAction = "preserve";
export const SignatureActionDropBlock: SignatureCompatibilityAction = "drop_block";
export const SignatureActionDropSignature: SignatureCompatibilityAction = "drop_signature";
export const SignatureActionReplaceWithGeminiBypass: SignatureCompatibilityAction = "replace_with_gemini_bypass";
export const SignatureActionNoCompatibleReplacement: SignatureCompatibilityAction = "no_compatible_replacement";

export interface SignatureCompatibilityDecision {
  targetProvider: SignatureProvider;
  detectedProvider: SignatureProvider;
  blockKind: SignatureBlockKind;
  compatible: boolean;
  action: SignatureCompatibilityAction;
  replacementSignature: string;
  normalizedSignature: string;
  reason: string;
}

/** Maps common model names to the provider family whose signed history can be replayed for that model. */
export function signatureProviderFromModelName(modelName: string): SignatureProvider {
  const lower = modelName.trim().toLowerCase();
  if (lower === "") return SignatureProviderUnknown;
  // A namespaced ID's canonical model is its last path segment.
  let candidate = lower;
  const idx = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf(":"));
  if (idx >= 0 && idx < lower.length - 1) candidate = lower.slice(idx + 1);
  const provider = signatureProviderFromModelNameValue(candidate);
  if (provider !== SignatureProviderUnknown) return provider;
  if (candidate !== lower) return signatureProviderFromModelNameValue(lower);
  return SignatureProviderUnknown;
}

function signatureProviderFromModelNameValue(lower: string): SignatureProvider {
  if (lower.includes("claude")) return SignatureProviderClaude;
  if (lower.includes("gemini")) return SignatureProviderGemini;
  if (lower.includes("gpt") || lower.includes("openai") || lower.includes("codex") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) return SignatureProviderGPT;
  if (lower.includes("kimi") || lower.includes("moonshot") || lower.startsWith("k2") || lower.startsWith("k3")) return SignatureProviderKimi;
  if (lower.includes("grok")) return SignatureProviderGrok;
  if (isMetaMuseModelName(lower)) return SignatureProviderMeta;
  if (lower.includes("swe-")) return SignatureProviderSWE;
  return SignatureProviderUnknown;
}

function isMetaMuseModelName(lower: string): boolean {
  if (lower === "muse" || lower.startsWith("muse-") || lower.startsWith("muse_") || lower.endsWith("/muse") || lower.includes("/muse-") || lower.includes("/muse_")) return true;
  for (const prefix of ["meta-", "meta_"]) {
    const idx = lower.indexOf(prefix + "muse");
    if (idx >= 0) {
      const rest = lower.slice(idx + prefix.length + 4);
      if (rest === "" || rest[0] === "-" || rest[0] === "_" || rest[0] === "." || rest[0] === ":") return true;
    }
  }
  return false;
}

/**
 * The base64 first characters a self-describing provider envelope can produce:
 * 'C' Claude CAIS, 'E' Claude single-layer / Gemini field-2, 'A' Gemini bare-Tink,
 * 'Q' Antigravity CAQS / Meta Muse, 'R' Claude double-layer, 'g' GPT Fernet.
 */
export const selfDescribingSignatureFirstChars = "ACEQRg";

/** Structural pre-filter: a false result is conclusive, a true result only narrows candidates. */
export function maybeSelfDescribingSignatureEnvelope(rawSignature: string): boolean {
  if (rawSignature === "") return false;
  return selfDescribingSignatureFirstChars.includes(rawSignature[0]!);
}

/** Classifies the provider family that can replay rawSignature. */
export function detectSignatureProvider(rawSignature: string): SignatureProvider {
  return detectSignatureProviderForBlock(rawSignature, SignatureBlockKindUnknown);
}

/** Classifies rawSignature with block-kind context. UUID-shaped payloads are never replay-safe. */
export function detectSignatureProviderForBlock(rawSignature: string, blockKind: SignatureBlockKind): SignatureProvider {
  const sig = rawSignature.trim();
  if (sig === "") return SignatureProviderUnknown;
  const split = splitSignatureProviderPrefix(sig);
  if (split.ok) {
    if (split.rest.includes("#")) return SignatureProviderUnknown;
    switch (split.provider) {
      case SignatureProviderGemini:
        if (isGeminiThoughtSignatureBypass(split.rest)) return SignatureProviderGeminiBypass;
        if (isRecognizedGeminiProviderSignature(split.rest, blockKind)) return SignatureProviderGemini;
        break;
      case SignatureProviderClaude:
        if (isValidClaudeThinkingSignature(split.rest, { strict: true }) || isValidClaudeCAISSignature(split.rest)) return SignatureProviderClaude;
        break;
      case SignatureProviderGPT:
        if (isValidGPTReasoningSignature(split.rest)) return SignatureProviderGPT;
        break;
      case SignatureProviderSWE:
        if (split.rest.startsWith("sealed.v1.")) return SignatureProviderSWE;
        break;
    }
    return SignatureProviderUnknown;
  }
  if (sig.includes("#")) return SignatureProviderUnknown;
  if (isGeminiThoughtSignatureBypass(sig)) return SignatureProviderGeminiBypass;
  if (sig.startsWith("sealed.v1.")) return SignatureProviderSWE;
  if (maybeSelfDescribingSignatureEnvelope(sig)) {
    if (isValidGPTReasoningSignature(sig)) return SignatureProviderGPT;
    if (isValidMetaReasoningSignature(sig)) return SignatureProviderMeta;
    if (isValidClaudeCAISSignature(sig)) return SignatureProviderClaude;
    if (isValidClaudeThinkingSignature(sig, { strict: true })) return SignatureProviderClaude;
    if (isRecognizedGeminiProviderSignature(sig, blockKind)) return SignatureProviderGemini;
  }
  if (isValidKimiThinkingSignature(sig)) return SignatureProviderKimi;
  return SignatureProviderUnknown;
}

export function isSignatureCompatibleWithProvider(targetProvider: SignatureProvider, rawSignature: string): boolean {
  return decideSignatureCompatibility(targetProvider, rawSignature, SignatureBlockKindUnknown).compatible;
}

/** The safe handling policy for replaying a signed block into targetProvider. */
export function decideSignatureCompatibility(targetProvider: SignatureProvider, rawSignature: string, blockKind: SignatureBlockKind): SignatureCompatibilityDecision {
  return decideSignatureCompatibilityForModel(targetProvider, "", rawSignature, blockKind);
}

/** The safe handling policy for replaying a signed block into targetProvider for targetModel. */
export function decideSignatureCompatibilityForModel(
  targetProvider: SignatureProvider,
  targetModel: string,
  rawSignature: string,
  blockKind: SignatureBlockKind,
): SignatureCompatibilityDecision {
  targetProvider = normalizeSignatureTargetProvider(targetProvider);
  if (!blockKind) blockKind = SignatureBlockKindUnknown;
  const detected = detectSignatureProviderForBlock(rawSignature, blockKind);
  const decision: SignatureCompatibilityDecision = {
    targetProvider,
    detectedProvider: detected,
    blockKind,
    compatible: false,
    action: "",
    replacementSignature: "",
    normalizedSignature: "",
    reason: "",
  };
  // A Claude envelope does not authorize a Google transport wrapper on native Claude endpoints.
  if (targetProvider === SignatureProviderClaude && detected === SignatureProviderClaude && signaturePayloadWithoutProviderPrefix(rawSignature).startsWith("Q")) {
    decision.action = SignatureActionDropBlock;
    decision.reason = "Antigravity CAQS wrapper requires Antigravity replay";
    return decision;
  }
  if (signatureProviderMatchesTarget(targetProvider, detected)) {
    const normalized = normalizeCompatibleSignatureForProvider(targetProvider, rawSignature, blockKind);
    if (normalized !== "") {
      decision.compatible = true;
      decision.action = SignatureActionPreserve;
      decision.normalizedSignature = normalized;
      decision.reason = claudeCompatibleSignatureReason(targetProvider, rawSignature, targetModel);
      return decision;
    }
  }
  decision.compatible = false;
  switch (targetProvider) {
    case SignatureProviderGemini:
      if (blockKind === SignatureBlockKindGeminiFunctionCall || blockKind === SignatureBlockKindGeminiModelPart || blockKind === SignatureBlockKindUnknown) {
        decision.action = SignatureActionReplaceWithGeminiBypass;
        decision.replacementSignature = geminiSkipThoughtSignatureValidator;
        decision.reason = "missing or incompatible signature";
        return decision;
      }
      decision.action = SignatureActionDropBlock;
      decision.reason = "signature is not compatible with Gemini and this block is not a bypass-safe Gemini model part";
      break;
    case SignatureProviderClaude:
      decision.action = SignatureActionDropBlock;
      decision.reason = "Claude has no cross-provider bypass sentinel for thinking blocks";
      break;
    case SignatureProviderGPT:
      decision.action = SignatureActionDropBlock;
      decision.reason = "GPT reasoning encrypted_content cannot be synthesized from another provider signature";
      break;
    case SignatureProviderSWE:
      decision.action = SignatureActionDropBlock;
      decision.reason = "SWE requires sealed.v1 signature from its own backend";
      break;
    case SignatureProviderMeta:
      decision.action = SignatureActionDropBlock;
      decision.reason = "Meta Muse requires its native encrypted_content envelope and has no cross-provider bypass sentinel";
      break;
    case SignatureProviderKimi:
      decision.action = SignatureActionDropSignature;
      decision.reason = "Kimi does not validate replayed thinking signatures, so the block survives without one";
      break;
    case SignatureProviderGrok:
      decision.action = SignatureActionDropBlock;
      decision.reason = "xAI verifies encrypted_content on replay and rejects foreign or mutated blobs";
      break;
    default:
      decision.action = SignatureActionNoCompatibleReplacement;
      decision.reason = "unknown target provider";
  }
  return decision;
}

export interface SplitProviderPrefix {
  provider: SignatureProvider;
  rest: string;
  ok: boolean;
}

export function splitSignatureProviderPrefix(rawSignature: string): SplitProviderPrefix {
  const trimmed = rawSignature.trim();
  const idx = trimmed.indexOf("#");
  if (idx < 0) return { provider: SignatureProviderUnknown, rest: rawSignature, ok: false };
  const provider = signatureProviderFromCachePrefix(trimmed.slice(0, idx));
  if (provider === SignatureProviderUnknown) return { provider: SignatureProviderUnknown, rest: rawSignature, ok: false };
  return { provider, rest: trimmed.slice(idx + 1).trim(), ok: true };
}

/** Maps this repo's explicit provider-prefix envelope to a provider family (stricter than model-name mapping). */
export function signatureProviderFromCachePrefix(prefix: string): SignatureProvider {
  switch (prefix.trim().toLowerCase()) {
    case "claude":
    case "anthropic":
    case "cais":
    case "claude-cais":
    case "claude_cais":
    case "ccmax":
    case "claude-code-max":
    case "claude_code_max":
      return SignatureProviderClaude;
    case "gemini":
    case "google":
      return SignatureProviderGemini;
    case "openai":
    case "gpt":
    case "codex":
      return SignatureProviderGPT;
    case "swe":
    case "sealed":
      return SignatureProviderSWE;
    default:
      return SignatureProviderUnknown;
  }
}

/** Strips this repo's provider cache prefix when present; the result is what should be replayed upstream. */
export function signaturePayloadWithoutProviderPrefix(rawSignature: string): string {
  const split = splitSignatureProviderPrefix(rawSignature);
  return split.ok ? split.rest : rawSignature.trim();
}

/** A replayable provider-native signature for targetProvider, or undefined when incompatible. */
export function compatibleSignatureForProvider(targetProvider: SignatureProvider, rawSignature: string): string | undefined {
  return compatibleSignatureForProviderBlock(targetProvider, rawSignature, SignatureBlockKindUnknown);
}

export function compatibleSignatureForProviderBlock(targetProvider: SignatureProvider, rawSignature: string, blockKind: SignatureBlockKind): string | undefined {
  const decision = decideSignatureCompatibility(targetProvider, rawSignature, blockKind);
  if (!decision.compatible || decision.normalizedSignature === "") return undefined;
  return decision.normalizedSignature;
}

/** The double-layer R or Q form required by Antigravity Claude replay, or undefined. */
export function compatibleAntigravityClaudeThinkingSignature(rawSignature: string): string | undefined {
  if (detectSignatureProviderForBlock(rawSignature, SignatureBlockKindClaudeThinking) !== SignatureProviderClaude) return undefined;
  try {
    return normalizeClaudeThinkingSignature(signaturePayloadWithoutProviderPrefix(rawSignature), { strict: true });
  } catch {
    return undefined;
  }
}

function claudeCompatibleSignatureReason(targetProvider: SignatureProvider, rawSignature: string, targetModel: string): string {
  const genericReason = "signature provider matches target provider";
  if (targetProvider !== SignatureProviderClaude) return genericReason;
  let info;
  try {
    info = inspectClaudeCAISSignature(signaturePayloadWithoutProviderPrefix(rawSignature));
  } catch {
    return genericReason;
  }
  let reason: string;
  if (info.modelText !== "") reason = "valid Claude CAIS signature with embedded model " + info.modelText + " is compatible with any Claude target";
  else if (info.envelopeVersion >= 4) reason = "valid Claude CAQS signature is compatible with any Claude target";
  else reason = "valid Claude CAIS signature is compatible with any Claude target";
  const trimmedModel = targetModel.trim();
  if (trimmedModel !== "") reason += ", including target model " + trimmedModel;
  return reason;
}

export function normalizeSignatureTargetProvider(provider: SignatureProvider): SignatureProvider {
  return provider === SignatureProviderGeminiBypass ? SignatureProviderGemini : provider;
}

function signatureProviderMatchesTarget(target: SignatureProvider, detected: SignatureProvider): boolean {
  switch (target) {
    case SignatureProviderGemini:
      return detected === SignatureProviderGemini || detected === SignatureProviderGeminiBypass;
    case SignatureProviderClaude:
    case SignatureProviderGPT:
    case SignatureProviderSWE:
    case SignatureProviderMeta:
    case SignatureProviderKimi:
      return detected === target;
    default:
      // Grok is deliberately absent: detection never yields it.
      return false;
  }
}

function normalizeCompatibleSignatureForProvider(targetProvider: SignatureProvider, rawSignature: string, blockKind: SignatureBlockKind): string {
  const payload = signaturePayloadWithoutProviderPrefix(rawSignature);
  switch (normalizeSignatureTargetProvider(targetProvider)) {
    case SignatureProviderClaude:
      if (isValidClaudeCAISSignature(payload)) return payload;
      try {
        return normalizeClaudeProviderNativeThinkingSignature(payload);
      } catch {
        return "";
      }
    case SignatureProviderGemini:
      if (isGeminiThoughtSignatureBypass(payload)) return payload;
      if (isRecognizedGeminiProviderSignature(payload, blockKind)) return payload;
      break;
    case SignatureProviderGPT:
      if (isValidGPTReasoningSignature(payload)) return payload;
      break;
    case SignatureProviderSWE:
      if (payload.startsWith("sealed.v1.")) return payload;
      break;
    case SignatureProviderMeta:
      if (isValidMetaReasoningSignature(payload)) return payload;
      break;
    case SignatureProviderKimi:
      if (isValidKimiThinkingSignature(payload)) return payload;
      break;
  }
  return "";
}

export function isRecognizedGeminiProviderSignature(rawSignature: string, _blockKind: SignatureBlockKind): boolean {
  if (isValidClaudeCAISSignature(rawSignature)) return false;
  return isValidGeminiThoughtSignature(rawSignature, { requireKnownEnvelope: true });
}

/** Whether rawSignature is a structurally valid reasoning signature from any known provider (Grok shape included). */
export function isRecognizedReasoningSignature(rawSignature: string): boolean {
  const sig = rawSignature.trim();
  if (sig === "") return false;
  if (detectSignatureProvider(sig) !== SignatureProviderUnknown) return true;
  return isValidGrokEncryptedContent(sig);
}
