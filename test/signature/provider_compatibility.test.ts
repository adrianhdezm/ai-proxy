// Ported from: internal/signature/provider_compatibility_test.go
// Skipped cases: "antigravity CAQS" fixture entry of replaySafeEnvelopeFixtures (needs the Antigravity-only signaturetest fixture package, not ported)
import { expect, test } from "bun:test";
import {
  compatibleAntigravityClaudeThinkingSignature,
  compatibleSignatureForProvider,
  compatibleSignatureForProviderBlock,
  decideSignatureCompatibility,
  detectSignatureProvider,
  detectSignatureProviderForBlock,
  geminiSkipThoughtSignatureValidator,
  gptReasoningSignatureCharSet,
  grokEncryptedContentCharSet,
  isRecognizedGeminiProviderSignature,
  maybeSelfDescribingSignatureEnvelope,
  metaReasoningSignatureCharSet,
  normalizeClaudeProviderNativeThinkingSignature,
  sanitizeClaudeMessagesForClaudeUpstream,
  sanitizeClaudeMessagesSignaturesForModel,
  selfDescribingSignatureFirstChars,
  SignatureActionPreserve,
  SignatureActionReplaceWithGeminiBypass,
  SignatureBlockKindGeminiFunctionCall,
  SignatureBlockKindGeminiModelPart,
  SignatureBlockKindUnknown,
  SignatureProviderClaude,
  SignatureProviderGemini,
  SignatureProviderGPT,
  SignatureProviderMeta,
  SignatureProviderUnknown,
  splitSignatureProviderPrefix,
  type SignatureProvider,
} from "../../src/signature/index.ts";
import { garray, getAt } from "../../src/util/gpath.ts";
import {
  bytesOf,
  encodeStd,
  observedFable5Sample,
  testClaudeCAISSignature,
  testClaudeThinkingSignature,
  testClaudeThinkingSignatureWithOpaqueLen,
  testGemini3ThoughtSignature,
  testGeminiBareTinkSignature,
  testGeminiThoughtSignature,
  testGeminiThoughtSignatureEnvelope,
  testGPTReasoningSignature,
  testMetaReasoningSignature,
  testUnpaddedAntigravityClaudeThinkingSignature,
} from "./helpers.ts";

const at = (payload: string, path: string): unknown => getAt(JSON.parse(payload), path);

test("base64AlphabetSet matches encoder alphabets", () => {
  const cases: { name: string; set: Uint8Array; alphabet: string }[] = [
    { name: "grok unpadded std", set: grokEncryptedContentCharSet, alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" },
    { name: "gpt base64url", set: gptReasoningSignatureCharSet, alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=" },
    { name: "meta base64url unpadded", set: metaReasoningSignatureCharSet, alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" },
  ];
  for (const tc of cases) {
    const allowed = new Set<number>();
    for (let i = 0; i < tc.alphabet.length; i++) allowed.add(tc.alphabet.charCodeAt(i));
    for (let c = 0; c < 256; c++) {
      expect(!!tc.set[c], `${tc.name}: byte 0x${c.toString(16)}`).toBe(allowed.has(c));
    }
  }
});

// One fixture per self-describing provider envelope that carries replayable state.
function replaySafeEnvelopeFixtures(): Record<string, { sig: string; want: SignatureProvider }> {
  return {
    "claude single-layer E": { sig: testClaudeThinkingSignature(), want: SignatureProviderClaude },
    "claude double-layer R": { sig: testUnpaddedAntigravityClaudeThinkingSignature(), want: SignatureProviderClaude },
    "claude CAIS": { sig: testClaudeCAISSignature("claude-fable-5"), want: SignatureProviderClaude },
    "gemini protobuf field2": { sig: testGeminiThoughtSignatureEnvelope(), want: SignatureProviderGemini },
    "gemini vertex bare tink": { sig: testGeminiBareTinkSignature(405), want: SignatureProviderGemini },
    "gpt fernet": { sig: testGPTReasoningSignature(), want: SignatureProviderGPT },
    "meta muse": { sig: testMetaReasoningSignature(1024), want: SignatureProviderMeta },
  };
}

test("selfDescribingSignatureFirstChars covers every known envelope", () => {
  for (const [name, fixture] of Object.entries(replaySafeEnvelopeFixtures())) {
    expect(maybeSelfDescribingSignatureEnvelope(fixture.sig), `${name}: first char ${fixture.sig[0]} not in ${selfDescribingSignatureFirstChars}`).toBe(true);
  }
  for (const sig of ["K1ZAIbzDbO", "jQDLUr+fD8RFP8nbkkfI", "qcgG7jzxH3D6mlVLBBaKXaG3"]) {
    expect(maybeSelfDescribingSignatureEnvelope(sig), sig).toBe(false);
  }
});

test("Gemini ASCII UUID is gate independent", () => {
  for (const uuid of [
    "09743975-4bb0-4936-9e28-d5b0d21bdc48",
    "49743975-4bb0-4936-9e28-d5b0d21bdc48",
    "89743975-4bb0-4936-9e28-d5b0d21bdc48",
    "a9743975-4bb0-4936-9e28-d5b0d21bdc48",
    "e9743975-4bb0-4936-9e28-d5b0d21bdc48",
  ]) {
    const sig = testGeminiThoughtSignature(bytesOf(uuid));
    expect(detectSignatureProvider(sig), uuid).toBe(SignatureProviderUnknown);
    expect(decideSignatureCompatibility(SignatureProviderGemini, sig, SignatureBlockKindGeminiFunctionCall).action, uuid).toBe(SignatureActionReplaceWithGeminiBypass);
  }
});

test("DetectSignatureProviderForBlock classifies every known envelope", () => {
  for (const [name, fixture] of Object.entries(replaySafeEnvelopeFixtures())) {
    expect(detectSignatureProvider(fixture.sig), name).toBe(fixture.want);
  }
});

test("Gemini envelope never claims Claude signatures", () => {
  const sigs: Record<string, string> = {
    "single-layer E": testClaudeThinkingSignature(),
    "single-layer E opaque": testClaudeThinkingSignatureWithOpaqueLen(64),
    "double-layer R": testUnpaddedAntigravityClaudeThinkingSignature(),
    "CAIS synthetic": testClaudeCAISSignature("claude-opus-5"),
    "CAIS observed": observedFable5Sample,
  };
  for (const [name, sig] of Object.entries(sigs)) {
    expect(isRecognizedGeminiProviderSignature(sig, SignatureBlockKindUnknown), name).toBe(false);
    expect(detectSignatureProvider(sig), name).toBe(SignatureProviderClaude);
    expect(compatibleSignatureForProvider(SignatureProviderGemini, sig), name).toBeUndefined();
  }
});

test("DetectSignatureProvider uses provider prefix", () => {
  expect(detectSignatureProvider("claude#" + testClaudeThinkingSignature())).toBe(SignatureProviderClaude);
  expect(detectSignatureProvider("gemini#" + testGemini3ThoughtSignature([0x01, 0x0c, 0x39]))).toBe(SignatureProviderGemini);
});

test("DetectSignatureProvider rejects misleading Claude prefix", () => {
  expect(detectSignatureProvider("claude#" + testGemini3ThoughtSignature([0x01, 0x0c, 0x39]))).toBe(SignatureProviderUnknown);
});

test("DetectSignatureProvider Gemini 3 E prefix does not look Claude", () => {
  const geminiSig = testGemini3ThoughtSignature([0x01, 0x0c, 0x39, 0xd6, 0xc7, 0x34]);
  expect(geminiSig.startsWith("E")).toBe(true);
  expect(detectSignatureProvider(geminiSig)).toBe(SignatureProviderGemini);
});

test("CompatibleSignatureForProvider Claude uses provider-native E form", () => {
  const nativeSig = testClaudeThinkingSignature();
  const doubleEncoded = encodeStd(bytesOf(nativeSig));
  expect(compatibleSignatureForProvider(SignatureProviderClaude, doubleEncoded)).toBe(nativeSig);
});

test("CompatibleAntigravityClaudeThinkingSignature uses double-layer R form", () => {
  const nativeSig = testClaudeThinkingSignature();
  expect(compatibleAntigravityClaudeThinkingSignature(nativeSig)).toBe(encodeStd(bytesOf(nativeSig)));
});

test("CompatibleAntigravityClaudeThinkingSignature rejects Gemini E prefix", () => {
  const geminiSig = testGemini3ThoughtSignature([0x01, 0x0c, 0x39, 0xd6, 0xc7, 0x34]);
  expect(geminiSig.startsWith("E")).toBe(true);
  expect(compatibleAntigravityClaudeThinkingSignature(geminiSig)).toBeUndefined();
});

test("DetectSignatureProvider does not classify arbitrary base64 as Gemini", () => {
  expect(detectSignatureProvider(testGeminiThoughtSignature([0x45, 0x12]))).toBe(SignatureProviderUnknown);
});

test("Gemini ASCII UUID signature uses bypass", () => {
  const plainUUID = "e24830a7-5cd6-42fe-998b-ee539e72b9c3";
  const sig = testGeminiThoughtSignature(bytesOf(plainUUID));
  expect(detectSignatureProvider(plainUUID)).toBe(SignatureProviderUnknown);
  expect(detectSignatureProvider("gemini#" + plainUUID)).toBe(SignatureProviderUnknown);
  expect(detectSignatureProvider(sig)).toBe(SignatureProviderUnknown);
  expect(detectSignatureProvider("gemini#" + sig)).toBe(SignatureProviderUnknown);
  expect(detectSignatureProviderForBlock(sig, SignatureBlockKindGeminiFunctionCall)).toBe(SignatureProviderUnknown);
  expect(compatibleSignatureForProvider(SignatureProviderGemini, sig)).toBeUndefined();
  expect(compatibleSignatureForProviderBlock(SignatureProviderGemini, sig, SignatureBlockKindGeminiFunctionCall)).toBeUndefined();
  let decision = decideSignatureCompatibility(SignatureProviderGemini, sig, SignatureBlockKindGeminiFunctionCall);
  expect(decision.action).toBe(SignatureActionReplaceWithGeminiBypass);
  expect(decision.replacementSignature).toBe(geminiSkipThoughtSignatureValidator);
  decision = decideSignatureCompatibility(SignatureProviderGemini, sig, SignatureBlockKindGeminiModelPart);
  expect(decision.action).toBe(SignatureActionReplaceWithGeminiBypass);
});

test("Gemini wrapped UUID function call signature is compatible", () => {
  const sig = testGemini3ThoughtSignature(bytesOf("e24830a7-5cd6-42fe-998b-ee539e72b9c3"));
  expect(detectSignatureProvider(sig)).toBe(SignatureProviderGemini);
  expect(detectSignatureProviderForBlock(sig, SignatureBlockKindGeminiFunctionCall)).toBe(SignatureProviderGemini);
  expect(compatibleSignatureForProviderBlock(SignatureProviderGemini, sig, SignatureBlockKindGeminiFunctionCall)).toBe(sig);
  for (const blockKind of [SignatureBlockKindGeminiFunctionCall, SignatureBlockKindGeminiModelPart]) {
    const decision = decideSignatureCompatibility(SignatureProviderGemini, sig, blockKind);
    expect(decision.compatible, blockKind).toBe(true);
    expect(decision.action, blockKind).toBe(SignatureActionPreserve);
    expect(decision.normalizedSignature, blockKind).toBe(sig);
  }
});

test("CompatibleSignatureForProvider strips Gemini prefix", () => {
  const sig = testGemini3ThoughtSignature([0x01, 0x0c, 0x39]);
  expect(compatibleSignatureForProvider(SignatureProviderGemini, "gemini#" + sig)).toBe(sig);
});

test("SplitSignatureProviderPrefix uses strict provider aliases", () => {
  expect(detectSignatureProvider("gpt#" + testGPTReasoningSignature())).toBe(SignatureProviderGPT);
  const mislabeledPrefix = "claude-cache#" + testClaudeThinkingSignature();
  expect(splitSignatureProviderPrefix(mislabeledPrefix).ok).toBe(false);
  expect(detectSignatureProvider(mislabeledPrefix)).toBe(SignatureProviderUnknown);
});

test("DecideSignatureCompatibility Gemini function call uses bypass", () => {
  const decision = decideSignatureCompatibility(SignatureProviderGemini, "claude#" + testClaudeThinkingSignature(), SignatureBlockKindGeminiFunctionCall);
  expect(decision.action).toBe(SignatureActionReplaceWithGeminiBypass);
  expect(decision.replacementSignature).toBe(geminiSkipThoughtSignatureValidator);
});

test("SanitizeClaudeMessagesSignaturesForModel normalizes same-provider Claude", () => {
  const nativeSig = testClaudeThinkingSignature();
  const input = `{"model":"claude-sonnet","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"claude#${nativeSig}"},{"type":"text","text":"answer"}]}]}`;
  const expectedSig = normalizeClaudeProviderNativeThinkingSignature(nativeSig);
  const { payload, report } = sanitizeClaudeMessagesSignaturesForModel(input, "claude-sonnet-4-5");
  expect(report.preserved).toBe(1);
  expect(report.droppedBlocks).toBe(0);
  expect(at(payload, "messages.0.content.0.signature")).toBe(expectedSig);
});

test("SanitizeClaudeMessagesSignaturesForModel drops Claude thinking for Gemini", () => {
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"drop","signature":"claude#${testClaudeThinkingSignature()}"},{"type":"text","text":"answer"}]}]}`;
  const { payload, report } = sanitizeClaudeMessagesSignaturesForModel(input, "gemini-3.5-flash");
  expect(report.droppedBlocks).toBe(1);
  const content = garray(at(payload, "messages.0.content"));
  expect(content.length).toBe(1);
  expect(getAt(content[0], "text")).toBe("answer");
});

test("SanitizeClaudeMessagesSignaturesForModel preserves Gemini thinking for Gemini", () => {
  const nativeSig = testGemini3ThoughtSignature([0x01, 0x0c, 0x39]);
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"gemini#${nativeSig}"},{"type":"text","text":"answer"}]}]}`;
  const { payload, report } = sanitizeClaudeMessagesSignaturesForModel(input, "gemini-3.5-flash");
  expect(report.preserved).toBe(1);
  expect(report.droppedBlocks).toBe(0);
  expect(at(payload, "messages.0.content.0.signature")).toBe(nativeSig);
});

test("SanitizeClaudeMessagesSignaturesForModel preserves GPT for GPT", () => {
  const sig = testGPTReasoningSignature();
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"${sig}"},{"type":"text","text":"answer"}]}]}`;
  const { payload, report } = sanitizeClaudeMessagesSignaturesForModel(input, "gpt-5.2");
  expect(report.preserved).toBe(1);
  expect(report.droppedBlocks).toBe(0);
  expect(at(payload, "messages.0.content.0.signature")).toBe(sig);
});

test("SanitizeClaudeMessagesSignaturesForModel drops empty assistant message", () => {
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"drop","signature":"claude#${testClaudeThinkingSignature()}"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]}`;
  const { payload, report } = sanitizeClaudeMessagesSignaturesForModel(input, "gpt-5.2");
  expect(report.droppedBlocks).toBe(1);
  const messages = garray(at(payload, "messages"));
  expect(messages.length).toBe(1);
  expect(getAt(messages[0], "role")).toBe("user");
});

test("SanitizeClaudeMessagesForClaudeUpstream drops invalid thinking and cleans tool_use", () => {
  const input =
    '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"drop me","signature":""},{"type":"text","text":"answer"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"git status"},"signature":"bad","thoughtSignature":"bad2","thought_signature":"bad3","model":"claude-sonnet-4-5","extra_content":{"google":{"thought_signature":"bad4"}}}]}]}';
  const { payload, report } = sanitizeClaudeMessagesForClaudeUpstream(input, "claude-sonnet-4-5");
  expect(report.droppedBlocks).toBe(1);
  const parts = garray(at(payload, "messages.0.content"));
  expect(parts.length).toBe(2);
  expect(getAt(parts[0], "type")).toBe("text");
  const toolUse = parts[1];
  expect(getAt(toolUse, "type")).toBe("tool_use");
  expect(getAt(toolUse, "id")).toBe("toolu_1");
  for (const path of ["signature", "thoughtSignature", "thought_signature", "model", "extra_content"]) {
    expect(getAt(toolUse, path), path).toBeUndefined();
  }
});

test("SanitizeClaudeMessagesForClaudeUpstream normalizes valid thinking and drops empty message", () => {
  const nativeSig = testClaudeThinkingSignature();
  const doubleEncoded = encodeStd(bytesOf(nativeSig));
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"${doubleEncoded}"},{"type":"text","text":"answer"}]},{"role":"assistant","content":[{"type":"thinking","thinking":"drop"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]}`;
  const { payload, report } = sanitizeClaudeMessagesForClaudeUpstream(input, "claude-sonnet-4-5");
  expect(report.preserved).toBe(1);
  expect(report.droppedBlocks).toBe(1);
  const messages = garray(at(payload, "messages"));
  expect(messages.length).toBe(2);
  expect(getAt(messages[0], "content.0.signature")).toBe(nativeSig);
  expect(getAt(messages[1], "role")).toBe("user");
});
