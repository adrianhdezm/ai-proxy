// Port of internal/signature/gpt_validation.go.
import { decodeBase64, rawURLEncoding, urlEncoding } from "../util/base64.ts";
import { SignatureError } from "./claude_validation.ts";
import { base64AlphabetSet, isValidMetaRouterSuffix, maxMetaRouterSuffixLen } from "./meta_validation.ts";

export const maxGPTReasoningSignatureLen = 32 * 1024 * 1024;

export interface GPTReasoningSignatureInfo {
  decodedLen: number;
  ciphertextLen: number;
  /** The dot-delimited suffix a router such as OpenRouter appends after the native Fernet envelope. */
  routerSuffix: string;
}

export function isValidGPTReasoningSignature(rawSignature: string): boolean {
  try {
    inspectGPTReasoningSignature(rawSignature);
    return true;
  } catch {
    return false;
  }
}

/** Validates the Fernet-like outer format used by GPT/Codex reasoning encrypted_content (transport-shape check only). */
export function inspectGPTReasoningSignature(rawSignature: string): GPTReasoningSignatureInfo {
  const sig = rawSignature.trim();
  if (sig === "") throw new SignatureError("empty GPT reasoning signature");
  if (sig.length > maxGPTReasoningSignatureLen) throw new SignatureError(`GPT reasoning signature exceeds maximum length (${maxGPTReasoningSignatureLen} bytes)`);
  if (!sig.startsWith("gAAAA")) throw new SignatureError("invalid GPT reasoning signature: expected gAAAA prefix");
  let native = sig;
  let routerSuffix = "";
  const dot = sig.indexOf(".");
  if (dot >= 0) {
    const tail = sig.slice(dot + 1);
    if (!isValidMetaRouterSuffix(tail)) throw new SignatureError(`invalid GPT reasoning signature: router suffix must be 1-${maxMetaRouterSuffixLen} alphanumeric characters`);
    native = sig.slice(0, dot);
    routerSuffix = tail;
  }
  const bad = firstInvalidChar(native, gptReasoningSignatureCharSet);
  if (bad) throw new SignatureError(`invalid GPT reasoning signature: contains non-base64url character U+${bad.code.toString(16).toUpperCase().padStart(4, "0")} at byte ${bad.index}`);
  const decoded = decodeBase64(native, rawURLEncoding) ?? decodeBase64(native, urlEncoding);
  if (!decoded) throw new SignatureError("invalid GPT reasoning signature: base64url decode failed");
  if (decoded.length < 73) throw new SignatureError("invalid GPT reasoning signature: decoded payload too short");
  if (decoded[0] !== 0x80) throw new SignatureError(`invalid GPT reasoning signature: expected version 0x80, got 0x${decoded[0]!.toString(16).padStart(2, "0")}`);
  const ciphertextLen = decoded.length - 1 - 8 - 16 - 32;
  if (ciphertextLen <= 0 || ciphertextLen % 16 !== 0) throw new SignatureError(`invalid GPT reasoning signature: ciphertext length ${ciphertextLen} is not a positive AES block multiple`);
  return { decodedLen: decoded.length, ciphertextLen, routerSuffix };
}

/** The base64url alphabet, padding included. */
export const gptReasoningSignatureCharSet = base64AlphabetSet("-_=");

/** Returns the first character (by UTF-16 index; code point reported) outside the set, or undefined. */
export function firstInvalidChar(sig: string, set: Uint8Array): { index: number; code: number } | undefined {
  let byteIndex = 0;
  for (const ch of sig) {
    const code = ch.codePointAt(0)!;
    if (code > 255 || !set[code]) return { index: byteIndex, code };
    byteIndex += 1;
  }
  return undefined;
}
