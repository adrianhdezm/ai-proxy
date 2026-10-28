// Ported from: internal/signature/gemini_validation_test.go
// Skipped cases: TestIsValidGeminiThoughtSignature_AgyNativeSamples (needs the untracked agy Gemini corpus file)
import { describe, expect, test } from "bun:test";
import {
  decideSignatureCompatibility,
  detectSignatureProvider,
  detectSignatureProviderForBlock,
  geminiReplaySignatureOrBypass,
  geminiSkipThoughtSignatureValidator,
  inspectGeminiThoughtSignature,
  isGeminiVertexBareTinkSignature,
  isValidClaudeCAISSignature,
  isValidGeminiThoughtSignature,
  SignatureActionPreserve,
  SignatureActionReplaceWithGeminiBypass,
  SignatureBlockKindClaudeThinking,
  SignatureBlockKindGeminiFunctionCall,
  SignatureBlockKindGeminiModelPart,
  SignatureProviderGemini,
  validateGeminiFunctionCallPairing,
  validateGeminiThoughtSignatures,
} from "../../src/signature/index.ts";
import { bytesOf, testGemini25ThoughtSignature, testGemini3ThoughtSignature, testGeminiBareTinkSignature, testGeminiThoughtSignature } from "./helpers.ts";

const knownEnvelope = (sig: string): boolean => {
  try {
    return inspectGeminiThoughtSignature(sig, { requireKnownEnvelope: true }).knownEnvelope;
  } catch {
    return false;
  }
};

test("InspectGeminiThoughtSignature accepts opaque base64", () => {
  const info = inspectGeminiThoughtSignature(testGeminiThoughtSignature([0x12, 0x34, 0x56]));
  expect(info.isBypassSentinel).toBe(false);
  expect(info.decodedLen).toBe(3);
  expect(info.firstByte).toBe(0x12);
  expect(info.hasObservedMarker).toBe(true);
  expect(info.envelope).toBe("unknown");
  expect(info.knownEnvelope).toBe(false);
});

test("InspectGeminiThoughtSignature accepts Gemini 3.1 Pro field-2 envelope", () => {
  const sig = testGemini3ThoughtSignature([0x01, 0x0c, 0x39, 0xd6, 0xc7, 0x34]);
  const info = inspectGeminiThoughtSignature(sig, { requireKnownEnvelope: true });
  expect(info.envelope).toBe("protobuf_field_2");
  expect(info.hasObservedMarker).toBe(true);
  expect(info.recordCount).toBe(1);
  expect(info.opaquePayloadLen).toBe(6);
});

test("InspectGeminiThoughtSignature accepts captured Gemini 3.1 Flash Lite envelope", () => {
  const sig = "EjQKMgEMOdbHO0Gd+c9Mxk4ELwPGbpCEcp2mFfYYLix2UVtBH3fL8GECc4+JITVnHF4qZDsA";
  const info = inspectGeminiThoughtSignature(sig, { requireKnownEnvelope: true });
  expect(info.envelope).toBe("protobuf_field_2");
  expect(info.recordCount).toBe(1);
  expect(info.opaquePayloadLen).toBe(50);
});

const liveCapturedToolCallSig =
  "ErUDCrIDCAISrQMBEU0yD9ECvDhSY1DQJNUGafArdfd2mDfO8VQq7XjLx/91zESuo0QPSdkRFWkLeVIocSQmQULonYMOJcs6XDLV2LTRC9myb3MCCP9CUoWbEeqhAvXKTScyS3nwBDDVJYuDDbY3YvR4V86T/DnU3qufpaVZ3wQOiJVyBVZ515dYTN+XGq7SuUc3RpfAqVU06jgxaCM0WKV4Df5mGMJWb25e/aFG2Jc7upSqpf3n6aElj+4c/eWr4GdKd0TUIElXBZ0HEN/vNcWzD3F0S4MeVbk1LDakL6HG6oyaSS2gocxYNYxqm9mdMHaXYa4mIYqWqmqBEnbgcHp8H4fgqBxc3Cx8C3otV8IarO5OALaVDA3NaXB1zjLet1587kEpkCNr9OvrYOES2nCl/i4EgbPK01nlXo+Wwm5jsZU5nEG4/Z0bErzqC5TKwOsqpJ7afL2sPWI0IGrXhXL+QCumWCS5iUtwybSkL7CYSk9GC+iY+ev6FAmC4V5JEc4OaWOc9+m/29LniN/iPTSxtUQSZT94pUa3/irIIdH7ReAS3cpeM6OTvumR1PwNxXx3XM1mEGc=";

test("InspectGeminiThoughtSignature accepts server-side tool protobuf envelope", () => {
  const info = inspectGeminiThoughtSignature(liveCapturedToolCallSig, { requireKnownEnvelope: true });
  expect(info.envelope).toBe("protobuf_field_2");
  expect(info.knownEnvelope).toBe(true);
  expect(detectSignatureProviderForBlock(liveCapturedToolCallSig, SignatureBlockKindGeminiModelPart)).toBe(SignatureProviderGemini);
});

test("InspectGeminiThoughtSignature rejects malformed tool invocation payload", () => {
  expect(knownEnvelope(testGemini3ThoughtSignature([0x08, 0x02, 0x12, 0x10, 0x01]))).toBe(false);
  expect(knownEnvelope(testGemini3ThoughtSignature([0x08, 0x02, 0x12, 0x04, 0x99, 0x98, 0x97, 0x96]))).toBe(false);
  expect(knownEnvelope(testGemini3ThoughtSignature([0x08, 0x02, 0x10, 0x05]))).toBe(false);
});

test("ValidateGeminiFunctionCallPairing accepts server-side tool blocks", () => {
  const input = `{
    "contents": [
      {"role": "model", "parts": [
        {"toolCall": {"id": "search_1", "toolType": "GOOGLE_SEARCH_WEB"}},
        {"toolResponse": {"id": "search_1", "response": {}}},
        {"functionCall": {"id": "call_1", "name": "do_something", "args": {}}}
      ]},
      {"role": "user", "parts": [
        {"functionResponse": {"id": "call_1", "name": "do_something", "response": {"result": "ok"}}}
      ]}
    ]
  }`;
  expect(validateGeminiFunctionCallPairing(input)).toBeUndefined();
});

test("InspectGeminiThoughtSignature accepts Gemini 3 wrapped UUID envelope", () => {
  const providerUUID = "e24830a7-5cd6-42fe-998b-ee539e72b9c3";
  const sig = testGemini3ThoughtSignature(bytesOf(providerUUID));
  const info = inspectGeminiThoughtSignature(sig, { requireKnownEnvelope: true });
  expect(info.envelope).toBe("protobuf_field_2");
  expect(info.recordCount).toBe(1);
  expect(info.opaquePayloadLen).toBe(providerUUID.length);
  expect(detectSignatureProviderForBlock(sig, SignatureBlockKindGeminiFunctionCall)).toBe(SignatureProviderGemini);
});

test("InspectGeminiThoughtSignature rejects Gemini 2.5 field-1 envelope", () => {
  const sig = testGemini25ThoughtSignature([0x01, 0x8f], [0x01, 0x90, 0x91]);
  expect(() => inspectGeminiThoughtSignature(sig, { requireKnownEnvelope: true })).toThrow();
  const info = inspectGeminiThoughtSignature(sig);
  expect(info.envelope).toBe("unknown");
  expect(info.knownEnvelope).toBe(false);
  const decision = decideSignatureCompatibility(SignatureProviderGemini, sig, SignatureBlockKindGeminiModelPart);
  expect(decision.action).toBe(SignatureActionReplaceWithGeminiBypass);
  expect(decision.replacementSignature).toBe(geminiSkipThoughtSignatureValidator);
});

test("InspectGeminiThoughtSignature rejects malformed known envelope", () => {
  expect(isValidGeminiThoughtSignature(testGemini3ThoughtSignature([0x02, 0x0c, 0x39]), { requireKnownEnvelope: true })).toBe(false);
});

test("InspectGeminiThoughtSignature classifies ASCII UUID as opaque", () => {
  const sig = testGeminiThoughtSignature(bytesOf("e24830a7-5cd6-42fe-998b-ee539e72b9c3"));
  const info = inspectGeminiThoughtSignature(sig);
  expect(info.envelope).toBe("ascii_uuid");
  expect(info.knownEnvelope).toBe(false);
  expect(isValidGeminiThoughtSignature(sig, { requireKnownEnvelope: true })).toBe(false);
});

test("InspectGeminiThoughtSignature observed marker option", () => {
  const sig = testGeminiThoughtSignature([0x45, 0x12]);
  expect(() => inspectGeminiThoughtSignature(sig)).not.toThrow();
  expect(() => inspectGeminiThoughtSignature(sig, { requireObservedMarker: true })).toThrow("expected observed marker");
});

test("InspectGeminiThoughtSignature bypass sentinel requires option", () => {
  expect(isValidGeminiThoughtSignature(geminiSkipThoughtSignatureValidator)).toBe(false);
  const info = inspectGeminiThoughtSignature(geminiSkipThoughtSignatureValidator, { allowBypassSentinel: true });
  expect(info.isBypassSentinel).toBe(true);
  expect(info.bypassSentinel).toBe(geminiSkipThoughtSignatureValidator);
});

test("InspectGeminiThoughtSignature rejects invalid base64", () => {
  expect(isValidGeminiThoughtSignature("not valid base64!!!")).toBe(false);
});

test("ValidateGeminiThoughtSignatures first functionCall requires signature", () => {
  const input = '{"contents":[{"role":"model","parts":[{"functionCall":{"id":"call-1","name":"read_file","args":{}}}]}]}';
  expect(validateGeminiThoughtSignatures(input)).toContain("missing thoughtSignature on first functionCall");
});

test("ValidateGeminiThoughtSignatures allows unsigned parallel sibling", () => {
  const input = `{"contents":[{"role":"model","parts":[
    {"functionCall":{"id":"call-1","name":"read_file","args":{}},"thoughtSignature":"skip_thought_signature_validator"},
    {"functionCall":{"id":"call-2","name":"read_file","args":{}}}
  ]}]}`;
  expect(validateGeminiThoughtSignatures(input, { allowBypassSentinel: true })).toBeUndefined();
});

describe("ValidateGeminiThoughtSignatures rejects sentinel outside first functionCall", () => {
  const cases = [
    {
      name: "parallel sibling",
      parts: '[{"functionCall":{"name":"first","args":{}},"thoughtSignature":"skip_thought_signature_validator"},{"functionCall":{"name":"second","args":{}},"thoughtSignature":"skip_thought_signature_validator"}]',
    },
    { name: "thought part", parts: '[{"text":"hidden","thought":true,"thoughtSignature":"skip_thought_signature_validator"}]' },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const err = validateGeminiThoughtSignatures(`{"contents":[{"role":"model","parts":${tc.parts}}]}`, { allowBypassSentinel: true });
      expect(err).toContain("allowed only on the first model functionCall");
    });
  }
});

describe("ValidateGeminiThoughtSignatures call after text starts new group", () => {
  test("rejects unsigned call after text", () => {
    const input = `{"contents":[{"role":"model","parts":[
      {"functionCall":{"id":"call-1","name":"read_file","args":{}},"thoughtSignature":"skip_thought_signature_validator"},
      {"text":"more"},
      {"functionCall":{"id":"call-2","name":"read_file","args":{}}}
    ]}]}`;
    expect(validateGeminiThoughtSignatures(input, { allowBypassSentinel: true })).toContain("missing thoughtSignature on first functionCall");
  });
  test("accepts sentinel on call after text", () => {
    const input = `{"contents":[{"role":"model","parts":[
      {"functionCall":{"id":"call-1","name":"read_file","args":{}},"thoughtSignature":"skip_thought_signature_validator"},
      {"text":"more"},
      {"functionCall":{"id":"call-2","name":"read_file","args":{}},"thoughtSignature":"skip_thought_signature_validator"}
    ]}]}`;
    expect(validateGeminiThoughtSignatures(input, { allowBypassSentinel: true })).toBeUndefined();
  });
});

test("ValidateGeminiThoughtSignatures rejects non-canonical nested signature", () => {
  const signature = testGemini3ThoughtSignature([0x01, 0x0c, 0x39]);
  const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{},"thoughtSignature":"${signature}"}}]}]}`;
  expect(validateGeminiThoughtSignatures(input)).toContain("canonical top-level field");
});

test("ValidateGeminiThoughtSignatures accepts wrapped request and sentinel when allowed", () => {
  const input = '{"request":{"contents":[{"role":"model","parts":[{"functionCall":{"id":"call-1","name":"read_file","args":{}},"thoughtSignature":"skip_thought_signature_validator"}]}]}}';
  expect(validateGeminiThoughtSignatures(input, { allowBypassSentinel: true })).toBeUndefined();
});

test("ValidateGeminiThoughtSignatures rejects invalid text part signature", () => {
  const input = '{"contents":[{"role":"model","parts":[{"text":"previous answer","thoughtSignature":"bad!!!"}]}]}';
  expect(validateGeminiThoughtSignatures(input)).toContain("base64 decode failed");
});

test("ValidateGeminiFunctionCallPairing valid parallel group", () => {
  const input = `{"contents":[
    {"role":"model","parts":[{"functionCall":{"id":"call-1","name":"weather","args":{"city":"Paris"}}},{"functionCall":{"id":"call-2","name":"weather","args":{"city":"London"}}}]},
    {"role":"user","parts":[{"functionResponse":{"id":"call-1","name":"weather","response":{"temp":"15C"}}},{"functionResponse":{"id":"call-2","name":"weather","response":{"temp":"12C"}}}]}
  ]}`;
  expect(validateGeminiFunctionCallPairing(input)).toBeUndefined();
});

test("ValidateGeminiFunctionCallPairing allows user boundary before response", () => {
  const payload = '{"contents":[{"role":"model","parts":[{"functionCall":{"id":"call-1","name":"run","args":{}}}]},{"role":"user","parts":[{"text":"boundary"}]},{"role":"user","parts":[{"functionResponse":{"id":"call-1","name":"run","response":{"result":"ok"}}}]}]}';
  expect(validateGeminiFunctionCallPairing(payload)).toBeUndefined();
});

test("ValidateGeminiFunctionCallPairing rejects model boundary before response", () => {
  const payload = '{"contents":[{"role":"model","parts":[{"functionCall":{"id":"call-1","name":"run","args":{}}}]},{"role":"model","parts":[{"text":"boundary"}]},{"role":"user","parts":[{"functionResponse":{"id":"call-1","name":"run","response":{"result":"ok"}}}]}]}';
  expect(validateGeminiFunctionCallPairing(payload)).toBeDefined();
});

test("ValidateGeminiFunctionCallPairing rejects empty content boundary before response", () => {
  for (const boundary of ['{"role":"user","parts":[]}', '{"role":"user"}', '{"role":"user","parts":null}']) {
    const payload = `{"contents":[{"role":"model","parts":[{"functionCall":{"id":"call-1","name":"run","args":{}}}]},${boundary},{"role":"model","parts":[{"functionResponse":{"id":"call-1","name":"run","response":{"result":"ok"}}}]}]}`;
    expect(validateGeminiFunctionCallPairing(payload), boundary).toBeDefined();
  }
});

test("ValidateGeminiFunctionCallPairing rejects response count mismatch", () => {
  const input = `{"contents":[
    {"role":"model","parts":[{"functionCall":{"id":"call-1","name":"weather","args":{}}},{"functionCall":{"id":"call-2","name":"weather","args":{}}}]},
    {"role":"user","parts":[{"functionResponse":{"id":"call-1","name":"weather","response":{}}}]}
  ]}`;
  expect(validateGeminiFunctionCallPairing(input)).toContain("does not match pending functionCall count");
});

test("ValidateGeminiFunctionCallPairing rejects missing functionCall name", () => {
  const input = '{"contents":[{"role":"model","parts":[{"functionCall":{"id":"call-1","args":{}}}]}]}';
  expect(validateGeminiFunctionCallPairing(input)).toContain("missing functionCall.name");
});

test("ValidateGeminiFunctionCallPairing rejects ID mismatch", () => {
  const input = `{"contents":[
    {"role":"model","parts":[{"functionCall":{"id":"call-1","name":"weather","args":{}}}]},
    {"role":"user","parts":[{"functionResponse":{"id":"call-other","name":"weather","response":{}}}]}
  ]}`;
  expect(validateGeminiFunctionCallPairing(input)).toContain("does not match functionCall.id");
});

test("ValidateGeminiFunctionCallPairing rejects missing response name", () => {
  const input = `{"contents":[
    {"role":"model","parts":[{"functionCall":{"id":"call-1","name":"weather","args":{}}}]},
    {"role":"user","parts":[{"functionResponse":{"id":"call-1","response":{}}}]}
  ]}`;
  expect(validateGeminiFunctionCallPairing(input)).toContain("missing functionResponse.name");
});

test("ValidateGeminiFunctionCallPairing rejects same-content interleaving", () => {
  const input = '{"contents":[{"role":"model","parts":[{"functionCall":{"id":"call-1","name":"weather","args":{}}},{"functionResponse":{"id":"call-1","name":"weather","response":{}}}]}]}';
  expect(validateGeminiFunctionCallPairing(input)).toContain("must not be interleaved");
});

test("InspectGeminiThoughtSignature accepts Vertex bare-Tink envelope", () => {
  const sig = testGeminiBareTinkSignature(606);
  const info = inspectGeminiThoughtSignature(sig, { requireKnownEnvelope: true });
  expect(info.envelope).toBe("bare_tink");
  expect(info.knownEnvelope).toBe(true);
  expect(info.firstByte).toBe(0x01);
  expect(info.recordCount).toBe(1);
  expect(info.opaquePayloadLen).toBe(606);
  expect(info.hasObservedMarker).toBe(false);
  expect(detectSignatureProviderForBlock(sig, SignatureBlockKindGeminiModelPart)).toBe(SignatureProviderGemini);
  expect(detectSignatureProviderForBlock(sig, SignatureBlockKindGeminiFunctionCall)).toBe(SignatureProviderGemini);
  const decision = decideSignatureCompatibility(SignatureProviderGemini, sig, SignatureBlockKindGeminiFunctionCall);
  expect(decision.action).toBe(SignatureActionPreserve);
  expect(geminiReplaySignatureOrBypass(sig, SignatureBlockKindGeminiFunctionCall)).toBe(sig);
});

test("InspectGeminiThoughtSignature rejects short bare-Tink envelope", () => {
  const sig = testGeminiThoughtSignature([0x01, 0x8f, 0x3d, ...new Array<number>(10).fill(0)]);
  expect(() => inspectGeminiThoughtSignature(sig, { requireKnownEnvelope: true })).toThrow();
  const decision = decideSignatureCompatibility(SignatureProviderGemini, sig, SignatureBlockKindGeminiFunctionCall);
  expect(decision.action).toBe(SignatureActionReplaceWithGeminiBypass);
  expect(decision.replacementSignature).toBe(geminiSkipThoughtSignatureValidator);
});

test("DetectSignatureProvider Vertex bare-Tink never claims other families", () => {
  const sig = testGeminiBareTinkSignature(405);
  expect(detectSignatureProviderForBlock(sig, SignatureBlockKindClaudeThinking)).toBe(SignatureProviderGemini);
  expect(isValidClaudeCAISSignature(sig)).toBe(false);
});

test("InspectGeminiThoughtSignature bare-Tink requires Vertex key id", () => {
  const payload = [0x01, 0x69, 0x14, 0x7d, 0x13];
  while (payload.length < 405) payload.push(0xa0 + (payload.length % 0x20));
  const sig = testGeminiThoughtSignature(payload);
  expect(isGeminiVertexBareTinkSignature(sig)).toBe(false);
  expect(() => inspectGeminiThoughtSignature(sig, { requireKnownEnvelope: true })).toThrow();
  expect(detectSignatureProvider(sig)).not.toBe(SignatureProviderGemini);
  expect(isGeminiVertexBareTinkSignature(testGeminiBareTinkSignature(405))).toBe(true);
  expect(isGeminiVertexBareTinkSignature("gemini#" + testGeminiBareTinkSignature(405))).toBe(true);
});
