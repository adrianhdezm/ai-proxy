// Port of internal/translator/gemini/openai/responses/trailing_signature.go.
//
// Keeps text signature carriers off the client-visible reasoning timeline. The
// replay cache bounds their lifetime and size.
import { parseSuffix } from "../../../../thinking/index.ts";
import { sha256Hex } from "../../../../util/hash.ts";
import { str } from "./helpers.ts";
import { cacheReplayItems, getReplayItems } from "./replay_cache.ts";
import {
  compatibleGeminiResponsesCarrierSignature,
  decodeGeminiResponsesCarrier,
  encodeGeminiResponsesCarrier,
  geminiResponsesCarrierPrevious,
  geminiResponsesCarrierText,
  isOpenAIResponsesDetachedCarrier,
  openAIResponsesAssistantVisibleText,
} from "./signature_carrier.ts";

const textSignatureSessionPrefix = "gemini-responses-text:";

export function cacheGeminiResponsesTextSignatures(modelName: string, messageID: string, text: string, signatures: string[]): boolean {
  if (messageID === "" || text === "") return false;
  const textHash = sha256Hex(text);
  const items: string[] = [];
  for (const signature of signatures) {
    if (compatibleGeminiResponsesCarrierSignature(signature, geminiResponsesCarrierText) === undefined) return false;
    items.push(JSON.stringify({ type: "thought_signature", targetKind: "text", thoughtSignature: signature, targetHash: textHash }));
  }
  return cacheReplayItems(parseSuffix(modelName).modelName, textSignatureSessionPrefix + messageID, items);
}

export function restoreGeminiResponsesTextSignatures(modelName: string, items: unknown[]): unknown[] {
  const restored: unknown[] = [];
  const skip = new Set<number>();
  items.forEach((item, index) => {
    if (skip.has(index)) return;
    restored.push(item);
    const text = openAIResponsesAssistantVisibleText(item);
    const messageID = str(item, "id").trim();
    if (text === undefined || messageID === "") return;
    const cached = getReplayItems(parseSuffix(modelName).modelName, textSignatureSessionPrefix + messageID);
    if (!cached) return;
    // Replay the cached prefix in its original order, then retain uncached explicit carriers.
    const replayed = new Set<string>();
    const textHash = sha256Hex(text);
    for (const raw of cached) {
      let entry: unknown;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      const signature = str(entry, "thoughtSignature");
      if (str(entry, "targetHash") !== textHash) continue;
      restored.push({ type: "reasoning", summary: [], encrypted_content: encodeGeminiResponsesCarrier(signature, geminiResponsesCarrierPrevious, geminiResponsesCarrierText) });
      replayed.add(signature);
    }
    for (let adjacent = index + 1; adjacent < items.length && isOpenAIResponsesDetachedCarrier(items[adjacent]); adjacent++) {
      const decoded = decodeGeminiResponsesCarrier(str(items[adjacent], "encrypted_content"));
      if (decoded.ok && decoded.direction === geminiResponsesCarrierPrevious && decoded.targetKind === geminiResponsesCarrierText && replayed.has(decoded.signature)) skip.add(adjacent);
    }
  });
  return restored;
}
