// Ported from: internal/signature/claude_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import {
  compatibleAntigravityClaudeThinkingSignature,
  compatibleSignatureForProvider,
  decideSignatureCompatibilityForModel,
  detectSignatureProvider,
  detectSignatureProviderForBlock,
  inspectClaudeCAISSignature,
  inspectGeminiThoughtSignature,
  isRecognizedGeminiProviderSignature,
  isSignatureCompatibleWithProvider,
  isValidClaudeCAISSignature,
  sanitizeClaudeMessagesForClaudeUpstream,
  SignatureActionPreserve,
  SignatureBlockKindClaudeThinking,
  SignatureBlockKindUnknown,
  SignatureProviderClaude,
  SignatureProviderGemini,
  stripInvalidClaudeThinkingBlocks,
  stripInvalidClaudeThinkingBlocksAndEmptyMessages,
} from "../../src/signature/index.ts";
import { bytesToLatin1, latin1ToBytes } from "../../src/util/base64.ts";
import { garray, getAt } from "../../src/util/gpath.ts";
import {
  type ClaudeCAISParts,
  decodeStd,
  defaultClaudeCAISParts,
  encodeClaudeCAISParts,
  encodeStd,
  observedFable51CAQSNarrationSample,
  observedFable51CAQSSample,
  observedFable5Sample,
  testClaudeCAISSignature,
  testClaudeThinkingSignature,
} from "./helpers.ts";

const at = (payload: string, path: string): unknown => getAt(JSON.parse(payload), path);
const contentOf = (payload: string, msg = 0): unknown[] => garray(at(payload, `messages.${msg}.content`));

test("StripInvalidClaudeThinkingBlocks removes GPT encrypted_content", () => {
  const input = `{
    "messages": [
      {"role":"assistant","content":[
        {"type":"thinking","thinking":"codex reasoning","signature":"gAAAAABopenai-encrypted-content"},
        {"type":"text","text":"Answer"}
      ]},
      {"role":"user","content":[{"type":"text","text":"next"}]}
    ]
  }`;
  const out = stripInvalidClaudeThinkingBlocks(input);
  const content = contentOf(out);
  expect(content.length).toBe(1);
  expect(getAt(content[0], "text")).toBe("Answer");
  expect(out).not.toContain("gAAAAABopenai-encrypted-content");
  expect(out).not.toContain("codex reasoning");
});

test("StripInvalidClaudeThinkingBlocksAndEmptyMessages drops messages left empty", () => {
  const input = `{
    "messages": [
      {"role":"assistant","content":[
        {"type":"thinking","thinking":"codex reasoning","signature":"gAAAAABopenai-encrypted-content"}
      ]},
      {"role":"user","content":[{"type":"text","text":"next"}]}
    ]
  }`;
  const out = stripInvalidClaudeThinkingBlocksAndEmptyMessages(input);
  const messages = garray(at(out, "messages"));
  expect(messages.length).toBe(1);
  expect(getAt(messages[0], "role")).toBe("user");
  expect(out).not.toContain("gAAAAABopenai-encrypted-content");
  expect(out).not.toContain("codex reasoning");
});

test("StripInvalidClaudeThinkingBlocks removes malformed E prefix", () => {
  const input = '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"bad","signature":"Ebad"},{"type":"text","text":"Answer"}]}]}';
  const out = stripInvalidClaudeThinkingBlocks(input);
  expect(contentOf(out).length).toBe(1);
  expect(out).not.toContain("Ebad");
  expect(out).not.toContain("bad");
});

test("StripInvalidClaudeThinkingBlocks base64Only keeps decodable E prefix", () => {
  const input = '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"bad","signature":"Ebad"},{"type":"text","text":"Answer"}]}]}';
  const out = stripInvalidClaudeThinkingBlocks(input, { base64Only: true });
  expect(contentOf(out).length).toBe(2);
});

test("StripInvalidClaudeThinkingBlocks base64Only removes invalid base64", () => {
  const input = '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"bad","signature":"E!!!invalid!!!"},{"type":"text","text":"Answer"}]}]}';
  const out = stripInvalidClaudeThinkingBlocks(input, { base64Only: true });
  expect(contentOf(out).length).toBe(1);
  expect(out).not.toContain("E!!!invalid!!!");
  expect(out).not.toContain("bad");
});

test("StripInvalidClaudeThinkingBlocks allows empty signature empty text placeholder", () => {
  const input = '{"messages":[{"role":"assistant","content":[{"type":"thinking","text":"","signature":""},{"type":"text","text":"Answer"}]}]}';
  const out = stripInvalidClaudeThinkingBlocks(input, { base64Only: true, allowEmptySignatureWithEmptyText: true });
  expect(contentOf(out).length).toBe(2);
});

test("StripInvalidClaudeThinkingBlocks strict removes malformed Claude tree", () => {
  const sig = encodeStd([0x12, 0xff, 0xfe, 0xfd]);
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"bad","signature":"${sig}"},{"type":"text","text":"Answer"}]}]}`;
  const out = stripInvalidClaudeThinkingBlocks(input, { strict: true });
  expect(contentOf(out).length).toBe(1);
  expect(out).not.toContain(sig);
  expect(out).not.toContain("bad");
});

test("StripInvalidClaudeThinkingBlocks keeps Claude signature prefixes", () => {
  const singleLayer = encodeStd([0x12, 0x34]);
  const doubleLayer = encodeStd(new TextEncoder().encode(singleLayer));
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"one","signature":"${singleLayer}"},{"type":"thinking","thinking":"two","signature":"modelGroup#${doubleLayer}"}]}]}`;
  const out = stripInvalidClaudeThinkingBlocks(input);
  expect(contentOf(out).length).toBe(2);
});

test("ClaudeCAISSignature observed fable-5 sample", () => {
  expect(isValidClaudeCAISSignature(observedFable5Sample)).toBe(true);
  const info = inspectClaudeCAISSignature(observedFable5Sample);
  expect(info.modelText).toBe("claude-fable-5");
  expect(info.blockKind).toBe("thinking");
  expect(info.contextID).toBe("d9743975-4bb0-4936-9e28-d5b0d21bdc48");
  expect(info.firstByte).toBe(0x08);
});

test("ClaudeCAQSSignature observed fable-5.1 sample", () => {
  expect(isValidClaudeCAISSignature(observedFable51CAQSSample)).toBe(true);
  const info = inspectClaudeCAISSignature(observedFable51CAQSSample);
  expect(info.envelopeVersion).toBe(4);
  expect(info.channelID).toBe(17);
  expect(info.blockKind).toBe("thinking");
  expect(info.firstByte).toBe(0x08);
  expect(info.signatureLen).toBe(4064);
  expect(detectSignatureProvider(observedFable51CAQSSample)).toBe(SignatureProviderClaude);
});

test("ClaudeCAISSignature observed fable-5.1 CAQS narration sample", () => {
  expect(isValidClaudeCAISSignature(observedFable51CAQSNarrationSample)).toBe(true);
  const info = inspectClaudeCAISSignature(observedFable51CAQSNarrationSample);
  expect(info.envelopeVersion).toBe(4);
  expect(info.channelID).toBe(17);
  expect(info.blockKind).toBe("narration");
  expect(info.firstByte).toBe(0x08);
  expect(info.signatureLen).toBe(883);
  expect(detectSignatureProvider(observedFable51CAQSNarrationSample)).toBe(SignatureProviderClaude);
});

describe("ClaudeCAQSSignature rejects malformed payloads", () => {
  const mutateBlockKind = (replacement: string): string => {
    const decoded = bytesToLatin1(decodeStd(observedFable51CAQSSample));
    return encodeStd(latin1ToBytes(decoded.replace("thinking", replacement)));
  };
  const cases = [
    { name: "invalid block kind", signature: mutateBlockKind("unknown!") },
    { name: "unrecognized block kind", signature: mutateBlockKind("redacted") },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(isValidClaudeCAISSignature(tc.signature)).toBe(false);
      expect(() => inspectClaudeCAISSignature(tc.signature)).toThrow();
    });
  }
});

test("ClaudeCAISSignature DetectSignatureProvider", () => {
  for (const prefix of ["", "ccmax#", "claude-code-max#", "claude_code_max#", "cais#", "claude-cais#", "claude_cais#", "claude#"]) {
    expect(detectSignatureProvider(prefix + observedFable5Sample), prefix).toBe(SignatureProviderClaude);
  }
});

test("ClaudeCAISSignature observed opus-5 layout", () => {
  const signature = testClaudeCAISSignature("claude-opus-5");
  const info = inspectClaudeCAISSignature(signature);
  expect(info.modelText).toBe("claude-opus-5");
  const decision = decideSignatureCompatibilityForModel(SignatureProviderClaude, "claude-opus-5", signature, SignatureBlockKindClaudeThinking);
  expect(decision.compatible).toBe(true);
  expect(decision.normalizedSignature).toBe(signature);
  expect(decision.detectedProvider).toBe(SignatureProviderClaude);
});

test("ClaudeCAISSignature not compatible with Gemini", () => {
  expect(compatibleSignatureForProvider(SignatureProviderGemini, observedFable5Sample)).toBeUndefined();
  expect(isSignatureCompatibleWithProvider(SignatureProviderGemini, observedFable5Sample)).toBe(false);
  expect(isRecognizedGeminiProviderSignature(observedFable5Sample, SignatureBlockKindUnknown)).toBe(false);
  expect(() => inspectGeminiThoughtSignature(observedFable5Sample)).toThrow();
});

test("ClaudeCAISSignature compatible with all Claude targets", () => {
  const decision = decideSignatureCompatibilityForModel(SignatureProviderClaude, "claude-fable-5", observedFable5Sample, SignatureBlockKindClaudeThinking);
  expect(decision.compatible).toBe(true);
  expect(decision.action).toBe(SignatureActionPreserve);
  expect(decision.normalizedSignature).toBe(observedFable5Sample);
  expect(decision.detectedProvider).toBe(SignatureProviderClaude);

  const decisionCase = decideSignatureCompatibilityForModel(SignatureProviderClaude, "CLAUDE-FABLE-5", observedFable5Sample, SignatureBlockKindClaudeThinking);
  expect(decisionCase.compatible).toBe(true);
  expect(decisionCase.action).toBe(SignatureActionPreserve);

  const decisionDiff = decideSignatureCompatibilityForModel(SignatureProviderClaude, "claude-opus-5", observedFable5Sample, SignatureBlockKindClaudeThinking);
  expect(decisionDiff.compatible).toBe(true);
  expect(decisionDiff.action).toBe(SignatureActionPreserve);
  expect(decisionDiff.normalizedSignature).toBe(observedFable5Sample);

  const opus5Sig = testClaudeCAISSignature("claude-opus-5");
  const decisionOpus = decideSignatureCompatibilityForModel(SignatureProviderClaude, "claude-opus-4-8", opus5Sig, SignatureBlockKindClaudeThinking);
  expect(decisionOpus.compatible).toBe(true);
  expect(decisionOpus.action).toBe(SignatureActionPreserve);
  expect(decisionOpus.normalizedSignature).toBe(opus5Sig);

  expect(compatibleSignatureForProvider(SignatureProviderClaude, observedFable5Sample)).toBe(observedFable5Sample);

  const decisionGemini = decideSignatureCompatibilityForModel(SignatureProviderGemini, "claude-fable-5", observedFable5Sample, SignatureBlockKindClaudeThinking);
  expect(decisionGemini.compatible).toBe(false);
});

test("SanitizeClaudeMessagesForClaudeUpstream Claude CAIS", () => {
  const inputSame = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"${observedFable5Sample}"},{"type":"text","text":"answer"}]}]}`;
  const same = sanitizeClaudeMessagesForClaudeUpstream(inputSame, "claude-fable-5");
  expect(same.report.preserved).toBe(1);
  expect(same.report.droppedBlocks).toBe(0);
  expect(at(same.payload, "messages.0.content.0.signature")).toBe(observedFable5Sample);

  const inputTool = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"${observedFable5Sample}"},{"type":"text","text":"answer"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pwd"},"signature":"${observedFable5Sample}"}]}]}`;
  const tool = sanitizeClaudeMessagesForClaudeUpstream(inputTool, "claude-fable-5");
  expect(tool.report.preserved).toBe(1);
  const partsTool = contentOf(tool.payload);
  expect(partsTool.length).toBe(3);
  expect(getAt(partsTool[0], "signature")).toBe(observedFable5Sample);
  expect(getAt(partsTool[2], "signature")).toBeUndefined();

  const diff = sanitizeClaudeMessagesForClaudeUpstream(inputSame, "claude-opus-5");
  expect(diff.report.preserved).toBe(1);
  expect(diff.report.droppedBlocks).toBe(0);
  const partsDiff = contentOf(diff.payload);
  expect(partsDiff.length).toBe(2);
  expect(getAt(partsDiff[0], "signature")).toBe(observedFable5Sample);
});

describe("ClaudeCAISSignature tolerates upstream field drift", () => {
  const variant = (mutate: (p: ClaudeCAISParts) => void, model = "claude-opus-5"): ClaudeCAISParts => {
    const p = defaultClaudeCAISParts(model);
    mutate(p);
    return p;
  };
  const cases: { name: string; parts: ClaudeCAISParts }[] = [
    { name: "observed layout", parts: defaultClaudeCAISParts("claude-opus-5") },
    { name: "new channel id", parts: variant((p) => (p.channelID = 17)) },
    { name: "new envelope version", parts: variant((p) => (p.topEnvelope = 3)) },
    { name: "no top-level trailer", parts: variant((p) => (p.includeTopTrailer = false)) },
    { name: "no channel version", parts: variant((p) => (p.includeChannelVersion = false)) },
    { name: "longer signature bytes", parts: variant((p) => (p.signatureLen = 96)) },
    { name: "no field 7", parts: variant((p) => (p.includeField7 = false)) },
    { name: "other block kind", parts: variant((p) => (p.blockKind = "redacted_thinking")) },
    { name: "no block kind", parts: variant((p) => (p.blockKind = "")) },
    { name: "no context id", parts: variant((p) => (p.contextID = "")) },
    { name: "unreleased model name", parts: defaultClaudeCAISParts("claude-opus-6-preview") },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const sig = encodeClaudeCAISParts(tc.parts);
      expect(() => inspectClaudeCAISSignature(sig)).not.toThrow();
      expect(detectSignatureProviderForBlock(sig, SignatureBlockKindClaudeThinking)).toBe(SignatureProviderClaude);
      const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"${sig}"}]}]}`;
      const { payload, report } = sanitizeClaudeMessagesForClaudeUpstream(input, "claude-opus-5");
      expect(report.preserved).toBe(1);
      expect(report.droppedBlocks).toBe(0);
      expect(at(payload, "messages.0.content.0.signature")).toBe(sig);
    });
  }
});

describe("ClaudeCAISSignature rejects malformed payloads", () => {
  const truncated = ((): string => {
    const decoded = decodeStd(observedFable5Sample);
    return encodeStd(decoded.slice(0, Math.floor(decoded.length / 2)));
  })();
  const variant = (mutate: (p: ClaudeCAISParts) => void, model = "claude-opus-5"): string => {
    const p = defaultClaudeCAISParts(model);
    mutate(p);
    return encodeClaudeCAISParts(p);
  };
  const cases: { name: string; signature: string }[] = [
    { name: "empty", signature: "" },
    { name: "whitespace only", signature: "   " },
    { name: "not base64", signature: "CAIS!!!not-base64" },
    { name: "truncated payload", signature: truncated },
    // 'E' prefix is the classic Claude form and must not reach CAIS parsing.
    { name: "classic claude prefix", signature: encodeStd([0x12, 0x00]) },
    // 'C' prefix but a non-0x08 marker byte.
    { name: "wrong marker byte", signature: encodeStd([0x0a, 0x00]) },
    { name: "no container", signature: variant((p) => (p.includeContainer = false)) },
    { name: "no channel block", signature: variant((p) => (p.includeChannelBlock = false)) },
    { name: "no channel id", signature: variant((p) => (p.includeChannelID = false)) },
    { name: "channel id wrong wire type", signature: variant((p) => (p.channelIDAsBytes = true)) },
    { name: "no signature bytes", signature: variant((p) => (p.includeSignature = false)) },
    { name: "empty signature bytes", signature: variant((p) => (p.signatureLen = 0)) },
    { name: "no model text", signature: variant((p) => (p.includeModelText = false)) },
    { name: "foreign model text", signature: testClaudeCAISSignature("gemini-3-pro") },
    { name: "invalid utf-8 model text", signature: variant((p) => (p.modelText = Uint8Array.from([0x63, 0x6c, 0x61, 0x75, 0x64, 0x65, 0x2d, 0xff, 0xfe]))) },
    { name: "non-uuid context id", signature: variant((p) => (p.contextID = "not-a-canonical-uuid-value-000000000")) },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(isValidClaudeCAISSignature(tc.signature)).toBe(false);
    });
  }
});

test("ClaudeCAISSignature does not shadow classic Claude signature", () => {
  const classic = testClaudeThinkingSignature();
  expect(isValidClaudeCAISSignature(classic)).toBe(false);
  expect(detectSignatureProviderForBlock(classic, SignatureBlockKindClaudeThinking)).toBe(SignatureProviderClaude);
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"${classic}"}]}]}`;
  const { payload, report } = sanitizeClaudeMessagesForClaudeUpstream(input, "claude-sonnet-4-6");
  expect(report.preserved).toBe(1);
  expect(report.droppedBlocks).toBe(0);
  expect(at(payload, "messages.0.content.0.signature")).toBe(classic);
});

describe("ClaudeCAISSignature cache prefix survives Claude upstream sanitize", () => {
  for (const prefix of ["claude#", "anthropic#", "cais#", "ccmax#"]) {
    test(prefix, () => {
      const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"${prefix + observedFable5Sample}"}]}]}`;
      const { payload, report } = sanitizeClaudeMessagesForClaudeUpstream(input, "claude-fable-5");
      expect(report.preserved).toBe(1);
      expect(report.droppedBlocks).toBe(0);
      expect(at(payload, "messages.0.content.0.signature")).toBe(observedFable5Sample);
    });
  }
});

test("CompatibleAntigravityClaudeThinkingSignature rejects Claude CAIS", () => {
  for (const prefix of ["", "ccmax#", "cais#", "claude-cais#"]) {
    expect(compatibleAntigravityClaudeThinkingSignature(prefix + observedFable5Sample), prefix).toBeUndefined();
  }
});
