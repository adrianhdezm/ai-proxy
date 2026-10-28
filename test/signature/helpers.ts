// Shared fixture builders for the signature tests (ported from the helpers in
// internal/signature/*_test.go). No captured provider payload is embedded except
// the observed Claude samples that the Go tests also pin.
import { spyOn } from "bun:test";
import { decodeBase64, encodeBase64, rawStdEncoding, rawURLEncoding, stdEncoding, utf8Encode } from "../../src/util/base64.ts";
import { logLevel, setLogLevel } from "../../src/log.ts";
import { appendBytes, appendString, appendTag, appendVarint, WireBytes, WireVarint } from "../../src/signature/protowire.ts";
import { geminiBareTinkMinLen } from "../../src/signature/gemini_validation.ts";
import { metaReasoningSignatureHeader, metaReasoningSignatureOverheadLen } from "../../src/signature/meta_validation.ts";

export const encodeStd = (bytes: Uint8Array | number[]): string => encodeBase64(Uint8Array.from(bytes), stdEncoding);
export const encodeRawStd = (bytes: Uint8Array | number[]): string => encodeBase64(Uint8Array.from(bytes), rawStdEncoding);
export const encodeRawURL = (bytes: Uint8Array | number[]): string => encodeBase64(Uint8Array.from(bytes), rawURLEncoding);
export const decodeStd = (s: string): Uint8Array => {
  const decoded = decodeBase64(s, stdEncoding);
  if (!decoded) throw new Error("fixture is not standard base64");
  return decoded;
};
export const bytesOf = (s: string): Uint8Array => utf8Encode(s);

// ---- Claude classic (E/R) ----

export function testClaudeThinkingSignature(): string {
  let channelBlock: number[] = [];
  channelBlock = appendTag(channelBlock, 1, WireVarint);
  channelBlock = appendVarint(channelBlock, 12);
  channelBlock = appendTag(channelBlock, 2, WireVarint);
  channelBlock = appendVarint(channelBlock, 2);
  channelBlock = appendTag(channelBlock, 6, WireBytes);
  channelBlock = appendString(channelBlock, "claude-sonnet-4-6");

  let container: number[] = [];
  container = appendTag(container, 1, WireBytes);
  container = appendBytes(container, channelBlock);

  let payload: number[] = [];
  payload = appendTag(payload, 2, WireBytes);
  payload = appendBytes(payload, container);
  payload = appendTag(payload, 3, WireVarint);
  payload = appendVarint(payload, 1);
  return encodeStd(payload);
}

export function testClaudeThinkingSignatureWithOpaqueLen(opaqueLen: number): string {
  let channelBlock: number[] = [];
  channelBlock = appendTag(channelBlock, 1, WireVarint);
  channelBlock = appendVarint(channelBlock, 12);
  channelBlock = appendTag(channelBlock, 2, WireVarint);
  channelBlock = appendVarint(channelBlock, 2);
  channelBlock = appendTag(channelBlock, 6, WireBytes);
  channelBlock = appendString(channelBlock, "claude-sonnet-4-6");

  let container: number[] = [];
  container = appendTag(container, 1, WireBytes);
  container = appendBytes(container, channelBlock);

  let payload: number[] = [];
  payload = appendTag(payload, 2, WireBytes);
  payload = appendBytes(payload, container);
  payload = appendTag(payload, 3, WireVarint);
  payload = appendVarint(payload, 1);
  payload = appendTag(payload, 4, WireBytes);
  const opaque: number[] = [];
  for (let i = 0; opaque.length < opaqueLen; i++) opaque.push((i * 41 + 17) % 251);
  payload = appendBytes(payload, opaque);
  return encodeStd(payload);
}

export const testUnpaddedClaudeThinkingSignature = (): string => testClaudeThinkingSignatureWithOpaqueLen(35);

export const testUnpaddedAntigravityClaudeThinkingSignature = (): string => encodeStd(bytesOf(testClaudeThinkingSignatureWithOpaqueLen(41)));

// ---- Claude CAIS ----

export const observedFable5Sample = "CAISqwIKiAEIEBgCKkBHRlRBsNiptQUWfPoOhuQKwi5LnncZVO9bB5jqOs76D7uBtgktML0zqJtNmLHXHHcgD6lk4MQu4QBXzFd1lbC3Mg5jbGF1ZGUtZmFibGUtNTgBQgh0aGlua2luZ1okZDk3NDM5NzUtNGJiMC00OTM2LTllMjgtZDViMGQyMWJkYzQ4EgxCGh+XVFFFeySAjtAaDL/A1LltGu6MMJ+eXSIwsN0oBpDrqLv22UBfkMnTotnIbkvkOyb9xZHgigG6OZVHaI3gThm+maLKmgO5PrFLKlDFYp+YZksy/wKwszJlnLTPzAK+NUlfzagOE1ymtZTXhAYK260XyFYmg/te/C231+Fr/hoX+EJoUBnrn0gD7hqMISOT+TaFEuOXYsN517GfaxgB";
export const observedFable51CAQSSample = "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";
export const observedFable51CAQSNarrationSample = "CAQS1wcKEQgRGAI4AUIJbmFycmF0aW9uEgx5LrAwGWmNqIuLoPoaDCz9ejHfn6/z4XQk9SIwhyZlO5uaOp3VmdX3F7fs7KEDyPDqwVnN7xaSmeJOV5Arz+KM6Jxjf9GCXPbFBh9UKvMGF85qvThSqk2AZdjBT+OH4tN1F9puuxtUcp9vlwta78FgdgwUxd6/h0gD2r+5lEUJ9XfwxBvSi3X6fBGoHh+GV/3b0bQKutA7FgmvO7x6s5oAYg4EKs7CSkIOnkwo3g1ahX43xHjkaMsQeoziouORPGM6kCWq9E2TpwhEse3ouQ6PzvbTkj2W/vOhy2RVDXf5qvS/zt4w488A17nI5z8upoVvO0rmY5KQhaZRuAOmjMUqnFyNAZzikwNo9O8ukArtXkSWkGjbIbJ4rd1cX0zdYzmTE8Nos/LroXsqB2Dk7GxZn2TP6uqtoLL/6aowhC+yYOYPeSobtERH9AUuAgBEZk0vGHR+viVeJf6cCm2dFQtv0hEYgPlgcSwoDiKrMq7fOEiBkpM8QD114FR39f0C8cJemOScabiaToHE75grwQx1NVoBjYRHNb/sftU3tnSiiqhsCTxxZVYtB5p4WLhLH21KeI7Fjs1DQhXv9MwfByAHJXusYsQ4SPwAUYnxn+NN/XzN/0OeCxz+CtUo1QD9q4LU/tWM58EcA/y1sAUE9p+6ILvXYQ9bitNf8RQFzp9hNCFWKgiuRtKTGKGI2PEaWOUp7Lmo8LM1DeFyKU4RiylXXKEdhS53WoK+gY0/iwJPBMoFZv+EAWZCGxOfYjgv51XVTl2tHLCwevmuSQqzdZSdKtuyoheaDaAblRJNwK/8CngwAZk8ef+CCdM5lCFkZ4dKVrmbSDBGi5PZDkY185oRVqVWO1VyiqjQ4AfwMp3vYE+vDlI+ylm72KU4TqScVgSm/SUGVsER7Wg5Kuqgb7fOvPhPVX6/C4v7sfUwejjax0T7JFXqlUGqxP8yGUck2PA9XPeZXFpuQVmhuWgWp4lWAWCQggvMnhQILFojjxnIwvA8v16n3FpK8ZODxQ2hlg6NJBai5S3OdSxGIR30io4g24rfSkXinMoaofM6VSUeUs0io05byPmuGocGoC6ivpnU+rOuIR5ShNHiIuPQl1PMfuPxzOPPMu4GyuFO659GTqtyokntivgIGtS1XC/2CX/sp42A3gflhPR7oZmtnAOFUm3mQT94SU9dGUTT06eXyx4g+4VaiW6keFOAJ6dfa6PMd0MUJc0z/nXmpzEFr3gZJo8FUrpTyw/HTTq5RVbvPnxAz5ZAcVMJy10t0hwS0Qyf5xgB";
export const observedContextID = "d9743975-4bb0-4936-9e28-d5b0d21bdc48";

/** Builds Claude CAIS signatures field by field so tests can assert the observed layout and tolerated drift. */
export interface ClaudeCAISParts {
  includeTopEnvelope: boolean;
  topEnvelope: number;
  includeTopTrailer: boolean;
  includeContainer: boolean;
  includeChannelBlock: boolean;
  includeChannelID: boolean;
  channelID: number;
  channelIDAsBytes: boolean;
  includeChannelVersion: boolean;
  includeSignature: boolean;
  signatureLen: number;
  includeModelText: boolean;
  modelText: Uint8Array;
  includeField7: boolean;
  blockKind: string;
  contextID: string;
}

/** Mirrors the layout observed on claude-fable-5 and claude-opus-5 responses. */
export function defaultClaudeCAISParts(model: string): ClaudeCAISParts {
  return {
    includeTopEnvelope: true,
    topEnvelope: 2,
    includeTopTrailer: true,
    includeContainer: true,
    includeChannelBlock: true,
    includeChannelID: true,
    channelID: 16,
    channelIDAsBytes: false,
    includeChannelVersion: true,
    includeSignature: true,
    signatureLen: 64,
    includeModelText: true,
    modelText: bytesOf(model),
    includeField7: true,
    blockKind: "thinking",
    contextID: observedContextID,
  };
}

export function encodeClaudeCAISParts(p: ClaudeCAISParts): string {
  let channelBlock: number[] = [];
  if (p.includeChannelID) {
    if (p.channelIDAsBytes) {
      channelBlock = appendTag(channelBlock, 1, WireBytes);
      channelBlock = appendBytes(channelBlock, [0x10]);
    } else {
      channelBlock = appendTag(channelBlock, 1, WireVarint);
      channelBlock = appendVarint(channelBlock, p.channelID);
    }
  }
  if (p.includeChannelVersion) {
    channelBlock = appendTag(channelBlock, 3, WireVarint);
    channelBlock = appendVarint(channelBlock, 2);
  }
  if (p.includeSignature) {
    channelBlock = appendTag(channelBlock, 5, WireBytes);
    channelBlock = appendBytes(channelBlock, new Uint8Array(p.signatureLen));
  }
  if (p.includeModelText) {
    channelBlock = appendTag(channelBlock, 6, WireBytes);
    channelBlock = appendBytes(channelBlock, p.modelText);
  }
  if (p.includeField7) {
    channelBlock = appendTag(channelBlock, 7, WireVarint);
    channelBlock = appendVarint(channelBlock, 1);
  }
  if (p.blockKind !== "") {
    channelBlock = appendTag(channelBlock, 8, WireBytes);
    channelBlock = appendString(channelBlock, p.blockKind);
  }
  if (p.contextID !== "") {
    channelBlock = appendTag(channelBlock, 11, WireBytes);
    channelBlock = appendString(channelBlock, p.contextID);
  }

  let container: number[] = [];
  if (p.includeChannelBlock) {
    container = appendTag(container, 1, WireBytes);
    container = appendBytes(container, channelBlock);
  }

  let payload: number[] = [];
  if (p.includeTopEnvelope) {
    payload = appendTag(payload, 1, WireVarint);
    payload = appendVarint(payload, p.topEnvelope);
  }
  if (p.includeContainer) {
    payload = appendTag(payload, 2, WireBytes);
    payload = appendBytes(payload, container);
  }
  if (p.includeTopTrailer) {
    payload = appendTag(payload, 3, WireVarint);
    payload = appendVarint(payload, 1);
  }
  return encodeStd(payload);
}

export const testClaudeCAISSignature = (model: string): string => encodeClaudeCAISParts(defaultClaudeCAISParts(model));

/** A CAIS signature whose base64 form carries no "=" padding (the model text length is varied to get there). */
export function testUnpaddedClaudeCAISSignature(): string {
  for (let suffix = 0; suffix < 8; suffix++) {
    const sample = testClaudeCAISSignature("claude-opus-5" + "x".repeat(suffix));
    if (!sample.includes("=")) return sample;
  }
  throw new Error("could not build an unpadded Claude CAIS fixture");
}

// ---- Gemini ----

export const testGeminiThoughtSignature = (payload: Uint8Array | number[]): string => encodeStd(payload);

export function testGemini25ThoughtSignature(...records: (Uint8Array | number[])[]): string {
  let payload: number[] = [];
  for (const record of records) {
    payload = appendTag(payload, 1, WireBytes);
    payload = appendBytes(payload, record);
  }
  return testGeminiThoughtSignature(payload);
}

export function testGemini3ThoughtSignature(payload: Uint8Array | number[]): string {
  let inner: number[] = [];
  inner = appendTag(inner, 1, WireBytes);
  inner = appendBytes(inner, payload);
  let outer: number[] = [];
  outer = appendTag(outer, 2, WireBytes);
  outer = appendBytes(outer, inner);
  return testGeminiThoughtSignature(outer);
}

export function testGeminiThoughtSignatureEnvelope(): string {
  const payload = [0x01, 0x0c];
  for (let i = 0; i < 97; i++) payload.push(i);
  const inner = [0x0a, payload.length, ...payload];
  const outer = [0x12, inner.length, ...inner];
  return encodeRawStd(outer);
}

export function testGemini25Field1ThoughtSignatureEnvelope(): string {
  const payload = [0x01];
  for (let i = 0; payload.length < 128; i++) payload.push((i * 37 + 11) % 251);
  let decoded: number[] = [];
  decoded = appendTag(decoded, 1, WireBytes);
  decoded = appendBytes(decoded, payload);
  return encodeRawStd(decoded);
}

/** Synthetic Vertex-style bare-Tink signature: TINK prefix byte, four-byte key id, then filler ciphertext up to n bytes. */
export function testGeminiBareTinkSignature(n: number): string {
  if (n < geminiBareTinkMinLen) n = geminiBareTinkMinLen;
  const payload = [0x01, 0x8f, 0x3d, 0x6b, 0x5f];
  while (payload.length < n) payload.push(0xa0 + (payload.length % 0x20));
  return testGeminiThoughtSignature(payload);
}

// ---- GPT / Meta ----

export function testGPTReasoningSignature(): string {
  const payload = new Uint8Array(1 + 8 + 16 + 16 + 32);
  payload[0] = 0x80;
  for (let i = 9; i < payload.length; i++) payload[i] = i;
  return encodeRawURL(payload);
}

/** Synthetic Meta Muse envelope with the observed fixed header and a power-of-two payload bucket. */
export function testMetaReasoningSignatureBytes(payloadLen: number, mutate?: (b: Uint8Array) => void): Uint8Array {
  const decoded = new Uint8Array(metaReasoningSignatureOverheadLen + payloadLen);
  decoded.set(metaReasoningSignatureHeader);
  for (let i = metaReasoningSignatureHeader.length; i < decoded.length; i++) decoded[i] = (i * 31 + 7) & 0xff;
  if (mutate) mutate(decoded);
  return decoded;
}

export const testMetaReasoningSignature = (payloadLen: number): string => encodeRawURL(testMetaReasoningSignatureBytes(payloadLen));

/** Synthetic router suffix in the observed OpenRouter shape: 67 alphanumeric characters. */
export const testMetaRouterSuffix = (): string => "Ab3".repeat(23).slice(0, 67);

// ---- Kimi ----

/** Deterministic PRNG (mulberry32) standing in for Go's seeded math/rand. */
function seededBytes(len: number, seed: number): Uint8Array {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

/** A signature-shaped payload of the requested decoded size from a seeded PRNG. */
export const synthesizeKimiSignature = (decodedLen: number, seed: number): string => encodeRawStd(seededBytes(decodedLen, seed));

// ---- Debug log capture ----

export interface DebugLogCapture {
  /** The debug messages emitted so far (the logger's message text only). */
  entries(): string[];
  reset(): void;
  restore(): void;
}

/** Captures log.debug output at debug level, like the logrus test hook in the Go tests. */
export function captureDebugLogs(): DebugLogCapture {
  const previousLevel = logLevel();
  setLogLevel("debug");
  const messages: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("[DEBUG]")) messages.push(args.slice(1).map(String).join(" "));
  });
  return {
    entries: () => [...messages],
    reset: () => {
      messages.length = 0;
    },
    restore: () => {
      spy.mockRestore();
      setLogLevel(previousLevel);
    },
  };
}
