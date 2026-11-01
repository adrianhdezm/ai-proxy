// Port of internal/signature/gemini_validation.go.
//
// Gemini thought signatures are opaque provider state; local validation checks only
// the transport-level protobuf envelope (field-2 -> field-1 wrapping a Tink payload,
// provider UUID or server-side tool invocation message) or the Vertex bare-Tink form.
import { decodeBase64, rawStdEncoding, stdEncoding } from "../util/base64.ts";
import { getAt, gstr, isObj } from "../util/gpath.ts";
import { isValidClaudeCAISSignature, SignatureError } from "./claude_validation.ts";
import { consumeBytes, consumeFixed32, consumeFixed64, consumeTag, consumeVarint, WireBytes, WireFixed32, WireFixed64, WireVarint } from "./protowire.ts";
import { signaturePayloadWithoutProviderPrefix } from "./provider_compatibility.ts";

export const maxGeminiThoughtSignatureLen = 32 * 1024 * 1024;
export const geminiSkipThoughtSignatureValidator = "skip_thought_signature_validator";
export const geminiContextEngineeringBypass = "context_engineering_is_the_way_to_go";

export interface GeminiThoughtSignatureValidationOptions {
  /** Accepts Gemini's documented synthetic-history bypass sentinels. */
  allowBypassSentinel?: boolean;
  /** Requires the decoded payload to match one of the observed protobuf envelopes. */
  requireKnownEnvelope?: boolean;
  /** Requires the decoded payload to start with 0x12. */
  requireObservedMarker?: boolean;
}

export type GeminiThoughtSignatureEnvelope = "unknown" | "protobuf_field_2" | "bare_tink" | "ascii_uuid";

export interface GeminiThoughtSignatureInfo {
  isBypassSentinel: boolean;
  bypassSentinel: string;
  decodedLen: number;
  firstByte: number;
  hasObservedMarker: boolean;
  knownEnvelope: boolean;
  envelope: GeminiThoughtSignatureEnvelope;
  recordCount: number;
  opaquePayloadLen: number;
}

/** Whether rawSignature is one of Gemini's documented bypass sentinels. */
export function isGeminiThoughtSignatureBypass(rawSignature: string): boolean {
  const s = rawSignature.trim();
  return s === geminiSkipThoughtSignatureValidator || s === geminiContextEngineeringBypass;
}

export function isValidGeminiThoughtSignature(rawSignature: string, opt: GeminiThoughtSignatureValidationOptions = {}): boolean {
  try {
    inspectGeminiThoughtSignature(rawSignature, opt);
    return true;
  } catch {
    return false;
  }
}

/** Validates and inspects the local transport shape of a Gemini thought signature. Throws SignatureError. */
export function inspectGeminiThoughtSignature(rawSignature: string, opt: GeminiThoughtSignatureValidationOptions = {}): GeminiThoughtSignatureInfo {
  const sig = rawSignature.trim();
  if (sig === "") throw new SignatureError("empty Gemini thought signature");
  if (isValidClaudeCAISSignature(sig)) throw new SignatureError("invalid Gemini thought signature: detected Claude CAIS signature");
  if (isGeminiThoughtSignatureBypass(sig)) {
    if (!opt.allowBypassSentinel) throw new SignatureError("Gemini thought signature bypass sentinel is not allowed");
    return { isBypassSentinel: true, bypassSentinel: sig, decodedLen: 0, firstByte: 0, hasObservedMarker: false, knownEnvelope: false, envelope: "unknown", recordCount: 0, opaquePayloadLen: 0 };
  }
  const decoded = decodeGeminiThoughtSignature(sig);
  if (decoded.length === 0) throw new SignatureError("invalid Gemini thought signature: empty decoded payload");
  const [envelope, knownEnvelope] = classifyGeminiThoughtSignatureEnvelope(decoded);
  const [recordCount, opaquePayloadLen] = inspectGeminiEnvelope(decoded, envelope);
  const info: GeminiThoughtSignatureInfo = {
    isBypassSentinel: false,
    bypassSentinel: "",
    decodedLen: decoded.length,
    firstByte: decoded[0]!,
    hasObservedMarker: decoded[0] === 0x12,
    knownEnvelope,
    envelope,
    recordCount,
    opaquePayloadLen,
  };
  if (opt.requireKnownEnvelope && !info.knownEnvelope) throw new SignatureError(`invalid Gemini thought signature: unknown envelope "${info.envelope}"`);
  if (opt.requireObservedMarker && !info.hasObservedMarker) {
    throw new SignatureError(`invalid Gemini thought signature: expected observed marker 0x12, got 0x${info.firstByte.toString(16).padStart(2, "0")}`);
  }
  return info;
}

function geminiContents(root: unknown): { contents: unknown; path: string } {
  const contents = getAt(root, "contents");
  if (contents !== undefined) return { contents, path: "contents" };
  return { contents: getAt(root, "request.contents"), path: "request.contents" };
}

function parseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Validates thoughtSignature fields in a Gemini native payload: the first
 * functionCall in each parallel-call group of a model turn must carry a valid
 * provider signature (or an allowed sentinel); other signatures must still be valid.
 * Returns an error message or undefined.
 */
export function validateGeminiThoughtSignatures(inputRawJSON: string, opt: GeminiThoughtSignatureValidationOptions = {}): string | undefined {
  const { contents, path: contentsPath } = geminiContents(parseJSON(inputRawJSON));
  if (!Array.isArray(contents)) return undefined;
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    const parts = getAt(content, "parts");
    if (!Array.isArray(parts)) continue;
    const isModelTurn = gstr(getAt(content, "role")).trim().toLowerCase() === "model";
    let firstFunctionCallSeen = false;
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      const hasFunctionCall = getAt(part, "functionCall") !== undefined;
      const isFirstFunctionCall = isModelTurn && hasFunctionCall && !firstFunctionCallSeen;
      if (isModelTurn && (hasFunctionCall || !getAt(part, "thought"))) firstFunctionCallSeen = hasFunctionCall;
      const { signature, has } = geminiPartThoughtSignature(part);
      if (!hasFunctionCall && !has) continue;
      const partPath = `${contentsPath}[${i}].parts[${j}]`;
      const rawSignature = signature.trim();
      if (getAt(part, "functionResponse") !== undefined && has) return `${partPath}: functionResponse must not carry thoughtSignature`;
      if (rawSignature === "") {
        if (isFirstFunctionCall) return `${partPath}: missing thoughtSignature on first functionCall`;
        if (has) return `${partPath}: empty thoughtSignature`;
        continue;
      }
      if (isGeminiThoughtSignatureBypass(rawSignature) && !isFirstFunctionCall) return `${partPath}: Gemini bypass sentinel is allowed only on the first model functionCall`;
      if (!hasNormalizedGeminiPartThoughtSignature(part, rawSignature)) return `${partPath}: thoughtSignature must use one canonical top-level field`;
      try {
        inspectGeminiThoughtSignature(rawSignature, opt);
      } catch (err) {
        return `${partPath}: ${(err as Error).message}`;
      }
    }
  }
  return undefined;
}

/**
 * Validates the replay shape around Gemini functionCall/functionResponse parts:
 * id/name pairing and no interleaving inside one content. Returns an error message or undefined.
 */
export function validateGeminiFunctionCallPairing(inputRawJSON: string): string | undefined {
  const { contents, path: contentsPath } = geminiContents(parseJSON(inputRawJSON));
  if (!Array.isArray(contents)) return undefined;
  interface CallRef {
    id: string;
    name: string;
    path: string;
  }
  let pending: CallRef[] = [];
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    const parts = getAt(content, "parts");
    if (!Array.isArray(parts) || parts.length === 0) {
      if (pending.length > 0) return `${contentsPath}[${i}]: content appears before ${pending.length} pending functionResponse part(s)`;
      continue;
    }
    const calls: CallRef[] = [];
    const responses: { part: unknown; path: string }[] = [];
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      const partPath = `${contentsPath}[${i}].parts[${j}]`;
      const call = getAt(part, "functionCall");
      if (call !== undefined) {
        if (gstr(getAt(call, "name")) === "") return `${partPath}: missing functionCall.name`;
        calls.push({ id: gstr(getAt(call, "id")), name: gstr(getAt(call, "name")), path: partPath });
      }
      if (getAt(part, "functionResponse") !== undefined) responses.push({ part, path: partPath });
    }
    if (calls.length > 0 && responses.length > 0) return `${contentsPath}[${i}]: functionCall and functionResponse parts must not be interleaved in the same content`;
    if (calls.length > 0 && pending.length > 0) return `${contentsPath}[${i}]: functionCall appears before ${pending.length} pending functionResponse part(s)`;
    if (calls.length > 0) {
      pending = calls;
      continue;
    }
    if (responses.length === 0 && pending.length > 0) {
      if (gstr(getAt(content, "role")).trim().toLowerCase() === "model") return `${contentsPath}[${i}]: model content appears before ${pending.length} pending functionResponse part(s)`;
      continue;
    }
    if (responses.length === 0) continue;
    if (pending.length === 0) return `${contentsPath}[${i}]: functionResponse without preceding functionCall`;
    if (responses.length !== pending.length) return `${contentsPath}[${i}]: functionResponse count ${responses.length} does not match pending functionCall count ${pending.length}`;
    for (let r = 0; r < responses.length; r++) {
      const partPath = responses[r]!.path;
      const response = getAt(responses[r]!.part, "functionResponse");
      const call = pending[r]!;
      const responseID = gstr(getAt(response, "id"));
      const responseName = gstr(getAt(response, "name"));
      if (call.id !== "" && responseID === "") return `${partPath}: missing functionResponse.id for ${call.path}`;
      if (call.id !== "" && responseID !== call.id) return `${partPath}: functionResponse.id "${responseID}" does not match functionCall.id "${call.id}" at ${call.path}`;
      if (responseName === "") return `${partPath}: missing functionResponse.name`;
      if (call.name !== "" && responseName !== call.name) return `${partPath}: functionResponse.name "${responseName}" does not match functionCall.name "${call.name}" at ${call.path}`;
    }
    pending = [];
  }
  return undefined;
}

function decodeGeminiThoughtSignature(sig: string): Uint8Array {
  if (sig.length > maxGeminiThoughtSignatureLen) throw new SignatureError(`Gemini thought signature exceeds maximum length (${maxGeminiThoughtSignatureLen} bytes)`);
  const decoded = decodeBase64(sig, stdEncoding) ?? decodeBase64(sig, rawStdEncoding);
  if (!decoded) throw new SignatureError("invalid Gemini thought signature: base64 decode failed");
  return decoded;
}

function classifyGeminiThoughtSignatureEnvelope(decoded: Uint8Array): [GeminiThoughtSignatureEnvelope, boolean] {
  if (decoded.length === 0) return ["unknown", false];
  if (isASCIIUUIDBytes(decoded)) return ["ascii_uuid", false];
  if (isGeminiField2Envelope(decoded)) return ["protobuf_field_2", true];
  if (isGeminiBareTinkEnvelope(decoded)) return ["bare_tink", true];
  return ["unknown", false];
}

function isGeminiField2Envelope(decoded: Uint8Array): boolean {
  const info = inspectGeminiField2Envelope(decoded);
  return info !== undefined && info.recordCount === 1 && info.opaquePayloadLen > 0;
}

function inspectGeminiEnvelope(decoded: Uint8Array, envelope: GeminiThoughtSignatureEnvelope): [number, number] {
  if (envelope === "protobuf_field_2") {
    const info = inspectGeminiField2Envelope(decoded);
    if (info) return [info.recordCount, info.opaquePayloadLen];
  } else if (envelope === "bare_tink" && isGeminiBareTinkEnvelope(decoded)) {
    return [1, decoded.length];
  }
  return [0, 0];
}

/** Structural floor for a bare Tink payload: prefix byte, four-byte key id, 16-byte tag. */
export const geminiBareTinkMinLen = 1 + 4 + 16;

/** Tink key ids observed on the Vertex AI serve path. */
const geminiVertexBareTinkKeyIDs: number[][] = [[0x8f, 0x3d, 0x6b, 0x5f]];

function isGeminiBareTinkEnvelope(decoded: Uint8Array): boolean {
  if (decoded.length < geminiBareTinkMinLen || decoded[0] !== 0x01) return false;
  return geminiVertexBareTinkKeyIDs.some((known) => known.every((b, i) => decoded[1 + i] === b));
}

/** Whether rawSignature is a Vertex AI bare-Tink thought signature (incompatible with non-Vertex Gemini endpoints). */
export function isGeminiVertexBareTinkSignature(rawSignature: string): boolean {
  try {
    const info = inspectGeminiThoughtSignature(signaturePayloadWithoutProviderPrefix(rawSignature), { requireKnownEnvelope: true });
    return info.envelope === "bare_tink";
  } catch {
    return false;
  }
}

function inspectGeminiField2Envelope(decoded: Uint8Array): { recordCount: number; opaquePayloadLen: number } | undefined {
  const value = consumeGeminiField2Field1Value(decoded);
  if (!value || (!isLikelyGeminiOpaquePayload(value) && !isASCIIUUIDBytes(value) && !isLikelyGeminiToolInvocationPayload(value))) return undefined;
  return { recordCount: 1, opaquePayloadLen: value.length };
}

function consumeGeminiField2Field1Value(decoded: Uint8Array): Uint8Array | undefined {
  const tag = consumeTag(decoded, 0);
  if (!tag || tag.num !== 2 || tag.type !== WireBytes) return undefined;
  const container = consumeBytes(decoded, tag.n);
  if (!container || tag.n + container.n !== decoded.length) return undefined;
  const innerTag = consumeTag(container.value, 0);
  if (!innerTag || innerTag.num !== 1 || innerTag.type !== WireBytes) return undefined;
  const value = consumeBytes(container.value, innerTag.n);
  if (!value || innerTag.n + value.n !== container.value.length) return undefined;
  return value.value;
}

function isLikelyGeminiOpaquePayload(value: Uint8Array): boolean {
  // The envelope body is a Tink primitive output: prefix-type byte 0x01, key id, ciphertext.
  return value.length > 0 && value[0] === 0x01;
}

function isLikelyGeminiToolInvocationPayload(value: Uint8Array): boolean {
  if (value.length === 0) return false;
  let offset = 0;
  let hasTinkField = false;
  while (offset < value.length) {
    const tag = consumeTag(value, offset);
    if (!tag) return false;
    offset += tag.n;
    switch (tag.type) {
      case WireVarint: {
        const v = consumeVarint(value, offset);
        if (!v) return false;
        offset += v.n;
        break;
      }
      case WireBytes: {
        const b = consumeBytes(value, offset);
        if (!b) return false;
        offset += b.n;
        if (isLikelyGeminiOpaquePayload(b.value)) hasTinkField = true;
        break;
      }
      case WireFixed32: {
        const n = consumeFixed32(value, offset);
        if (n < 0) return false;
        offset += n;
        break;
      }
      case WireFixed64: {
        const n = consumeFixed64(value, offset);
        if (n < 0) return false;
        offset += n;
        break;
      }
      default:
        return false;
    }
  }
  return hasTinkField && offset === value.length;
}

function isASCIIUUIDBytes(decoded: Uint8Array): boolean {
  if (decoded.length !== 36) return false;
  for (let i = 0; i < decoded.length; i++) {
    const b = decoded[i]!;
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (b !== 0x2d) return false;
    } else if (!((b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46))) {
      return false;
    }
  }
  return true;
}

export const geminiPartThoughtSignaturePaths = [
  "thoughtSignature",
  "thought_signature",
  "functionCall.thoughtSignature",
  "functionCall.thought_signature",
  "functionResponse.thoughtSignature",
  "functionResponse.thought_signature",
  "extra_content.google.thought_signature",
];

/** The first thought signature carried by a Gemini part under any of its known paths. */
export function geminiPartThoughtSignature(part: unknown): { signature: string; has: boolean } {
  for (const path of geminiPartThoughtSignaturePaths) {
    const result = getAt(part, path);
    if (result !== undefined) return { signature: gstr(result), has: true };
  }
  return { signature: "", has: false };
}

/** Whether the part carries exactly one canonical string thoughtSignature equal to replaySignature and no aliases. */
export function hasNormalizedGeminiPartThoughtSignature(part: unknown, replaySignature: string): boolean {
  if (!isObj(part)) return false;
  const canonical = part.thoughtSignature;
  if (typeof canonical !== "string" || canonical !== replaySignature) return false;
  for (const path of geminiPartThoughtSignaturePaths.slice(1)) if (getAt(part, path) !== undefined) return false;
  return true;
}
