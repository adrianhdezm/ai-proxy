// Ported from: internal/signature/gpt_validation_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { compatibleSignatureForProvider, detectSignatureProvider, inspectGPTReasoningSignature, SignatureProviderGPT } from "../../src/signature/index.ts";
import { testGPTReasoningSignature } from "./helpers.ts";

test("DetectSignatureProvider GPT reasoning", () => {
  expect(detectSignatureProvider(testGPTReasoningSignature())).toBe(SignatureProviderGPT);
});

test("InspectGPTReasoningSignature rejects unicode ellipsis", () => {
  const sig = testGPTReasoningSignature();
  const polluted = sig.slice(0, 20) + String.fromCodePoint(0x2026) + sig.slice(20);
  expect(() => inspectGPTReasoningSignature(polluted)).toThrow("non-base64url character U+2026");
});

test("InspectGPTReasoningSignature router suffixed", () => {
  const native = testGPTReasoningSignature();
  const suffix = "Ab3".repeat(27).slice(0, 79);
  const routed = native + "." + suffix;

  const info = inspectGPTReasoningSignature(routed);
  expect(info.routerSuffix).toBe(suffix);
  expect(detectSignatureProvider(routed)).toBe(SignatureProviderGPT);
  expect(compatibleSignatureForProvider(SignatureProviderGPT, routed)).toBe(routed);

  for (const bad of [native + ".", native + ".bad_char", native + ".a.b"]) {
    expect(() => inspectGPTReasoningSignature(bad)).toThrow();
  }
});
