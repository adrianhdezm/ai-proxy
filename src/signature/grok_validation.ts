// Port of internal/signature/grok_validation.go.
import { decodeBase64, rawStdEncoding, bytesToLatin1 } from "../util/base64.ts";
import { isValidClaudeCAISSignature, isValidClaudeThinkingSignature, SignatureError } from "./claude_validation.ts";
import { inspectGeminiThoughtSignature } from "./gemini_validation.ts";
import { firstInvalidChar } from "./gpt_validation.ts";
import { isValidKimiThinkingSignature } from "./kimi_validation.ts";
import { base64AlphabetSet, isValidMetaReasoningSignature, isValidMetaRouterSuffix, maxMetaRouterSuffixLen } from "./meta_validation.ts";
import { maybeSelfDescribingSignatureEnvelope, splitSignatureProviderPrefix } from "./provider_compatibility.ts";

/** Transport safety cap for opaque replay blobs. */
export const maxGrokEncryptedContentLen = 8 * 1024 * 1024;
/** A deliberately loose floor; the entropy check does the real filtering. */
export const minGrokEncryptedContentDecodedLen = 32;
/** Rejects obvious non-ciphertext payloads; native samples are >= 0.892. */
export const minGrokEncryptedContentEntropyRatio = 0.85;

export interface GrokEncryptedContentInfo {
  rawLen: number;
  decodedLen: number;
  routerSuffix: string;
}

/**
 * Validates the transport shape of xAI/Grok reasoning encrypted_content. This is a
 * replay-safety check, not a provider classifier: xAI emits no envelope, so every
 * high-entropy unpadded standard-base64 blob passes. Callers must establish
 * provenance (target model) first.
 */
export function inspectGrokEncryptedContent(raw: string): GrokEncryptedContentInfo {
  const sig = raw.trim();
  if (sig === "") throw new SignatureError("empty Grok encrypted_content");
  if (sig.length > maxGrokEncryptedContentLen) throw new SignatureError(`Grok encrypted_content exceeds maximum length (${maxGrokEncryptedContentLen} bytes)`);
  if (sig !== raw) throw new SignatureError("Grok encrypted_content has leading or trailing whitespace");
  if (sig.includes("=")) throw new SignatureError("invalid Grok encrypted_content: expected unpadded standard base64");
  if (splitSignatureProviderPrefix(sig).ok) throw new SignatureError("invalid Grok encrypted_content: carries another provider's cache prefix");
  let native = sig;
  let routerSuffix = "";
  const dot = sig.indexOf(".");
  if (dot >= 0) {
    const tail = sig.slice(dot + 1);
    if (!isValidMetaRouterSuffix(tail)) throw new SignatureError(`invalid Grok encrypted_content: router suffix must be 1-${maxMetaRouterSuffixLen} alphanumeric characters`);
    native = sig.slice(0, dot);
    routerSuffix = tail;
  }
  const bad = firstInvalidChar(native, grokEncryptedContentCharSet);
  if (bad) throw new SignatureError(`invalid Grok encrypted_content: contains non-base64 character U+${bad.code.toString(16).toUpperCase().padStart(4, "0")} at byte ${bad.index}`);
  if (maybeSelfDescribingSignatureEnvelope(native)) {
    if (native.startsWith("gAAAA")) throw new SignatureError("Grok encrypted_content looks like GPT/Codex reasoning signature");
    if (isValidMetaReasoningSignature(native)) throw new SignatureError("Grok encrypted_content looks like Meta reasoning signature");
    if (isValidClaudeThinkingSignature(native, { strict: true })) throw new SignatureError("Grok encrypted_content looks like Claude thinking signature");
    if (isValidClaudeCAISSignature(native)) throw new SignatureError("Grok encrypted_content looks like Claude CAIS thinking signature");
    let geminiKnown = false;
    try {
      inspectGeminiThoughtSignature(native, { requireKnownEnvelope: true });
      geminiKnown = true;
    } catch {
      geminiKnown = false;
    }
    if (geminiKnown) throw new SignatureError("Grok encrypted_content looks like Gemini thoughtSignature");
  }
  if (isValidKimiThinkingSignature(native)) throw new SignatureError("Grok encrypted_content has a Kimi thinking signature length");
  const decoded = decodeBase64(native, rawStdEncoding);
  if (!decoded) throw new SignatureError("invalid Grok encrypted_content: base64 decode failed");
  if (bytesToLatin1(decoded.subarray(0, 28)).startsWith("cpa-codex-gemini-carrier-v1:")) {
    throw new SignatureError("invalid Grok encrypted_content: carries Gemini Codex thoughtSignature carrier");
  }
  if (decoded.length < minGrokEncryptedContentDecodedLen) throw new SignatureError(`invalid Grok encrypted_content: decoded payload too short (${decoded.length} bytes)`);
  const entropyRatio = byteEntropyRatio(decoded);
  if (entropyRatio < minGrokEncryptedContentEntropyRatio) {
    throw new SignatureError(`invalid Grok encrypted_content: decoded payload entropy ratio ${entropyRatio.toFixed(3)} below ${minGrokEncryptedContentEntropyRatio.toFixed(3)}`);
  }
  return { rawLen: sig.length, decodedLen: decoded.length, routerSuffix };
}

export function isValidGrokEncryptedContent(raw: string): boolean {
  try {
    inspectGrokEncryptedContent(raw);
    return true;
  } catch {
    return false;
  }
}

/** The unpadded standard base64 alphabet. */
export const grokEncryptedContentCharSet = base64AlphabetSet("+/");

export function byteEntropyRatio(buf: Uint8Array): number {
  if (buf.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const b of buf) counts[b]!++;
  const n = buf.length;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  const maxSymbols = Math.min(buf.length, 256);
  if (maxSymbols <= 1) return 0;
  return entropy / Math.log2(maxSymbols);
}
