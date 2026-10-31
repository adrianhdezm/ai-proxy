// Ported from: internal/translator/gemini/claude/gemini_claude_response_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { convertClaudeRequestToGemini } from "../../../../src/translator/gemini/claude/request.ts";
import {
  convertGeminiResponseToClaude,
  convertGeminiResponseToClaudeNonStream,
  resetGeminiClaudeToolUseIDCounter,
} from "../../../../src/translator/gemini/claude/response.ts";
import { emptyContext, type TranslatorState } from "../../../../src/translator/types.ts";
import { getAt, gstr } from "../../../../src/util/gpath.ts";
import { dataPayloads, exists, getArr, getInt, getStr, inputJSONDeltas, raw, streamToClaude } from "../helpers.ts";

const ctx = emptyContext;
const nonStream = (model: string, orig: string, trans: string, body: string): string => convertGeminiResponseToClaudeNonStream(ctx, model, orig, trans, body, {});
const block = (b: unknown, path: string): string => gstr(getAt(b, path));

describe("ConvertGeminiResponseToClaude_VertexStreamingPartialArgs", () => {
  const requestJSON = `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"weather?"}],"tools":[{"name":"get_weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}}}}]}`;

  test("streams partial args as input_json_delta", () => {
    const chunks = [
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"New ","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-partial-1"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"partialArgs":[{"jsonPath":"$.city","stringValue":"York"}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-partial-1"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-partial-1"}`,
      "[DONE]",
    ];
    const state: TranslatorState = {};
    let partialJSON = "";
    let firstChunkDelta = "";
    chunks.forEach((chunk, chunkIdx) => {
      const out = convertGeminiResponseToClaude(ctx, "gemini-2.5-pro", requestJSON, requestJSON, chunk, state).join("");
      for (const payload of dataPayloads(out)) {
        if (getStr(payload, "type") === "content_block_delta" && getStr(payload, "delta.type") === "input_json_delta") {
          const piece = getStr(payload, "delta.partial_json");
          partialJSON += piece;
          if (chunkIdx === 0) firstChunkDelta += piece;
        }
      }
    });
    expect(firstChunkDelta).toContain("New ");
    expect(partialJSON).toBe(`{"city":"New York"}`);
  });

  test("multiple same-name calls and interrupted stream", () => {
    const multiChunks = [
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"Par","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-multi"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"partialArgs":[{"jsonPath":"$.city","stringValue":"is"}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-multi"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{}},{"functionCall":{"name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"Lyon"}],"willContinue":false}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-multi"}`,
      "[DONE]",
    ];
    const byBlock = new Map<number, string>();
    const toolIDs: string[] = [];
    const state: TranslatorState = {};
    for (const ch of multiChunks) {
      const out = convertGeminiResponseToClaude(ctx, "gemini-2.5-pro", requestJSON, requestJSON, ch, state).join("");
      for (const payload of dataPayloads(out)) {
        switch (getStr(payload, "type")) {
          case "content_block_start":
            if (getStr(payload, "content_block.type") === "tool_use") toolIDs.push(getStr(payload, "content_block.id"));
            break;
          case "content_block_delta":
            if (getStr(payload, "delta.type") === "input_json_delta") {
              const idx = getInt(payload, "index");
              byBlock.set(idx, (byBlock.get(idx) ?? "") + getStr(payload, "delta.partial_json"));
            }
            break;
        }
      }
    }
    expect(toolIDs.length).toBe(2);
    expect(toolIDs[0]).not.toBe(toolIDs[1]);
    expect(byBlock.get(0)).toBe(`{"city":"Paris"}`);
    expect(byBlock.get(1)).toBe(`{"city":"Lyon"}`);

    // Interrupted stream should not emit message_stop or content_block_stop on [DONE].
    const truncText = streamToClaude(requestJSON, requestJSON, [multiChunks[0]!, "[DONE]"]);
    expect(truncText).not.toContain(`"type":"message_stop"`);
    expect(truncText).not.toContain(`"type":"content_block_stop"`);
  });

  test("standalone thoughtSignature during streaming tool call does not split block", () => {
    const sigChunks = [
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"Ber","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-sig"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"text":""}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-sig"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"text":"","thoughtSignature":"sig-mid-1"}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-sig"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"lin"}],"willContinue":true},"thoughtSignature":"sig-mid-2"}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-sig"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-sig"}`,
      "[DONE]",
    ];
    let block0JSON = "";
    const deferredSigs: string[] = [];
    let toolStopped = false;
    const state: TranslatorState = {};
    for (const ch of sigChunks) {
      const out = convertGeminiResponseToClaude(ctx, "gemini-2.5-pro", requestJSON, requestJSON, ch, state).join("");
      for (const payload of dataPayloads(out)) {
        switch (getStr(payload, "type")) {
          case "content_block_delta":
            if (getStr(payload, "delta.type") === "input_json_delta") {
              expect(getInt(payload, "index"), payload).toBe(0);
              expect(toolStopped, `input_json_delta emitted after tool block stopped: ${payload}`).toBe(false);
              block0JSON += getStr(payload, "delta.partial_json");
            } else if (getStr(payload, "delta.type") === "signature_delta") {
              expect(toolStopped, `signature_delta emitted before tool block finished: ${payload}`).toBe(true);
              deferredSigs.push(getStr(payload, "delta.signature"));
            }
            break;
          case "content_block_stop":
            if (getInt(payload, "index") === 0) toolStopped = true;
            break;
        }
      }
    }
    expect(block0JSON).toBe(`{"city":"Berlin"}`);
    expect(deferredSigs).toEqual(["sig-mid-1", "sig-mid-2"]);
  });

  test("strips nested injected placeholder fields while streaming real declared reason and dotted keys", () => {
    const origReq = `{"tools":[{"name":"complex_tool","input_schema":{"type":"object","properties":{"options":{"type":"object","additionalProperties":false},"a":{"type":"object","properties":{"b":{"type":"object","properties":{"keep":{"type":"number"}}}}},"a.b":{"type":"object","additionalProperties":false},"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"number"}},"additionalProperties":false}},"real":{"type":"object","properties":{"reason":{"type":"string"}}}},"additionalProperties":false}}]}`;
    const transReq = `{"tools":[{"functionDeclarations":[{"name":"complex_tool","parameters":{"type":"object","properties":{"options":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]},"a":{"type":"object","properties":{"b":{"type":"object","properties":{"keep":{"type":"number"}}}}},"a.b":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]},"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"number"},"_":{"type":"boolean"}},"required":["_"]}},"real":{"type":"object","properties":{"reason":{"type":"string"}}}}}}]}]}`;
    const chunks = [
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"complex_tool","partialArgs":[{"jsonPath":"$.real.reason","stringValue":"ke","willContinue":true},{"jsonPath":"$.a.b.keep","numberValue":1},{"jsonPath":"$['a.b'].junk","stringValue":"drop"},{"jsonPath":"$.options.reason","stringValue":"injected","willContinue":true},{"jsonPath":"$.items[0]._","boolValue":true},{"jsonPath":"$.items[0].id","numberValue":7}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-clean"}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"partialArgs":[{"jsonPath":"$.real.reason","stringValue":"pt"},{"jsonPath":"$.options.reason","stringValue":"-more"}],"willContinue":false}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp-clean"}`,
      "[DONE]",
    ];
    const state: TranslatorState = {};
    let argBuf = "";
    let chunk0Delta = "";
    chunks.forEach((ch, chunkIdx) => {
      const out = convertGeminiResponseToClaude(ctx, "gemini-2.5-pro", origReq, transReq, ch, state).join("");
      for (const payload of dataPayloads(out)) {
        if (getStr(payload, "type") === "content_block_delta" && getStr(payload, "delta.type") === "input_json_delta") {
          const d = getStr(payload, "delta.partial_json");
          if (chunkIdx === 0) chunk0Delta += d;
          argBuf += d;
        }
      }
    });
    expect(chunk0Delta).toContain(`"real":{"reason":"ke`);
    expect(argBuf).toBe(`{"real":{"reason":"kept"},"a":{"b":{"keep":1}},"a.b":{},"options":{},"items":[{"id":7}]}`);
  });

  test("single-chunk willContinue false parameterless call and empty partialArgs with complete args", () => {
    const cPing = `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"ping","willContinue":false}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-ping"}`;
    const text1 = streamToClaude("", "", [cPing]);
    expect(text1).toContain(`"partial_json":"{}"`);
    expect(text1).toContain(`"type":"content_block_stop","index":0`);

    const cArgs = `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"},"partialArgs":[]}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7},"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-args"}`;
    const text2 = streamToClaude("", "", [cArgs]);
    expect(text2).toContain(`{\\"city\\":\\"Paris\\"}`);
  });

  test("replaced unfinished tool call does not emit content_block_stop for incomplete block", () => {
    const c1 = `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_a","name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"New ","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-replace"}`;
    const c2 = `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_b","name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"LA"}],"willContinue":false}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp-claude-replace"}`;
    const full = streamToClaude(requestJSON, requestJSON, [c1, c2, "[DONE]"]);
    expect(full).not.toContain(`{"type":"content_block_stop","index":0}`);
    expect(full).not.toContain(`"type":"message_stop"`);
  });
});

test("ConvertGeminiResponseToClaude_SignatureOnlyPartDoesNotOpenEmptyTextBlock", () => {
  const requestJSON = `{"model":"gemini-test","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`;
  const thinkingChunk = `{"candidates":[{"content":{"parts":[{"text":"thinking text","thought":true}]}}],"modelVersion":"gemini-test","responseId":"resp-test"}`;
  const signatureChunk = `{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"sig-test"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"thoughtsTokenCount":2,"totalTokenCount":12},"modelVersion":"gemini-test","responseId":"resp-test"}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [thinkingChunk, signatureChunk, "[DONE]"], {}, "gemini-test");

  expect(outputText).not.toContain(`"content_block":{"type":"text"`);
  expect(outputText).not.toContain(`"type":"content_block_stop","index":1`);
  expect(outputText).toContain(`"type":"signature_delta"`);
  expect(outputText).toContain(`"signature":"sig-test"`);
  expect(outputText.split(`"type":"content_block_stop","index":0`).length - 1).toBe(1);
  expect(outputText).toContain(`"type":"message_delta"`);
  expect(outputText).toContain(`"output_tokens":2`);
  expect(outputText).toContain(`"type":"message_stop"`);
});

test("ConvertGeminiResponseToClaudeNonStream_PreservesThoughtSignature", () => {
  const requestJSON = `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`;
  const geminiResponse = `{"candidates":[{"content":{"parts":[
    {"text":"thinking step 1\\n","thought":true},
    {"text":"thinking step 2","thought":true,"thoughtSignature":"sig-xyz-123"},
    {"text":"visible answer"}
  ]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5},"modelVersion":"gemini-2.5-pro","responseId":"resp-non-stream"}`;
  const output = nonStream("gemini-2.5-pro", requestJSON, requestJSON, geminiResponse);
  const blocks = getArr(output, "content");
  expect(blocks.length).toBe(2);
  expect(block(blocks[0], "type")).toBe("thinking");
  expect(block(blocks[0], "thinking")).toBe("thinking step 1\nthinking step 2");
  expect(block(blocks[0], "signature")).toBe("sig-xyz-123");
  expect(block(blocks[1], "type")).toBe("text");
  expect(block(blocks[1], "text")).toBe("visible answer");
});

test("ConvertGeminiResponseToClaudeNonStream_PartWithThoughtSignatureWithoutThoughtBool", () => {
  const requestJSON = `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`;
  const geminiResponse = `{"candidates":[{"content":{"parts":[
    {"text":"inferred reasoning","thought_signature":"sig-snake-case"},
    {"text":"final answer"}
  ]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5},"modelVersion":"gemini-2.5-pro","responseId":"resp-non-stream-2"}`;
  const output = nonStream("gemini-2.5-pro", requestJSON, requestJSON, geminiResponse);
  const blocks = getArr(output, "content");
  expect(blocks.length).toBe(2);
  expect(block(blocks[0], "type")).toBe("thinking");
  expect(block(blocks[0], "thinking")).toBe("");
  expect(block(blocks[0], "signature")).toBe("sig-snake-case");
  expect(block(blocks[1], "type")).toBe("text");
  expect(block(blocks[1], "text")).toBe("inferred reasoningfinal answer");
});

test("ConvertGeminiResponseToClaudeNonStream_TrailingSignatureOnlyPart", () => {
  const requestJSON = `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`;
  const geminiResponse = `{"candidates":[{"content":{"parts":[
    {"text":"thinking step 1\\n","thought":true},
    {"text":"","thoughtSignature":"sig-trailing"},
    {"text":"visible answer"}
  ]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5},"modelVersion":"gemini-2.5-pro","responseId":"resp-non-stream-trailing"}`;
  const output = nonStream("gemini-2.5-pro", requestJSON, requestJSON, geminiResponse);
  const blocks = getArr(output, "content");
  expect(blocks.length).toBe(2);
  expect(block(blocks[0], "type")).toBe("thinking");
  expect(block(blocks[0], "thinking")).toBe("thinking step 1\n");
  expect(block(blocks[0], "signature")).toBe("sig-trailing");
  expect(block(blocks[1], "type")).toBe("text");
  expect(block(blocks[1], "text")).toBe("visible answer");
});

test("ConvertGeminiResponseToClaude_UsageWithCachedContentTokenCount", () => {
  const requestJSON = `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`;
  const chunk = `{"candidates":[{"content":{"parts":[{"text":"Hello world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7,"cachedContentTokenCount":91},"modelVersion":"gemini-2.5-pro","responseId":"resp-usage-cache"}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk]);
  expect(outputText).toContain(`"type":"message_delta"`);
  let foundMessageDelta = false;
  for (const payload of dataPayloads(outputText)) {
    if (getStr(payload, "type") !== "message_delta") continue;
    foundMessageDelta = true;
    expect(getInt(payload, "usage.input_tokens")).toBe(9);
    expect(getInt(payload, "usage.cache_read_input_tokens")).toBe(91);
    expect(getInt(payload, "usage.output_tokens")).toBe(7);
  }
  expect(foundMessageDelta).toBe(true);
});

test("ConvertGeminiResponseToClaudeNonStream_UsageWithCachedContentTokenCount", () => {
  const requestJSON = `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`;
  const geminiResponse = `{"candidates":[{"content":{"parts":[{"text":"Hello world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7,"cachedContentTokenCount":91},"modelVersion":"gemini-2.5-pro","responseId":"resp-usage-cache-nonstream"}`;
  const output = nonStream("gemini-2.5-pro", requestJSON, requestJSON, geminiResponse);
  expect(getInt(output, "usage.input_tokens")).toBe(9);
  expect(getInt(output, "usage.cache_read_input_tokens")).toBe(91);
  expect(getInt(output, "usage.output_tokens")).toBe(7);
});

function expectEventOrder(outputText: string, events: string[]): void {
  let lastIndex = -1;
  for (const eventName of events) {
    const index = outputText.indexOf("event: " + eventName + "\n");
    expect(index, `event ${eventName} not found in output:\n${outputText}`).toBeGreaterThanOrEqual(0);
    expect(index, `event ${eventName} is out of order in output:\n${outputText}`).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
}

test("ConvertGeminiResponseToClaudeStream_PartlessSafetyClosesMessageWithRefusal", () => {
  const requestJSON = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}`;
  const chunk = `{"candidates":[{"content":{"role":"model","parts":[]},"index":0,"finishReason":"SAFETY"}],"modelVersion":"m","usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":37,"totalTokenCount":157}}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk, "[DONE]"], {}, "claude-opus-5-5");
  expectEventOrder(outputText, ["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"]);
  let foundDelta = false;
  for (const payload of dataPayloads(outputText)) {
    if (getStr(payload, "type") !== "message_delta") continue;
    foundDelta = true;
    expect(getStr(payload, "delta.stop_reason")).toBe("refusal");
    expect(getInt(payload, "usage.input_tokens")).toBe(120);
    expect(getInt(payload, "usage.output_tokens")).toBe(37);
  }
  expect(foundDelta).toBe(true);
});

test("ConvertGeminiResponseToClaudeStream_PartlessMalformedFunctionCallClosesMessage", () => {
  const requestJSON = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}`;
  const chunk = `{"candidates":[{"content":{"role":"model","parts":[]},"index":0,"finishReason":"MALFORMED_FUNCTION_CALL"}],"modelVersion":"m","usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":10,"totalTokenCount":60}}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk, "[DONE]"], {}, "claude-opus-5-5");
  expect(outputText).not.toContain(`"stop_reason":"refusal"`);
  expect(outputText).not.toContain(`"type":"message_delta"`);
  expect(outputText).not.toContain(`"type":"message_stop"`);
  expect(outputText).toContain("event: error\n");
  let foundError = false;
  for (const payload of dataPayloads(outputText)) {
    if (getStr(payload, "type") !== "error") continue;
    foundError = true;
    expect(getStr(payload, "error.type")).toBe("api_error");
    expect(getStr(payload, "error.message")).toContain("MALFORMED_FUNCTION_CALL");
  }
  expect(foundError).toBe(true);
});

test("ConvertGeminiResponseToClaudeStream_MalformedFunctionCallAfterThinkingEmitsError", () => {
  const requestJSON = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}`;
  const chunk1 = `{"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"planning tool call"}]},"index":0}],"modelVersion":"m"}`;
  const chunk2 = `{"candidates":[{"content":{"role":"model","parts":[]},"index":0,"finishReason":"MALFORMED_FUNCTION_CALL"}],"modelVersion":"m","usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":10,"thoughtsTokenCount":313,"totalTokenCount":373}}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk1, chunk2, "[DONE]"], {}, "claude-opus-5-5");
  const stopIdx = outputText.indexOf("event: content_block_stop\n");
  const errIdx = outputText.indexOf("event: error\n");
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(errIdx).toBeGreaterThanOrEqual(0);
  expect(stopIdx).toBeLessThan(errIdx);
  expect(outputText).not.toContain(`"type":"message_delta"`);
  expect(outputText).not.toContain(`"type":"message_stop"`);
});

test("ConvertGeminiResponseToClaudeStream_MalformedFunctionCallWithoutUsageAndDuplicateTerminalChunk", () => {
  const requestJSON = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}`;
  const chunkWithoutUsage = `{"candidates":[{"content":{"role":"model","parts":[]},"index":0,"finishReason":"MALFORMED_FUNCTION_CALL"}],"modelVersion":"m"}`;
  const duplicateTerminalChunk = `{"candidates":[{"content":{"role":"model","parts":[{"text":"late text"}]},"index":0,"finishReason":"MALFORMED_FUNCTION_CALL"}],"modelVersion":"m","usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":10,"totalTokenCount":60}}`;
  const state: TranslatorState = {};
  const output = convertGeminiResponseToClaude(ctx, "claude-opus-5-5", requestJSON, requestJSON, chunkWithoutUsage, state).join("");
  const lateOutput = convertGeminiResponseToClaude(ctx, "claude-opus-5-5", requestJSON, requestJSON, duplicateTerminalChunk, state).join("");
  const doneOutput = convertGeminiResponseToClaude(ctx, "claude-opus-5-5", requestJSON, requestJSON, "[DONE]", state).join("");
  expect(lateOutput).toBe("");
  expect(doneOutput).toBe("");
  expect(output.split("event: error\n").length - 1).toBe(1);
});

test("ConvertGeminiResponseToClaude_MalformedFunctionCallWithToolUsePreservesToolUse", () => {
  const requestJSON = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}],"tools":[{"name":"Bash","input_schema":{"type":"object"}}]}`;
  const rawJSON = `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"Bash","args":{"command":"ls"}}}]},"index":0,"finishReason":"MALFORMED_FUNCTION_CALL"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":10,"totalTokenCount":60},"modelVersion":"m","responseId":"resp-tool"}`;
  const nonStreamOut = nonStream("claude-opus-5-5", requestJSON, requestJSON, rawJSON);
  expect(getStr(nonStreamOut, "stop_reason")).toBe("tool_use");
  const streamText = streamToClaude(requestJSON, requestJSON, [rawJSON, "[DONE]"], {}, "claude-opus-5-5");
  expect(streamText).not.toContain("event: error\n");
  expect(streamText).toContain(`"stop_reason":"tool_use"`);
});

test("ConvertGeminiResponseToClaudeStream_PartlessStopClosesMessageWithEndTurn", () => {
  const requestJSON = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}`;
  const chunk = `{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"index":0,"finishReason":"STOP"}],"modelVersion":"m","usageMetadata":{"promptTokenCount":80,"candidatesTokenCount":0,"totalTokenCount":80}}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk, "[DONE]"], {}, "claude-opus-5-5");
  expectEventOrder(outputText, ["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"]);
  let foundDelta = false;
  for (const payload of dataPayloads(outputText)) {
    if (getStr(payload, "type") !== "message_delta") continue;
    foundDelta = true;
    expect(getStr(payload, "delta.stop_reason")).toBe("end_turn");
  }
  expect(foundDelta).toBe(true);
});

describe("ConvertGeminiResponseToClaudeNonStream_SafetyAndMalformedFunctionCallRefusal", () => {
  const requestJSON = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}`;
  const cases = [
    { finishReason: "SAFETY", wantReason: "refusal" },
    { finishReason: "RECITATION", wantReason: "refusal" },
    { finishReason: "PROHIBITED_CONTENT", wantReason: "refusal" },
    { finishReason: "SPII", wantReason: "refusal" },
    { finishReason: "BLOCKLIST", wantReason: "refusal" },
    { finishReason: "IMAGE_SAFETY", wantReason: "refusal" },
    { finishReason: "MALFORMED_RESPONSE", wantReason: "refusal" },
    { finishReason: "MAX_TOKENS", wantReason: "max_tokens" },
    { finishReason: "STOP", wantReason: "end_turn" },
  ];
  for (const tc of cases) {
    test(tc.finishReason, () => {
      const rawJSON = `{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"${tc.finishReason}"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":37,"totalTokenCount":157},"modelVersion":"m","responseId":"resp-test"}`;
      const output = nonStream("claude-opus-5-5", requestJSON, requestJSON, rawJSON);
      expect(getStr(output, "stop_reason")).toBe(tc.wantReason);
    });
  }
});

test("ConvertGeminiResponseToClaudeNonStream_MalformedFunctionCallReturnsAPIError", () => {
  const requestJSON = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}`;
  const rawJSON = `{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"MALFORMED_FUNCTION_CALL"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":37,"totalTokenCount":157},"modelVersion":"m","responseId":"resp-test"}`;
  const output = nonStream("claude-opus-5-5", requestJSON, requestJSON, rawJSON);
  expect(getStr(output, "stop_reason")).not.toBe("refusal");
  expect(getStr(output, "type")).toBe("error");
  expect(getStr(output, "error.type")).toBe("api_error");
  expect(getStr(output, "error.message")).toContain("MALFORMED_FUNCTION_CALL");
});

test("ConvertGeminiResponseToClaudeNonStream_Issue6409_SignedVisibleText", () => {
  const requestJSON = `{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"hi"}]}`;
  const geminiResponse = `{"candidates":[{"content":{"parts":[{"text":"ok","thoughtSignature":"EmAKXgFpFH0Tb/MkBw="}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1},"modelVersion":"gemini-3.5-flash-lite","responseId":"5Qm-as2qBuLI-sAP76KVkAk"}`;
  const output = nonStream("gemini-3.5-flash-lite", requestJSON, requestJSON, geminiResponse);
  const blocks = getArr(output, "content");
  expect(blocks.length).toBe(2);
  expect(block(blocks[0], "type")).toBe("thinking");
  expect(block(blocks[0], "thinking")).toBe("");
  expect(block(blocks[0], "signature")).toBe("EmAKXgFpFH0Tb/MkBw=");
  expect(block(blocks[1], "type")).toBe("text");
  expect(block(blocks[1], "text")).toBe("ok");
});

test("ConvertGeminiResponseToClaudeNonStream_Issue6409_ThinkingFollowedBySignedVisibleText", () => {
  const requestJSON = `{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"hi"}]}`;
  const geminiResponse = `{"candidates":[{"content":{"parts":[
    {"text":"reasoning step","thought":true,"thoughtSignature":"sig-think"},
    {"text":"final answer","thoughtSignature":"sig-visible"}
  ],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-mixed"}`;
  const output = nonStream("gemini-3.5-flash-lite", requestJSON, requestJSON, geminiResponse);
  const blocks = getArr(output, "content");
  expect(blocks.length).toBe(3);
  expect(block(blocks[0], "type")).toBe("thinking");
  expect(block(blocks[0], "thinking")).toBe("reasoning step");
  expect(block(blocks[0], "signature")).toBe("sig-think");
  expect(block(blocks[1], "type")).toBe("thinking");
  expect(block(blocks[1], "thinking")).toBe("");
  expect(block(blocks[1], "signature")).toBe("sig-visible");
  expect(block(blocks[2], "type")).toBe("text");
  expect(block(blocks[2], "text")).toBe("final answer");
});

test("ConvertGeminiResponseToClaudeNonStream_Issue6409_ConsecutiveSignedVisibleTexts", () => {
  const requestJSON = `{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"hi"}]}`;
  const geminiResponse = `{"candidates":[{"content":{"parts":[
    {"text":"part A","thoughtSignature":"sig-A"},
    {"text":"part B","thoughtSignature":"sig-B"}
  ],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-consecutive"}`;
  const output = nonStream("gemini-3.5-flash-lite", requestJSON, requestJSON, geminiResponse);
  const blocks = getArr(output, "content");
  expect(blocks.length).toBe(4);
  expect(block(blocks[0], "type")).toBe("thinking");
  expect(block(blocks[0], "signature")).toBe("sig-A");
  expect(block(blocks[1], "type")).toBe("text");
  expect(block(blocks[1], "text")).toBe("part A");
  expect(block(blocks[2], "type")).toBe("thinking");
  expect(block(blocks[2], "signature")).toBe("sig-B");
  expect(block(blocks[3], "type")).toBe("text");
  expect(block(blocks[3], "text")).toBe("part B");
});

test("ConvertGeminiResponseToClaudeStream_Issue6409_SignedVisibleText", () => {
  const requestJSON = `{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"hi"}]}`;
  const chunk = `{"candidates":[{"content":{"parts":[{"text":"ok","thoughtSignature":"sig-stream-1"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1},"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-s1"}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk, "[DONE]"], {}, "gemini-3.5-flash-lite");
  expect(outputText).not.toContain(`"thinking_delta"`);
  expect(outputText).toContain(`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`);
  expect(outputText).toContain(`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-stream-1"}}`);
  expect(outputText).toContain(`{"type":"content_block_stop","index":0}`);
  expect(outputText).toContain(`{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`);
  expect(outputText).toContain(`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}`);
  expect(outputText).toContain(`{"type":"content_block_stop","index":1}`);
});

test("ConvertGeminiResponseToClaudeStream_Issue6409_SplitTrailingSignature", () => {
  const requestJSON = `{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"hi"}]}`;
  const textChunk = `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-s2"}`;
  const sigChunk = `{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"sig-stream-trailing"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1},"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-s2"}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [textChunk, sigChunk, "[DONE]"], {}, "gemini-3.5-flash-lite");
  expect(outputText).not.toContain(`"thinking_delta"`);
  expect(outputText).toContain(`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`);
  expect(outputText).toContain(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`);
  expect(outputText).toContain(`{"type":"content_block_stop","index":0}`);
  expect(outputText).toContain(`{"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}`);
  expect(outputText).toContain(`{"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"sig-stream-trailing"}}`);
  expect(outputText).toContain(`{"type":"content_block_stop","index":1}`);
});

test("ConvertGeminiResponseToClaudeStream_Issue6409_SignedFunctionCall", () => {
  const requestJSON = `{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"hi"}]}`;
  const chunk = `{"candidates":[{"content":{"parts":[{"thoughtSignature":"sig-fc-stream","functionCall":{"name":"test_tool","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1},"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-fc"}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk, "[DONE]"], {}, "gemini-3.5-flash-lite");
  expect(outputText).toContain(`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`);
  expect(outputText).toContain(`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-fc-stream"}}`);
  expect(outputText).toContain(`{"type":"content_block_stop","index":0}`);
  expect(outputText).toContain(`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use"`);
  expect(outputText).toContain(`{"type":"content_block_stop","index":1}`);
});

test("ConvertGeminiResponseToClaudeStream_Issue6409_FunctionCallContinuationSignature", () => {
  const requestJSON = `{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"hi"}]}`;
  const chunk1 = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"test_tool","args":{}}}]}}],"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-fc-cont"}`;
  const chunk2 = `{"candidates":[{"content":{"parts":[{"thoughtSignature":"sig-fc-cont-done","functionCall":{"args":{"key":"val"}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-fc-cont"}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk1, chunk2, "[DONE]"], {}, "gemini-3.5-flash-lite");
  expect(outputText).toContain(`"type":"input_json_delta"`);
  expect(outputText).toContain(`"signature":"sig-fc-cont-done"`);
});

test("ConvertGeminiResponseToClaudeStream_Issue6409_ThinkingFollowedBySignedVisibleText", () => {
  const requestJSON = `{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"hi"}]}`;
  const chunk1 = `{"candidates":[{"content":{"parts":[{"text":"thinking step","thought":true,"thoughtSignature":"sig-stream-think"}]}}],"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-mixed-stream"}`;
  const chunk2 = `{"candidates":[{"content":{"parts":[{"text":"visible text","thoughtSignature":"sig-stream-visible"}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.5-flash-lite","responseId":"resp-mixed-stream"}`;
  const outputText = streamToClaude(requestJSON, requestJSON, [chunk1, chunk2, "[DONE]"], {}, "gemini-3.5-flash-lite");
  expect(outputText).toContain(`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`);
  expect(outputText).toContain(`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-stream-think"}}`);
  expect(outputText).toContain(`{"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}`);
  expect(outputText).toContain(`{"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"sig-stream-visible"}}`);
  expect(outputText).toContain(`{"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}`);
  expect(outputText).toContain(`{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"visible text"}}`);
});

test("ConvertGeminiResponseToClaudeNonStream_UniqueToolUseIDsAcrossTurns", () => {
  resetGeminiClaudeToolUseIDCounter(0);
  const requestJSON = `{"model":"gemini-4-argon","messages":[{"role":"user","content":"run command"}]}`;
  const rawResponse = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"Bash","args":{"command":"ls"}}}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-4-argon","responseId":"resp-tool"}`;

  const streamText = streamToClaude(requestJSON, requestJSON, [rawResponse, "[DONE]"], {}, "gemini-4-argon");
  let streamToolID = "";
  for (const payload of dataPayloads(streamText)) {
    if (payload.includes(`"type":"tool_use"`)) {
      streamToolID = getStr(payload, "content_block.id");
      break;
    }
  }
  expect(streamToolID).not.toBe("");

  const nonStream1 = nonStream("gemini-4-argon", requestJSON, requestJSON, rawResponse);
  const nonStreamID1 = getStr(nonStream1, "content.0.id");
  expect(nonStreamID1).not.toBe("");
  const nonStream2 = nonStream("gemini-4-argon", requestJSON, requestJSON, rawResponse);
  const nonStreamID2 = getStr(nonStream2, "content.0.id");
  expect(nonStreamID2).not.toBe("");

  expect(nonStreamID1).not.toBe(streamToolID);
  expect(nonStreamID1).not.toBe(nonStreamID2);
});

test("ConvertGeminiResponseToClaude_SanitizesParameterlessToolArguments", () => {
  const origRequest = `{"model":"gemini-3-flash","tools":[{"name":"EnterPlanMode","input_schema":{"type":"object","properties":{}}}]}`;
  const rawResponse = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"EnterPlanMode","args":{"reason":"Plan mode switch"}}}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3-flash","responseId":"resp-zero-arg"}`;
  const nonStreamOut = nonStream("gemini-3-flash", origRequest, origRequest, rawResponse);
  expect(raw(nonStreamOut, "content.0.input")).toBe("{}");
  const streamText = streamToClaude(origRequest, origRequest, [rawResponse], {}, "gemini-3-flash");
  expect(inputJSONDeltas(streamText)).toBe("{}");
});

test("ConvertGeminiResponseToClaude_CanonicalNameCollisionKeepsExactToolArguments", () => {
  const origRequest = `{"model":"gemini-3-flash","tools":[{"name":"Read","input_schema":{"type":"object","properties":{}}},{"name":"read","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}]}`;
  const readWithArgs = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"/tmp/a"}}}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3-flash","responseId":"resp-collision"}`;
  const readParameterless = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"Read","args":{"reason":"x"}}}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3-flash","responseId":"resp-collision-2"}`;

  const nonStreamOut = nonStream("gemini-3-flash", origRequest, origRequest, readWithArgs);
  expect(raw(nonStreamOut, "content.0.input")).toBe(`{"path":"/tmp/a"}`);
  expect(getStr(nonStreamOut, "content.0.name")).toBe("read");

  const streamText = streamToClaude(origRequest, origRequest, [readWithArgs], {}, "gemini-3-flash");
  expect(inputJSONDeltas(streamText)).toBe(`{"path":"/tmp/a"}`);

  const nonStreamParameterless = nonStream("gemini-3-flash", origRequest, origRequest, readParameterless);
  expect(raw(nonStreamParameterless, "content.0.input")).toBe("{}");
});

test("ConvertGeminiResponseToClaude_AmbiguousCanonicalNameKeepsUpstreamNameAndArguments", () => {
  const origRequest = `{"model":"gemini-3-flash","tools":[{"name":"Read","input_schema":{"type":"object","properties":{}}},{"name":"read","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}]}`;
  const ambiguousResponse = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"READ","args":{"path":"/tmp/a"}}}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3-flash","responseId":"resp-ambiguous"}`;
  const nonStreamOut = nonStream("gemini-3-flash", origRequest, origRequest, ambiguousResponse);
  expect(getStr(nonStreamOut, "content.0.name")).toBe("READ");
  expect(raw(nonStreamOut, "content.0.input")).toBe(`{"path":"/tmp/a"}`);
});

test("ConvertGeminiResponseToClaude_KeepsReasonWhenTranslatedSchemaHasNoPlaceholder", () => {
  const origRequest = `{"model":"gemini-3-flash","tools":[{"name":"Bash","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]}`;
  const translatedRequest = convertClaudeRequestToGemini("gemini-3-flash", origRequest, false);
  const rawResponse = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"Bash","args":{"command":"ls","reason":"why"}}}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3-flash","responseId":"resp-bash-reason"}`;
  const nonStreamOut = nonStream("gemini-3-flash", origRequest, translatedRequest, rawResponse);
  expect(raw(nonStreamOut, "content.0.input")).toBe(`{"command":"ls","reason":"why"}`);
});

test("ConvertGeminiResponseToClaude_ParameterlessToolContinuationDoesNotDuplicateEmptyObject", () => {
  const origRequest = `{"model":"gemini-3-flash","tools":[{"name":"EnterPlanMode","input_schema":{"type":"object","properties":{}}}]}`;
  const firstChunk = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"EnterPlanMode","args":{"reason":"Plan mode switch"}}}],"role":"model"}}],"modelVersion":"gemini-3-flash","responseId":"resp-zero-arg"}`;
  const continuationChunk = `{"candidates":[{"content":{"parts":[{"functionCall":{"args":{"reason":"more"}}}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3-flash","responseId":"resp-zero-arg"}`;
  const streamText = streamToClaude(origRequest, origRequest, [firstChunk, continuationChunk], {}, "gemini-3-flash");
  expect(inputJSONDeltas(streamText)).toBe("{}");
});

describe("ConvertGeminiResponseToClaude_ImplicitOpenToolContinuationOrdering", () => {
  const origRequest = `{"model":"gemini-3-flash","tools":[{"name":"echo","input_schema":{"type":"object","properties":{}}}]}`;
  const cases = [
    { name: "empty_then_real_args", firstArgs: `{}`, contArgs: `{"user":"v"}`, want: `{"user":"v"}` },
    { name: "placeholder_then_real_args", firstArgs: `{"reason":"thinking"}`, contArgs: `{"user":"v"}`, want: `{"user":"v"}` },
    { name: "real_args_then_empty", firstArgs: `{"user":"v"}`, contArgs: `{}`, want: `{"user":"v"}` },
    { name: "real_args_then_placeholder", firstArgs: `{"user":"v"}`, contArgs: `{"reason":"done"}`, want: `{"user":"v"}` },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const firstChunk = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"echo","args":${tc.firstArgs}}}],"role":"model"}}],"modelVersion":"gemini-3-flash","responseId":"resp-echo"}`;
      const continuationChunk = `{"candidates":[{"content":{"parts":[{"functionCall":{"args":${tc.contArgs}}}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-3-flash","responseId":"resp-echo"}`;
      const streamText = streamToClaude(origRequest, origRequest, [firstChunk, continuationChunk], {}, "gemini-3-flash");
      expect(inputJSONDeltas(streamText)).toBe(tc.want);
    });
  }
});

// Addition for this port: the Gemini CLI (Code Assist) upstream wraps every chunk and body in {"response": ...}.
describe("Code Assist response envelope", () => {
  const requestJSON = `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`;

  test("stream unwraps the response envelope and accepts data-prefixed lines", () => {
    const wrapped = `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2},"modelVersion":"gemini-2.5-pro","responseId":"resp-cli"},"traceId":"abc"}`;
    const outputText = streamToClaude(requestJSON, requestJSON, [wrapped, "[DONE]"]);
    const payloads = dataPayloads(outputText);
    expect(getStr(payloads[0]!, "type")).toBe("message_start");
    expect(getStr(payloads[0]!, "message.id")).toBe("resp-cli");
    expect(getStr(payloads[0]!, "message.model")).toBe("gemini-2.5-pro");
    expect(outputText).toContain(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`);
    const delta = payloads.find((p) => getStr(p, "type") === "message_delta")!;
    expect(getStr(delta, "delta.stop_reason")).toBe("end_turn");
    expect(getInt(delta, "usage.input_tokens")).toBe(3);
    expect(getInt(delta, "usage.output_tokens")).toBe(2);
    expect(outputText).toContain(`"type":"message_stop"`);
  });

  test("non-stream unwraps the response envelope", () => {
    const wrapped = `{"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2},"modelVersion":"gemini-2.5-pro","responseId":"resp-cli"}}`;
    const output = nonStream("gemini-2.5-pro", requestJSON, requestJSON, wrapped);
    expect(getStr(output, "id")).toBe("resp-cli");
    expect(getStr(output, "model")).toBe("gemini-2.5-pro");
    expect(getStr(output, "content.0.text")).toBe("Hello");
    expect(getStr(output, "stop_reason")).toBe("max_tokens");
    expect(getInt(output, "usage.input_tokens")).toBe(3);
    expect(exists(output, "usage.cache_read_input_tokens")).toBe(false);
  });

  test("a root with candidates is never unwrapped", () => {
    const body = `{"candidates":[{"content":{"parts":[{"text":"top"}]},"finishReason":"STOP"}],"response":{"candidates":[{"content":{"parts":[{"text":"inner"}]}}]}}`;
    const output = nonStream("gemini-2.5-pro", requestJSON, requestJSON, body);
    expect(getStr(output, "content.0.text")).toBe("top");
  });
});
