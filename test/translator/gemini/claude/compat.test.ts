// Ported from: internal/translator/gemini/claude/gemini_claude_compat_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { geminiSkipThoughtSignatureValidator } from "../../../../src/signature/index.ts";
import { convertClaudeRequestToGemini, convertClaudeRequestToGeminiWithCompat } from "../../../../src/translator/gemini/claude/request.ts";
import { exists, getArr, getStr, getVal } from "../helpers.ts";

const capturedGeminiThinkingSignature = "EjQKMgEMOdbHO0Gd+c9Mxk4ELwPGbpCEcp2mFfYYLix2UVtBH3fL8GECc4+JITVnHF4qZDsA";

describe("ConvertClaudeRequestToGeminiWithCompat_SignatureCompatibility", () => {
  const cases = [
    { name: "preserves valid gemini signature", signature: "gemini#" + capturedGeminiThinkingSignature, wantSignature: capturedGeminiThinkingSignature },
    { name: "foreign claude signature maps to bypass sentinel", signature: "claude#opaque-signature-12345", wantSignature: geminiSkipThoughtSignatureValidator },
    { name: "empty signature maps to bypass sentinel", signature: "", wantSignature: geminiSkipThoughtSignatureValidator },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const payload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"${tc.signature}"}]}]}`;
      const withCompat = convertClaudeRequestToGeminiWithCompat("deepseek-v4", payload, false);
      expect(getVal(withCompat, "contents.0.parts.0.thought")).toBe(true);
      expect(getStr(withCompat, "contents.0.parts.0.text")).toBe("reason");
      expect(getStr(withCompat, "contents.0.parts.0.thoughtSignature")).toBe(tc.wantSignature);
    });
  }
});

test("ConvertClaudeRequestToGeminiWithCompatPreservesEmptyThinking", () => {
  const payload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":""}]}]}`;

  const withoutCompat = convertClaudeRequestToGemini("deepseek-v4", payload, false);
  expect(getArr(withoutCompat, "contents.0.parts").length).toBe(0);

  const withCompat = convertClaudeRequestToGeminiWithCompat("deepseek-v4", payload, false);
  expect(getVal(withCompat, "contents.0.parts.0.thought")).toBe(true);
  expect(getStr(withCompat, "contents.0.parts.0.text")).toBe("reason");
  expect(exists(withCompat, "contents.0.parts.0.thoughtSignature")).toBe(true);
  expect(getStr(withCompat, "contents.0.parts.0.thoughtSignature")).toBe(geminiSkipThoughtSignatureValidator);
});
