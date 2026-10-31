// Port of internal/signature/claude_validation.go and claude_antigravity_validation.go.
//
// Claude thinking signatures use base64 in one or two layers; the first character
// selects the envelope: 'E' single-layer (payload[0] == 0x12), 'R' double-layer
// (inner starts with 'E'), 'C' CAIS (payload[0] == 0x08) and 'Q' the double-layer
// Antigravity CAQS wrapper. See the Go source for the protobuf field layout.
import { decodeBase64, encodeBase64, latin1ToBytes, bytesToLatin1, stdEncoding, utf8DecodeStrict } from "../util/base64.ts";
import { consumeBytes, consumeVarint, walkFields, WireBytes, WireVarint } from "./protowire.ts";

export const maxClaudeThinkingSignatureLen = 32 * 1024 * 1024;

/** Controls how far Claude thinking signatures are inspected. */
export interface ClaudeSignatureValidationOptions {
  /** Checks the legacy E/R prefix or a fully validated Q envelope. */
  prefixOnly?: boolean;
  /** Checks the cache prefix, E/R prefix and base64 layers without validating the decoded marker. */
  base64Only?: boolean;
  /** Preserves empty thinking placeholders with no signature and no text during strip operations. */
  allowEmptySignatureWithEmptyText?: boolean;
  /** Additionally verifies the classic protobuf tree. */
  strict?: boolean;
}

/** The protobuf fields currently used for Claude thinking signature routing. */
export interface ClaudeSignatureTree {
  encodingLayers: number;
  channelID: number;
  field2?: number;
  routingClass: string;
  infrastructureClass: string;
  schemaFeatures: string;
  modelText: string;
  legacyRouteHint: string;
  hasField7: boolean;
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

function decodeStd(sig: string): Uint8Array | null {
  return decodeBase64(sig, stdEncoding);
}

/** Returns whether rawSignature is a valid Claude thinking signature under the options. */
export function isValidClaudeThinkingSignature(rawSignature: string, opt: ClaudeSignatureValidationOptions = {}): boolean {
  if (opt.prefixOnly) return hasClaudeThinkingSignaturePrefix(rawSignature);
  if (opt.base64Only) return hasDecodableClaudeThinkingSignature(rawSignature);
  try {
    normalizeClaudeThinkingSignature(rawSignature, opt);
    return true;
  } catch {
    return false;
  }
}

/** Checks legacy E/R encoding or a strictly validated Antigravity double-layer CAQS envelope. */
export function hasDecodableClaudeThinkingSignature(rawSignature: string): boolean {
  const sig = stripClaudeSignaturePrefix(rawSignature);
  if (sig === "" || sig.length > maxClaudeThinkingSignatureLen) return false;
  switch (sig[0]) {
    case "Q":
      return tryInspect(() => inspectAntigravityClaudeCAQSSignature(sig));
    case "E": {
      const decoded = decodeStd(sig);
      return decoded !== null && decoded.length > 0;
    }
    case "R": {
      const decoded = decodeStd(sig);
      if (decoded === null || decoded.length === 0 || decoded[0] !== 0x45) return false;
      const inner = decodeStd(bytesToLatin1(decoded));
      return inner !== null && inner.length > 0;
    }
    default:
      return false;
  }
}

/** Whether rawSignature has the Claude E/R prefix or a structurally valid Q envelope after cache-prefix removal. */
export function hasClaudeThinkingSignaturePrefix(rawSignature: string): boolean {
  const sig = stripClaudeSignaturePrefix(rawSignature);
  if (sig === "") return false;
  if (sig[0] === "Q") return tryInspect(() => inspectAntigravityClaudeCAQSSignature(sig));
  return sig[0] === "E" || sig[0] === "R";
}

function tryInspect(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

export function stripClaudeSignaturePrefix(rawSignature: string): string {
  let sig = rawSignature.trim();
  if (sig === "") return "";
  const idx = sig.indexOf("#");
  if (idx >= 0) sig = sig.slice(idx + 1).trim();
  return sig;
}

/** Validates every thinking block signature in a Claude messages payload; returns an error message or undefined. */
export function validateClaudeThinkingSignatures(inputRawJSON: string, opt: ClaudeSignatureValidationOptions = {}): string | undefined {
  let root: unknown;
  try {
    root = JSON.parse(inputRawJSON);
  } catch {
    return undefined;
  }
  const messages = (root as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = 0; i < messages.length; i++) {
    const content = (messages[i] as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      const part = content[j] as Record<string, unknown> | null;
      if (!part || part.type !== "thinking") continue;
      const rawSignature = typeof part.signature === "string" ? part.signature.trim() : "";
      if (rawSignature === "") return `messages[${i}].content[${j}]: missing thinking signature`;
      try {
        normalizeClaudeThinkingSignature(rawSignature, opt);
      } catch (err) {
        return `messages[${i}].content[${j}]: ${(err as Error).message}`;
      }
    }
  }
  return undefined;
}

/** Strips any cache prefix, validates, and returns the double-layer R or Q form expected by Antigravity. Throws SignatureError. */
export function normalizeClaudeThinkingSignature(rawSignature: string, opt: ClaudeSignatureValidationOptions = {}): string {
  const sig = stripClaudeSignaturePrefix(rawSignature);
  if (sig === "") throw new SignatureError("empty signature");
  if (sig.length > maxClaudeThinkingSignatureLen) throw new SignatureError(`signature exceeds maximum length (${maxClaudeThinkingSignatureLen} bytes)`);
  switch (sig[0]) {
    case "Q":
      inspectAntigravityClaudeCAQSSignature(sig);
      return sig;
    case "R":
      validateClaudeDoubleLayerSignature(sig, opt);
      return sig;
    case "E":
      validateClaudeSingleLayerSignature(sig, opt);
      return encodeBase64(latin1ToBytes(sig), stdEncoding);
    default:
      throw new SignatureError(`invalid signature: expected 'E', 'R' or 'Q' prefix, got "${sig[0]}"`);
  }
}

/** Strips any cache prefix, validates, and returns the single-layer E-form expected by Claude-native providers. */
export function normalizeClaudeProviderNativeThinkingSignature(rawSignature: string, opt: ClaudeSignatureValidationOptions = {}): string {
  const sig = stripClaudeSignaturePrefix(rawSignature);
  if (sig === "") throw new SignatureError("empty signature");
  if (sig.length > maxClaudeThinkingSignatureLen) throw new SignatureError(`signature exceeds maximum length (${maxClaudeThinkingSignatureLen} bytes)`);
  switch (sig[0]) {
    case "E":
      validateClaudeSingleLayerSignature(sig, opt);
      return sig;
    case "R": {
      validateClaudeDoubleLayerSignature(sig, opt);
      const decoded = decodeStd(sig);
      if (!decoded) throw new SignatureError("invalid double-layer signature: base64 decode failed");
      return bytesToLatin1(decoded);
    }
    default:
      throw new SignatureError(`invalid signature: expected 'E' or 'R' prefix, got "${sig[0]}"`);
  }
}

function validateClaudeDoubleLayerSignature(sig: string, opt: ClaudeSignatureValidationOptions): void {
  const decoded = decodeStd(sig);
  if (!decoded) throw new SignatureError("invalid double-layer signature: base64 decode failed");
  if (decoded.length === 0) throw new SignatureError("invalid double-layer signature: empty after decode");
  if (decoded[0] !== 0x45) throw new SignatureError(`invalid double-layer signature: inner does not start with 'E', got 0x${decoded[0]!.toString(16).padStart(2, "0")}`);
  validateClaudeSingleLayerSignatureContent(bytesToLatin1(decoded), 2, opt);
}

function validateClaudeSingleLayerSignature(sig: string, opt: ClaudeSignatureValidationOptions): void {
  validateClaudeSingleLayerSignatureContent(sig, 1, opt);
}

function validateClaudeSingleLayerSignatureContent(sig: string, encodingLayers: number, opt: ClaudeSignatureValidationOptions): void {
  const decoded = decodeStd(sig);
  if (!decoded) throw new SignatureError("invalid single-layer signature: base64 decode failed");
  if (decoded.length === 0) throw new SignatureError("invalid single-layer signature: empty after decode");
  if (decoded[0] !== 0x12) throw new SignatureError(`invalid Claude signature: expected first byte 0x12, got 0x${decoded[0]!.toString(16).padStart(2, "0")}`);
  if (!opt.strict) return;
  inspectClaudeSignaturePayload(decoded, encodingLayers);
}

/** Decodes and inspects a double-layer Claude thinking signature. */
export function inspectClaudeDoubleLayerSignature(sig: string): ClaudeSignatureTree {
  const decoded = decodeStd(sig);
  if (!decoded) throw new SignatureError("invalid double-layer signature: base64 decode failed");
  if (decoded.length === 0) throw new SignatureError("invalid double-layer signature: empty after decode");
  if (decoded[0] !== 0x45) throw new SignatureError("invalid double-layer signature: inner does not start with 'E'");
  return inspectClaudeSingleLayerSignatureWithLayers(bytesToLatin1(decoded), 2);
}

/** Decodes and inspects a single-layer Claude thinking signature. */
export function inspectClaudeSingleLayerSignature(sig: string): ClaudeSignatureTree {
  return inspectClaudeSingleLayerSignatureWithLayers(sig, 1);
}

function inspectClaudeSingleLayerSignatureWithLayers(sig: string, encodingLayers: number): ClaudeSignatureTree {
  const decoded = decodeStd(sig);
  if (!decoded) throw new SignatureError("invalid single-layer signature: base64 decode failed");
  if (decoded.length === 0) throw new SignatureError("invalid single-layer signature: empty after decode");
  return inspectClaudeSignaturePayload(decoded, encodingLayers);
}

/** Inspects the decoded Claude thinking signature protobuf payload. */
export function inspectClaudeSignaturePayload(payload: Uint8Array, encodingLayers: number): ClaudeSignatureTree {
  if (payload.length === 0) throw new SignatureError("invalid Claude signature: empty payload");
  if (payload[0] !== 0x12) throw new SignatureError(`invalid Claude signature: expected first byte 0x12, got 0x${payload[0]!.toString(16).padStart(2, "0")}`);
  const container = extractClaudeBytesField(payload, 2, "top-level protobuf");
  const channelBlock = extractClaudeBytesField(container, 1, "Claude Field 2 container");
  return inspectClaudeChannelBlock(channelBlock, encodingLayers);
}

function inspectClaudeChannelBlock(channelBlock: Uint8Array, encodingLayers: number): ClaudeSignatureTree {
  const tree: ClaudeSignatureTree = {
    encodingLayers,
    channelID: 0,
    routingClass: "unknown",
    infrastructureClass: "infra_unknown",
    schemaFeatures: "unknown_schema_features",
    modelText: "",
    legacyRouteHint: "",
    hasField7: false,
  };
  let haveChannelID = false;
  let hasField6 = false;
  let hasField7 = false;
  const fields = walkClaudeProtobufFields(channelBlock);
  for (const field of fields) {
    switch (field.num) {
      case 1:
        if (field.type !== WireVarint) throw new SignatureError("invalid Claude signature: Field 2.1.1 channel_id must be varint");
        tree.channelID = decodeClaudeVarintField(field.raw, "Field 2.1.1 channel_id");
        haveChannelID = true;
        break;
      case 2:
        if (field.type !== WireVarint) throw new SignatureError("invalid Claude signature: Field 2.1.2 field2 must be varint");
        tree.field2 = decodeClaudeVarintField(field.raw, "Field 2.1.2 field2");
        break;
      case 6: {
        if (field.type !== WireBytes) throw new SignatureError("invalid Claude signature: Field 2.1.6 model_text must be bytes");
        const modelBytes = decodeClaudeBytesField(field.raw, "Field 2.1.6 model_text");
        const text = utf8DecodeStrict(modelBytes);
        if (text === undefined) throw new SignatureError("invalid Claude signature: Field 2.1.6 model_text is not valid UTF-8");
        tree.modelText = text;
        hasField6 = true;
        break;
      }
      case 7:
        if (field.type !== WireVarint) throw new SignatureError("invalid Claude signature: Field 2.1.7 must be varint");
        decodeClaudeVarintField(field.raw, "Field 2.1.7");
        hasField7 = true;
        tree.hasField7 = true;
        break;
    }
  }
  if (!haveChannelID) throw new SignatureError("invalid Claude signature: missing Field 2.1.1 channel_id");
  if (tree.channelID === 11) tree.routingClass = "routing_class_11";
  else if (tree.channelID === 12) tree.routingClass = "routing_class_12";
  if (tree.field2 === undefined) tree.infrastructureClass = "infra_default";
  else if (tree.field2 === 1) tree.infrastructureClass = "infra_aws";
  else if (tree.field2 === 2) tree.infrastructureClass = "infra_google";
  else tree.infrastructureClass = "infra_unknown";
  if (hasField6) tree.schemaFeatures = "extended_model_tagged_schema";
  else if (!hasField6 && !hasField7 && channelBlock.length >= 70 && channelBlock.length <= 72) tree.schemaFeatures = "compact_schema";
  if (tree.channelID === 11) {
    if (tree.field2 === undefined) tree.legacyRouteHint = "legacy_default_group";
    else if (tree.field2 === 1) tree.legacyRouteHint = "legacy_aws_group";
    else if (tree.field2 === 2 && encodingLayers === 2) tree.legacyRouteHint = "legacy_vertex_direct";
    else if (tree.field2 === 2 && encodingLayers === 1) tree.legacyRouteHint = "legacy_vertex_proxy";
  }
  return tree;
}

export function extractClaudeBytesField(msg: Uint8Array, fieldNum: number, scope: string): Uint8Array {
  let value: Uint8Array | undefined;
  for (const field of walkClaudeProtobufFields(msg)) {
    if (field.num !== fieldNum) continue;
    if (field.type !== WireBytes) throw new SignatureError(`invalid Claude signature: ${scope} field ${fieldNum} must be bytes`);
    value = decodeClaudeBytesField(field.raw, `${scope} field ${fieldNum}`);
  }
  if (value === undefined) throw new SignatureError(`invalid Claude signature: missing ${scope} field ${fieldNum}`);
  return value;
}

function walkClaudeProtobufFields(msg: Uint8Array): { num: number; type: number; raw: Uint8Array }[] {
  const fields = walkFields(msg);
  if (fields === null) throw new SignatureError("invalid Claude signature: malformed protobuf field");
  return fields;
}

function decodeClaudeVarintField(raw: Uint8Array, label: string): number {
  const v = consumeVarint(raw, 0);
  if (!v) throw new SignatureError(`invalid Claude signature: failed to decode ${label}`);
  return Number(v.value);
}

function decodeClaudeBytesField(raw: Uint8Array, label: string): Uint8Array {
  const v = consumeBytes(raw, 0);
  if (!v) throw new SignatureError(`invalid Claude signature: failed to decode ${label}`);
  return v.value;
}

const claudeCAISSignatureMarker = 0x08;
const claudeCAISModelTextPrefix = "claude-";

/** The locally inspected structure of a Claude CAIS thinking signature. */
export interface ClaudeCAISSignatureInfo {
  firstByte: number;
  envelopeVersion: number;
  infrastructure?: number;
  channelID: number;
  modelText: string;
  blockKind: string;
  contextID: string;
  signatureLen: number;
  signatureInContainer: boolean;
}

export function isValidClaudeCAISSignature(rawSignature: string): boolean {
  return tryInspect(() => inspectClaudeCAISSignature(rawSignature));
}

/** Decodes and structurally validates a Claude CAIS thinking signature. Throws SignatureError. */
export function inspectClaudeCAISSignature(rawSignature: string): ClaudeCAISSignatureInfo {
  const sig = stripClaudeSignaturePrefix(rawSignature);
  if (sig === "") throw new SignatureError("empty signature");
  if (sig.length > maxClaudeThinkingSignatureLen) throw new SignatureError(`signature exceeds maximum length (${maxClaudeThinkingSignatureLen} bytes)`);
  if (sig[0] !== "C") throw new SignatureError(`invalid Claude CAIS signature: expected 'C' prefix, got "${sig[0]}"`);
  const decoded = decodeStd(sig);
  if (!decoded) throw new SignatureError("invalid Claude CAIS signature: base64 decode failed");
  return inspectClaudeCAISPayload(decoded, false);
}

function inspectClaudeCAISPayload(decoded: Uint8Array, rejectDuplicateMessages: boolean): ClaudeCAISSignatureInfo {
  if (decoded.length === 0) throw new SignatureError("invalid Claude CAIS signature: empty after decode");
  if (decoded[0] !== claudeCAISSignatureMarker) {
    throw new SignatureError(`invalid Claude CAIS signature: expected first byte 0x08, got 0x${decoded[0]!.toString(16).padStart(2, "0")}`);
  }
  const info: ClaudeCAISSignatureInfo = { firstByte: decoded[0]!, envelopeVersion: 0, channelID: 0, modelText: "", blockKind: "", contextID: "", signatureLen: 0, signatureInContainer: false };

  let container: Uint8Array | undefined;
  let containerSignatureBytes: Uint8Array | undefined;
  let haveContainer = false;
  for (const field of walkClaudeProtobufFields(decoded)) {
    switch (field.num) {
      case 1:
        info.envelopeVersion = decodeClaudeCAISVarint(field.raw, field.type, "CAIS top-level field 1 envelope version");
        break;
      case 2:
        if (rejectDuplicateMessages && haveContainer) throw new SignatureError("invalid Antigravity CAQS signature: duplicate container");
        haveContainer = true;
        container = decodeClaudeCAISBytes(field.raw, field.type, "CAIS top-level field 2 container");
        break;
      case 3:
        decodeClaudeCAISVarint(field.raw, field.type, "CAIS top-level field 3 trailer");
        break;
    }
  }
  if (container === undefined) throw new SignatureError("invalid Claude CAIS signature: missing top-level field 2 container");

  let channelBlock: Uint8Array | undefined;
  let haveChannelBlock = false;
  for (const field of walkClaudeProtobufFields(container)) {
    switch (field.num) {
      case 1:
        if (rejectDuplicateMessages && haveChannelBlock) throw new SignatureError("invalid Antigravity CAQS signature: duplicate channel block");
        haveChannelBlock = true;
        channelBlock = decodeClaudeCAISBytes(field.raw, field.type, "CAIS container field 1 channel block");
        break;
      case 5:
        containerSignatureBytes = decodeClaudeCAISBytes(field.raw, field.type, "CAIS container field 5 signature bytes");
        break;
    }
  }
  if (channelBlock === undefined) throw new SignatureError("invalid Claude CAIS signature: missing container field 1 channel block");

  let haveChannelID = false;
  let haveSignatureBytes = false;
  let haveModelText = false;
  for (const field of walkClaudeProtobufFields(channelBlock)) {
    switch (field.num) {
      case 1:
        info.channelID = decodeClaudeCAISVarint(field.raw, field.type, "CAIS channel field 1 channel_id");
        haveChannelID = true;
        break;
      case 2:
        info.infrastructure = decodeClaudeCAISVarint(field.raw, field.type, "CAIS channel field 2 infrastructure");
        break;
      case 3:
        decodeClaudeCAISVarint(field.raw, field.type, "CAIS channel field 3 version");
        break;
      case 5: {
        const value = decodeClaudeCAISBytes(field.raw, field.type, "CAIS channel field 5 signature bytes");
        if (value.length === 0) throw new SignatureError("invalid Claude CAIS signature: channel field 5 signature bytes must not be empty");
        info.signatureLen = value.length;
        haveSignatureBytes = true;
        break;
      }
      case 6: {
        const value = decodeClaudeCAISUTF8(field.raw, field.type, "CAIS channel field 6 model_text");
        if (!value.startsWith(claudeCAISModelTextPrefix)) {
          throw new SignatureError(`invalid Claude CAIS signature: channel field 6 model_text must start with "${claudeCAISModelTextPrefix}", got "${value}"`);
        }
        info.modelText = value;
        haveModelText = true;
        break;
      }
      case 7:
        decodeClaudeCAISVarint(field.raw, field.type, "CAIS channel field 7");
        break;
      case 8:
        info.blockKind = decodeClaudeCAISUTF8(field.raw, field.type, "CAIS channel field 8 block kind");
        break;
      case 11: {
        const value = decodeClaudeCAISUTF8(field.raw, field.type, "CAIS channel field 11 context id");
        if (!isCanonicalUUID(value)) throw new SignatureError(`invalid Claude CAIS signature: channel field 11 context id must be a canonical UUID, got "${value}"`);
        info.contextID = value;
        break;
      }
    }
  }
  if (!haveSignatureBytes && info.envelopeVersion >= 4 && containerSignatureBytes && containerSignatureBytes.length > 0) {
    info.signatureLen = containerSignatureBytes.length;
    info.signatureInContainer = true;
    haveSignatureBytes = true;
  }
  if (!haveChannelID) throw new SignatureError("invalid Claude CAIS signature: missing channel field 1 channel_id");
  if (!haveSignatureBytes) throw new SignatureError("invalid Claude CAIS signature: missing signature bytes");
  if (!haveModelText && info.envelopeVersion < 4) throw new SignatureError("invalid Claude CAIS signature: missing channel field 6 model_text");
  if (info.envelopeVersion >= 4 && info.blockKind !== "thinking" && info.blockKind !== "narration") {
    throw new SignatureError(`invalid Claude CAQS signature: expected block kind "thinking" or "narration", got "${info.blockKind}"`);
  }
  return info;
}

function decodeClaudeCAISVarint(raw: Uint8Array, type: number, label: string): number {
  if (type !== WireVarint) throw new SignatureError(`invalid Claude CAIS signature: ${label} must be varint`);
  return decodeClaudeVarintField(raw, label);
}

function decodeClaudeCAISBytes(raw: Uint8Array, type: number, label: string): Uint8Array {
  if (type !== WireBytes) throw new SignatureError(`invalid Claude CAIS signature: ${label} must be bytes`);
  return decodeClaudeBytesField(raw, label);
}

function decodeClaudeCAISUTF8(raw: Uint8Array, type: number, label: string): string {
  const value = decodeClaudeCAISBytes(raw, type, label);
  const text = utf8DecodeStrict(value);
  if (text === undefined) throw new SignatureError(`invalid Claude CAIS signature: ${label} must be valid UTF-8`);
  return text;
}

export function isCanonicalUUID(s: string): boolean {
  if (s.length !== 36) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== "-") return false;
    } else if (!/[0-9a-fA-F]/.test(c)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates the double-base64 CAQS envelope observed on Antigravity Claude 5.5.
 * Structural validation only; two encoding layers are supported.
 */
export function inspectAntigravityClaudeCAQSSignature(rawSignature: string): ClaudeCAISSignatureInfo {
  const sig = stripClaudeSignaturePrefix(rawSignature);
  if (sig.length === 0 || sig.length > maxClaudeThinkingSignatureLen) throw new SignatureError("invalid Antigravity CAQS signature length");
  if (sig[0] !== "Q" || /[\r\n]/.test(sig)) throw new SignatureError("invalid Antigravity CAQS wrapper");
  const inner = decodeBase64(sig, { padding: true, strict: true });
  if (!inner) throw new SignatureError("invalid Antigravity CAQS encoding");
  const innerText = bytesToLatin1(inner);
  if (innerText.length === 0 || innerText[0] !== "C" || /[ \t\r\n#]/.test(innerText)) throw new SignatureError("invalid Antigravity CAQS inner encoding");
  const decoded = decodeBase64(innerText, { padding: true, strict: true });
  if (!decoded) throw new SignatureError("invalid Antigravity CAQS inner encoding");
  let info: ClaudeCAISSignatureInfo;
  try {
    info = inspectClaudeCAISPayload(decoded, true);
  } catch (err) {
    throw new SignatureError(`invalid Antigravity CAQS payload: ${(err as Error).message}`);
  }
  if (info.envelopeVersion !== 4 || info.infrastructure !== 2 || info.blockKind !== "thinking" || !info.signatureInContainer) {
    throw new SignatureError("unsupported Antigravity CAQS envelope or channel schema");
  }
  return info;
}
