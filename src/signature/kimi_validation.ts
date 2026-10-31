// Port of internal/signature/kimi_validation.go.
//
// Kimi thinking signatures carry no envelope; the raw signature length is fixed per
// protocol mode (12946 characters non-streaming, 4340 streaming). This probe runs
// after every self-describing envelope check has declined.
import { decodeBase64, rawStdEncoding } from "../util/base64.ts";
import { isValidClaudeCAISSignature, isValidClaudeThinkingSignature, SignatureError } from "./claude_validation.ts";
import { isValidGeminiThoughtSignature } from "./gemini_validation.ts";
import { firstInvalidChar } from "./gpt_validation.ts";
import { byteEntropyRatio, grokEncryptedContentCharSet } from "./grok_validation.ts";
import { maybeSelfDescribingSignatureEnvelope, splitSignatureProviderPrefix } from "./provider_compatibility.ts";

export const kimiThinkingSignatureNonStreamingLen = 12946;
export const kimiThinkingSignatureStreamingLen = 4340;

export type KimiThinkingSignatureMode = "non_streaming" | "streaming";

export const kimiThinkingSignatureLens = new Map<number, KimiThinkingSignatureMode>([
  [kimiThinkingSignatureNonStreamingLen, "non_streaming"],
  [kimiThinkingSignatureStreamingLen, "streaming"],
]);

export const minKimiThinkingSignatureEntropyRatio = 0.85;

export interface KimiThinkingSignatureInfo {
  rawLen: number;
  decodedLen: number;
  mode: KimiThinkingSignatureMode;
}

/** Validates the transport shape of a Kimi Messages thinking signature (size and character class only). */
export function inspectKimiThinkingSignature(raw: string): KimiThinkingSignatureInfo {
  const sig = raw.trim();
  if (sig === "") throw new SignatureError("empty Kimi thinking signature");
  if (sig !== raw) throw new SignatureError("Kimi thinking signature has leading or trailing whitespace");
  const mode = kimiThinkingSignatureLens.get(sig.length);
  if (!mode) throw new SignatureError(`invalid Kimi thinking signature: unexpected length ${sig.length}`);
  if (sig.includes("=")) throw new SignatureError("invalid Kimi thinking signature: expected unpadded standard base64");
  const bad = firstInvalidChar(sig, grokEncryptedContentCharSet);
  if (bad) throw new SignatureError(`invalid Kimi thinking signature: contains non-base64 character U+${bad.code.toString(16).toUpperCase().padStart(4, "0")} at byte ${bad.index}`);
  if (splitSignatureProviderPrefix(sig).ok) throw new SignatureError("invalid Kimi thinking signature: carries another provider's cache prefix");
  if (maybeSelfDescribingSignatureEnvelope(sig)) {
    if (sig.startsWith("gAAAA")) throw new SignatureError("Kimi thinking signature looks like GPT/Codex reasoning signature");
    if (isValidClaudeCAISSignature(sig)) throw new SignatureError("Kimi thinking signature looks like Claude CAIS thinking signature");
    if (isValidClaudeThinkingSignature(sig, { strict: true })) throw new SignatureError("Kimi thinking signature looks like Claude thinking signature");
    if (isValidGeminiThoughtSignature(sig, { requireKnownEnvelope: true })) throw new SignatureError("Kimi thinking signature looks like Gemini thoughtSignature");
  }
  const decoded = decodeBase64(sig, rawStdEncoding);
  if (!decoded) throw new SignatureError("invalid Kimi thinking signature: base64 decode failed");
  const entropyRatio = byteEntropyRatio(decoded);
  if (entropyRatio < minKimiThinkingSignatureEntropyRatio) {
    throw new SignatureError(`invalid Kimi thinking signature: decoded payload entropy ratio ${entropyRatio.toFixed(3)} below ${minKimiThinkingSignatureEntropyRatio.toFixed(3)}`);
  }
  return { rawLen: sig.length, decodedLen: decoded.length, mode };
}

export function isValidKimiThinkingSignature(raw: string): boolean {
  try {
    inspectKimiThinkingSignature(raw);
    return true;
  } catch {
    return false;
  }
}
