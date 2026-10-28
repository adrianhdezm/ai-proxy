// Ported from: internal/signature/kimi_validation_test.go
// Skipped cases: TestInspectKimiThinkingSignature_NativeCorpus (needs untracked Kimi corpus), TestDetectSignatureProvider_KimiProbeDoesNotDisturbCatalog (needs untracked signature catalog)
import { describe, expect, test } from "bun:test";
import {
  decideSignatureCompatibility,
  detectSignatureProvider,
  inspectKimiThinkingSignature,
  isValidGrokEncryptedContent,
  isValidKimiThinkingSignature,
  kimiThinkingSignatureNonStreamingLen,
  kimiThinkingSignatureStreamingLen,
  maybeSelfDescribingSignatureEnvelope,
  SignatureActionDropSignature,
  SignatureActionPreserve,
  SignatureBlockKindClaudeThinking,
  signatureProviderFromModelName,
  SignatureProviderClaude,
  SignatureProviderGemini,
  SignatureProviderGPT,
  SignatureProviderKimi,
  type KimiThinkingSignatureMode,
  type SignatureProvider,
} from "../../src/signature/index.ts";
import { observedFable5Sample, synthesizeKimiSignature } from "./helpers.ts";

describe("Kimi thinking signature lengths match decoded sizes", () => {
  const cases = [
    { name: "non streaming", decodedLen: 9709, wantRawLen: kimiThinkingSignatureNonStreamingLen },
    { name: "streaming", decodedLen: 3255, wantRawLen: kimiThinkingSignatureStreamingLen },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const sig = synthesizeKimiSignature(tc.decodedLen, 1);
      expect(sig.length).toBe(tc.wantRawLen);
      expect(inspectKimiThinkingSignature(sig).decodedLen).toBe(tc.decodedLen);
    });
  }
});

describe("InspectKimiThinkingSignature reports mode", () => {
  const cases: { name: string; decodedLen: number; wantMode: KimiThinkingSignatureMode }[] = [
    { name: "non streaming", decodedLen: 9709, wantMode: "non_streaming" },
    { name: "streaming", decodedLen: 3255, wantMode: "streaming" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(inspectKimiThinkingSignature(synthesizeKimiSignature(tc.decodedLen, 7)).mode).toBe(tc.wantMode);
    });
  }
});

test("rejects neighbouring lengths", () => {
  for (const decodedLen of [9709, 3255]) {
    const native = synthesizeKimiSignature(decodedLen, 3);
    expect(isValidKimiThinkingSignature(native.slice(0, -1)), `${decodedLen} one short`).toBe(false);
    expect(isValidKimiThinkingSignature(native + "A"), `${decodedLen} one long`).toBe(false);
  }
});

describe("rejects malformed input", () => {
  const native = synthesizeKimiSignature(3255, 5);
  const cases = [
    { name: "empty", sig: "" },
    { name: "whitespace only", sig: "   " },
    { name: "leading whitespace", sig: " " + native },
    { name: "trailing whitespace", sig: native + " " },
    { name: "padded base64", sig: native.slice(0, -2) + "==" },
    { name: "non base64 character", sig: native.slice(0, -1) + "!" },
    { name: "provider cache prefix", sig: "claude#" + native },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(isValidKimiThinkingSignature(tc.sig)).toBe(false);
    });
  }
});

test("rejects low entropy filler", () => {
  for (const length of [kimiThinkingSignatureStreamingLen, kimiThinkingSignatureNonStreamingLen]) {
    expect(isValidKimiThinkingSignature("A".repeat(length)), String(length)).toBe(false);
  }
});

test("rejects self-describing envelope", () => {
  expect(isValidKimiThinkingSignature(observedFable5Sample)).toBe(false);
});

test("DetectSignatureProvider Kimi runs after envelope probes", () => {
  expect(detectSignatureProvider(observedFable5Sample)).toBe(SignatureProviderClaude);
  let checked = 0;
  for (let seed = 0; seed < 200 && checked < 3; seed++) {
    const sig = synthesizeKimiSignature(3255, seed);
    if (!maybeSelfDescribingSignatureEnvelope(sig)) continue;
    checked++;
    expect(detectSignatureProvider(sig), `seed ${seed}`).toBe(SignatureProviderKimi);
  }
  expect(checked).toBeGreaterThan(0);
});

test("InspectGrokEncryptedContent rejects Kimi lengths", () => {
  for (const decodedLen of [9709, 3255]) {
    expect(isValidGrokEncryptedContent(synthesizeKimiSignature(decodedLen, 11)), String(decodedLen)).toBe(false);
  }
});

describe("SignatureProviderFromModelName Kimi", () => {
  const cases: [string, SignatureProvider][] = [
    ["kimi-k3", SignatureProviderKimi],
    ["kimi-k3-256k", SignatureProviderKimi],
    ["kimi-k2.7-code-highspeed", SignatureProviderKimi],
    ["k3", SignatureProviderKimi],
    ["k2-thinking", SignatureProviderKimi],
    ["moonshot-v1-128k", SignatureProviderKimi],
    ["claude-opus-5", SignatureProviderClaude],
    ["gemini-3.6-flash", SignatureProviderGemini],
    ["gpt-5.6-sol", SignatureProviderGPT],
  ];
  for (const [model, want] of cases) {
    test(model, () => {
      expect(signatureProviderFromModelName(model)).toBe(want);
    });
  }
});

test("DecideSignatureCompatibility Kimi drops signature not block", () => {
  const decision = decideSignatureCompatibility(SignatureProviderKimi, observedFable5Sample, SignatureBlockKindClaudeThinking);
  expect(decision.compatible).toBe(false);
  expect(decision.action).toBe(SignatureActionDropSignature);
});

test("DecideSignatureCompatibility Kimi preserves native signature", () => {
  const native = synthesizeKimiSignature(9709, 13);
  const decision = decideSignatureCompatibility(SignatureProviderKimi, native, SignatureBlockKindClaudeThinking);
  expect(decision.compatible, decision.reason).toBe(true);
  expect(decision.action).toBe(SignatureActionPreserve);
  expect(decision.normalizedSignature).toBe(native);
});
