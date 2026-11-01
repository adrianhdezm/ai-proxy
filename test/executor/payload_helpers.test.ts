// Ported from: internal/runtime/executor/helps/payload_mutations_test.go
// Ported from: internal/runtime/executor/helps/thinking_test.go
// Ported from: internal/runtime/executor/helps/user_id_cache_test.go
// Skipped cases: payload_mutations_test.go: TestSetRawIfDifferent* (no SetRawIfDifferent helper in this port),
//   TestApplyPayloadConfig* / TestSetPayloadValueIfDifferent* / TestRemoveToolTypeReusesArrayWithoutMatch /
//   TestConfigExampleDocumentsCodexAdditionalToolsPayloadFilter (payload config rules not ported), the Go benchmark.
//   The "no payload copy" assertions become "the same string is returned".
//   thinking_test.go: TestApplyThinkingWithSourcePayloadPreservesNormalizerSummaryRemoval (translator plugin hooks not
//   ported), TestApplyThinkingWithSourcePayload_AntigravityResponsesReasoningSummaryAuto (Antigravity dropped).
//   user_id_cache_test.go: every CachedUserID / CachedSessionID case (the per-API-key user_id and session-id TTL caches
//   and their Home KV backing are not ported: the cloaked metadata.user_id is derived from the request's session
//   identity instead).
import { describe, expect, test } from "bun:test";
import { setBoolIfDifferent, setStringIfDifferent } from "../../src/executor/openai/helpers.ts";
import { setStringIfDifferent as geminiSetStringIfDifferent, translateToGemini } from "../../src/executor/gemini/request.ts";
import { generateFakeUserID, isValidUserID } from "../../src/executor/claude/client_detection.ts";

describe("payload mutations", () => {
  test("TestSetStringIfDifferentReusesCanonicalValue", () => {
    const input = `{"model":"gpt-test","messages":[]}`;
    expect(setStringIfDifferent(input, "model", "gpt-test")).toBe(input);
    expect(geminiSetStringIfDifferent(input, "model", "gpt-test")).toBe(input);
  });

  test("TestSetStringIfDifferentNormalizesWrongType", () => {
    const input = `{"model":123}`;
    for (const out of [setStringIfDifferent(input, "model", "123"), geminiSetStringIfDifferent(input, "model", "123")]) {
      expect(JSON.parse(out).model).toBe("123");
    }
  });

  test("TestSetBoolIfDifferentReusesCanonicalValue", () => {
    const input = `{"stream":true,"input":[]}`;
    expect(setBoolIfDifferent(input, "stream", true)).toBe(input);
  });

  test("TestSetBoolIfDifferentNormalizesWrongType", () => {
    expect(JSON.parse(setBoolIfDifferent(`{"stream":"true"}`, "stream", true)).stream).toBe(true);
  });
});

test("TestApplyThinkingWithSourcePayloadPreservesOriginalOnlySummary", () => {
  // The working payload has no reasoning summary; the original request disabled it (summary:null), so the Gemini body
  // must carry includeThoughts=false. Go called ApplyThinkingWithSourcePayload directly on a pre-built body; here the
  // same inputs go through the executor's translateToGemini (Responses -> Gemini translation + thinking).
  const current = `{"model":"gemini-3.6-flash","reasoning":{"effort":"high"},"input":"hi"}`;
  const original = `{"model":"gemini-3.6-flash","reasoning":{"summary":null},"input":"hi"}`;
  const out = translateToGemini({ model: "gemini-3.6-flash", payload: current, format: "openai-response" }, { stream: false, sourceFormat: "openai-response", originalRequest: original }, false, "aistudio");
  const include = JSON.parse(out).generationConfig?.thinkingConfig?.includeThoughts;
  expect(include).toBe(false);
});

test("TestGenerateFakeUserIDUsesClaudeCode220JSONShape", () => {
  const userID = generateFakeUserID();
  expect(isValidUserID(userID)).toBe(true);
  expect(JSON.parse(userID).account_uuid).toBe("");
});
