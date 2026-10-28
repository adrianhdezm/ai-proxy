// Port of internal/signature/meta_validation.go.
import { decodeBase64 } from "../util/base64.ts";
import { SignatureError } from "./claude_validation.ts";

export const maxMetaReasoningSignatureLen = 32 * 1024 * 1024;
export const metaReasoningSignatureOverheadLen = 45;
export const metaReasoningSignatureMinPayload = 1024;
export const maxMetaRouterSuffixLen = 128;

/** The fixed five-byte prefix observed on every captured Meta Muse reasoning encrypted_content value. */
export const metaReasoningSignatureHeader = Uint8Array.from([0x43, 0xe3, 0xda, 0x0e, 0x01]);

export interface MetaReasoningSignatureInfo {
  decodedLen: number;
  /** decodedLen minus the fixed 45-byte envelope overhead (the power-of-two padded region). */
  payloadLen: number;
  bucketExponent: number;
  /** The dot-delimited router suffix; replay must forward the full value verbatim. */
  routerSuffix: string;
}

/** Builds a byte lookup table for the alphanumeric base64 core plus `extra`. */
export function base64AlphabetSet(extra: string): Uint8Array {
  const set = new Uint8Array(256);
  for (let c = 65; c <= 90; c++) set[c] = 1;
  for (let c = 97; c <= 122; c++) set[c] = 1;
  for (let c = 48; c <= 57; c++) set[c] = 1;
  for (let i = 0; i < extra.length; i++) set[extra.charCodeAt(i)] = 1;
  return set;
}

export function isValidMetaReasoningSignature(rawSignature: string): boolean {
  try {
    inspectMetaReasoningSignature(rawSignature);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the Meta Muse envelope shape: canonical unpadded base64url, the fixed
 * header, and a decoded length of exactly 45 + 1024*2^k bytes, optionally followed
 * by one "." plus a short alphanumeric router suffix.
 */
export function inspectMetaReasoningSignature(rawSignature: string): MetaReasoningSignatureInfo {
  const sig = rawSignature.trim();
  if (sig === "") throw new SignatureError("empty Meta reasoning signature");
  if (sig.length > maxMetaReasoningSignatureLen) throw new SignatureError(`Meta reasoning signature exceeds maximum length (${maxMetaReasoningSignatureLen} bytes)`);
  if (!sig.startsWith("Q-PaDg")) throw new SignatureError("invalid Meta reasoning signature: expected Q-PaDg prefix");
  let native = sig;
  let routerSuffix = "";
  const dot = sig.indexOf(".");
  if (dot >= 0) {
    const tail = sig.slice(dot + 1);
    if (!isValidMetaRouterSuffix(tail)) throw new SignatureError(`invalid Meta reasoning signature: router suffix must be 1-${maxMetaRouterSuffixLen} alphanumeric characters`);
    native = sig.slice(0, dot);
    routerSuffix = tail;
  }
  const info = inspectNativeMetaReasoningSignature(native);
  info.routerSuffix = routerSuffix;
  return info;
}

function inspectNativeMetaReasoningSignature(sig: string): MetaReasoningSignatureInfo {
  if (!sig.startsWith("Q-PaDg")) throw new SignatureError("invalid Meta reasoning signature: expected Q-PaDg prefix");
  if (sig.length % 4 === 1) throw new SignatureError(`invalid Meta reasoning signature: base64url length ${sig.length} cannot decode`);
  let decodedLen = Math.floor(sig.length / 4) * 3;
  if (sig.length % 4 === 2) decodedLen++;
  else if (sig.length % 4 === 3) decodedLen += 2;
  const payloadLen = decodedLen - metaReasoningSignatureOverheadLen;
  if (payloadLen < metaReasoningSignatureMinPayload || (payloadLen & (payloadLen - 1)) !== 0) {
    throw new SignatureError(`invalid Meta reasoning signature: payload length ${payloadLen} is not a power-of-two bucket`);
  }
  for (let i = 0; i < sig.length; i++) {
    const c = sig.charCodeAt(i);
    if (c > 255 || !metaReasoningSignatureCharSet[c]) {
      throw new SignatureError(`invalid Meta reasoning signature: contains non-base64url character U+${c.toString(16).toUpperCase().padStart(4, "0")} at byte ${i}`);
    }
  }
  const decoded = decodeBase64(sig, { url: true, padding: false, strict: true });
  if (!decoded) throw new SignatureError("invalid Meta reasoning signature: base64url decode failed");
  for (let i = 0; i < metaReasoningSignatureHeader.length; i++) {
    if (decoded[i] !== metaReasoningSignatureHeader[i]) throw new SignatureError("invalid Meta reasoning signature: unexpected envelope header");
  }
  let exponent = 0;
  for (let p = payloadLen; p > metaReasoningSignatureMinPayload; p >>= 1) exponent++;
  return { decodedLen: decoded.length, payloadLen, bucketExponent: exponent, routerSuffix: "" };
}

/** The unpadded base64url alphabet. */
export const metaReasoningSignatureCharSet = base64AlphabetSet("-_");

/** The alphanumeric-only alphabet observed on router-appended suffixes. */
export const metaRouterSuffixCharSet = base64AlphabetSet("");

export function isValidMetaRouterSuffix(suffix: string): boolean {
  if (suffix.length === 0 || suffix.length > maxMetaRouterSuffixLen) return false;
  for (let i = 0; i < suffix.length; i++) {
    const c = suffix.charCodeAt(i);
    if (c > 255 || !metaRouterSuffixCharSet[c]) return false;
  }
  return true;
}
