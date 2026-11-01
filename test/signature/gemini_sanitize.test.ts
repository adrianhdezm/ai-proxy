// Ported from: internal/signature/gemini_sanitize_test.go
// Skipped cases: BenchmarkSanitizeGeminiRequestThoughtSignaturesNormalizedHistory (benchmark)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  geminiSkipThoughtSignatureValidator,
  sanitizeGeminiRequestThoughtSignatures,
  sanitizeNonVertexGeminiRequestThoughtSignatures,
  SignatureProviderSWE,
  SignatureProviderUnknown,
} from "../../src/signature/index.ts";
import { getAt } from "../../src/util/gpath.ts";
import { bytesOf, captureDebugLogs, type DebugLogCapture, testGemini3ThoughtSignature, testGeminiBareTinkSignature, testGeminiThoughtSignature, testGeminiThoughtSignatureEnvelope } from "./helpers.ts";

const at = (payload: string, path: string): unknown => getAt(JSON.parse(payload), path);
const bypass = geminiSkipThoughtSignatureValidator;

let hook: DebugLogCapture;
beforeEach(() => {
  hook = captureDebugLogs();
});
afterEach(() => {
  hook.restore();
});

function assertSignatureDebugDoesNotLeak(forbidden: string): void {
  if (forbidden === "") return;
  for (const entry of hook.entries()) expect(entry).not.toContain(forbidden);
}

test("preserves Gemini signature", () => {
  const sig = testGemini3ThoughtSignature([0x01, 0x0c, 0x39]);
  const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"f","args":{}},"thoughtSignature":"${sig}"}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(sig);
  expect(out).toBe(input);
});

test("normalizes duplicate canonical field", () => {
  const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"f","args":{}},"thoughtSignature":"${bypass}","thoughtSignature":"bad","thoughtSignature":"worse"}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(bypass);
  expect(out.split('"thoughtSignature"').length - 1).toBe(1);
});

test("parallel synthetic only first gets bypass", () => {
  const input = '{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}}},{"functionCall":{"name":"second","args":{}}}]}]}';
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(bypass);
  expect(at(out, "contents.0.parts.1.thoughtSignature")).toBeUndefined();
});

describe("call after text gets bypass", () => {
  test("unsigned calls separated by text", () => {
    const input = '{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}}},{"functionCall":{"name":"second","args":{}}},{"text":"more"},{"functionCall":{"name":"third","args":{}}}]}]}';
    const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
    expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(bypass);
    expect(at(out, "contents.0.parts.1.thoughtSignature")).toBeUndefined();
    expect(at(out, "contents.0.parts.3.thoughtSignature")).toBe(bypass);
  });

  test("bypass signed calls separated by text", () => {
    const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}},"thoughtSignature":"${bypass}"},{"functionCall":{"name":"second","args":{}},"thoughtSignature":"${bypass}"},{"text":"more"},{"functionCall":{"name":"third","args":{}},"thoughtSignature":"${bypass}"}]}]}`;
    const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
    expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(bypass);
    expect(at(out, "contents.0.parts.1.thoughtSignature")).toBeUndefined();
    expect(at(out, "contents.0.parts.3.thoughtSignature")).toBe(bypass);
  });

  test("thought part does not end parallel group", () => {
    const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}},"thoughtSignature":"${bypass}"},{"text":"hidden","thought":true},{"functionCall":{"name":"second","args":{}},"thoughtSignature":"${bypass}"}]}]}`;
    const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
    expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(bypass);
    expect(at(out, "contents.0.parts.2.thoughtSignature")).toBeUndefined();
  });
});

test("native parallel preserves unsigned sibling", () => {
  const nativeSignature = testGemini3ThoughtSignature([0x01, 0x0c, 0x39]);
  const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}},"thoughtSignature":"${nativeSignature}"},{"functionCall":{"name":"second","args":{}}}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(nativeSignature);
  expect(at(out, "contents.0.parts.1.thoughtSignature")).toBeUndefined();
  expect(out).toBe(input);
});

test("removes polluted sibling bypass", () => {
  const nativeSignature = testGemini3ThoughtSignature([0x01, 0x0c, 0x39]);
  const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}},"thoughtSignature":"${nativeSignature}"},{"functionCall":{"name":"second","args":{}},"thoughtSignature":"${bypass}"}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(nativeSignature);
  expect(at(out, "contents.0.parts.1.thoughtSignature")).toBeUndefined();
});

describe("removes prefixed sibling bypass", () => {
  const nativeSignature = testGemini3ThoughtSignature([0x01, 0x0c, 0x39]);
  for (const prefix of ["gemini", "google"]) {
    test(prefix, () => {
      const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}},"thoughtSignature":"${nativeSignature}"},{"functionCall":{"name":"second","args":{}},"thoughtSignature":"${prefix}#${bypass}"}]}]}`;
      const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
      expect(at(out, "contents.0.parts.1.thoughtSignature")).toBeUndefined();
    });
  }
});

test("leaves unsigned thought unsigned", () => {
  const input = '{"contents":[{"role":"model","parts":[{"text":"hidden","thought":true}]}]}';
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBeUndefined();
  expect(out).toBe(input);
});

test("reuses unsigned functionResponse payload", () => {
  const input = '{"contents":[{"role":"user","parts":[{"functionResponse":{"name":"f","response":{"result":"ok"}}}]}]}';
  expect(sanitizeGeminiRequestThoughtSignatures(input, "contents")).toBe(input);
});

test("replaces base64 UUID function call", () => {
  const sig = testGeminiThoughtSignature(bytesOf("e24830a7-5cd6-42fe-998b-ee539e72b9c3"));
  const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"f","args":{},"thoughtSignature":"${sig}"}}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(bypass);
  expect(at(out, "contents.0.parts.0.functionCall.thoughtSignature")).toBeUndefined();
});

test("logs bypass replacement", () => {
  const sig = testGeminiThoughtSignature(bytesOf("e24830a7-5cd6-42fe-998b-ee539e72b9c3"));
  const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"f","args":{},"thoughtSignature":"${sig}"}}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(bypass);
  const entries = hook.entries();
  expect(entries.length).toBe(1);
  for (const field of ["sanitized 1 thoughtSignature", "action=replace_bypass", "part=function_call", "sig_type=unknown", 'reason="missing or incompatible signature"']) {
    expect(entries[0]).toContain(field);
  }
  assertSignatureDebugDoesNotLeak(sig);
});

test("aggregates repeated logs", () => {
  const input = `{"contents":[
    {"role":"model","parts":[{"text":"a","thoughtSignature":"invalid_sig_1"}]},
    {"role":"model","parts":[{"text":"b","thoughtSignature":"invalid_sig_2"}]},
    {"role":"model","parts":[{"text":"c","thoughtSignature":"invalid_sig_3"}]}
  ]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  for (let i = 0; i < 3; i++) expect(at(out, `contents.${i}.parts.0.thoughtSignature`)).toBeUndefined();
  const entries = hook.entries();
  expect(entries.length).toBe(1);
  for (const field of ["sanitized 3 thoughtSignatures", "action=drop", "part=model_part", "sig_type=unknown", 'reason="text parts cannot carry signatures"']) {
    expect(entries[0]).toContain(field);
  }
  for (const sig of ["invalid_sig_1", "invalid_sig_2", "invalid_sig_3"]) assertSignatureDebugDoesNotLeak(sig);

  hook.reset();
  const again = sanitizeGeminiRequestThoughtSignatures(out, "contents");
  expect(again).toBe(out);
  expect(hook.entries().length).toBe(0);
});

test("distinguishes detected providers", () => {
  const input = `{"contents":[
    {"role":"model","parts":[{"text":"a","thoughtSignature":"sealed.v1.demo_signature_1"}]},
    {"role":"model","parts":[{"text":"b","thoughtSignature":"sealed.v1.demo_signature_2"}]},
    {"role":"model","parts":[{"text":"c","thoughtSignature":"invalid_sig_unknown_1"}]},
    {"role":"model","parts":[{"text":"d","thoughtSignature":"invalid_sig_unknown_2"}]}
  ]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  for (let i = 0; i < 4; i++) expect(at(out, `contents.${i}.parts.0.thoughtSignature`)).toBeUndefined();
  const entries = hook.entries();
  expect(entries.length).toBe(2);
  [SignatureProviderSWE, SignatureProviderUnknown].forEach((provider, i) => {
    for (const field of ["sanitized 2 thoughtSignatures", "sig_type=" + provider, "path=contents"]) {
      expect(entries[i]).toContain(field);
    }
  });
});

describe("sibling bypass logs single aggregate", () => {
  for (const prefix of ["", "gemini#", "google#"]) {
    test(prefix || "(none)", () => {
      hook.reset();
      const input = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}},"thoughtSignature":"${bypass}"},{"functionCall":{"name":"second","args":{}},"thoughtSignature":"${prefix}${bypass}"},{"functionCall":{"name":"third","args":{}},"thoughtSignature":"${prefix}${bypass}"}]}]}`;
      const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
      expect(at(out, "contents.0.parts.1.thoughtSignature")).toBeUndefined();
      expect(at(out, "contents.0.parts.2.thoughtSignature")).toBeUndefined();
      const entries = hook.entries();
      expect(entries.length).toBe(1);
      for (const field of ["sanitized 2 thoughtSignatures", "action=drop", "part=function_call", "sig_type=bypass", 'reason="sibling calls must be unsigned"']) {
        expect(entries[0]).toContain(field);
      }
    });
  }
});

test("invalid sibling still logs at debug", () => {
  const input = `{"request":{"contents":[{"role":"model","parts":[{"functionCall":{"name":"first","args":{}},"thoughtSignature":"${bypass}"},{"functionCall":{"name":"second","args":{}},"thoughtSignature":"invalid_sibling_signature"},{"functionCall":{"name":"third","args":{}},"thoughtSignature":"${bypass}"}]}]}}`;
  // Independent requests must not be suppressed by a process-wide deduplication cache.
  for (let round = 0; round < 2; round++) {
    hook.reset();
    const out = sanitizeGeminiRequestThoughtSignatures(input, "request.contents");
    expect(at(out, "request.contents.0.parts.1.thoughtSignature")).toBeUndefined();
    const entries = hook.entries();
    expect(entries.length).toBe(2);
    let foundInvalid = false;
    let foundBypass = false;
    for (const entry of entries) {
      if (entry.includes("sig_type=unknown") && entry.includes("sanitized 1 thoughtSignature")) foundInvalid = true;
      if (entry.includes("sig_type=bypass") && entry.includes("sanitized 1 thoughtSignature")) foundBypass = true;
      expect(entry).toContain("path=request.contents");
    }
    expect(foundInvalid).toBe(true);
    expect(foundBypass).toBe(true);
    assertSignatureDebugDoesNotLeak("invalid_sibling_signature");
  }
});

test("foreign prefixed bypass logs at debug", () => {
  for (const prefix of ["claude#", "gpt#", "swe#"]) {
    const foreign = prefix + bypass;
    for (const siblings of [[foreign], [foreign, "invalid_sibling"], ["invalid_sibling", foreign]]) {
      hook.reset();
      let parts = `{"functionCall":{"name":"first","args":{}},"thoughtSignature":"${bypass}"}`;
      for (const sig of siblings) parts += `,{"functionCall":{"name":"sibling","args":{}},"thoughtSignature":"${sig}"}`;
      const out = sanitizeGeminiRequestThoughtSignatures(`{"contents":[{"role":"model","parts":[${parts}]}]}`, "contents");
      siblings.forEach((_, i) => {
        expect(at(out, `contents.0.parts.${i + 1}.thoughtSignature`)).toBeUndefined();
      });
      const entries = hook.entries();
      const expectedCountWord = siblings.length > 1 ? `sanitized ${siblings.length} thoughtSignatures` : `sanitized ${siblings.length} thoughtSignature`;
      expect(entries.length, prefix).toBe(1);
      expect(entries[0], prefix).toContain(expectedCountWord);
      assertSignatureDebugDoesNotLeak(foreign);
    }
  }
});

test("reason groups remain distinct", () => {
  const input = '{"contents":[{"role":"user","parts":[{"functionResponse":{"name":"f","response":{}},"thoughtSignature":"invalid_response_sig"}]},{"role":"model","parts":[{"text":"answer","thoughtSignature":"invalid_text_sig"}]}]}';
  sanitizeGeminiRequestThoughtSignatures(input, "contents");
  const entries = hook.entries();
  expect(entries.length).toBe(2);
  expect(entries[0]).not.toBe(entries[1]);
  ["tool responses cannot carry signatures", "text parts cannot carry signatures"].forEach((reason, i) => {
    expect(entries[i]).toContain(`reason=${JSON.stringify(reason)}`);
  });
  assertSignatureDebugDoesNotLeak("invalid_response_sig");
  assertSignatureDebugDoesNotLeak("invalid_text_sig");
});

test("preserves field-2 wrapped UUID function call", () => {
  const sig = testGemini3ThoughtSignature(bytesOf("e24830a7-5cd6-42fe-998b-ee539e72b9c3"));
  const input = `{"request":{"contents":[{"role":"model","parts":[{"functionCall":{"name":"f","args":{}},"thoughtSignature":"${sig}"}]}]}}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "request.contents");
  expect(at(out, "request.contents.0.parts.0.thoughtSignature")).toBe(sig);
});

test("removes functionResponse signature", () => {
  const input = '{"contents":[{"role":"user","parts":[{"functionResponse":{"name":"f","response":{"result":"ok"},"thoughtSignature":"bad","thoughtSignature":"worse"},"thoughtSignature":"bad"}]}]}';
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBeUndefined();
  expect(at(out, "contents.0.parts.0.functionResponse.thoughtSignature")).toBeUndefined();
});

const liveCapturedToolCallSig =
  "ErUDCrIDCAISrQMBEU0yD9ECvDhSY1DQJNUGafArdfd2mDfO8VQq7XjLx/91zESuo0QPSdkRFWkLeVIocSQmQULonYMOJcs6XDLV2LTRC9myb3MCCP9CUoWbEeqhAvXKTScyS3nwBDDVJYuDDbY3YvR4V86T/DnU3qufpaVZ3wQOiJVyBVZ515dYTN+XGq7SuUc3RpfAqVU06jgxaCM0WKV4Df5mGMJWb25e/aFG2Jc7upSqpf3n6aElj+4c/eWr4GdKd0TUIElXBZ0HEN/vNcWzD3F0S4MeVbk1LDakL6HG6oyaSS2gocxYNYxqm9mdMHaXYa4mIYqWqmqBEnbgcHp8H4fgqBxc3Cx8C3otV8IarO5OALaVDA3NaXB1zjLet1587kEpkCNr9OvrYOES2nCl/i4EgbPK01nlXo+Wwm5jsZU5nEG4/Z0bErzqC5TKwOsqpJ7afL2sPWI0IGrXhXL+QCumWCS5iUtwybSkL7CYSk9GC+iY+ev6FAmC4V5JEc4OaWOc9+m/29LniN/iPTSxtUQSZT94pUa3/irIIdH7ReAS3cpeM6OTvumR1PwNxXx3XM1mEGc=";

test("preserves toolCall and toolResponse signatures", () => {
  const sigModel = testGemini3ThoughtSignature([0x01, 0x0c, 0x39]);
  const input = `{"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"toolCall":{"toolType":"GOOGLE_SEARCH_WEB","id":"1"},"thoughtSignature":"${liveCapturedToolCallSig}"},{"toolResponse":{"toolType":"GOOGLE_SEARCH_WEB","id":"1"},"thoughtSignature":"${liveCapturedToolCallSig}"},{"functionCall":{"name":"f","args":{}},"thoughtSignature":"${sigModel}"}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.1.parts.0.thoughtSignature")).toBe(liveCapturedToolCallSig);
  expect(at(out, "contents.1.parts.1.thoughtSignature")).toBe(liveCapturedToolCallSig);
  expect(at(out, "contents.1.parts.2.thoughtSignature")).toBe(sigModel);
});

test("skips toolCall and toolResponse parts", () => {
  const arbitrarySig = "arbitrary_opaque_tool_sig_value";
  const input = `{"contents":[{"role":"model","parts":[{"toolCall":{"toolType":"GOOGLE_SEARCH_WEB","args":{}},"thoughtSignature":"${arbitrarySig}"},{"toolResponse":{"toolType":"GOOGLE_SEARCH_WEB","response":{}},"thoughtSignature":"${arbitrarySig}"}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(arbitrarySig);
  expect(at(out, "contents.0.parts.1.thoughtSignature")).toBe(arbitrarySig);
});

test("skips snake_case tool_call and tool_response parts", () => {
  const arbitrarySig = "arbitrary_snake_tool_sig";
  const input = `{"contents":[{"role":"model","parts":[{"tool_call":{"tool_type":"GOOGLE_SEARCH_WEB","args":{}},"thought_signature":"${arbitrarySig}"},{"tool_response":{"tool_type":"GOOGLE_SEARCH_WEB","response":{}},"thought_signature":"${arbitrarySig}"}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thought_signature")).toBe(arbitrarySig);
  expect(at(out, "contents.0.parts.1.thought_signature")).toBe(arbitrarySig);
});

test("drops foreign signature on text part", () => {
  const input = '{"contents":[{"role":"model","parts":[{"text":"answer","thoughtSignature":"claude_or_invalid_signature"}]}]}';
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBeUndefined();
});

test("mixed toolCall and unsigned functionCall", () => {
  const input = `{"contents":[{"role":"model","parts":[{"toolCall":{"toolType":"GOOGLE_SEARCH_WEB","id":"1"},"thoughtSignature":"${liveCapturedToolCallSig}"},{"functionCall":{"name":"my_func","args":{}}}]}]}`;
  const out = sanitizeGeminiRequestThoughtSignatures(input, "contents");
  expect(at(out, "contents.0.parts.0.thoughtSignature")).toBe(liveCapturedToolCallSig);
  expect(at(out, "contents.0.parts.1.thoughtSignature")).toBe(bypass);
});

function bareTinkReplayPayload(sig: string): string {
  return (
    '{"contents":[' +
    '{"role":"user","parts":[{"text":"list"}]},' +
    '{"role":"model","parts":[' +
    '{"text":"thinking","thought":true},' +
    `{"functionCall":{"name":"list_dir","args":{"path":"."}},"thoughtSignature":"${sig}"}]},` +
    '{"role":"user","parts":[{"functionResponse":{"name":"list_dir","response":{"files":[]}}}]},' +
    `{"role":"model","parts":[{"text":"done","thoughtSignature":"${sig}"}]}]}`
  );
}

test("preserves Vertex bare-Tink", () => {
  const sig = testGeminiBareTinkSignature(405);
  const out = sanitizeGeminiRequestThoughtSignatures(bareTinkReplayPayload(sig), "contents");
  expect(at(out, "contents.1.parts.1.thoughtSignature")).toBe(sig);
  expect(at(out, "contents.3.parts.0.thoughtSignature")).toBe(sig);
});

test("NonVertex replaces Vertex bare-Tink", () => {
  const sig = testGeminiBareTinkSignature(405);
  const out = sanitizeNonVertexGeminiRequestThoughtSignatures(bareTinkReplayPayload(sig), "contents");
  expect(at(out, "contents.1.parts.1.thoughtSignature")).toBe(bypass);
  expect(at(out, "contents.3.parts.0.thoughtSignature")).toBeUndefined();
  expect(at(out, "contents.1.parts.0.thought")).toBe(true);
});

test("NonVertex preserves wrapped envelope", () => {
  const sig = testGeminiThoughtSignatureEnvelope();
  const out = sanitizeNonVertexGeminiRequestThoughtSignatures(bareTinkReplayPayload(sig), "contents");
  expect(at(out, "contents.1.parts.1.thoughtSignature")).toBe(sig);
  expect(at(out, "contents.3.parts.0.thoughtSignature")).toBe(sig);
});
