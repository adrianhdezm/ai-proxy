// Ported from: internal/translator/gemini/openai/responses/gemini_openai-responses_request_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { geminiSkipThoughtSignatureValidator, sanitizeGeminiRequestThoughtSignatures, validateGeminiFunctionCallPairing } from "../../../../../src/signature/index.ts";
import { geminiResponsesThoughtSignature, reorderOpenAIResponsesDetachedReasoning } from "../../../../../src/translator/gemini/openai/responses/request.ts";
import {
  encodeGeminiResponsesCarrier,
  geminiResponsesCarrierFunction,
  geminiResponsesCarrierNext,
  geminiResponsesCarrierPrefix,
  geminiResponsesCarrierPrevious,
  geminiResponsesCarrierStandalone,
  geminiResponsesCarrierText,
} from "../../../../../src/translator/gemini/openai/responses/signature_carrier.ts";
import { differentResponsesGeminiThoughtSignature, g, J, testResponsesGeminiThoughtSignature as sig, toGemini, toGeminiErr } from "./helpers.ts";

const M = "gemini-3.6-flash-high";

function convert(input: string, model = M): string {
  return toGemini(model, input);
}

function allParts(result: string): J[] {
  return g(result, "contents").arr().flatMap((c) => c.arr("parts"));
}

function callSequence(result: string): string {
  const seq: string[] = [];
  for (const part of allParts(result)) {
    if (part.str("functionCall.id") !== "") seq.push("call:" + part.str("functionCall.id"));
    if (part.str("functionResponse.id") !== "") seq.push("output:" + part.str("functionResponse.id"));
  }
  return seq.join(",");
}

test("TestReorderOpenAIResponsesDetachedReasoningDoesNotCrossUserMessage", () => {
  const items = JSON.parse(`[
		{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]},
		{"id":"rs_test_detached_after_1","type":"reasoning","encrypted_content":"${sig}","summary":[]},
		{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{}"}
	]`);
  const reordered = reorderOpenAIResponsesDetachedReasoning(items).map((i) => new J(i));
  expect(reordered[0]!.str("role")).toBe("user");
  expect(reordered[1]!.str("type")).toBe("reasoning");
});

test("TestConvertOpenAIResponsesRequestToGemini_ReattachesReasoningAndSignatureToFunctionCall", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[{"type":"summary_text","text":"hidden thought"}]},
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"true\\"}"},
			{"type":"function_call_output","call_id":"call-1","output":"ok"}]}`);
  const parts = g(result, "contents.1.parts").arr();
  expect(parts.length).toBe(2);
  expect(parts[0]!.bool("thought")).toBe(true);
  expect(parts[1]!.str("functionCall.name")).toBe("run_command");
  expect(parts[1]!.str("thoughtSignature")).toBe(sig);
});

test("TestConvertOpenAIResponsesRequestToGemini_SyntheticParallelCallsOnlyFirstGetsSentinel", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"one\\"}"},
			{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{\\"command\\":\\"two\\"}"}]}`);
  const parts = g(result, "contents.0.parts").arr();
  expect(parts.length).toBe(2);
  expect(parts[0]!.str("thoughtSignature")).toBe(geminiSkipThoughtSignatureValidator);
  expect(parts[1]!.exists("thoughtSignature")).toBe(false);
});

test("TestConvertOpenAIResponsesRequestToGemini_NativeParallelCallsPreserveUnsignedSibling", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"run twice"}]},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"one\\"}"},
			{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{\\"command\\":\\"two\\"}"}]}`);
  const calls = allParts(result).filter((p) => p.exists("functionCall"));
  expect(calls.length).toBe(2);
  expect(calls[0]!.str("thoughtSignature")).toBe(sig);
  expect(calls[1]!.exists("thoughtSignature")).toBe(false);
});

test("TestConvertOpenAIResponsesRequestToGemini_PreservesMultipleLeadingToolSignatures", () => {
  const secondSignature = differentResponsesGeminiThoughtSignature();
  const result = convert(`{"model":"${M}","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"run twice"}]},
			{"id":"rs_before_1","type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"one\\"}"},
			{"id":"rs_before_2","type":"reasoning","encrypted_content":"${secondSignature}","summary":[]},
			{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{\\"command\\":\\"two\\"}"},
			{"type":"function_call_output","call_id":"call-1","output":"one"},
			{"type":"function_call_output","call_id":"call-2","output":"two"}]}`);
  expect(allParts(result).filter((p) => p.exists("functionCall")).map((p) => p.str("thoughtSignature"))).toEqual([sig, secondSignature]);
  expect(callSequence(result)).toBe("call:call-1,call:call-2,output:call-1,output:call-2");
  expect(validateGeminiFunctionCallPairing(result)).toBeUndefined();
});

test("TestConvertOpenAIResponsesRequestToGemini_GroupsReversedParallelToolOutputs", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"one\\"}"},
			{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{\\"command\\":\\"two\\"}"},
			{"type":"function_call_output","call_id":"call-2","output":"two"},
			{"type":"function_call_output","call_id":"call-1","output":"one"}]}`);
  expect(validateGeminiFunctionCallPairing(result)).toBeUndefined();
  const contents = g(result, "contents").arr();
  expect(contents.map((c) => c.str("role"))).toEqual(["model", "user"]);
  const responses = contents[1]!.arr("parts");
  expect(responses.map((r) => [r.str("functionResponse.id"), r.str("functionResponse.response.result")])).toEqual([
    ["call-1", "one"],
    ["call-2", "two"],
  ]);
});

test("TestConvertOpenAIResponsesRequestToGemini_GroupsNonContiguousParallelToolOutputs", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"one\\"}"},
			{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{\\"command\\":\\"two\\"}"},
			{"type":"function_call_output","call_id":"call-1","output":"one"},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"between outputs"}]},
			{"type":"function_call_output","call_id":"call-2","output":"two"}]}`);
  const contents = g(result, "contents").arr();
  expect(contents.map((c) => c.str("role"))).toEqual(["model", "user", "user", "user"]);
  expect(contents[1]!.str("parts.0.functionResponse.id")).toBe("call-1");
  expect(contents[2]!.str("parts.0.text")).toBe("between outputs");
  expect(contents[3]!.str("parts.0.functionResponse.id")).toBe("call-2");
});

test("TestConvertOpenAIResponsesRequestToGemini_PreservesReasoningBeforePairedFunctionSignature", () => {
  const secondSignature = differentResponsesGeminiThoughtSignature();
  const result = convert(`{"model":"${M}","input":[
			{"type":"reasoning","encrypted_content":"${sig}","summary":[{"type":"summary_text","text":"first"}]},
			{"type":"reasoning","encrypted_content":"${secondSignature}","summary":[{"type":"summary_text","text":"second"}]},
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"true\\"}"},
			{"type":"function_call_output","call_id":"call-1","output":"ok"}]}`);
  expect(allParts(result).map((p) => p.str("thoughtSignature")).filter((s) => s !== "")).toEqual([sig, secondSignature]);
});

test("TestConvertOpenAIResponsesRequestToGemini_PreservesFunctionOutputOrderAcrossModelText", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"one\\"}"},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"between"}]},
			{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{\\"command\\":\\"two\\"}"},
			{"type":"function_call_output","call_id":"call-1","output":"one"},
			{"type":"function_call_output","call_id":"call-2","output":"two"}]}`);
  expect(callSequence(result)).toBe("call:call-1,call:call-2,output:call-1,output:call-2");
});

test("TestConvertOpenAIResponsesRequestToGemini_ReattachesTrailingDetachedSignatureToText", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"turn one"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"visible answer"}]},
			{"id":"rs_text_detached_after_1","type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"turn two"}]}]}`);
  const parts = g(result, "contents.1.parts").arr();
  expect(parts.length).toBe(1);
  expect(parts[0]!.str("text")).toBe("visible answer");
  expect(parts[0]!.str("thoughtSignature")).toBe(sig);
  expect(parts[0]!.bool("thought")).toBe(false);
});

test("TestConvertOpenAIResponsesRequestToGemini_ReattachesUnmarkedTrailingSignatureToText", () => {
  const result = convert(
    `{"model":"gemini-3.5-flash","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"turn one"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"visible answer"}]},
			{"id":"rs_client_rewritten","type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"turn two"}]}]}`,
    "gemini-3.5-flash",
  );
  const parts = g(result, "contents.1.parts").arr();
  expect(parts.length).toBe(1);
  expect(parts[0]!.str("text")).toBe("visible answer");
  expect(parts[0]!.str("thoughtSignature")).toBe(sig);
});

test("TestConvertOpenAIResponsesRequestToGemini_UnmarkedReasoningBeforeFunctionCallStillPairsCall", () => {
  const result = convert(
    `{"model":"gemini-3.5-flash","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will run it."}]},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"true\\"}"},
			{"type":"function_call_output","call_id":"call-1","output":"ok"}]}`,
    "gemini-3.5-flash",
  );
  const parts = g(result, "contents.1.parts").arr();
  expect(parts.length).toBe(2);
  expect(parts[0]!.exists("thoughtSignature")).toBe(false);
  expect(parts[1]!.str("thoughtSignature")).toBe(sig);
});

test("TestConvertOpenAIResponsesRequestToGemini_ReattachesDetachedSignatureToFunctionCall", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]},
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"true\\"}"},
			{"id":"rs_function_detached_after_1","type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"function_call_output","call_id":"call-1","output":"ok"}]}`);
  const calls = g(result, "contents")
    .arr()
    .filter((c) => c.str("role") === "model")
    .flatMap((c) => c.arr("parts"))
    .filter((p) => p.str("functionCall.name") === "run_command");
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call.str("thoughtSignature")).toBe(sig);
});

test("TestConvertOpenAIResponsesRequestToGemini_ReattachesUnmarkedPostCallSignatureWithMatchingOutput", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"true\\"}"},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"function_call_output","call_id":"call-1","output":"ok"}]}`);
  expect(g(result, "contents.0.parts.0.thoughtSignature").str()).toBe(sig);
});

describe("TestConvertOpenAIResponsesRequestToGemini_ReattachesDirectionalFunctionCarriersWithoutIDs", () => {
  for (const c of [
    {
      name: "leading",
      direction: geminiResponsesCarrierNext,
      input: (carrier: string) =>
        `[{"type":"reasoning","encrypted_content":"${carrier}","summary":[]},{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{}"},{"type":"function_call_output","call_id":"call-1","output":"ok"}]`,
    },
    {
      name: "post-call",
      direction: geminiResponsesCarrierPrevious,
      input: (carrier: string) =>
        `[{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{}"},{"type":"reasoning","encrypted_content":"${carrier}","summary":[]},{"type":"function_call_output","call_id":"call-1","output":"ok"}]`,
    },
  ]) {
    test(c.name, () => {
      const carrier = encodeGeminiResponsesCarrier(sig, c.direction, geminiResponsesCarrierFunction);
      const result = convert(`{"model":"${M}","input":${c.input(carrier)}}`);
      expect(g(result, "contents.0.parts.0.thoughtSignature").str()).toBe(sig);
      expect(result).not.toContain(geminiResponsesCarrierPrefix);
    });
  }
});

describe("TestConvertOpenAIResponsesRequestToGemini_DoesNotRetargetExtraPreviousCarrier", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  test("text", () => {
    const first = encodeGeminiResponsesCarrier(sig, geminiResponsesCarrierNext, geminiResponsesCarrierText);
    const extra = encodeGeminiResponsesCarrier(signature2, geminiResponsesCarrierPrevious, geminiResponsesCarrierText);
    const parts = g(
      convert(
        `{"model":"${M}","input":[{"type":"reasoning","encrypted_content":"${first}","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"signed"}]},{"type":"reasoning","encrypted_content":"${extra}","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"unsigned"}]}]}`,
      ),
      "contents.0.parts",
    ).arr();
    expect(parts.length).toBe(3);
    expect(parts[1]!.exists("text")).toBe(true);
    expect(parts.map((p) => [p.str("text"), p.str("thoughtSignature")])).toEqual([
      ["signed", sig],
      ["", signature2],
      ["unsigned", ""],
    ]);
  });
  test("function", () => {
    const first = encodeGeminiResponsesCarrier(sig, geminiResponsesCarrierNext, geminiResponsesCarrierFunction);
    const extra = encodeGeminiResponsesCarrier(signature2, geminiResponsesCarrierPrevious, geminiResponsesCarrierFunction);
    const parts = g(
      convert(
        `{"model":"${M}","input":[{"type":"reasoning","encrypted_content":"${first}","summary":[]},{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{}"},{"type":"reasoning","encrypted_content":"${extra}","summary":[]},{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{}"}]}`,
      ),
      "contents.0.parts",
    ).arr();
    expect(parts.length).toBe(3);
    expect([parts[0]!.str("functionCall.id"), parts[0]!.str("thoughtSignature")]).toEqual(["call-1", sig]);
    expect(parts[1]!.exists("text")).toBe(true);
    expect([parts[1]!.str("text"), parts[1]!.str("thoughtSignature")]).toEqual(["", signature2]);
    // call-2 follows a text part, so it gets the bypass sentinel rather than signature2.
    expect([parts[2]!.str("functionCall.id"), parts[2]!.str("thoughtSignature")]).toEqual(["call-2", "skip_thought_signature_validator"]);
  });
});

test("TestConvertOpenAIResponsesRequestToGemini_DoesNotBindStandaloneFunctionCarrier", () => {
  const carrier = encodeGeminiResponsesCarrier(sig, geminiResponsesCarrierStandalone, geminiResponsesCarrierFunction);
  const parts = g(convert(`{"model":"${M}","input":[{"type":"reasoning","encrypted_content":"${carrier}","summary":[]},{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{}"}]}`), "contents.0.parts").arr();
  expect(parts.length).toBe(2);
  expect(parts[0]!.str("thoughtSignature")).toBe(sig);
  expect(parts[1]!.str("thoughtSignature")).toBe(geminiResponsesThoughtSignature);
});

test("TestConvertOpenAIResponsesRequestToGemini_ReattachesUnmarkedParallelPostCallSignature", () => {
  const parts = g(
    convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"one\\"}"},
			{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{\\"command\\":\\"two\\"}"},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"function_call_output","call_id":"call-1","output":"one"},
			{"type":"function_call_output","call_id":"call-2","output":"two"}]}`),
    "contents.0.parts",
  ).arr();
  expect(parts.map((p) => p.str("thoughtSignature"))).toEqual([geminiResponsesThoughtSignature, sig]);
});

test("TestConvertOpenAIResponsesRequestToGemini_ReattachesAlternatingParallelPostCallSignatures", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const parts = g(
    convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"one\\"}"},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"function_call","call_id":"call-2","name":"run_command","arguments":"{\\"command\\":\\"two\\"}"},
			{"type":"reasoning","encrypted_content":"${signature2}","summary":[]},
			{"type":"function_call_output","call_id":"call-1","output":"one"},
			{"type":"function_call_output","call_id":"call-2","output":"two"}]}`),
    "contents.0.parts",
  ).arr();
  expect(parts.map((p) => [p.str("functionCall.id"), p.str("thoughtSignature")])).toEqual([
    ["call-1", sig],
    ["call-2", signature2],
  ]);
});

test("TestConvertOpenAIResponsesRequestToGemini_PreservesExtraConsecutivePostCallCarrier", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const parts = g(
    convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{}"},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"reasoning","encrypted_content":"${signature2}","summary":[]},
			{"type":"function_call_output","call_id":"call-1","output":"ok"}]}`),
    "contents.0.parts",
  ).arr();
  expect(parts.length).toBe(2);
  expect([parts[0]!.str("functionCall.id"), parts[0]!.str("thoughtSignature")]).toEqual(["call-1", sig]);
  expect(parts[1]!.str("thoughtSignature")).toBe(signature2);
});

test("TestConvertOpenAIResponsesRequestToGemini_DoesNotPairUnmarkedPostCallSignatureAcrossMismatch", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{}"},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"function_call_output","call_id":"other-call","output":"ok"}]}`);
  expect(g(result, "contents.0.parts.0.thoughtSignature").str()).toBe(geminiResponsesThoughtSignature);
});

test("TestConvertOpenAIResponsesRequestToGemini_DoesNotPairUnmarkedPostCallSignatureAcrossUserMessage", () => {
  const result = convert(`{"model":"${M}","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{}"},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"boundary"}]},
			{"type":"function_call_output","call_id":"call-1","output":"ok"}]}`);
  expect(g(result, "contents.0.parts.0.thoughtSignature").str()).toBe(geminiResponsesThoughtSignature);
});

function validResponsesGPTReasoningSignature(): string {
  const raw = new Uint8Array(1 + 8 + 16 + 16 + 32);
  raw[0] = 0x80;
  raw[8] = 1;
  for (let i = 9; i < raw.length; i++) raw[i] = i;
  return Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

test("TestConvertOpenAIResponsesRequestToGemini_StripsTrailingAssistantPrefill", () => {
  const result = convert(
    `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"previous answer"}]}]}`,
    "gemini-3.1-pro-high",
  );
  const contents = g(result, "contents").arr();
  expect(contents.length).toBe(1);
  expect(contents[0]!.str("role")).toBe("user");
});

test("TestConvertOpenAIResponsesRequestToGemini_TextFormatJSONSchema", () => {
  const output = convert(
    `{"model":"gemini-flash-lite","temperature":0.2,"input":[{"role":"user","content":[{"type":"input_text","text":"Return structured JSON."}]}],
		"text":{"format":{"type":"json_schema","strict":true,"name":"response","schema":{"type":"object","properties":{"cleanedContent":{"type":"string"}},"required":["cleanedContent"],"additionalProperties":false}}}}`,
    "gemini-3.1-flash-lite",
  );
  const genConfig = g(output, "generationConfig");
  expect(genConfig.str("responseMimeType")).toBe("application/json");
  expect(genConfig.exists("responseJsonSchema")).toBe(true);
  expect(genConfig.exists("responseSchema")).toBe(false);
  expect(genConfig.str("responseJsonSchema.type")).toBe("object");
  expect(genConfig.str("responseJsonSchema.properties.cleanedContent.type")).toBe("string");
  expect(genConfig.exists("responseJsonSchema.additionalProperties")).toBe(true);
  expect(genConfig.bool("responseJsonSchema.additionalProperties")).toBe(false);
  expect(genConfig.num("temperature")).toBe(0.2);
});

test("TestConvertOpenAIResponsesRequestToGemini_TextFormatJSONObject", () => {
  const output = convert(`{"model":"gemini-flash-lite","input":"Return a JSON object.","text":{"format":{"type":"json_object"}}}`, "gemini-3.1-flash-lite");
  expect(g(output, "generationConfig.responseMimeType").str()).toBe("application/json");
  expect(g(output, "generationConfig.responseJsonSchema").exists()).toBe(false);
});

test("TestConvertOpenAIResponsesRequestToGemini_PreservesReasoningOnlyHistory", () => {
  const output = convert(`{"model":"gpt-5","input":[{"type":"reasoning","encrypted_content":"gemini#${sig}","summary":[{"type":"summary_text","text":"reasoning summary"}]}]}`, "gemini-3.5-flash");
  expect(g(output, "contents").arr().length).toBe(1);
  const parts = g(output, "contents.0.parts").arr();
  expect(parts.length).toBe(1);
  expect(parts[0]!.bool("thought")).toBe(true);
  expect(parts[0]!.str("thoughtSignature")).toBe(sig);
  expect(parts[0]!.str("text")).toBe("reasoning summary");
});

test("TestConvertOpenAIResponsesRequestToGemini_DropsEmptyUnsignedReasoningCarrier", () => {
  const output = convert(`{"model":"${M}","input":[{"type":"reasoning","encrypted_content":"","summary":[]}]}`);
  expect(g(output, "contents").arr().length).toBe(0);
});

test("TestConvertOpenAIResponsesRequestToGemini_PreservesUnboundDetachedCarrierWithoutEmptyThought", () => {
  const output = convert(`{"model":"${M}","input":[{"id":"rs_unbound_detached_after_1","type":"reasoning","encrypted_content":"${sig}","summary":[]}]}`);
  const parts = g(output, "contents.0.parts").arr();
  expect(parts.length).toBe(1);
  expect(parts[0]!.bool("thought")).toBe(false);
  expect(parts[0]!.exists("text")).toBe(true);
  expect(parts[0]!.str("text")).toBe("");
  expect(parts[0]!.str("thoughtSignature")).toBe(sig);
});

test("TestConvertOpenAIResponsesRequestToGemini_PreservesReasoningBeforeTrailingAssistantPrefill", () => {
  const output = convert(
    `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},
			{"type":"reasoning","encrypted_content":"gemini#${sig}","summary":[{"type":"summary_text","text":"reasoning summary"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"previous answer"}]}]}`,
    "gemini-3.5-flash",
  );
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(2);
  expect(contents[0]!.str("role")).toBe("user");
  expect(contents[1]!.str("parts.1.thoughtSignature")).toBe(sig);
});

describe("TestConvertOpenAIResponsesRequestToGemini_ReasoningSignatureCompatibility", () => {
  for (const c of [
    { name: "GPT encrypted_content is dropped from Gemini thought", encrypted: validResponsesGPTReasoningSignature(), want: "" },
    { name: "Gemini encrypted_content is preserved", encrypted: "gemini#" + sig, want: sig },
    { name: "Missing encrypted_content leaves Gemini thought unsigned", encrypted: "", want: "" },
  ]) {
    test(c.name, () => {
      const output = convert(`{"model":"gpt-5","input":[{"type":"reasoning","encrypted_content":"${c.encrypted}","summary":[{"type":"summary_text","text":"reasoning summary"}]}]}`, "gemini-3.5-flash");
      const parts = g(output, "contents.0.parts").arr();
      expect(parts.length).toBe(1);
      expect(parts[0]!.str("thoughtSignature")).toBe(c.want);
      expect(parts[0]!.str("text")).toBe("reasoning summary");
    });
  }
});

test("TestConvertOpenAIResponsesRequestToGemini_MergesReasoningWithAssistantVisibleAnswer", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","input":[{"type":"reasoning","encrypted_content":"gemini#${sig}","summary":[{"type":"summary_text","text":"internal reasoning"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"visible answer"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]}`,
    "gemini-3.5-flash",
  );
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(2);
  const parts = contents[0]!.arr("parts");
  expect(parts.length).toBe(2);
  expect(parts[0]!.bool("thought")).toBe(true);
  expect(parts[0]!.str("thoughtSignature")).toBe("");
  expect(parts[1]!.str("text")).toBe("visible answer");
  expect(parts[1]!.str("thoughtSignature")).toBe(sig);
});

test("TestConvertOpenAIResponsesRequestToGemini_MergesReasoningWithUserRoleOutputText", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","input":[{"type":"reasoning","encrypted_content":"gemini#${sig}","summary":[{"type":"summary_text","text":"reasoning summary"}]},{"type":"message","role":"user","content":[{"type":"output_text","text":"visible from user role"}]}]}`,
    "gemini-3.5-flash",
  );
  expect(g(output, "contents").arr().length).toBe(1);
  expect(g(output, "contents.0.parts.1.text").str()).toBe("visible from user role");
});

test("TestConvertOpenAIResponsesRequestToGemini_MergesReasoningWithAssistantStringContent", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","input":[{"type":"reasoning","encrypted_content":"gemini#${sig}","summary":[{"type":"summary_text","text":"reasoning summary"}]},{"type":"message","role":"assistant","content":"string visible answer"}]}`,
    "gemini-3.5-flash",
  );
  expect(g(output, "contents.0.parts.1.text").str()).toBe("string visible answer");
});

test("TestConvertOpenAIResponsesRequestToGemini_PreservesWhitespaceWhenMergingReasoning", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","input":[{"type":"reasoning","encrypted_content":"gemini#${sig}","summary":[{"type":"summary_text","text":"reasoning summary"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"  lead trail  "}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]}`,
    "gemini-3.5-flash",
  );
  expect(g(output, "contents.0.parts.1.text").str()).toBe("  lead trail  ");
});

describe("TestConvertOpenAIResponsesRequestToGemini_SystemAndDeveloperRoles", () => {
  for (const c of [
    { name: "system role", role: "system", want: "System message text" },
    { name: "developer role", role: "developer", want: "Developer message text" },
  ]) {
    test(c.name, () => {
      const output = convert(
        `{"instructions":"Be a helpful assistant","input":[{"type":"message","role":"${c.role}","content":[{"type":"input_text","text":"${c.want}"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}]}`,
        "gemini-3.5-flash",
      );
      const parts = g(output, "systemInstruction.parts").arr();
      expect(parts.map((p) => p.str("text"))).toEqual(["Be a helpful assistant", c.want]);
      for (const content of g(output, "contents").arr()) expect(content.str("role")).not.toBe(c.role);
    });
  }
});

test("TestConvertOpenAIResponsesRequestToGemini_MidSessionDeveloperMessageDoesNotMutateSystemInstruction", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","instructions":"Be a helpful assistant","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Turn 1 user"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Turn 1 assistant"}]},
			{"type":"message","role":"developer","content":"<image_resize_notice>Image 1 was resized to 800x600</image_resize_notice>"},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Turn 2 user"}]}]}`,
    "gemini-3.5-flash",
  );
  expect(g(output, "systemInstruction.parts").arr().map((p) => p.str("text"))).toEqual(["Be a helpful assistant"]);
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  expect([contents[0]!.str("role"), contents[0]!.str("parts.0.text")]).toEqual(["user", "Turn 1 user"]);
  expect([contents[1]!.str("role"), contents[1]!.str("parts.0.text")]).toEqual(["model", "Turn 1 assistant"]);
  expect(contents[2]!.str("role")).toBe("user");
  expect(contents[2]!.arr("parts").map((p) => p.str("text"))).toEqual([
    "<system-reminder>\n<image_resize_notice>Image 1 was resized to 800x600</image_resize_notice>\n</system-reminder>",
    "Turn 2 user",
  ]);
});

test("TestConvertOpenAIResponsesRequestToGemini_MidSessionSystemReminderEnvelope", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","instructions":"Be a helpful assistant","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Turn 1 user"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Turn 1 assistant"}]},
			{"type":"message","role":"developer","content":"Please decide which tool to call next."}]}`,
    "gemini-3.5-flash",
  );
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  expect(contents[2]!.str("parts.0.text")).toBe("<system-reminder>\nPlease decide which tool to call next.\n</system-reminder>");
});

test("TestConvertOpenAIResponsesRequestToGemini_MidSessionDeveloperMultiPartContentWrappedOnce", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","instructions":"Be a helpful assistant","input":[
			{"type":"message","role":"user","content":"Turn 1"},
			{"type":"message","role":"assistant","content":"Reply 1"},
			{"type":"message","role":"developer","content":[{"type":"input_text","text":"Rule line 1"},{"type":"input_text","text":"Rule line 2"}]}]}`,
    "gemini-3.5-flash",
  );
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  expect(contents[2]!.str("parts.0.text")).toBe("<system-reminder>\nRule line 1\nRule line 2\n</system-reminder>");
});

test("TestConvertOpenAIResponsesRequestToGemini_MultipleMidSessionDeveloperMessagesArrayContent", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","instructions":"Be a helpful assistant","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Turn 1"}]},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Reply 1"}]},
			{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>\\nApproved: git\\n</permissions instructions>"}]},
			{"type":"message","role":"developer","content":[{"type":"input_text","text":"<collaboration_mode>\\nPlan\\n</collaboration_mode>"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Proceed"}]}]}`,
    "gemini-3.5-flash",
  );
  expect(g(output, "systemInstruction.parts").arr().map((p) => p.str("text"))).toEqual(["Be a helpful assistant"]);
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  const p = contents[2]!.arr("parts");
  expect(p.length).toBe(3);
  expect(p[0]!.str("text")).toContain("permissions instructions");
  expect(p[1]!.str("text")).toContain("collaboration_mode");
  expect(p[2]!.str("text")).toBe("Proceed");
});

test("TestConvertOpenAIResponsesRequestToGemini_InterveningDeveloperMessagePreservesToolPairing", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","instructions":"Be a helpful assistant","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Run tool"}]},
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"echo test\\"}"},
			{"type":"message","role":"developer","content":"<permissions instructions>\\nApproved: echo\\n</permissions instructions>"},
			{"type":"function_call_output","call_id":"call-1","output":"test"}]}`,
    "gemini-3.5-flash",
  );
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  expect(g(output, "systemInstruction.parts").arr().map((p) => p.str("text"))).toEqual(["Be a helpful assistant"]);
  expect(allParts(output).some((p) => p.str("functionResponse.name") === "run_command")).toBe(true);
});

test("TestConvertOpenAIResponsesRequestToGemini_InterveningDeveloperAndUserMessageFlushesInOrder", () => {
  const output = convert(
    `{"model":"gemini-3.5-flash","instructions":"Be a helpful assistant","input":[
			{"type":"function_call","call_id":"call-1","name":"run_command","arguments":"{\\"command\\":\\"test\\"}"},
			{"type":"message","role":"developer","content":"<permissions instructions>\\nApproved: test\\n</permissions instructions>"},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Wait, also check this"}]},
			{"type":"function_call_output","call_id":"call-1","output":"done"}]}`,
    "gemini-3.5-flash",
  );
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  expect(contents[0]!.str("role")).toBe("model");
  const mid = contents[1]!.arr("parts");
  expect(mid.length).toBe(2);
  expect(mid[0]!.str("text")).toContain("permissions instructions");
  expect(mid[1]!.str("text")).toBe("Wait, also check this");
  expect(contents[2]!.exists("parts.0.functionResponse")).toBe(true);
});

test("TestConvertOpenAIResponsesRequestToGeminiCleansToolSchemaRequiredFields", () => {
  const output = convert(
    `{"model":"gemini-2.0-flash","input":"hi","tools":[{"type":"function","name":"search_company","description":"Search","parameters":{"type":"object","title":"SearchCompany","properties":{"country":{"type":"string"},"industry":{"type":"string"}},"required":["country","industry","stale_field","another_stale"]}}]}`,
    "gemini-2.0-flash",
  );
  const schema = g(output, "tools.0.functionDeclarations.0.parametersJsonSchema");
  expect(schema.exists()).toBe(true);
  expect(schema.exists("title")).toBe(false);
  expect(schema.arr("required").map((r) => r.str())).toEqual(["country", "industry"]);
});

test("TestConvertOpenAIResponsesRequestToGemini_FunctionCallOutputWithImages", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[
			{"role":"user","content":[{"type":"input_text","text":"Below is the image from tool. Reply IMAGE_SEEN."}]},
			{"type":"function_call","id":"fc_test","call_id":"call_test","name":"read","arguments":"{}"},
			{"type":"function_call_output","call_id":"call_test","output":[{"type":"input_text","text":"Read image file [image/png]"},{"type":"input_image","detail":"auto","image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="}]}]}`,
    "gemini-3.7-flash-high",
  );
  const userContent = g(output, "contents.2");
  expect(userContent.str("role")).toBe("user");
  const parts = userContent.arr("parts");
  expect(parts.length).toBe(1);
  const fr = parts[0]!.get("functionResponse");
  expect([fr.str("name"), fr.str("id"), fr.str("response.result")]).toEqual(["read", "call_test", "Read image file [image/png]"]);
  expect([fr.str("parts.0.inlineData.mimeType"), fr.str("parts.0.inlineData.data")]).toEqual(["image/png", "iVBORw0KGgoAAAANSUhEUg=="]);
});

function functionOutputRequest(name: string, output: string): string {
  return `{"model":"gemini-3.7-flash-high","input":[{"type":"function_call","call_id":"call_1","name":"${name}","arguments":"{}"},{"type":"function_call_output","call_id":"call_1","output":${output}}]}`;
}

describe("TestConvertOpenAIResponsesRequestToGemini_FunctionCallOutputVariations", () => {
  const firstPart = (output: string): J => {
    const parts = g(output, "contents.1.parts").arr();
    expect(parts.length).toBe(1);
    return parts[0]!;
  };
  test("stringified JSON array with image", () => {
    const out = convert(
      functionOutputRequest("screenshot", `"[{\\"type\\":\\"input_text\\",\\"text\\":\\"done\\"},{\\"type\\":\\"input_image\\",\\"image_url\\":\\"data:image/jpeg;base64,/9j/4AAQSkZJRg==\\"}]"`),
      "gemini-3.7-flash-high",
    );
    expect(firstPart(out).str("functionResponse.response.result")).toBe(`[{"type":"input_text","text":"done"},{"type":"input_image","image_url":"data:image/jpeg;base64,/9j/4AAQSkZJRg=="}]`);
  });
  test("plain structured JSON array without images", () => {
    const part = firstPart(convert(functionOutputRequest("list_items", `[{"id": 1, "name": "first"}, {"id": 2, "name": "second"}]`), "gemini-3.7-flash-high"));
    const resultArr = part.arr("functionResponse.response.result");
    expect(resultArr.length).toBe(2);
    expect(resultArr[0]!.str("name")).toBe("first");
  });
  test("plain string output", () => {
    expect(firstPart(convert(functionOutputRequest("echo", `"plain string result"`), "gemini-3.7-flash-high")).str("functionResponse.response.result")).toBe("plain string result");
  });
  test("structured JSON object with image_url property not an image block", () => {
    const part = firstPart(convert(functionOutputRequest("get_hero", `{"ok": true, "caption": "hero", "image_url": "https://example.com/hero.png"}`), "gemini-3.7-flash-high"));
    expect(part.str("functionResponse.response.result.caption")).toBe("hero");
  });
  test("mixed array with text and non-image structured object", () => {
    const part = firstPart(convert(functionOutputRequest("query", `[{"type": "input_text", "text": "summary header"},{"id": 1, "status": "active"}]`), "gemini-3.7-flash-high"));
    const resultArr = part.arr("functionResponse.response.result");
    expect(resultArr.length).toBe(2);
    expect(resultArr[1]!.str("status")).toBe("active");
  });
  test("stringified single-element object array preserved as string", () => {
    expect(firstPart(convert(functionOutputRequest("lookup", `"[{\\"id\\":1}]"`), "gemini-3.7-flash-high")).str("functionResponse.response.result")).toBe(`[{"id":1}]`);
  });
  test("nested image_url object with detail", () => {
    const part = firstPart(
      convert(functionOutputRequest("photo", `[{"type": "input_image", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="}, "detail": "high"}]`), "gemini-3.7-flash-high"),
    );
    expect(part.exists("functionResponse")).toBe(true);
    expect(part.str("functionResponse.parts.0.inlineData.mimeType")).toBe("image/png");
    expect(part.str("functionResponse.parts.0.inlineData.data")).toBe("iVBORw0KGgoAAAANSUhEUg==");
  });
});

test("TestConvertOpenAIResponsesRequestToGemini_ParallelFunctionCallOutputsWithImages", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[
			{"role":"user","content":[{"type":"input_text","text":"read both images"}]},
			{"type":"function_call","id":"fc_a","call_id":"call_a","name":"read_a","arguments":"{}"},
			{"type":"function_call","id":"fc_b","call_id":"call_b","name":"read_b","arguments":"{}"},
			{"type":"function_call_output","call_id":"call_a","output":[{"type":"input_text","text":"file A"},{"type":"input_image","image_url":"data:image/png;base64,QUJD"}]},
			{"type":"function_call_output","call_id":"call_b","output":[{"type":"input_text","text":"file B"},{"type":"input_image","image_url":"data:image/jpeg;base64,REVm"}]}]}`,
    "gemini-3.7-flash-high",
  );
  const userContent = g(output, "contents.2");
  expect(userContent.str("role")).toBe("user");
  const parts = userContent.arr("parts");
  expect(parts.length).toBe(2);
  const byID = new Map(parts.map((p) => [p.str("functionResponse.id"), p.get("functionResponse")]));
  expect([byID.get("call_a")?.str("parts.0.inlineData.mimeType"), byID.get("call_a")?.str("parts.0.inlineData.data")]).toEqual(["image/png", "QUJD"]);
  expect([byID.get("call_b")?.str("parts.0.inlineData.mimeType"), byID.get("call_b")?.str("parts.0.inlineData.data")]).toEqual(["image/jpeg", "REVm"]);
});

test("TestConvertOpenAIResponsesRequestToGemini_FunctionCallOutputWithMultipleImages", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[
			{"role":"user","content":[{"type":"input_text","text":"show two screenshots"}]},
			{"type":"function_call","id":"fc_multi","call_id":"call_multi","name":"take_screenshots","arguments":"{}"},
			{"type":"function_call_output","call_id":"call_multi","output":[{"type":"input_text","text":"captured 2 images"},{"type":"input_image","image_url":"data:image/png;base64,QUJD"},{"type":"input_image","image_url":"data:image/jpeg;base64,REVm"}]}]}`,
    "gemini-3.7-flash-high",
  );
  const parts = g(output, "contents.2.parts").arr();
  expect(parts.length).toBe(1);
  const fr = parts[0]!.get("functionResponse");
  expect([fr.str("id"), fr.str("response.result")]).toEqual(["call_multi", "captured 2 images"]);
  expect(fr.arr("parts").map((p) => [p.str("inlineData.mimeType"), p.str("inlineData.data")])).toEqual([
    ["image/png", "QUJD"],
    ["image/jpeg", "REVm"],
  ]);
});

test("TestConvertOpenAIResponsesRequestToGemini_AdditionalToolsNamespaceAndCustom", () => {
  const output = convert(
    `{"model":"gemini-2.5-flash","input":[
			{"type":"additional_tools","role":"developer","tools":[{"type":"namespace","name":"functions","tools":[
				{"type":"custom","name":"exec","description":"Execute a command"},
				{"type":"function","name":"continuity_probe","description":"Return a continuity probe","parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}]}]},
			{"role":"user","content":[{"type":"input_text","text":"Run probe"}]}],
		"tool_choice":{"type":"function","name":"continuity_probe","namespace":"functions"}}`,
    "gemini-2.5-flash",
  );
  const decls = g(output, "tools.0.functionDeclarations").arr();
  expect(decls.length).toBe(2);
  expect(decls[0]!.str("name")).toBe("functions__exec");
  expect(decls[0]!.str("parametersJsonSchema.properties.input.type")).toBe("string");
  expect(decls[1]!.str("name")).toBe("functions__continuity_probe");
  expect(g(output, "toolConfig.functionCallingConfig.mode").str()).toBe("ANY");
  expect(g(output, "toolConfig.functionCallingConfig.allowedFunctionNames.0").str()).toBe("functions__continuity_probe");
});

test("TestConvertOpenAIResponsesRequestToGemini_ReplaysCustomToolCallAndOutput", () => {
  const output = convert(
    `{"model":"gemini-2.5-flash","input":[
			{"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]}]},
			{"type":"custom_tool_call","call_id":"call_1","name":"exec","namespace":"functions","input":"pwd"},
			{"type":"custom_tool_call_output","call_id":"call_1","output":"/workspace"}]}`,
    "gemini-2.5-flash",
  );
  const contents = g(output, "contents").arr();
  expect(contents.length).toBeGreaterThanOrEqual(2);
  expect(contents[0]!.str("parts.0.functionCall.name")).toBe("functions__exec");
  expect(contents[0]!.str("parts.0.functionCall.args.input")).toBe("pwd");
  expect(contents[1]!.str("parts.0.functionResponse.name")).toBe("functions__exec");
});

test("TestConvertOpenAIResponsesRequestToGemini_TwoTurnCustomToolRoundtripWithReasoning", () => {
  const output = convert(`{"model":"${M}","input":[
			{"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Run pwd"}]},
			{"type":"reasoning","encrypted_content":"${sig}","summary":[{"type":"summary_text","text":"executing pwd"}]},
			{"type":"custom_tool_call","call_id":"call_1","name":"exec","namespace":"functions","input":"pwd"},
			{"type":"custom_tool_call_output","call_id":"call_1","output":"/workspace"}]}`);
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  const modelParts = contents[1]!.arr("parts");
  expect(modelParts.length).toBe(2);
  expect([modelParts[0]!.bool("thought"), modelParts[0]!.str("text")]).toEqual([true, "executing pwd"]);
  expect(modelParts[1]!.str("functionCall.name")).toBe("functions__exec");
  expect(modelParts[1]!.str("thoughtSignature")).toBe(sig);
  const resp = contents[2]!.arr("parts");
  expect(resp.length).toBe(1);
  expect([resp[0]!.str("functionResponse.name"), resp[0]!.str("functionResponse.response.result")]).toEqual(["functions__exec", "/workspace"]);
});

function userResponses(output: string): J[] {
  return g(output, "contents")
    .arr()
    .filter((c) => c.str("role") === "user")
    .flatMap((c) => c.arr("parts"))
    .filter((p) => p.exists("functionResponse"))
    .map((p) => p.get("functionResponse"));
}

describe("TestConvertOpenAIResponsesRequestToGemini_FunctionCallOutputAlternateIDsAndQueueFallback", () => {
  for (const c of [
    { name: "call_id standard", field: `"call_id":"call_123"` },
    { name: "id alternate field", field: `"id":"call_123"` },
    { name: "tool_call_id alternate field", field: `"tool_call_id":"call_123"` },
    { name: "callId alternate field", field: `"callId":"call_123"` },
    { name: "missing call_id with name fallback to pending queue", field: `"name":"Bash"` },
    { name: "missing call_id completely fallback to pending queue", field: `` },
  ]) {
    test(c.name, () => {
      const outputItem = `{"type":"function_call_output","output":"result"${c.field !== "" ? "," + c.field : ""}}`;
      const output = convert(
        `{"model":"gemini-3.7-flash-high","input":[{"role":"user","content":"run bash"},{"type":"function_call","call_id":"call_123","name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"},${outputItem}]}`,
        "gemini-3.7-flash-high",
      );
      const contents = g(output, "contents").arr();
      expect(contents.length).toBe(3);
      const fr = contents[2]!.get("parts.0.functionResponse");
      expect(fr.exists()).toBe(true);
      expect([fr.str("id"), fr.str("name")]).toEqual(["call_123", "Bash"]);
      expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
    });
  }
});

test("TestConvertOpenAIResponsesRequestToGemini_ParallelFunctionCallOutputsAlternateIDs", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[{"role":"user","content":"run tools"},
			{"type":"function_call","call_id":"call-1","name":"tool_a","arguments":"{}"},
			{"type":"function_call","call_id":"call-2","name":"tool_b","arguments":"{}"},
			{"type":"function_call_output","tool_call_id":"call-2","output":"result_b"},
			{"type":"function_call_output","id":"call-1","output":"result_a"}]}`,
    "gemini-3.7-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  expect(contents[2]!.arr("parts").map((p) => [p.str("functionResponse.id"), p.str("functionResponse.name")])).toEqual([
    ["call-1", "tool_a"],
    ["call-2", "tool_b"],
  ]);
});

test("TestConvertOpenAIResponsesRequestToGemini_DedicatedCallIDTakesPrecedenceOverItemID", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[{"role":"user","content":"run tasks"},
			{"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
			{"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"},
			{"type":"function_call_output","id":"item_b","tool_call_id":"call_b","output":"content_b"},
			{"type":"function_call_output","id":"item_a","tool_call_id":"call_a","output":"content_a"}]}`,
    "gemini-3.7-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  expect(contents[2]!.arr("parts").map((p) => [p.str("functionResponse.id"), p.str("functionResponse.response.result")])).toEqual([
    ["call_a", "content_a"],
    ["call_b", "content_b"],
  ]);
});

test("TestConvertOpenAIResponsesRequestToGemini_ExplicitUnmatchedCallIDNotRebound", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[{"role":"user","content":"run bash"},{"type":"function_call","call_id":"call_1","name":"Bash","arguments":"{}"},{"type":"function_call_output","call_id":"call_other","output":"other_result"}]}`,
    "gemini-3.7-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  let unmatchedTextFound = false;
  for (const content of g(output, "contents").arr()) {
    for (const part of content.arr("parts")) {
      if (part.exists("functionResponse")) {
        expect(part.str("functionResponse.id")).not.toBe("call_other");
        expect(part.str("functionResponse.response.result")).not.toBe("other_result");
      }
      if (content.str("role") === "user" && part.str("text") === "other_result") unmatchedTextFound = true;
    }
  }
  expect(unmatchedTextFound).toBe(true);
});

test("TestConvertOpenAIResponsesRequestToGemini_MixedMissingAndExplicitParallelOutputsAcrossUserMessage", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]},
			{"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
			{"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"},
			{"type":"function_call_output","output":"result_b"},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"intervening"}]},
			{"type":"function_call_output","call_id":"call_a","output":"result_a"}]}`,
    "gemini-3.7-flash-high",
  );
  const results = new Map(userResponses(output).map((fr) => [fr.str("id"), fr.str("response.result")]));
  expect(results.get("call_a")).toBe("result_a");
  expect(results.get("call_b")).toBe("result_b");
});

test("TestConvertOpenAIResponsesRequestToGemini_AllPendingCallsReservedByFutureExplicitOutputsDoesNotDuplicate", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]},
			{"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
			{"type":"function_call_output","output":"result_1"},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]},
			{"type":"function_call_output","call_id":"call_a","output":"result_2"}]}`,
    "gemini-3.7-flash-high",
  );
  const responses = userResponses(output);
  const callA = responses.filter((fr) => fr.str("id") === "call_a");
  expect(callA.length).toBe(1);
  expect(callA[0]!.str("response.result")).toBe("result_2");
});

function expectResponse(fr: J, id: string, result: string): void {
  expect([fr.str("id"), fr.str("name"), fr.str("response.result")]).toEqual([id, "shell", result]);
}

const interrupted = "call interrupted, no output";

test("TestConvertOpenAIResponsesRequestToGemini_InterruptedFunctionCallPreservesPairing", () => {
  const result = convert(
    `{"model":"gemini-3.8-flash-high","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"List the files."}]},
			{"type":"function_call","call_id":"c1","name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Stop, do something else instead."}]},
			{"type":"function_call","call_id":"c2","name":"shell","arguments":"{\\"command\\":[\\"pwd\\"]}"},
			{"type":"function_call_output","call_id":"c2","output":"/tmp\\n"}]}`,
    "gemini-3.8-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(result)).toBeUndefined();
  expectResponse(g(result, "contents.2.parts.0.functionResponse"), "c1", interrupted);
  expectResponse(g(result, "contents.5.parts.0.functionResponse"), "c2", "/tmp\n");
});

test("TestConvertOpenAIResponsesRequestToGemini_ParallelInterruptedFunctionCallPreservesPairingAndOrder", () => {
  const result = convert(
    `{"model":"gemini-3.8-flash-high","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"List and print."}]},
			{"type":"function_call","call_id":"c1","name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"},
			{"type":"function_call","call_id":"c2","name":"shell","arguments":"{\\"command\\":[\\"pwd\\"]}"},
			{"type":"function_call_output","call_id":"c2","output":"/tmp\\n"},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Stop, do something else instead."}]},
			{"type":"function_call","call_id":"c3","name":"shell","arguments":"{\\"command\\":[\\"whoami\\"]}"},
			{"type":"function_call_output","call_id":"c3","output":"root\\n"}]}`,
    "gemini-3.8-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(result)).toBeUndefined();
  expectResponse(g(result, "contents.2.parts.0.functionResponse"), "c1", interrupted);
  expectResponse(g(result, "contents.2.parts.1.functionResponse"), "c2", "/tmp\n");
});

test("TestConvertOpenAIResponsesRequestToGemini_TrailingPartialParallelCallsPreservesPairingAndOrder", () => {
  const result = convert(
    `{"model":"gemini-3.8-flash-high","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"List and print."}]},
			{"type":"function_call","call_id":"c1","name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"},
			{"type":"function_call","call_id":"c2","name":"shell","arguments":"{\\"command\\":[\\"pwd\\"]}"},
			{"type":"function_call_output","call_id":"c2","output":"/tmp\\n"}]}`,
    "gemini-3.8-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(result)).toBeUndefined();
  expectResponse(g(result, "contents.2.parts.0.functionResponse"), "c1", interrupted);
  expectResponse(g(result, "contents.2.parts.1.functionResponse"), "c2", "/tmp\n");
});

test("TestConvertOpenAIResponsesRequestToGemini_InterruptedMessageBeforeRealOutputPreservesPairingAndOrder", () => {
  const result = convert(
    `{"model":"gemini-3.8-flash-high","input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"List and print."}]},
			{"type":"function_call","call_id":"c1","name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"},
			{"type":"function_call","call_id":"c2","name":"shell","arguments":"{\\"command\\":[\\"pwd\\"]}"},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"Stop, do something else instead."}]},
			{"type":"function_call_output","call_id":"c2","output":"/tmp\\n"}]}`,
    "gemini-3.8-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(result)).toBeUndefined();
  expect(g(result, "contents.2.parts.0.text").str()).toBe("Stop, do something else instead.");
  expectResponse(g(result, "contents.3.parts.0.functionResponse"), "c1", interrupted);
  expectResponse(g(result, "contents.3.parts.1.functionResponse"), "c2", "/tmp\n");
});

test("TestConvertOpenAIResponsesRequestToGemini_FunctionCallOutputWithFCOItemID", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[{"role":"user","content":"run command"},
			{"type":"function_call","call_id":"call_1788961125480214178_817","name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"},
			{"type":"function_call_output","id":"fco_01a08664-2d16-7a91-8ab2-2eccd49e4c3e","output":"/tmp"}]}`,
    "gemini-3.7-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(3);
  const responses = contents[2]!.arr("parts");
  expect(responses.length).toBe(1);
  expect([responses[0]!.str("functionResponse.id"), responses[0]!.str("functionResponse.name")]).toEqual(["call_1788961125480214178_817", "Bash"]);
});

function delegationScan(output: string): { delegationFound: boolean; bashCallID: string; bashResponseID: string; responseIDs: string[] } {
  let delegationFound = false;
  let bashCallID = "";
  let bashResponseID = "";
  const responseIDs: string[] = [];
  for (const content of g(output, "contents").arr()) {
    for (const part of content.arr("parts")) {
      if (part.exists("functionResponse")) {
        responseIDs.push(part.str("functionResponse.id"));
        if (part.str("functionResponse.name") === "Bash") bashResponseID = part.str("functionResponse.id");
      }
      if (part.str("functionCall.name") === "Bash") bashCallID = part.str("functionCall.id");
      if (content.str("role") === "user" && part.str("text").includes("<codex_delegation>")) delegationFound = true;
    }
  }
  return { delegationFound, bashCallID, bashResponseID, responseIDs };
}

test("TestConvertOpenAIResponsesRequestToGemini_OrphanFunctionCallOutputBecomesUserText", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[
			{"role":"user","content":[{"type":"input_text","text":"Task initialization"}]},
			{"type":"function_call_output","id":"fco_01a09fca-8d33-73a1-97fd-4d83ecc02f9d","name":"send_message_to_thread","output":"<codex_delegation>\\n  <source_thread_id>01a022d7-d4d0-72b2-8571-4590484ccaee</source_thread_id>\\n  <input>Execute sub-task</input>\\n</codex_delegation>"},
			{"type":"function_call","call_id":"call_1789387253098037589_85","name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"},
			{"type":"function_call_output","call_id":"call_1789387253098037589_85","id":"fco_01a09fca-a5f0-7b40-9943-21fbc923c537","output":"/Users/developer"}]}`,
    "gemini-3.7-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  const scan = delegationScan(output);
  expect(scan.responseIDs).not.toContain("");
  expect(scan.delegationFound).toBe(true);
  expect(scan.bashCallID).toBe("call_1789387253098037589_85");
  expect(scan.bashResponseID).toBe("call_1789387253098037589_85");
});

test("TestConvertOpenAIResponsesRequestToGemini_UnpairedExplicitCallIDBecomesUserText", () => {
  const output = convert(
    `{"model":"gemini-3.7-flash-high","input":[
			{"role":"user","content":[{"type":"input_text","text":"Task initialization"}]},
			{"type":"function_call_output","call_id":"call_missing","name":"send_message_to_thread","output":"<codex_delegation>Execute sub-task</codex_delegation>"},
			{"type":"function_call","call_id":"call_1789387253098037589_85","name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"},
			{"type":"function_call_output","call_id":"call_1789387253098037589_85","output":"/Users/developer"}]}`,
    "gemini-3.7-flash-high",
  );
  expect(validateGeminiFunctionCallPairing(output)).toBeUndefined();
  const scan = delegationScan(output);
  expect(scan.responseIDs).not.toContain("call_missing");
  expect(scan.delegationFound).toBe(true);
  expect(scan.bashResponseID).toBe("call_1789387253098037589_85");
});

test("TestConvertOpenAIResponsesRequestToGemini_ParametersJsonSchema_PreservesAdditionalPropertiesAndPattern_Issue5959", () => {
  const output = convert(
    `{"model":"gemini-2.5-flash","input":"hi","tools":[{"type":"function","name":"submit","description":"Submit a bounded schema test value.","parameters":{
				"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
				"properties":{"recipient":{"type":"string","pattern":"^(alice|bob)$"},"amount":{"type":"number"},
					"nested":{"type":"object","additionalProperties":false,"properties":{"tag":{"type":"string","pattern":"^[a-z]+$"}}}},
				"required":["recipient","amount"]}}]}`,
    "gemini-2.5-flash",
  );
  const schema = g(output, "tools.0.functionDeclarations.0.parametersJsonSchema");
  expect(schema.exists()).toBe(true);
  expect(schema.get("additionalProperties").v).toBe(false);
  expect(schema.str("properties.recipient.pattern")).toBe("^(alice|bob)$");
  expect(schema.get("properties.nested.additionalProperties").v).toBe(false);
  expect(schema.str("properties.nested.properties.tag.pattern")).toBe("^[a-z]+$");
  expect(schema.str("description")).not.toContain("No extra properties allowed");
  expect(schema.str("properties.recipient.description")).not.toContain("pattern:");
});

const userMsg = (...content: string[]): string => `{"model":"gemini-2.5-flash","input":[{"type":"message","role":"user","content":[${content.join(",")}]}]}`;

describe("TestConvertOpenAIResponsesRequestToGemini_AudioInput", () => {
  for (const c of [
    { name: "standard nested input_audio object", input: userMsg(`{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}`, `{"type":"input_text","text":"Transcribe this audio"}`), mime: "audio/wav", data: "UklGRg==" },
    { name: "flat input_audio fields", input: userMsg(`{"type":"input_audio","data":"SUQzBA==","format":"mp3"}`), mime: "audio/mpeg", data: "SUQzBA==" },
    { name: "audio_url data URI", input: userMsg(`{"type":"input_audio","audio_url":"data:audio/ogg;base64,T2dnUw=="}`), mime: "audio/ogg", data: "T2dnUw==" },
    { name: "top-level input item audio", input: `{"model":"gemini-2.5-flash","input":[{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}]}`, mime: "audio/wav", data: "UklGRg==" },
    { name: "nested audio alias object", input: userMsg(`{"type":"audio","audio":{"data":"SUQzBA==","format":"mp3"}}`), mime: "audio/mpeg", data: "SUQzBA==" },
    { name: "nested audio alias object with wav", input: userMsg(`{"type":"audio","audio":{"data":"UklGRg==","format":"wav"}}`), mime: "audio/wav", data: "UklGRg==" },
  ]) {
    test(c.name, () => {
      const output = convert(c.input, "gemini-2.5-flash");
      const contents = g(output, "contents").arr();
      expect(contents.length).toBeGreaterThan(0);
      const inline = contents[0]!.arr("parts").find((p) => p.exists("inline_data"));
      expect(inline).toBeDefined();
      expect([inline!.str("inline_data.mime_type"), inline!.str("inline_data.data")]).toEqual([c.mime, c.data]);
    });
  }
});

describe("TestConvertOpenAIResponsesRequestToGemini_VideoInput", () => {
  for (const c of [
    { name: "openresponses input_video with data URL string", input: userMsg(`{"type":"input_video","video_url":"data:video/mp4;base64,AAAAIGZ0eXBtcDQy"}`, `{"type":"input_text","text":"Describe the video"}`), mime: "video/mp4", data: "AAAAIGZ0eXBtcDQy" },
    { name: "openresponses input_video with video_url object", input: userMsg(`{"type":"input_video","video_url":{"url":"data:video/webm;base64,GkXfo59ChoEBQveBAULygQ8="}}`), mime: "video/webm", data: "GkXfo59ChoEBQveBAULygQ8=" },
    { name: "input_file with video filename", input: userMsg(`{"type":"input_file","filename":"sample.mp4","file_data":"AAAAIGZ0eXA="}`), mime: "video/mp4", data: "AAAAIGZ0eXA=" },
    { name: "top-level input item video and text combined", input: `{"model":"gemini-2.5-flash","input":[{"type":"input_text","text":"Check video"},{"type":"input_video","video_url":"data:video/mp4;base64,AAAAIGZ0eXA="}]}`, mime: "video/mp4", data: "AAAAIGZ0eXA=" },
    { name: "nested video object with format webm", input: userMsg(`{"type":"video","video":{"data":"GkXfo59ChoEBQveBAULygQ8=","format":"webm"}}`), mime: "video/webm", data: "GkXfo59ChoEBQveBAULygQ8=" },
  ]) {
    test(c.name, () => {
      const inline = allParts(convert(c.input, "gemini-2.5-flash")).find((p) => p.str("inline_data.mime_type") === c.mime);
      expect(inline).toBeDefined();
      expect(inline!.str("inline_data.data")).toBe(c.data);
    });
  }
});

test("TestConvertOpenAIResponsesRequestToGemini_TopLevelVideoAndTextCombined", () => {
  const output = convert(`{"model":"gemini-2.5-flash","input":[{"type":"input_text","text":"Check video"},{"type":"input_video","video_url":"data:video/mp4;base64,AAAAIGZ0eXA="}]}`, "gemini-2.5-flash");
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(1);
  expect(contents[0]!.str("role")).toBe("user");
  const parts = contents[0]!.arr("parts");
  expect(parts.length).toBe(2);
  expect(parts[0]!.str("text")).toBe("Check video");
  expect([parts[1]!.str("inline_data.mime_type"), parts[1]!.str("inline_data.data")]).toEqual(["video/mp4", "AAAAIGZ0eXA="]);
});

test("TestConvertOpenAIResponsesRequestToGemini_FallbackMIMEOnGenericDataURL", () => {
  const output = convert(
    userMsg(
      `{"type":"input_image","image_url":"data:;base64,AAAA","mime_type":"image/jpeg"}`,
      `{"type":"input_file","file_data":"data:;base64,BBBB","mime_type":"application/pdf"}`,
      `{"type":"input_image","image_url":"data:;base64,CCCC","filename":"photo.jpeg"}`,
      `{"type":"input_file","file_data":"data:;base64,DDDD","format":"pdf"}`,
      `{"type":"input_image","image_url":"data:;base64,EEEE","filename":"photo"}`,
      `{"type":"input_image","image_url":"data:;base64,FFFF","filename":"photo.unknownext"}`,
      `{"type":"input_image","image_url":"data:application/octet-stream;base64,GGGG","filename":"photo.jpeg"}`,
      `{"type":"input_image","image_url":"data:binary/octet-stream;base64,HHHH","filename":"photo.jpeg"}`,
      `{"type":"input_file","file_data":"QUJD","filename":"report.pdf","mime_type":"binary/octet-stream"}`,
    ),
    "gemini-2.5-flash",
  );
  const parts = g(output, "contents.0.parts").arr();
  expect(parts.length).toBeGreaterThanOrEqual(9);
  expect(parts.slice(0, 9).map((p) => p.str("inline_data.mime_type"))).toEqual([
    "image/jpeg",
    "application/pdf",
    "image/jpeg",
    "application/pdf",
    "image/png",
    "image/png",
    "image/jpeg",
    "image/jpeg",
    "application/pdf",
  ]);
});

test("TestConvertOpenAIResponsesRequestToGemini_RemoteURLDoesNotOverrideExplicitFormat", () => {
  const parts = g(
    convert(userMsg(`{"type":"input_audio","audio_url":"https://example.com/download.bin","format":"wav"}`, `{"type":"input_video","video_url":"https://example.com/stream.bin","format":"mp4"}`), "gemini-2.5-flash"),
    "contents.0.parts",
  ).arr();
  expect(parts.length).toBeGreaterThanOrEqual(2);
  expect([parts[0]!.str("file_data.mime_type"), parts[1]!.str("file_data.mime_type")]).toEqual(["audio/wav", "video/mp4"]);
});

test("TestConvertOpenAIResponsesRequestToGemini_UnknownExtensionFallsBackToDefaults", () => {
  const parts = g(
    convert(
      userMsg(
        `{"type":"input_audio","audio_url":"https://example.com/download.bin","mime_type":"application/octet-stream"}`,
        `{"type":"input_video","video_url":"https://example.com/download.bin","mime_type":"application/octet-stream"}`,
      ),
      "gemini-2.5-flash",
    ),
    "contents.0.parts",
  ).arr();
  expect(parts.slice(0, 2).map((p) => p.str("file_data.mime_type"))).toEqual(["audio/wav", "video/mp4"]);
});

test("TestConvertOpenAIResponsesRequestToGemini_InlineExplicitFormatNotOverriddenByFilename", () => {
  const parts = g(
    convert(userMsg(`{"type":"input_audio","data":"UklGRg==","format":"wav","filename":"download.bin"}`, `{"type":"input_video","data":"AAAAIGZ0eXA=","format":"mp4","filename":"download.bin"}`), "gemini-2.5-flash"),
    "contents.0.parts",
  ).arr();
  expect(parts.slice(0, 2).map((p) => p.str("inline_data.mime_type"))).toEqual(["audio/wav", "video/mp4"]);
});

test("TestConvertOpenAIResponsesRequestToGemini_RemoteNestedFormatNotOverriddenByFilename", () => {
  const parts = g(
    convert(
      userMsg(
        `{"type":"input_video","video_url":"https://example.com/download.bin","input_video":{"format":"mp4"}}`,
        `{"type":"input_audio","audio_url":"https://example.com/download.bin","input_audio":{"mime_type":"audio/wav"}}`,
        `{"type":"input_file","file_url":"https://example.com/download.bin","file":{"format":"pdf"}}`,
        `{"type":"input_file","file_url":"https://example.com/download.bin","file":{"format":"jpeg"}}`,
        `{"type":"input_image","image_url":"https://example.com/download.bin","image":{"format":"jpeg"}}`,
      ),
      "gemini-2.5-flash",
    ),
    "contents.0.parts",
  ).arr();
  expect(parts.slice(0, 5).map((p) => p.str("file_data.mime_type"))).toEqual(["video/mp4", "audio/wav", "application/pdf", "image/jpeg", "image/jpeg"]);
});

test("TestConvertOpenAIResponsesRequestToGemini_GenericMIMEWithNestedFormatNotOverriddenByFilename", () => {
  const parts = g(
    convert(
      userMsg(
        `{"type":"input_video","video_url":"https://example.com/download.bin","mime_type":"application/octet-stream","input_video":{"format":"mp4"}}`,
        `{"type":"input_audio","audio_url":"https://example.com/download.bin","mime_type":"binary/octet-stream","input_audio":{"format":"wav"}}`,
        `{"type":"input_file","file_url":"https://example.com/download.bin","mime_type":"application/octet-stream","file":{"format":"pdf"}}`,
      ),
      "gemini-2.5-flash",
    ),
    "contents.0.parts",
  ).arr();
  expect(parts.slice(0, 3).map((p) => p.str("file_data.mime_type"))).toEqual(["video/mp4", "audio/wav", "application/pdf"]);
});

test("TestConvertOpenAIResponsesRequestToGemini_RemoteMedia", () => {
  const parts = g(
    convert(
      userMsg(
        `{"type":"input_video","video_url":"https://example.com/stream.mp4"}`,
        `{"type":"input_audio","audio_url":"https://example.com/recording.wav"}`,
        `{"type":"input_image","image_url":"https://example.com/photo.jpeg"}`,
        `{"type":"input_image","image_url":"https://example.com/legacy.bin","format":"jpg"}`,
        `{"type":"input_video","video_url":"https://example.com/clip.webm","format":"binary/octet-stream"}`,
        `{"type":"input_audio","audio_url":"https://example.com/recording.mp3","mime_type":"application/octet-stream"}`,
      ),
      "gemini-2.5-flash",
    ),
    "contents.0.parts",
  ).arr();
  expect(parts.length).toBeGreaterThanOrEqual(6);
  const found = new Set(parts.filter((p) => p.exists("file_data")).map((p) => `${p.str("file_data.mime_type")} ${p.str("file_data.file_uri")}`));
  for (const want of [
    "video/mp4 https://example.com/stream.mp4",
    "audio/wav https://example.com/recording.wav",
    "image/jpeg https://example.com/photo.jpeg",
    "image/jpeg https://example.com/legacy.bin",
    "video/webm https://example.com/clip.webm",
    "audio/mpeg https://example.com/recording.mp3",
  ])
    expect(found.has(want)).toBe(true);
});

describe("TestConvertOpenAIResponsesRequestToGemini_InvalidDataURLsRejected", () => {
  for (const c of [
    { name: "empty base64 audio payload", part: `{"type":"input_audio","data":"data:audio/wav;base64,"}` },
    { name: "non-base64 data URL", part: `{"type":"input_video","video_url":"data:text/plain,hello"}` },
    { name: "corrupted base64 payload", part: `{"type":"input_audio","data":"data:audio/wav;base64,!!!"}` },
    { name: "uppercase DATA scheme with invalid payload", part: `{"type":"input_audio","data":"DATA:audio/wav,hello"}` },
    { name: "leading whitespace on data URL with corrupted base64", part: `{"type":"input_audio","data":" DATA:audio/wav;base64,!!!"}` },
    { name: "source base64 with invalid data URL", part: `{"type":"input_image","source":{"type":"base64","data":" DATA:image/png;base64,!!!"}}` },
  ]) {
    test(c.name, () => {
      // Go returned the body alongside the emptied-turn error; the TS transform throws instead.
      const [output] = toGeminiErr("gemini-2.5-flash", userMsg(c.part));
      for (const part of allParts(output)) expect(part.exists("inline_data")).toBe(false);
    });
  }
});

describe("TestConvertOpenAIResponsesRequestToGemini_FunctionResponseJSONRef", () => {
  const req = (name: string, output: string): string =>
    `{"model":"gemini-3.8-flash","input":[{"type":"function_call","call_id":"call_1","name":"${name}","arguments":"{}"},{"type":"function_call_output","call_id":"call_1","output":${output}}]}`;
  test("nested $ref object output is serialized as string result", () => {
    const result = g(
      convert(req("get_openapi_operation", `{"responses":{"400":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/ErrorModel"}}}}}}`), "gemini-3.8-flash"),
      "contents.1.parts.0.functionResponse.response.result",
    );
    expect(typeof result.v).toBe("string");
    expect(result.str()).toContain("#/components/schemas/ErrorModel");
  });
  test("array with nested $ref object is serialized as string result", () => {
    const result = g(convert(req("get_openapi_schemas", `[{"schema":{"$ref":"#/components/schemas/ErrorModel"}}]`), "gemini-3.8-flash"), "contents.1.parts.0.functionResponse.response.result");
    expect(typeof result.v).toBe("string");
    expect(result.str()).toContain("#/components/schemas/ErrorModel");
  });
  test("ordinary structured object without $ref remains raw JSON object", () => {
    const result = g(convert(req("get_weather", `{"temperature":72,"condition":"sunny"}`), "gemini-3.8-flash"), "contents.1.parts.0.functionResponse.response.result");
    expect(typeof result.v === "object" && !Array.isArray(result.v)).toBe(true);
    expect(result.int("temperature")).toBe(72);
  });
  test("array with $ref object and media block preserves inlineData and stringifies result", () => {
    const fr = g(
      convert(req("render_schema_diagram", `[{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="},{"schema":{"$ref":"#/components/schemas/ErrorModel"}}]`), "gemini-3.8-flash"),
      "contents.1.parts.0.functionResponse",
    );
    expect(fr.exists()).toBe(true);
    expect(fr.str("parts.0.inlineData.mimeType")).toBe("image/png");
    expect(typeof fr.get("response.result").v).toBe("string");
    expect(fr.str("response.result")).toContain("#/components/schemas/ErrorModel");
  });
});

test("TestConvertOpenAIResponsesRequestToGemini_UnsignedModelTextDoesNotSynthesizeBypassSignature", () => {
  const output = convert(
    `{"input":[{"type":"reasoning","encrypted_content":"","summary":[{"type":"summary_text","text":"my thinking process"}]},{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"my visible answer"}]}]}`,
    "gemini-3.8-flash",
  );
  const contents = g(output, "contents").arr();
  expect(contents.length).toBe(1);
  const parts = contents[0]!.arr("parts");
  expect(parts.length).toBe(2);
  expect([parts[0]!.bool("thought"), parts[0]!.str("text"), parts[0]!.exists("thoughtSignature")]).toEqual([true, "my thinking process", false]);
  expect([parts[1]!.bool("thought"), parts[1]!.str("text"), parts[1]!.exists("thoughtSignature")]).toEqual([false, "my visible answer", false]);
  const sanitized = sanitizeGeminiRequestThoughtSignatures(output, "contents");
  const sanitizedParts = g(sanitized, "contents.0.parts").arr();
  expect(sanitizedParts.length).toBe(2);
  expect(sanitizedParts[1]!.exists("thoughtSignature")).toBe(false);
});
