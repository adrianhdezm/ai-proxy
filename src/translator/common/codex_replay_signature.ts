// Port of internal/translator/common/codex_replay_signature.go.
import { getAt, gstr } from "../../util/gpath.ts";
import {
  compatibleSignatureForProvider,
  detectSignatureProvider,
  inspectGrokEncryptedContent,
  signatureProviderFromModelName,
  SignatureProviderGPT,
  SignatureProviderGrok,
  SignatureProviderMeta,
  SignatureProviderUnknown,
} from "../../signature/index.ts";

/**
 * Strips a trailing "(suffix)" from a model name (the thinking-suffix syntax,
 * mirroring thinking.ParseSuffix().ModelName) so the family lookup sees the bare model.
 */
export function modelNameWithoutSuffix(model: string): string {
  const lastOpen = model.lastIndexOf("(");
  if (lastOpen === -1 || !model.endsWith(")")) return model;
  return model.slice(0, lastOpen);
}

/**
 * Returns the model name to use for reasoning signature family checks, falling
 * back to the client-supplied "model" field in rawPayload when modelName is an
 * unmapped upstream alias for a Responses-native family (Meta Muse, Grok, GPT).
 */
export function resolveCodexReplayTargetModel(modelName: string, rawPayload: string | undefined): string {
  if (signatureProviderFromModelName(modelNameWithoutSuffix(modelName)) !== SignatureProviderUnknown) return modelName;
  if (rawPayload) {
    let root: unknown;
    try {
      root = JSON.parse(rawPayload);
    } catch {
      root = undefined;
    }
    const rawModel = gstr(getAt(root, "model")).trim();
    if (rawModel !== "") {
      switch (signatureProviderFromModelName(modelNameWithoutSuffix(rawModel))) {
        case SignatureProviderMeta:
        case SignatureProviderGrok:
        case SignatureProviderGPT:
          return rawModel;
      }
    }
  }
  return modelName;
}

/**
 * Returns the exact value that may be written as a Responses reasoning
 * encrypted_content for the Codex-format upstream serving modelName, or
 * undefined when rawSignature must not replay there. An unmapped target defaults
 * to the GPT family; Grok falls back to its shape inspector keyed on the target.
 */
export function codexReplaySignatureForTarget(modelName: string, rawSignature: string): string | undefined {
  rawSignature = rawSignature.trim();
  if (rawSignature === "") return undefined;
  const target = signatureProviderFromModelName(modelNameWithoutSuffix(modelName));
  const detected = detectSignatureProvider(rawSignature);
  if (detected !== SignatureProviderUnknown) {
    const effectiveTarget = target === SignatureProviderUnknown ? SignatureProviderGPT : target;
    if (detected !== effectiveTarget) return undefined;
    const normalized = compatibleSignatureForProvider(effectiveTarget, rawSignature);
    return normalized && normalized !== "" ? normalized : undefined;
  }
  if (target === SignatureProviderGrok) {
    try {
      inspectGrokEncryptedContent(rawSignature);
      return rawSignature;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
