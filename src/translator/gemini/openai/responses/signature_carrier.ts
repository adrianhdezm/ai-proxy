// Port of internal/translator/gemini/openai/responses/signature_carrier.go.
//
// Gemini thought signatures that have no client-visible reasoning item of their
// own travel to the Responses client inside an encrypted_content "carrier"
// envelope that records which neighbouring item they bind to.
import {
  SignatureBlockKindGeminiFunctionCall,
  SignatureBlockKindGeminiModelPart,
  SignatureProviderGemini,
  compatibleSignatureForProviderBlock,
  isGeminiThoughtSignatureBypass,
  maxGeminiThoughtSignatureLen,
  signaturePayloadWithoutProviderPrefix,
} from "../../../../signature/index.ts";
import { decodeBase64, encodeBase64, rawStdEncoding } from "../../../../util/base64.ts";
import { getAt, isArr, isObj } from "../../../../util/gpath.ts";
import { has, str } from "./helpers.ts";

export const geminiResponsesCarrierPrefix = "cpa-gemini-responses-carrier-v1:";
export const geminiResponsesCarrierNext = "next";
export const geminiResponsesCarrierPrevious = "previous";
export const geminiResponsesCarrierStandalone = "standalone";
export const geminiResponsesCarrierText = "text";
export const geminiResponsesCarrierFunction = "function";
export const geminiResponsesCarrierAny = "any";

export const geminiResponsesCarrierDirectionField = "_cpa_reasoning_direction";
export const geminiResponsesCarrierTargetField = "_cpa_reasoning_target";
export const geminiResponsesCarrierSignatureField = "_cpa_reasoning_signature";
export const geminiResponsesCarrierSummaryField = "_cpa_reasoning_summary";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeGeminiResponsesCarrier(rawSignature: string, direction: string, targetKind: string): string {
  rawSignature = rawSignature.trim();
  if (rawSignature === "") return "";
  return geminiResponsesCarrierPrefix + direction + ":" + targetKind + ":" + encodeBase64(textEncoder.encode(rawSignature), rawStdEncoding);
}

export interface DecodedCarrier {
  signature: string;
  direction: string;
  targetKind: string;
  marked: boolean;
  ok: boolean;
}

export function decodeGeminiResponsesCarrier(rawSignature: string): DecodedCarrier {
  rawSignature = rawSignature.trim();
  const invalid: DecodedCarrier = { signature: "", direction: "", targetKind: "", marked: true, ok: false };
  if (!rawSignature.startsWith(geminiResponsesCarrierPrefix)) return { signature: rawSignature, direction: "", targetKind: "", marked: false, ok: true };
  if (rawSignature.length > Math.floor((maxGeminiThoughtSignatureLen * 4) / 3) + 1024) return invalid;
  const rest = rawSignature.slice(geminiResponsesCarrierPrefix.length);
  const first = rest.indexOf(":");
  if (first < 0) return invalid;
  const second = rest.indexOf(":", first + 1);
  if (second < 0) return invalid;
  const direction = rest.slice(0, first);
  const targetKind = rest.slice(first + 1, second);
  const payload = rest.slice(second + 1);
  if (direction !== geminiResponsesCarrierNext && direction !== geminiResponsesCarrierPrevious && direction !== geminiResponsesCarrierStandalone) return invalid;
  if (targetKind !== geminiResponsesCarrierText && targetKind !== geminiResponsesCarrierFunction && targetKind !== geminiResponsesCarrierAny) return invalid;
  const decoded = decodeBase64(payload, rawStdEncoding);
  if (!decoded || decoded.length === 0) return invalid;
  const signature = textDecoder.decode(decoded);
  if (signature.startsWith(geminiResponsesCarrierPrefix)) return invalid;
  return { signature, direction, targetKind, marked: true, ok: true };
}

export function compatibleGeminiResponsesCarrierSignature(rawSignature: string, targetKind: string): string | undefined {
  const blockKind = targetKind === geminiResponsesCarrierFunction ? SignatureBlockKindGeminiFunctionCall : SignatureBlockKindGeminiModelPart;
  const normalized = compatibleSignatureForProviderBlock(SignatureProviderGemini, rawSignature, blockKind);
  if (normalized === undefined || isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(normalized))) return undefined;
  return normalized;
}

/**
 * The visible text of an assistant output item: a message whose content is a
 * string with an assistant/model role, or that contains output_text parts.
 * Returns undefined when the item is not assistant-visible output.
 */
export function openAIResponsesAssistantVisibleText(item: unknown): string | undefined {
  let itemType = str(item, "type");
  const itemRole = str(item, "role");
  if (itemType === "" && itemRole !== "") itemType = "message";
  if (itemType !== "message") return undefined;
  const content = getAt(item, "content");
  if (content === undefined) return undefined;
  if (typeof content === "string") {
    switch (itemRole.trim().toLowerCase()) {
      case "assistant":
      case "model":
        return content;
      default:
        return undefined;
    }
  }
  if (!isArr(content)) return undefined;
  const textParts: string[] = [];
  let hasOutputText = false;
  for (const contentItem of content) {
    let contentType = str(contentItem, "type");
    if (contentType === "") contentType = "input_text";
    if (contentType !== "output_text") continue;
    hasOutputText = true;
    textParts.push(str(contentItem, "text"));
  }
  if (!hasOutputText) return undefined;
  return textParts.join("\n");
}

function geminiResponsesCarrierSemanticTarget(item: unknown): string {
  switch (str(item, "type")) {
    case "function_call":
    case "custom_tool_call":
      return geminiResponsesCarrierFunction;
    case "reasoning":
      if (str(item, "summary.0.text").trim() !== "") return geminiResponsesCarrierText;
      break;
  }
  if (openAIResponsesAssistantVisibleText(item) !== undefined) return geminiResponsesCarrierText;
  return "";
}

function geminiResponsesCarrierMatchesAdjacent(items: unknown[], index: number, direction: string, targetKind: string): boolean {
  const step = direction === geminiResponsesCarrierPrevious ? -1 : 1;
  for (let adjacent = index + step; adjacent >= 0 && adjacent < items.length; adjacent += step) {
    const kind = geminiResponsesCarrierSemanticTarget(items[adjacent]);
    if (kind !== "") return targetKind === geminiResponsesCarrierAny || targetKind === kind;
    if (!isOpenAIResponsesDetachedCarrier(items[adjacent])) return false;
  }
  return false;
}

function hasInternalCarrierFields(item: unknown): boolean {
  return (
    has(item, geminiResponsesCarrierDirectionField) ||
    has(item, geminiResponsesCarrierTargetField) ||
    has(item, geminiResponsesCarrierSignatureField) ||
    has(item, geminiResponsesCarrierSummaryField)
  );
}

function stripGeminiResponsesCarrierMetadata(item: unknown): unknown {
  if (!isObj(item)) return item;
  const out: Record<string, unknown> = { ...item };
  delete out[geminiResponsesCarrierDirectionField];
  delete out[geminiResponsesCarrierTargetField];
  delete out[geminiResponsesCarrierSignatureField];
  delete out[geminiResponsesCarrierSummaryField];
  // Go round-trips through map[string]json.RawMessage, which sorts keys.
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key];
  return sorted;
}

/**
 * Strips client-supplied internal pairing fields, decodes carrier envelopes and
 * drops invalid ones. Returns the normalized items and whether any valid Gemini
 * carrier (or a compatible legacy raw signature) was present.
 */
export function normalizeGeminiResponsesCarriers(items: unknown[]): { items: unknown[]; hasCarrier: boolean } {
  const normalized: unknown[] = [];
  let hasValidCarrier = false;
  items.forEach((originalItem, itemIndex) => {
    let item = originalItem;
    if (hasInternalCarrierFields(originalItem)) item = stripGeminiResponsesCarrierMetadata(originalItem);
    if (str(item, "type") !== "reasoning") {
      normalized.push(item);
      return;
    }
    const rawSignature = str(item, "encrypted_content").trim();
    const decoded = decodeGeminiResponsesCarrier(rawSignature);
    let { signature, ok } = decoded;
    const { direction, targetKind, marked } = decoded;
    if (!marked) {
      if (rawSignature !== "" && compatibleGeminiResponsesCarrierSignature(rawSignature, geminiResponsesCarrierAny) !== undefined) hasValidCarrier = true;
      normalized.push(item);
      return;
    }
    if (ok) {
      const compatible = compatibleGeminiResponsesCarrierSignature(signature, targetKind);
      ok = compatible !== undefined;
      signature = compatible ?? "";
    }
    if (ok && direction !== geminiResponsesCarrierStandalone) ok = geminiResponsesCarrierMatchesAdjacent(items, itemIndex, direction, targetKind);
    const isDetached = isOpenAIResponsesDetachedCarrier(item);
    const hasSummary = str(item, "summary.0.text").trim() !== "";
    const validSummaryCarrier =
      hasSummary &&
      ((direction === geminiResponsesCarrierStandalone && (targetKind === geminiResponsesCarrierText || targetKind === geminiResponsesCarrierAny)) ||
        direction === geminiResponsesCarrierNext);
    if (!ok || (!isDetached && !validSummaryCarrier)) {
      if (!hasSummary) return;
      const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      delete copy.encrypted_content;
      normalized.push(copy);
      return;
    }
    hasValidCarrier = true;
    const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
    copy.encrypted_content = signature;
    copy[geminiResponsesCarrierDirectionField] = direction;
    copy[geminiResponsesCarrierTargetField] = targetKind;
    normalized.push(copy);
  });
  return { items: normalized, hasCarrier: hasValidCarrier };
}

export function geminiResponsesCarrierDirection(item: unknown): string {
  return str(item, geminiResponsesCarrierDirectionField);
}

export function geminiResponsesCarrierTarget(item: unknown): string {
  return str(item, geminiResponsesCarrierTargetField);
}

export function isOpenAIResponsesDetachedCarrier(item: unknown): boolean {
  return str(item, "type") === "reasoning" && str(item, "encrypted_content").trim() !== "" && str(item, "summary.0.text").trim() === "";
}

