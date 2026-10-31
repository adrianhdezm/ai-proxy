// Ported from: internal/translator/gemini/openai/responses/trailing_signature_test.go
// Skipped cases: none (TestGeminiResponsesCacheRecoveryPreservesFallbackSignatureOrder replaces the
// disabled Home KV client with the local replay cache's write filter)
import { afterEach, expect, test } from "bun:test";
import { setReplayCacheWriteFilter } from "../../../../../src/translator/gemini/openai/responses/replay_cache.ts";
import {
  encodeGeminiResponsesCarrier,
  geminiResponsesCarrierPrevious,
  geminiResponsesCarrierText,
} from "../../../../../src/translator/gemini/openai/responses/signature_carrier.ts";
import { cacheGeminiResponsesTextSignatures } from "../../../../../src/translator/gemini/openai/responses/trailing_signature.ts";
import type { TranslatorState } from "../../../../../src/translator/types.ts";
import {
  completedOutput,
  decodedResponsesCarrierSignature,
  differentResponsesGeminiThoughtSignature,
  g,
  parseSSEEvent,
  streamChunk,
  streamEvents,
  testResponsesGeminiThoughtSignature as sig,
  toGemini,
} from "./helpers.ts";

afterEach(() => setReplayCacheWriteFilter(undefined));

test("TestGeminiResponsesLateSignaturePreservesSummary", () => {
  const chunks = [
    `data: {"candidates":[{"content":{"parts":[{"text":"Let me think.","thought":true}]}}],"responseId":"issue-5513"}`,
    `data: {"candidates":[{"content":{"parts":[{"text":"The answer is 42."}]}}]}`,
    `data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${sig}"}]},"finishReason":"STOP"}]}`,
    `data: [DONE]`,
  ];
  const events = streamEvents("gemini-3.8-flash-high", "", "", chunks);
  for (const { event, data } of events) {
    if ((event === "response.output_item.added" || event === "response.output_item.done") && data.str("item.type") === "reasoning" && data.arr("item.summary").length === 0 && data.str("item.encrypted_content") !== "") {
      throw new Error(`late signature emitted an empty reasoning item: ${data.raw}`);
    }
  }
  const completed = completedOutput(events);
  expect(completed.arr().length).toBe(2);
  expect(completed.str("0.summary.0.text")).toBe("Let me think.");
  expect(completed.str("1.type")).toBe("message");
  const replayed = toGemini("gemini-3.8-flash-high", `{"input":${completed.raw}}`);
  expect(g(replayed, "contents.0.parts.1.thoughtSignature").str()).toBe(sig);
});

test("TestGeminiResponsesCachedTextSignatureReplayBoundaries", () => {
  const model = "gemini-3.8-flash-high";
  const messageID = "msg_resp_issue-5513-boundaries_0";
  const text = "An exact signed answer.";
  expect(cacheGeminiResponsesTextSignatures(model, messageID, text, [sig])).toBe(true);
  const message = `{"id":"${messageID}","type":"message","role":"assistant","content":[{"type":"output_text","text":"${text}"}]}`;
  const cases = [
    { name: "exact", model, message, want: true },
    { name: "different model", model: "gemini-other", message, want: false },
    { name: "edited text", model, message: message.replaceAll(text, "Edited answer."), want: false },
    { name: "different ID", model, message: message.replaceAll(messageID, messageID + "-other"), want: false },
    { name: "no ID", model, message: message.replaceAll(`"id":"${messageID}",`, ""), want: false },
  ];
  for (const c of cases) {
    const output = toGemini(c.model, `{"input":[${c.message}]}`);
    expect([c.name, output.includes(sig)]).toEqual([c.name, c.want]);
  }
  const carrier = JSON.stringify({ type: "reasoning", summary: [], encrypted_content: encodeGeminiResponsesCarrier(sig, geminiResponsesCarrierPrevious, geminiResponsesCarrierText) });
  const output = toGemini(model, `{"input":[${message},${carrier}]}`);
  expect(output.split(sig).length - 1).toBe(1);
});

test("TestGeminiResponsesTextSignatureCacheRejectsInvalidSignature", () => {
  expect(cacheGeminiResponsesTextSignatures("gemini-test", "msg_resp_invalid_0", "answer", ["invalid"])).toBe(false);
  const state: TranslatorState = {};
  const line = `data: {"candidates":[{"content":{"parts":[{"text":"answer"},{"text":"","thoughtSignature":"invalid"}]},"finishReason":"STOP"}],"responseId":"invalid-cache-fallback"}`;
  const frames = [...streamChunk("gemini-test", "", "", line, state), ...streamChunk("gemini-test", "", "", "[DONE]", state)];
  const completed = completedOutput(frames.map(parseSSEEvent));
  expect(completed.arr().length).toBe(2);
  expect(completed.str("1.type")).toBe("reasoning");
});

test("TestGeminiResponsesLateSignatureReplayWithThinkingSuffix", () => {
  const state: TranslatorState = {};
  const line = `data: {"candidates":[{"content":{"parts":[{"text":"suffix answer"},{"text":"","thoughtSignature":"${sig}"}]},"finishReason":"STOP"}],"responseId":"issue-5513-suffix"}`;
  const frames = [...streamChunk("gemini-2.5-pro(8192)", "", "", line, state), ...streamChunk("gemini-2.5-pro(8192)", "", "", "[DONE]", state)];
  const completed = completedOutput(frames.map(parseSSEEvent));
  const output = toGemini("gemini-2.5-pro", `{"input":${completed.raw}}`);
  expect(g(output, "contents.0.parts.0.thoughtSignature").str()).toBe(sig);
});

test("TestGeminiResponsesCachedSignaturesMergeExplicitPrefixInOrder", () => {
  const model = "gemini-3.8-flash-high";
  const messageID = "msg_resp_issue-5513-merge_0";
  const signature2 = differentResponsesGeminiThoughtSignature();
  expect(cacheGeminiResponsesTextSignatures(model, messageID, "answer", [sig, signature2])).toBe(true);
  for (const explicitSignature of [sig, signature2]) {
    const carrier = JSON.stringify({ type: "reasoning", summary: [], encrypted_content: encodeGeminiResponsesCarrier(explicitSignature, geminiResponsesCarrierPrevious, geminiResponsesCarrierText) });
    const output = toGemini(model, `{"input":[{"id":"${messageID}","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]},${carrier}]}`);
    const parts = g(output, "contents.0.parts").arr();
    expect(parts.length).toBe(2);
    expect(parts[0]!.str("text")).toBe("answer");
    expect(parts[0]!.str("thoughtSignature")).toBe(sig);
    expect(parts[1]!.str("thoughtSignature")).toBe(signature2);
  }
});

test("TestGeminiResponsesLateThoughtSignatureDoesNotBindEarlierMessage", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const lines = [
    `data: {"candidates":[{"content":{"parts":[{"text":"earlier answer"}]}}],"responseId":"issue-5513-thought-boundary"}`,
    `data: {"candidates":[{"content":{"parts":[{"text":"later thought","thought":true,"thoughtSignature":"${sig}"}]}}]}`,
    `data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}]}`,
    `data: [DONE]`,
  ];
  const completed = completedOutput(streamEvents("gemini-3.8-flash-high", "", "", lines));
  const output = toGemini("gemini-3.8-flash-high", `{"input":${completed.raw}}`);
  const parts = g(output, "contents.0.parts").arr();
  expect(parts.length).toBeGreaterThanOrEqual(2);
  expect(parts[0]!.str("thoughtSignature")).toBe("");
  expect(parts[1]!.str("thoughtSignature")).toBe(sig);
  expect(output).toContain(signature2);
});

test("TestGeminiResponsesCacheRecoveryPreservesFallbackSignatureOrder", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const lines = [
    `data: {"candidates":[{"content":{"parts":[{"text":"recovery answer"}]}}],"responseId":"issue-5513-cache-recovery"}`,
    `data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${sig}"}]}}]}`,
    `data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}]}`,
    `data: [DONE]`,
  ];
  const state: TranslatorState = {};
  const frames: string[] = [];
  lines.forEach((line, index) => {
    // The first cache write is rejected (Go: a disabled Home client); later writes succeed.
    setReplayCacheWriteFilter(index === 1 ? () => false : undefined);
    frames.push(...streamChunk("gemini-3.8-flash-high", "", "", line, state));
  });
  const completed = completedOutput(frames.map(parseSSEEvent));
  expect(completed.arr().length).toBe(2);
  expect(decodedResponsesCarrierSignature(completed.str("1.encrypted_content"))).toBe(sig);
  const output = toGemini("gemini-3.8-flash-high", `{"input":${completed.raw}}`);
  const parts = g(output, "contents.0.parts").arr();
  expect(parts.length).toBe(2);
  expect(parts[0]!.str("thoughtSignature")).toBe(sig);
  expect(parts[1]!.str("thoughtSignature")).toBe(signature2);
});
