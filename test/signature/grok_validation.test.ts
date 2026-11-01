// Ported from: internal/signature/grok_validation_test.go
// Skipped cases: TestInspectGrokEncryptedContent_NativeSamples (needs untracked Grok corpus), TestInspectGrokEncryptedContent_RejectsAgyGeminiThoughtSignatures (needs untracked agy corpus), TestDetectSignatureProvider_NeverClassifiesGrok (needs untracked Grok corpus)
import { describe, expect, test } from "bun:test";
import {
  byteEntropyRatio,
  decideSignatureCompatibility,
  detectSignatureProvider,
  inspectGrokEncryptedContent,
  isRecognizedReasoningSignature,
  isValidClaudeCAISSignature,
  isValidClaudeThinkingSignature,
  isValidGeminiThoughtSignature,
  minGrokEncryptedContentDecodedLen,
  minGrokEncryptedContentEntropyRatio,
  SignatureActionDropBlock,
  SignatureBlockKindUnknown,
  signatureProviderFromModelName,
  SignatureProviderGrok,
  SignatureProviderUnknown,
} from "../../src/signature/index.ts";
import { sha256Bytes } from "../../src/util/hash.ts";
import {
  encodeRawStd,
  encodeStd,
  observedFable5Sample,
  testGemini25Field1ThoughtSignatureEnvelope,
  testGeminiThoughtSignatureEnvelope,
  testUnpaddedAntigravityClaudeThinkingSignature,
  testUnpaddedClaudeCAISSignature,
  testUnpaddedClaudeThinkingSignature,
} from "./helpers.ts";

const errorOf = (sig: string): string => {
  try {
    inspectGrokEncryptedContent(sig);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

test("rejects Gemini thoughtSignature envelope", () => {
  expect(errorOf(testGeminiThoughtSignatureEnvelope())).toContain("Gemini");
});

test("retired Gemini 2.5 field-1 envelope reaches the residual transport check", () => {
  const sample = testGemini25Field1ThoughtSignatureEnvelope();
  expect(isValidGeminiThoughtSignature(sample, { requireKnownEnvelope: true })).toBe(false);
  expect(() => inspectGrokEncryptedContent(sample)).not.toThrow();
});

test("rejects Claude thinking signature", () => {
  const sample = testUnpaddedClaudeThinkingSignature();
  expect(isValidClaudeThinkingSignature(sample, { strict: true })).toBe(true);
  expect(errorOf(sample)).toContain("Claude");
});

test("rejects Antigravity Claude thinking signature", () => {
  const sample = testUnpaddedAntigravityClaudeThinkingSignature();
  expect(sample.startsWith("R")).toBe(true);
  expect(sample).not.toContain("=");
  expect(isValidClaudeThinkingSignature(sample, { strict: true })).toBe(true);
  expect(errorOf(sample)).toContain("Claude");
});

describe("rejects Claude CAIS signature", () => {
  const cases = [
    { name: "synthetic unpadded", sample: testUnpaddedClaudeCAISSignature() },
    { name: "observed fable-5", sample: observedFable5Sample },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(tc.sample).not.toContain("=");
      expect(isValidClaudeCAISSignature(tc.sample)).toBe(true);
      expect(isValidClaudeThinkingSignature(tc.sample, { strict: true })).toBe(false);
      expect(errorOf(tc.sample)).toContain("CAIS");
    });
  }
});

test("rejects provider cache prefix", () => {
  for (const prefix of ["claude#", "anthropic#", "gemini#", "openai#", "codex#"]) {
    expect(() => inspectGrokEncryptedContent(prefix + testUnpaddedClaudeCAISSignature()), prefix).toThrow();
  }
});

test("threshold margins", () => {
  const shortestObservedDecodedLen = 50;
  const lowestObservedEntropyRatio = 0.892;
  expect(minGrokEncryptedContentDecodedLen).toBeLessThan(shortestObservedDecodedLen);
  expect(minGrokEncryptedContentEntropyRatio).toBeLessThan(lowestObservedEntropyRatio);
});

test("rejects foreign shapes", () => {
  const cases = ["", "bad", " opaque", "gAAAAABinvalid-gpt-shape", "abcd_efg", encodeStd(new Uint8Array(minGrokEncryptedContentDecodedLen).fill(0xa5))];
  for (const sample of cases) {
    expect(() => inspectGrokEncryptedContent(sample), sample).toThrow();
  }
});

test("rejects low entropy payload", () => {
  const sample = encodeRawStd(new Uint8Array(minGrokEncryptedContentDecodedLen).fill(0xa5));
  expect(errorOf(sample)).toContain("entropy ratio");
});

test("rejects invalid base64 length", () => {
  expect(errorOf("AAAAA")).toContain("base64 decode failed");
});

test("byteEntropyRatio single byte returns zero", () => {
  expect(byteEntropyRatio(Uint8Array.from([0xa5]))).toBe(0);
});

test("router suffixed", () => {
  const rawBytes = new Uint8Array(135);
  for (let i = 0; i < rawBytes.length; i++) rawBytes[i] = (i * 73 + 19) & 0xff;
  const native = encodeRawStd(rawBytes);
  const suffix = "Ab3".repeat(21).slice(0, 62);
  const routed = native + "." + suffix;
  const info = inspectGrokEncryptedContent(routed);
  expect(info.routerSuffix).toBe(suffix);
  expect(info.decodedLen).toBe(rawBytes.length);
  expect(isRecognizedReasoningSignature(routed)).toBe(true);
  for (const bad of [native + ".", native + ".bad-dash", native + ".a.b"]) {
    expect(() => inspectGrokEncryptedContent(bad), bad).toThrow();
  }
});

describe("SignatureProviderFromModelName Grok", () => {
  for (const model of ["grok-4.5", "grok-4.5-build", "grok-composer-2.5-fast", "grok-code-fast-1"]) {
    test(model, () => {
      expect(signatureProviderFromModelName(model)).toBe(SignatureProviderGrok);
    });
  }
});

test("DecideSignatureCompatibility Grok drops block", () => {
  const decision = decideSignatureCompatibility(SignatureProviderGrok, observedFable5Sample, SignatureBlockKindUnknown);
  expect(decision.compatible).toBe(false);
  expect(decision.action).toBe(SignatureActionDropBlock);
});

test("accepts payload starting with Tink prefix byte", () => {
  // Uniform xAI ciphertext starts with 0x01 about once in 256 values; that alone
  // must not make it look like a Gemini Vertex bare-Tink signature.
  for (let seed = 0; seed < 4096; seed++) {
    const chunks: number[] = [];
    for (let i = 0; chunks.length < 256; i++) chunks.push(...sha256Bytes(Uint8Array.from([seed & 0xff, (seed >> 8) & 0xff, i & 0xff])));
    const buf = Uint8Array.from(chunks.slice(0, 256));
    if (buf[0] !== 0x01) continue;
    const sig = encodeRawStd(buf);
    expect(() => inspectGrokEncryptedContent(sig), `seed ${seed}`).not.toThrow();
    expect(detectSignatureProvider(sig), `seed ${seed}`).toBe(SignatureProviderUnknown);
    return;
  }
  throw new Error("no synthetic payload starting with 0x01 found");
});
