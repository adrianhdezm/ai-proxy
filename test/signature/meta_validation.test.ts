// Ported from: internal/signature/meta_validation_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { encodeBase64, rawURLEncoding } from "../../src/util/base64.ts";
import {
  compatibleSignatureForProvider,
  decideSignatureCompatibility,
  detectSignatureProvider,
  inspectMetaReasoningSignature,
  isValidMetaReasoningSignature,
  maxMetaRouterSuffixLen,
  metaReasoningSignatureOverheadLen,
  SignatureActionDropBlock,
  SignatureActionDropSignature,
  SignatureActionPreserve,
  SignatureActionReplaceWithGeminiBypass,
  SignatureBlockKindUnknown,
  signatureProviderFromModelName,
  SignatureProviderClaude,
  SignatureProviderGemini,
  SignatureProviderGPT,
  SignatureProviderGrok,
  SignatureProviderKimi,
  SignatureProviderMeta,
  SignatureProviderUnknown,
  type SignatureCompatibilityAction,
  type SignatureProvider,
} from "../../src/signature/index.ts";
import { testGPTReasoningSignature, testMetaReasoningSignature, testMetaReasoningSignatureBytes, testMetaRouterSuffix } from "./helpers.ts";

const encode = (payloadLen: number, mutate?: (b: Uint8Array) => void): string => encodeBase64(testMetaReasoningSignatureBytes(payloadLen, mutate), rawURLEncoding);

test("InspectMetaReasoningSignature valid buckets", () => {
  for (const tc of [
    { payload: 1024, exponent: 0 },
    { payload: 2048, exponent: 1 },
    { payload: 4096, exponent: 2 },
    { payload: 32768, exponent: 5 },
  ]) {
    const sig = testMetaReasoningSignature(tc.payload);
    const info = inspectMetaReasoningSignature(sig);
    expect(info.decodedLen).toBe(tc.payload + metaReasoningSignatureOverheadLen);
    expect(info.payloadLen).toBe(tc.payload);
    expect(info.bucketExponent).toBe(tc.exponent);
    expect(isValidMetaReasoningSignature(sig)).toBe(true);
    expect(detectSignatureProvider(sig)).toBe(SignatureProviderMeta);
  }
});

test("InspectMetaReasoningSignature rejects malformed", () => {
  const valid = testMetaReasoningSignature(1024);
  const nonCanonical = ((): string => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(valid[valid.length - 1]!);
    for (let i = 0; i < alphabet.length; i++) {
      if (i !== last && (i & 0x30) === (last & 0x30)) return valid.slice(0, -1) + alphabet[i];
    }
    return valid;
  })();
  const cases: Record<string, string> = {
    empty: "",
    "mock prefix only": "Q-PaDg-mock-muse-spark-encrypted-reasoning-payload",
    "wrong literal start": "R" + valid.slice(1),
    "header byte flipped": encode(1024, (b) => {
      b[2] ^= 0xff;
    }),
    "version byte zero": encode(1024, (b) => {
      b[4] = 0x00;
    }),
    "payload below min": encode(512),
    "payload not power2": encode(1025),
    "payload off by one": encode(2047),
    "padded encoding": valid + "=",
    "standard base64 +": valid.slice(0, 100) + "+" + valid.slice(101),
    "embedded whitespace": valid.slice(0, 100) + " " + valid.slice(100),
    "length mod4 is 1": valid.slice(0, -1),
    "non-canonical bits": nonCanonical,
  };
  for (const [name, sig] of Object.entries(cases)) {
    expect(() => inspectMetaReasoningSignature(sig), name).toThrow();
    expect(detectSignatureProvider(sig), name).not.toBe(SignatureProviderMeta);
  }
});

test("InspectMetaReasoningSignature router suffixed", () => {
  const native = testMetaReasoningSignature(2048);
  const suffix = testMetaRouterSuffix();
  const routed = native + "." + suffix;

  const info = inspectMetaReasoningSignature(routed);
  expect(info.routerSuffix).toBe(suffix);
  const nativeInfo = inspectMetaReasoningSignature(native);
  expect(nativeInfo.routerSuffix).toBe("");
  expect(info.decodedLen).toBe(nativeInfo.decodedLen);
  expect(info.payloadLen).toBe(nativeInfo.payloadLen);
  expect(info.bucketExponent).toBe(nativeInfo.bucketExponent);
  expect(detectSignatureProvider(routed)).toBe(SignatureProviderMeta);
  expect(compatibleSignatureForProvider(SignatureProviderMeta, routed)).toBe(routed);

  const decision = decideSignatureCompatibility(SignatureProviderGPT, routed, SignatureBlockKindUnknown);
  expect(decision.compatible).toBe(false);
  expect(decision.detectedProvider).toBe(SignatureProviderMeta);
  expect(decision.action).toBe(SignatureActionDropBlock);
});

test("InspectMetaReasoningSignature rejects malformed router suffix", () => {
  const native = testMetaReasoningSignature(1024);
  const suffix = testMetaRouterSuffix();
  const cases: Record<string, string> = {
    "trailing dot": native + ".",
    "oversized suffix": native + "." + "a".repeat(maxMetaRouterSuffixLen + 1),
    "suffix with dash": native + "." + suffix.slice(0, 60) + "-" + suffix.slice(61),
    "suffix with underscore": native + "." + suffix.slice(0, 60) + "_" + suffix.slice(61),
    "suffix with padding": native + "." + suffix.slice(0, 60) + "=" + suffix.slice(61),
    "suffix with plus": native + "." + suffix.slice(0, 60) + "+" + suffix.slice(61),
    "suffix with slash": native + "." + suffix.slice(0, 60) + "/" + suffix.slice(61),
    "suffix with space": native + "." + suffix.slice(0, 60) + " " + suffix.slice(61),
    "second dot": native + "." + suffix.slice(0, 60) + "." + suffix.slice(61),
    "bad native header":
      encode(1024, (b) => {
        b[2] ^= 0xff;
      }) + "." + suffix,
    "non-bucket native": encode(1025) + "." + suffix,
    "suffix only": "." + suffix,
  };
  for (const [name, sig] of Object.entries(cases)) {
    expect(() => inspectMetaReasoningSignature(sig), name).toThrow();
    expect(detectSignatureProvider(sig), name).not.toBe(SignatureProviderMeta);
  }
});

test("Meta signature compatibility", () => {
  const sig = testMetaReasoningSignature(2048);

  const decision = decideSignatureCompatibility(SignatureProviderMeta, sig, SignatureBlockKindUnknown);
  expect(decision.compatible).toBe(true);
  expect(decision.action).toBe(SignatureActionPreserve);
  expect(decision.normalizedSignature).toBe(sig);
  expect(compatibleSignatureForProvider(SignatureProviderMeta, sig)).toBe(sig);

  const gptDecision = decideSignatureCompatibility(SignatureProviderGPT, sig, SignatureBlockKindUnknown);
  expect(gptDecision.compatible).toBe(false);
  expect(gptDecision.action).toBe(SignatureActionDropBlock);

  const metaDecision = decideSignatureCompatibility(SignatureProviderMeta, testGPTReasoningSignature(), SignatureBlockKindUnknown);
  expect(metaDecision.compatible).toBe(false);
  expect(metaDecision.detectedProvider).toBe(SignatureProviderGPT);
  expect(metaDecision.action).toBe(SignatureActionDropBlock);
});

test("SignatureProviderFromModelName Meta", () => {
  for (const model of ["muse-wonder-full-1.0-contributor", "muse-spark-1.3", "Muse-Wonder-1.0", "meta/muse-spark-1.2", "meta/muse", "muse", "meta-muse-spark", "muse_spark_1_3"]) {
    expect(signatureProviderFromModelName(model), model).toBe(SignatureProviderMeta);
  }
  for (const model of ["museum-1", "amuse-model", "meta-llama-4"]) {
    expect(signatureProviderFromModelName(model), model).toBe(SignatureProviderUnknown);
  }
});

test("Meta signature compatibility other targets", () => {
  const sig = testMetaReasoningSignature(1024);
  const cases: [SignatureProvider, SignatureCompatibilityAction][] = [
    [SignatureProviderClaude, SignatureActionDropBlock],
    [SignatureProviderGemini, SignatureActionReplaceWithGeminiBypass],
    [SignatureProviderKimi, SignatureActionDropSignature],
    [SignatureProviderGrok, SignatureActionDropBlock],
  ];
  for (const [target, action] of cases) {
    const decision = decideSignatureCompatibility(target, sig, SignatureBlockKindUnknown);
    expect(decision.compatible, target).toBe(false);
    expect(decision.detectedProvider, target).toBe(SignatureProviderMeta);
    expect(decision.action, target).toBe(action);
  }
});

test("SignatureProviderFromModelName namespaced tail wins", () => {
  const cases: Record<string, SignatureProvider> = {
    "openai-compatible/muse-spark-1.3": SignatureProviderMeta,
    "muse-proxy/gpt-5.4": SignatureProviderGPT,
    "openrouter/anthropic/claude-sonnet-4-6": SignatureProviderClaude,
  };
  for (const [model, want] of Object.entries(cases)) {
    expect(signatureProviderFromModelName(model), model).toBe(want);
  }
});

test("Meta cache prefix unsupported", () => {
  const sig = testMetaReasoningSignature(1024);
  for (const prefixed of ["meta#" + sig, "muse#" + sig]) {
    expect(detectSignatureProvider(prefixed)).toBe(SignatureProviderUnknown);
    expect(compatibleSignatureForProvider(SignatureProviderMeta, prefixed)).toBeUndefined();
  }
});
