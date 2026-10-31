// Ported from: internal/translator/gemini/openai/responses/gemini_openai-responses_response_test.go
// Skipped cases: BenchmarkConvertGeminiResponseToOpenAIResponses_TextDelta (benchmark, not a test)
import { describe, expect, test } from "bun:test";
import { GeminiToResponsesState } from "../../../../../src/translator/gemini/openai/responses/response.ts";
import {
  decodeGeminiResponsesCarrier,
  geminiResponsesCarrierFunction,
  geminiResponsesCarrierPrefix,
  geminiResponsesCarrierPrevious,
} from "../../../../../src/translator/gemini/openai/responses/signature_carrier.ts";
import type { TranslatorState } from "../../../../../src/translator/types.ts";
import {
  completedOutput,
  decodedResponsesCarrierSignature as dec,
  differentResponsesGeminiThoughtSignature,
  g,
  J,
  nonStream,
  parseSSEEvent,
  streamChunk,
  streamEvents,
  testResponsesGeminiThoughtSignature as sig,
  toGemini,
} from "./helpers.ts";

const M = "gemini-3.6-flash-high";
type Ev = { event: string; data: J };

/** Streams lines through a fresh state with model M and no request. */
function run(lines: string[], model = M, original = "", state: TranslatorState = {}): Ev[] {
  return streamEvents(model, original, "", lines, state);
}

/** Replays a completed output array as Responses input (optionally with extra items). */
function replay(output: J, ...extra: string[]): string {
  const items = [...(output.v as unknown[]), ...extra.map((e) => JSON.parse(e) as unknown)];
  return toGemini(M, JSON.stringify({ model: M, input: items }));
}

function parts(translated: string, path = "contents.0.parts"): J[] {
  return g(translated, path).arr();
}

function allParts(translated: string): J[] {
  return g(translated, "contents").arr().flatMap((c) => c.arr("parts"));
}

describe("TestConvertGeminiResponseToOpenAIResponses_VertexStreamingPartialArgs", () => {
  test("single call", () => {
    const chunks = [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"New ","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_1"}`,
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"partialArgs":[{"jsonPath":"$.city","stringValue":"York"}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_1"}`,
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_1"}`,
    ];
    const state: TranslatorState = {};
    const deltas: string[] = [];
    let doneArgs = "";
    let itemArgs = "";
    let doneInChunk = -1;
    chunks.forEach((line, chunkIdx) => {
      for (const { event, data } of streamChunk("gemini-2.5-pro", "", "", line, state).map(parseSSEEvent)) {
        if (event === "response.function_call_arguments.delta") deltas.push(data.str("delta"));
        if (event === "response.function_call_arguments.done") {
          doneInChunk = chunkIdx;
          doneArgs = data.str("arguments");
        }
        if (event === "response.output_item.done" && data.str("item.type") === "function_call") itemArgs = data.str("item.arguments");
      }
    });
    expect(doneInChunk).toBe(2);
    expect(deltas.join("")).toBe(`{"city":"New York"}`);
    expect(doneArgs).toBe(`{"city":"New York"}`);
    expect(itemArgs).toBe(`{"city":"New York"}`);
  });

  test("multiple same-name calls, complex paths, and thought signature", () => {
    const lines = [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"sig_before","functionCall":{"name":"query_db","partialArgs":[{"jsonPath":"$.filter.tags[0]","stringValue":"go","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_2"}`,
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"partialArgs":[{"jsonPath":"$.filter.tags[0]","stringValue":"lang"},{"jsonPath":"$.filter.tags[1]","stringValue":"ai"},{"jsonPath":"$.limit","numberValue":0},{"jsonPath":"$.strict","boolValue":false},{"jsonPath":"$.cursor","nullValue":null}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_2"}`,
      `data: {"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"sig_after","functionCall":{}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_2"}`,
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"query_db","partialArgs":[{"jsonPath":"$.filter.tags[0]","stringValue":"rust"}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_2"}`,
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_2"}`,
    ];
    const deltasByOutput = new Map<number, string>();
    const doneByOutput = new Map<number, string>();
    const funcCallIDs: string[] = [];
    let reasoningCount = 0;
    let sawCompleted = false;
    for (const { event, data } of run(lines, "gemini-2.5-pro")) {
      if (event === "response.output_item.added" && data.str("item.type") === "function_call") funcCallIDs.push(data.str("item.call_id"));
      if (event === "response.function_call_arguments.delta") deltasByOutput.set(data.int("output_index"), (deltasByOutput.get(data.int("output_index")) ?? "") + data.str("delta"));
      if (event === "response.function_call_arguments.done") doneByOutput.set(data.int("output_index"), data.str("arguments"));
      if (event === "response.output_item.done" && data.str("item.type") === "reasoning") reasoningCount++;
      if (event === "response.completed") sawCompleted = true;
    }
    expect(funcCallIDs.length).toBe(2);
    expect(funcCallIDs[0]).not.toBe(funcCallIDs[1]);
    expect(reasoningCount).toBe(2);
    expect(sawCompleted).toBe(true);
    for (const [idx, want] of [
      [1, `{"filter":{"tags":["golang","ai"]},"limit":0,"strict":false,"cursor":null}`],
      [3, `{"filter":{"tags":["rust"]}}`],
    ] as const) {
      expect(doneByOutput.get(idx)).toBe(want);
      expect(deltasByOutput.get(idx)).toBe(want);
    }
  });

  test("single-chunk willContinue false parameterless call and empty partialArgs with complete args", () => {
    const ping = run([
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"ping","willContinue":false}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7},"modelVersion":"gemini-2.5-pro","responseId":"resp_ping"}`,
    ], "gemini-2.5-pro");
    expect(ping.find((e) => e.event === "response.function_call_arguments.done")?.data.str("arguments")).toBe("{}");
    const args = run([
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"},"partialArgs":[]}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7},"modelVersion":"gemini-2.5-pro","responseId":"resp_args"}`,
    ], "gemini-2.5-pro");
    expect(args.find((e) => e.event === "response.function_call_arguments.done")?.data.str("arguments")).toBe(`{"city":"Paris"}`);
  });

  test("continuation chunk repeating tool name without id continues active call", () => {
    const evs = run(
      [
        `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"New ","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_repeat_name"}`,
        `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"York"}],"willContinue":false}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp_repeat_name"}`,
      ],
      "gemini-2.5-pro",
    );
    expect(evs.filter((e) => e.event === "response.function_call_arguments.done").pop()?.data.str("arguments")).toBe(`{"city":"New York"}`);
    expect(evs.some((e) => e.event === "response.completed")).toBe(true);
  });

  test("replaced unfinished call does not fabricate done or completed", () => {
    const evs = run(
      [
        `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_a","name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"New ","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_replace"}`,
        `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_b","name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"LA"}],"willContinue":false}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_replace"}`,
        "[DONE]",
      ],
      "gemini-2.5-pro",
    );
    for (const { event, data } of evs) {
      expect(event).not.toBe("response.completed");
      if (event === "response.function_call_arguments.done") expect(data.str("item_id")).not.toBe("fc_call_a");
    }
  });

  test("interrupted stream does not fabricate done or completed", () => {
    const evs = run(
      [
        `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"New ","willContinue":true}],"willContinue":true}}]}}],"modelVersion":"gemini-2.5-pro","responseId":"resp_partial_trunc"}`,
        "[DONE]",
      ],
      "gemini-2.5-pro",
    );
    for (const { event } of evs) expect(["response.function_call_arguments.done", "response.completed"]).not.toContain(event);
  });
});

test("TestConvertGeminiResponseToOpenAIResponsesOutputTokensIncludeThoughts", () => {
  const evs = run(
    [`data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":16,"candidatesTokenCount":5,"thoughtsTokenCount":42,"totalTokenCount":63},"modelVersion":"gemini-3.6-flash","responseId":"resp_usage"}`],
    "model",
  );
  const completed = evs.find((e) => e.event === "response.completed")!.data;
  expect(completed.exists("response.usage.output_tokens")).toBe(true);
  expect(completed.int("response.usage.output_tokens")).toBe(47);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStreamOutputTokensIncludeThoughts", () => {
  const result = nonStream("model", "", "", `{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":16,"thoughtsTokenCount":42,"totalTokenCount":58},"modelVersion":"gemini-3.6-flash","responseId":"resp_usage"}`);
  expect(g(result, "usage.output_tokens").exists()).toBe(true);
  expect(g(result, "usage.output_tokens").int()).toBe(42);
});

test("TestConvertGeminiResponseToOpenAIResponses_UnwrapAndAggregateText", () => {
  const usage = `"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2,"cachedContentTokenCount":0}`;
  const wrap = (partsJSON: string, extra = "", u = usage): string =>
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[${partsJSON}]}${extra}}],${u},"modelVersion":"test-model","responseId":"req_vrtx_1"},"traceId":"t1"}`;
  const lines = [
    wrap(`{"text":""}`),
    wrap(`{"text":"让"}`),
    wrap(`{"text":"我先"}`),
    wrap(`{"text":"了解"}`),
    wrap(`{"functionCall":{"name":"mcp__serena__list_dir","args":{"recursive":false,"relative_path":"internal"},"id":"toolu_1"}}`),
    wrap(`{"text":""}`, `,"finishReason":"STOP"`, `"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15,"cachedContentTokenCount":2}`),
  ];
  const evs = run(lines, "test-model", `{"instructions":"test instructions","model":"gpt-5","max_output_tokens":123}`);
  let textDone = "";
  let messageText = "";
  let funcName = "";
  let funcArgs = "";
  let posTextDone = -1;
  let posPartDone = -1;
  let posMessageDone = -1;
  let posFuncAdded = -1;
  let created = "";
  let inProgress = "";
  let completed: J | undefined;
  evs.forEach(({ event, data }, i) => {
    if (event === "response.output_text.done") {
      if (posTextDone === -1) posTextDone = i;
      textDone = data.str("text");
    }
    if (event === "response.content_part.done" && posPartDone === -1) posPartDone = i;
    if (event === "response.output_item.done" && data.str("item.type") === "message") {
      if (posMessageDone === -1) posMessageDone = i;
      messageText = data.str("item.content.0.text");
    }
    if (event === "response.output_item.done" && data.str("item.type") === "function_call") {
      funcName = data.str("item.name");
      funcArgs = data.str("item.arguments");
    }
    if (event === "response.output_item.added" && data.str("item.type") === "function_call" && posFuncAdded === -1) posFuncAdded = i;
    if (event === "response.created") created = data.str("response.model");
    if (event === "response.in_progress") inProgress = data.str("response.model");
    if (event === "response.completed") completed = data;
  });
  expect(posTextDone).toBeGreaterThan(-1);
  expect(posTextDone < posPartDone && posPartDone < posMessageDone && posMessageDone < posFuncAdded).toBe(true);
  expect(completed).toBeDefined();
  expect(textDone).toBe("让我先了解");
  expect(messageText).toBe("让我先了解");
  expect(completed!.str("response.id")).toBe("resp_req_vrtx_1");
  expect(created).toBe("gpt-5");
  expect(inProgress).toBe("gpt-5");
  expect(completed!.str("response.instructions")).toBe("test instructions");
  expect(completed!.int("response.usage.input_tokens_details.cached_tokens")).toBe(2);
  expect(funcName).toBe("mcp__serena__list_dir");
  const args = J.parse(funcArgs);
  expect(args.exists()).toBe(true);
  expect(args.bool("recursive")).toBe(false);
  expect(args.str("relative_path")).toBe("internal");
});

test("TestConvertGeminiResponseToOpenAIResponses_ConsecutiveSignedVisibleTextPreservesEverySignature", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"a"}]}}],"modelVersion":"gemini-3.6-flash","responseId":"signed-text"}}`,
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"b","thoughtSignature":"${sig}"}]}}],"modelVersion":"gemini-3.6-flash","responseId":"signed-text"}}`,
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"c","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.6-flash","responseId":"signed-text"}}`,
    `data: [DONE]`,
  ]);
  expect(evs.filter((e) => e.data.str("item.type") === "reasoning").length).toBe(0);
  const visible = parts(replay(completedOutput(evs))).filter((p) => !p.bool("thought") && p.str("text") !== "");
  expect(visible.map((p) => [p.str("text"), p.str("thoughtSignature")])).toEqual([
    ["ab", sig],
    ["c", signature2],
  ]);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_ConsecutiveSignedVisibleTextPreservesEverySignature", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b","thoughtSignature":"${sig}"},{"text":"c","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"signed-text-nonstream"}`);
  const output = g(out, "output");
  expect(dec(output.str("0.encrypted_content"))).toBe(sig);
  expect(output.str("1.content.0.text")).toBe("ab");
  expect(dec(output.str("2.encrypted_content"))).toBe(signature2);
  expect(output.str("3.content.0.text")).toBe("c");
  const items = output.v as Record<string, unknown>[];
  delete items[0]!.id;
  delete items[2]!.id;
  const visible = parts(replay(new J(items))).filter((p) => !p.bool("thought") && p.str("text") !== "");
  expect(visible.map((p) => p.str("thoughtSignature"))).toEqual([sig, signature2]);
});

test("TestConvertGeminiResponseToOpenAIResponses_SignedVisibleThenUnsignedPreservesBoundary", () => {
  const completed = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"signed","thoughtSignature":"${sig}"}]}}],"responseId":"signed-then-unsigned"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"unsigned"}]},"finishReason":"STOP"}],"responseId":"signed-then-unsigned"}}`,
      `data: [DONE]`,
    ]),
  );
  const translated = replay(completed);
  expect(parts(translated).map((p) => [p.str("text"), p.str("thoughtSignature")])).toEqual([
    ["signed", sig],
    ["unsigned", ""],
  ]);
  expect(completed.raw).not.toContain(geminiResponsesCarrierPrefix);
  expect(translated).not.toContain(geminiResponsesCarrierPrefix);
});

test("TestConvertGeminiResponseToOpenAIResponses_LeadingCarrierDoesNotCrossSignedThought", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const streamOutput = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${sig}"}]}}],"responseId":"leading-before-signed-thought"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"reason","thought":true,"thoughtSignature":"${signature2}"}]}}],"responseId":"leading-before-signed-thought"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"responseId":"leading-before-signed-thought"}}`,
      `data: [DONE]`,
    ]),
  );
  const ns = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${sig}"},{"text":"reason","thought":true,"thoughtSignature":"${signature2}"},{"text":"answer"}]},"finishReason":"STOP"}],"responseId":"leading-before-signed-thought-nonstream"}`);
  for (const output of [streamOutput, g(ns, "output")]) {
    const p = parts(replay(output));
    expect(p.length).toBe(3);
    expect(p[0]!.exists("text")).toBe(true);
    expect([p[0]!.str("text"), p[0]!.str("thoughtSignature")]).toEqual(["", sig]);
    expect([p[1]!.str("text"), p[1]!.bool("thought"), p[1]!.str("thoughtSignature")]).toEqual(["reason", true, signature2]);
    expect([p[2]!.str("text"), p[2]!.str("thoughtSignature")]).toEqual(["answer", ""]);
  }
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_SignedVisibleThenUnsignedPreservesBoundary", () => {
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"signed","thoughtSignature":"${sig}"},{"text":"unsigned"}]},"finishReason":"STOP"}],"responseId":"signed-then-unsigned-nonstream"}`);
  expect(parts(replay(g(out, "output"))).map((p) => [p.str("text"), p.str("thoughtSignature")])).toEqual([
    ["signed", sig],
    ["unsigned", ""],
  ]);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_TrailingCarrierDirectionDoesNotDependOnID", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"${sig}"},{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"trailing-direction-nonstream"}`);
  const p = parts(replay(g(out, "output")));
  expect(p.length).toBe(2);
  expect([p[0]!.str("text"), p[0]!.str("thoughtSignature")]).toEqual(["answer", sig]);
  expect(p[1]!.exists("text")).toBe(true);
  expect([p[1]!.str("text"), p[1]!.str("thoughtSignature")]).toEqual(["", signature2]);
});

test("TestConvertGeminiResponseToOpenAIResponses_CachedTrailingCarrierPreservesDirection", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const completed = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"${sig}"}]}}],"responseId":"trailing-direction-stream"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"trailing-direction-stream"}}`,
      `data: [DONE]`,
    ]),
  );
  const translated = replay(completed);
  const p = parts(translated);
  expect(p.length).toBe(2);
  expect([p[0]!.str("text"), p[0]!.str("thoughtSignature")]).toEqual(["answer", sig]);
  expect(p[1]!.exists("text")).toBe(true);
  expect([p[1]!.str("text"), p[1]!.str("thoughtSignature")]).toEqual(["", signature2]);
  expect(completed.raw).not.toContain(geminiResponsesCarrierPrefix);
  expect(translated).not.toContain(geminiResponsesCarrierPrefix);
});

function reasoningSignatures(evs: Ev[]): { added: Map<string, string>; done: Map<string, string> } {
  const added = new Map<string, string>();
  const done = new Map<string, string>();
  for (const { event, data } of evs) {
    if (data.str("item.type") !== "reasoning") continue;
    if (event === "response.output_item.added") added.set(data.str("item.id"), data.str("item.encrypted_content"));
    if (event === "response.output_item.done") done.set(data.str("item.id"), data.str("item.encrypted_content"));
  }
  return { added, done };
}

test("TestConvertGeminiResponseToOpenAIResponses_VisibleSignatureDoesNotOverwriteSignedThought", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"one","thought":true,"thoughtSignature":"${sig}"}]}}],"responseId":"signed-thought-visible"}}`,
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"signed-thought-visible"}}`,
    `data: [DONE]`,
  ]);
  const { added, done } = reasoningSignatures(evs);
  for (const [id, s] of added) expect(done.get(id)).toBe(s);
  const completed = completedOutput(evs);
  expect(completed.arr().length).toBe(2);
  expect(dec(completed.str("0.encrypted_content"))).toBe(sig);
  expect(completed.str("1.type")).toBe("message");
  const p = parts(replay(completed));
  const signatures = p.map((x) => x.str("thoughtSignature")).filter((s) => s !== "");
  expect(signatures.length).toBe(2);
  expect(p.find((x) => x.str("text") === "answer")?.str("thoughtSignature")).toBe(signature2);
});

test("TestConvertGeminiResponseToOpenAIResponses_FlushesVisibleSignatureBeforeLaterThought", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const signature3 = "third-distinct-gemini-signature-123456";
  const completed = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"thought-a","thought":true,"thoughtSignature":"${sig}"}]}}],"responseId":"visible-before-thought"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"${signature2}"}]}}],"responseId":"visible-before-thought"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"thought-c","thought":true,"thoughtSignature":"${signature3}"}]},"finishReason":"STOP"}],"responseId":"visible-before-thought"}}`,
      `data: [DONE]`,
    ]),
  );
  expect(completed.arr().length).toBe(3);
  expect(dec(completed.str("0.encrypted_content"))).toBe(sig);
  expect(completed.str("1.type")).toBe("message");
  expect(dec(completed.str("2.encrypted_content"))).toBe(signature3);
  const translated = toGemini(M, `{"input":${completed.raw}}`);
  expect(g(translated, "contents.0.parts.1.text").str()).toBe("answer");
  expect(g(translated, "contents.0.parts.1.thoughtSignature").str()).toBe(signature2);
  expect(g(translated, "contents.0.parts.2.text").str()).toBe("thought-c");
});

test("TestConvertGeminiResponseToOpenAIResponses_FunctionAndTrailingSignaturesRoundTrip", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const completed = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"parts":[{"thoughtSignature":"${sig}","functionCall":{"name":"run_command","args":{"command":"true"}}}]}}],"responseId":"function-trailing"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"function-trailing"}}`,
      `data: [DONE]`,
    ]),
  );
  const signatures = allParts(replay(completed))
    .map((p) => p.str("thoughtSignature"))
    .filter((s) => s !== "");
  expect(signatures).toEqual([sig, signature2]);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_FunctionAndTrailingSignaturesPreserveOrder", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"thoughtSignature":"${sig}","functionCall":{"name":"run_command","args":{"command":"true"}}},{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"function-trailing-nonstream"}`);
  expect(dec(g(out, "output.0.encrypted_content").str())).toBe(sig);
  expect(g(out, "output.1.type").str()).toBe("function_call");
  expect(dec(g(out, "output.2.encrypted_content").str())).toBe(signature2);
});

test("TestConvertGeminiResponseToOpenAIResponses_FunctionThenTrailingSignatureHasStreamParity", () => {
  const raw = `{"candidates":[{"content":{"parts":[{"text":"preamble"},{"functionCall":{"name":"run_command","args":{"command":"true"}}},{"text":"","thoughtSignature":"${sig}"}]},"finishReason":"STOP"}],"responseId":"function-trailing-parity"}`;
  const streamOutput = completedOutput(run(["data: " + raw, "[DONE]"]));
  const nonStreamOutput = g(nonStream(M, "", "", raw), "output");
  for (const output of [streamOutput, nonStreamOutput]) {
    const items = output.arr();
    expect(items.map((i) => i.str("type"))).toEqual(["message", "function_call", "reasoning"]);
    const decoded = decodeGeminiResponsesCarrier(items[2]!.str("encrypted_content"));
    expect(decoded).toEqual({ signature: sig, direction: geminiResponsesCarrierPrevious, targetKind: geminiResponsesCarrierFunction, marked: true, ok: true });
    const p = parts(replay(output));
    expect(p.length).toBe(2);
    expect(p[0]!.str("text")).toBe("preamble");
    expect(p[1]!.str("functionCall.name")).toBe("run_command");
    expect(p[1]!.str("thoughtSignature")).toBe(sig);
  }
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_TrailingSignatureFollowsPendingReasoning", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"thought","thought":true,"thoughtSignature":"${sig}"},{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"reasoning-trailing-nonstream"}`);
  expect(dec(g(out, "output.0.encrypted_content").str())).toBe(sig);
  expect(dec(g(out, "output.1.encrypted_content").str())).toBe(signature2);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_UnsignedThoughtDoesNotStealFunctionSignature", () => {
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"thoughtSignature":"${sig}","functionCall":{"name":"run_command","args":{"command":"true"}}},{"text":"later thought","thought":true}]},"finishReason":"STOP"}],"responseId":"function-unsigned-thought"}`);
  expect(dec(g(out, "output.0.encrypted_content").str())).toBe(sig);
  expect(g(out, "output.1.type").str()).toBe("function_call");
  expect(g(out, "output.2.summary.0.text").str()).toBe("later thought");
  expect(g(out, "output.2.encrypted_content").str()).toBe("");
});

test("TestConvertGeminiResponseToOpenAIResponses_InterleavedThoughtAndTextPreservesOrder", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"thought-a","thought":true,"thoughtSignature":"${sig}"},{"text":"answer-a"},{"text":"thought-b","thought":true,"thoughtSignature":"${signature2}"},{"text":"answer-b"}]},"finishReason":"STOP"}],"responseId":"interleaved"}}`,
    "[DONE]",
  ]);
  expect(evs.filter((e) => e.event === "response.output_item.done").map((e) => e.data.str("item.type"))).toEqual(["reasoning", "message", "reasoning", "message"]);
  const completed = completedOutput(evs);
  expect([completed.str("0.summary.0.text"), completed.str("1.content.0.text"), completed.str("2.summary.0.text"), completed.str("3.content.0.text")]).toEqual([
    "thought-a",
    "answer-a",
    "thought-b",
    "answer-b",
  ]);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_InterleavedThoughtAndTextPreservesOrder", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"thought-a","thought":true,"thoughtSignature":"${sig}"},{"text":"answer-a"},{"text":"thought-b","thought":true,"thoughtSignature":"${signature2}"},{"text":"answer-b"}]},"finishReason":"STOP"}],"responseId":"interleaved-nonstream"}`);
  expect(g(out, "output").arr().map((i) => i.str("type"))).toEqual(["reasoning", "message", "reasoning", "message"]);
});

test("TestConvertGeminiResponseToOpenAIResponses_LeadingEmptyAndSignedTextRoundTripInOrder", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const completed = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${sig}"}]}}],"responseId":"leading-empty-signed-text"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"leading-empty-signed-text"}}`,
      `data: [DONE]`,
    ]),
  );
  const p = parts(replay(completed));
  const signatures = p.map((x) => x.str("thoughtSignature")).filter((s) => s !== "");
  expect(signatures.length).toBe(2);
  expect(signatures[0]).toBe(sig);
  expect(p.find((x) => x.str("text") === "answer")?.str("thoughtSignature")).toBe(signature2);
});

test("TestConvertGeminiResponseToOpenAIResponses_SignedTextAndTrailingSignatureRoundTripInOrder", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const completed = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"${sig}"}]}}],"responseId":"signed-text-trailing"}}`,
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"signed-text-trailing"}}`,
      `data: [DONE]`,
    ]),
  );
  expect(completed.arr().length).toBe(1);
  expect(completed.str("0.type")).toBe("message");
  expect(
    parts(replay(completed))
      .map((p) => p.str("thoughtSignature"))
      .filter((s) => s !== ""),
  ).toEqual([sig, signature2]);
});

test("TestConvertGeminiResponseToOpenAIResponses_PreservesMultipleLeadingEmptySignatures", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const completed = completedOutput(
    run([`data: {"response":{"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"${sig}"},{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"leading-empty-signatures"}}`, "[DONE]"]),
  );
  expect(dec(completed.str("0.encrypted_content"))).toBe(sig);
  expect(dec(completed.str("1.encrypted_content"))).toBe(signature2);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_SignedTextAndTrailingSignatureRoundTripInOrder", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"${sig}"},{"text":"","thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"signed-text-trailing-nonstream"}`);
  expect(dec(g(out, "output.0.encrypted_content").str())).toBe(sig);
  expect(g(out, "output.1.type").str()).toBe("message");
  expect(dec(g(out, "output.2.encrypted_content").str())).toBe(signature2);
});

test("TestConvertGeminiResponseToOpenAIResponses_DistinctSignedThoughtsUseDistinctItems", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"one","thought":true,"thoughtSignature":"${sig}"}]}}],"modelVersion":"gemini-3.6-flash","responseId":"signed-thoughts"}}`,
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"two","thought":true,"thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.6-flash","responseId":"signed-thoughts"}}`,
    `data: [DONE]`,
  ]);
  const { added, done } = reasoningSignatures(evs);
  expect([added.size, done.size]).toEqual([2, 2]);
  for (const [id, s] of added) expect(done.get(id)).toBe(s);
  const completed = completedOutput(evs);
  expect(dec(completed.str("0.encrypted_content"))).toBe(sig);
  expect(dec(completed.str("1.encrypted_content"))).toBe(signature2);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_DistinctSignedThoughtsUseDistinctItems", () => {
  const signature2 = differentResponsesGeminiThoughtSignature();
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"one","thought":true,"thoughtSignature":"${sig}"},{"text":"two","thought":true,"thoughtSignature":"${signature2}"}]},"finishReason":"STOP"}],"responseId":"signed-thoughts-nonstream"}`);
  expect(g(out, "output").arr().length).toBe(2);
  expect(dec(g(out, "output.0.encrypted_content").str())).toBe(sig);
  expect(dec(g(out, "output.1.encrypted_content").str())).toBe(signature2);
});

test("TestConvertGeminiResponseToOpenAIResponses_VisibleSignatureCompletesActiveReasoning", () => {
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hidden thought","thought":true}]}}],"modelVersion":"gemini-3.6-flash","responseId":"resp_active_reasoning"}}`,
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"visible answer","thoughtSignature":"${sig}"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3,"totalTokenCount":15},"modelVersion":"gemini-3.6-flash","responseId":"resp_active_reasoning"}}`,
  ]);
  expect(evs.filter((e) => e.event === "response.output_item.done").map((e) => e.data.str("item.type"))).toEqual(["reasoning", "message"]);
  const { added, done } = reasoningSignatures(evs);
  expect(added.size).toBe(1);
  const [id, addedSignature] = [...added][0]!;
  expect(done.get(id)).toBe(addedSignature);
  expect(dec(addedSignature)).toBe(sig);
});

test("TestConvertGeminiResponseToOpenAIResponses_LateThoughtSignatureIsImmutable", () => {
  const signature = differentResponsesGeminiThoughtSignature();
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"one","thought":true}]}}],"responseId":"late-thought-signature"}}`,
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"two","thought":true,"thoughtSignature":"${signature}"}]},"finishReason":"STOP"}],"responseId":"late-thought-signature"}}`,
    `data: [DONE]`,
  ]);
  const added = evs.find((e) => e.event === "response.output_item.added" && e.data.str("item.type") === "reasoning")!.data;
  const done = evs.find((e) => e.event === "response.output_item.done" && e.data.str("item.type") === "reasoning")!.data;
  expect(added.str("item.id")).not.toBe("");
  expect(done.str("item.id")).toBe(added.str("item.id"));
  expect(dec(added.str("item.encrypted_content"))).toBe(signature);
  expect(done.str("item.encrypted_content")).toBe(added.str("item.encrypted_content"));
  expect(done.str("item.summary.0.text")).toBe("onetwo");
});

test("TestConvertGeminiResponseToOpenAIResponses_DoneFinalizesStartedStreamExactlyOnce", () => {
  const state: TranslatorState = {};
  streamChunk(M, "", "", `data: {"response":{"candidates":[{"content":{"parts":[{"text":"unsigned thought","thought":true}]}}],"responseId":"done-finalize"}}`, state);
  const out = streamChunk(M, "", "", "[DONE]", state).map(parseSSEEvent);
  expect(out.filter((e) => e.event === "response.reasoning_summary_text.delta").map((e) => e.data.str("delta")).join("")).toBe("unsigned thought");
  expect(out.filter((e) => e.event === "response.output_item.done").length).toBe(1);
  expect(out.filter((e) => e.event === "response.completed").length).toBe(1);
  expect(streamChunk(M, "", "", "[DONE]", state).length).toBe(0);
});

test("TestConvertGeminiResponseToOpenAIResponses_FinishReasonThenDoneDoesNotDuplicateCompletion", () => {
  const state: TranslatorState = {};
  const out = [
    ...streamChunk(M, "", "", `data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"responseId":"finish-then-done"}}`, state),
    ...streamChunk(M, "", "", "data: [DONE]", state),
  ].map(parseSSEEvent);
  expect(out.filter((e) => e.event === "response.completed").length).toBe(1);
  expect(streamChunk(M, "", "", "data: [DONE]", state).length).toBe(0);
  expect(streamChunk(M, "", "", `{"candidates":[{"content":{"parts":[{"text":"late"}]}}]}`, state).length).toBe(0);
});

test("TestConvertGeminiResponseToOpenAIResponses_BareDoneBeforeStartEmitsNothing", () => {
  const state: TranslatorState = {};
  expect(streamChunk(M, "", "", "data: [DONE]", state).length).toBe(0);
  const st = state.value as GeminiToResponsesState;
  expect([st.started, st.completed]).toEqual([false, false]);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_VisibleSignatureCompletesReasoning", () => {
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"role":"model","parts":[{"text":"hidden thought","thought":true},{"text":"visible answer","thoughtSignature":"${sig}"}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.6-flash","responseId":"resp_nonstream_active"}`);
  expect(g(out, "output.0.type").str()).toBe("reasoning");
  expect(dec(g(out, "output.0.encrypted_content").str())).toBe(sig);
  expect(g(out, "output.1.type").str()).toBe("message");
});

test("TestConvertGeminiResponseToOpenAIResponses_PreservesTextAroundFunction", () => {
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"preface"}]}}],"modelVersion":"gemini-3.6-flash","responseId":"resp_mixed_stream"}}`,
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"run_command","args":{"command":"true"}}}]}}],"modelVersion":"gemini-3.6-flash","responseId":"resp_mixed_stream"}}`,
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"after"}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.6-flash","responseId":"resp_mixed_stream"}}`,
    `data: [DONE]`,
  ]);
  expect(evs.filter((e) => e.event === "response.output_item.done").map((e) => e.data.str("item.type"))).toEqual(["message", "function_call", "message"]);
  const completed = completedOutput(evs);
  expect(completed.str("0.content.0.text")).toBe("preface");
  expect(completed.str("2.content.0.text")).toBe("after");
  const translated = replay(completed, JSON.stringify({ type: "function_call_output", call_id: completed.str("1.call_id"), output: "ok" }));
  const contents = g(translated, "contents").arr();
  expect(contents.map((c) => c.str("role"))).toEqual(["model", "user"]);
  const p = contents[0]!.arr("parts");
  expect(p.length).toBe(3);
  expect(p[0]!.str("text")).toBe("preface");
  expect(p[1]!.exists("functionCall")).toBe(true);
  expect(p[2]!.str("text")).toBe("after");
  expect(contents[1]!.exists("parts.0.functionResponse")).toBe(true);
});

test("TestConvertGeminiResponseToOpenAIResponses_PendingSignatureBeforeFunctionRoundTrips", () => {
  const completed = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"","thoughtSignature":"${sig}"}]}}],"modelVersion":"gemini-3.6-flash","responseId":"pending-function-signature"}}`,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"native-pending-call","name":"run_command","args":{"command":"true"}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.6-flash","responseId":"pending-function-signature"}}`,
      `data: [DONE]`,
    ]),
  );
  expect(completed.isArray()).toBe(true);
  const callID = completed.arr().find((i) => i.str("type") === "function_call")?.str("call_id") ?? "";
  expect(callID).not.toBe("");
  const p = parts(replay(completed, JSON.stringify({ type: "function_call_output", call_id: callID, output: "ok" })));
  expect(p.find((x) => x.exists("functionCall"))?.str("thoughtSignature")).toBe(sig);
  expect(p.filter((x) => x.exists("text") && x.str("text") === "" && x.str("thoughtSignature") !== "").length).toBe(0);
});

test("TestConvertGeminiResponseToOpenAIResponses_SignedTextBeforeSignedFunctionRoundTrips", () => {
  const toolSignature = differentResponsesGeminiThoughtSignature();
  const completed = completedOutput(
    run([
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"before "}]}}],"modelVersion":"gemini-3.6-flash","responseId":"resp_signed_mixed"}}`,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"tool","thoughtSignature":"${sig}"}]}}],"modelVersion":"gemini-3.6-flash","responseId":"resp_signed_mixed"}}`,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"${toolSignature}","functionCall":{"name":"run_command","args":{"command":"true"}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.6-flash","responseId":"resp_signed_mixed"}}`,
      `data: [DONE]`,
    ]),
  );
  const all = allParts(replay(completed, JSON.stringify({ type: "function_call_output", call_id: completed.str("3.call_id"), output: "ok" })));
  expect(all.find((p) => !p.exists("functionCall") && p.str("text") === "before tool")?.str("thoughtSignature")).toBe(sig);
  expect(all.find((p) => p.exists("functionCall"))?.str("thoughtSignature")).toBe(toolSignature);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_PreservesTextAroundSignedFunction", () => {
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"role":"model","parts":[{"text":"preface"},{"thoughtSignature":"${sig}","functionCall":{"name":"run_command","args":{"command":"true"}}},{"text":"after"}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.6-flash","responseId":"resp_nonstream_order"}`);
  expect(g(out, "output").arr().map((i) => i.str("type"))).toEqual(["message", "reasoning", "function_call", "message"]);
  expect(g(out, "output.3.content.0.text").str()).toBe("after");
});

test("TestConvertGeminiResponseToOpenAIResponses_CachesSignatureAfterVisibleText", () => {
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"visible answer"}]}}],"modelVersion":"gemini-3.6-flash","responseId":"resp_detached"}}`,
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"","thoughtSignature":"${sig}"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3,"totalTokenCount":15},"modelVersion":"gemini-3.6-flash","responseId":"resp_detached"}}`,
  ]);
  expect(evs.filter((e) => e.event === "response.output_item.done").map((e) => e.data.str("item.type"))).toEqual(["message"]);
  const completed = completedOutput(evs);
  expect(completed.arr().length).toBe(1);
  expect(g(toGemini(M, `{"input":${completed.raw}}`), "contents.0.parts.0.thoughtSignature").str()).toBe(sig);
});

test("TestConvertGeminiResponseToOpenAIResponses_GeminiToolSignature", () => {
  const evs = run([
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"${sig}","functionCall":{"id":"native-id","name":"run_command","args":{"command":"true"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3,"totalTokenCount":15},"modelVersion":"gemini-3.6-flash","responseId":"resp_tool_sig"}}`,
  ]);
  const done = evs.filter((e) => e.event === "response.output_item.done");
  expect(done.map((e) => e.data.str("item.type"))).toEqual(["reasoning", "function_call"]);
  expect(dec(done[0]!.data.str("item.encrypted_content"))).toBe(sig);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_DetachedSignature", () => {
  const out = nonStream(M, "", "", `{"candidates":[{"content":{"role":"model","parts":[{"text":"visible answer"},{"text":"","thoughtSignature":"${sig}"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3,"totalTokenCount":15},"modelVersion":"gemini-3.6-flash","responseId":"resp_nonstream_detached"}`);
  expect(g(out, "output.0.type").str()).toBe("reasoning");
  expect(dec(g(out, "output.0.encrypted_content").str())).toBe(sig);
  expect(g(out, "output.1.type").str()).toBe("message");
});

test("TestConvertGeminiResponseToOpenAIResponses_ReasoningEncryptedContent", () => {
  const s =
    "RXE0RENrZ0lDeEFDR0FJcVFOZDdjUzlleGFuRktRdFcvSzNyZ2MvWDNCcDQ4RmxSbGxOWUlOVU5kR1l1UHMrMGdkMVp0Vkg3ekdKU0g4YVljc2JjN3lNK0FrdGpTNUdqamI4T3Z0VVNETzdQd3pmcFhUOGl3U3hXUEJvTVFRQ09mWTFyMEtTWGZxUUlJakFqdmFGWk83RW1XRlBKckJVOVpkYzdDKw==";
  const w = (p: string, extra = ""): string => `data: {"response":{"candidates":[{"content":{"role":"model","parts":[${p}]}${extra}}],"modelVersion":"test-model","responseId":"req_vrtx_sig"},"traceId":"t1"}`;
  const evs = run([w(`{"thought":true,"thoughtSignature":"${s}","text":""}`), w(`{"thought":true,"text":"a"}`), w(`{"text":"hello"}`), w(`{"text":""}`, `,"finishReason":"STOP"`), "data: [DONE]"], "test-model");
  const added = evs.filter((e) => e.event === "response.output_item.added" && e.data.str("item.type") === "reasoning").pop()!.data.str("item.encrypted_content");
  const done = evs.filter((e) => e.event === "response.output_item.done" && e.data.str("item.type") === "reasoning").pop()!.data.str("item.encrypted_content");
  expect(dec(added)).toBe(s);
  expect(done).toBe(added);
});

test("TestConvertGeminiResponseToOpenAIResponses_FunctionCallEventOrder", () => {
  const w = (p: string, extra = "", usage = ""): string =>
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[${p}]}${extra}}],${usage}"modelVersion":"test-model","responseId":"req_vrtx_1"},"traceId":"t1"}`;
  const evs = run(
    [
      w(`{"functionCall":{"name":"tool0"}}`),
      w(`{"functionCall":{"name":"tool1"}}`),
      w(`{"functionCall":{"name":"tool2","args":{"a":1}}}`),
      w(`{"text":""}`, `,"finishReason":"STOP"`, `"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15,"cachedContentTokenCount":0},`),
    ],
    "test-model",
  );
  const posAdded = [-1, -1, -1];
  const posArgsDelta = [-1, -1, -1];
  const posArgsDone = [-1, -1, -1];
  const posItemDone = [-1, -1, -1];
  const deltaByIndex = new Map<number, string>();
  let posCompleted = -1;
  evs.forEach(({ event, data }, i) => {
    const idx = data.int("output_index");
    if (event === "response.output_item.added" && data.str("item.type") === "function_call") posAdded[idx] = i;
    if (event === "response.function_call_arguments.delta") {
      posArgsDelta[idx] = i;
      deltaByIndex.set(idx, data.str("delta"));
    }
    if (event === "response.function_call_arguments.done") posArgsDone[idx] = i;
    if (event === "response.output_item.done" && data.str("item.type") === "function_call") posItemDone[idx] = i;
    if (event === "response.completed") {
      posCompleted = i;
      expect(data.arr("response.output").length).toBe(3);
      expect([data.str("response.output.0.name"), data.str("response.output.0.arguments")]).toEqual(["tool0", "{}"]);
      expect([data.str("response.output.1.name"), data.str("response.output.1.arguments")]).toEqual(["tool1", "{}"]);
      expect(data.str("response.output.2.name")).toBe("tool2");
      expect(J.parse(data.str("response.output.2.arguments")).exists()).toBe(true);
    }
  });
  expect(posCompleted).toBeGreaterThan(-1);
  for (let idx = 0; idx < 3; idx++) {
    expect(posAdded[idx]! < posArgsDelta[idx]! && posArgsDelta[idx]! < posArgsDone[idx]! && posArgsDone[idx]! < posItemDone[idx]!).toBe(true);
    expect(posAdded[idx]).toBeGreaterThan(-1);
    if (idx > 0) expect(posItemDone[idx - 1]! < posAdded[idx]!).toBe(true);
  }
  expect(deltaByIndex.get(0)).toBe("{}");
  expect(deltaByIndex.get(1)).toBe("{}");
  expect(J.parse(deltaByIndex.get(2) ?? "").int("a")).toBe(1);
  expect(posItemDone[2]! < posCompleted).toBe(true);
});

test("TestConvertGeminiResponseToOpenAIResponses_ResponseOutputOrdering", () => {
  const w = (p: string, extra = "", usage = ""): string =>
    `data: {"response":{"candidates":[{"content":{"role":"model","parts":[${p}]}${extra}}],${usage}"modelVersion":"test-model","responseId":"req_vrtx_2"},"traceId":"t2"}`;
  const evs = run(
    [w(`{"functionCall":{"name":"tool0","args":{"x":"y"}}}`), w(`{"text":"hi"}`), w(`{"text":""}`, `,"finishReason":"STOP"`, `"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2,"cachedContentTokenCount":0},`)],
    "test-model",
  );
  const posFuncDone = evs.findIndex((e) => e.event === "response.output_item.done" && e.data.str("item.type") === "function_call" && e.data.int("output_index") === 0);
  const posMsgAdded = evs.findIndex((e) => e.event === "response.output_item.added" && e.data.str("item.type") === "message" && e.data.int("output_index") === 1);
  const posCompleted = evs.findIndex((e) => e.event === "response.completed");
  expect([posFuncDone, posMsgAdded, posCompleted].every((p) => p >= 0)).toBe(true);
  expect(posFuncDone < posMsgAdded && posMsgAdded < posCompleted).toBe(true);
  const completed = evs[posCompleted]!.data;
  expect(completed.str("response.output.0.type")).toBe("function_call");
  expect(completed.str("response.output.1.type")).toBe("message");
  expect(completed.str("response.output.1.content.0.text")).toBe("hi");
});

const additionalCustomRequest = `{
		"model":"gemini-2.5-flash",
		"input":[{"type":"additional_tools","role":"developer","tools":[
			{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]}
		]}]
	}`;
const additionalFunctionRequest = `{
		"model":"gemini-2.5-flash",
		"input":[{"type":"additional_tools","role":"developer","tools":[
			{"type":"namespace","name":"functions","tools":[{"type":"function","name":"continuity_probe","parameters":{"type":"object","properties":{"value":{"type":"string"}}}}]}]
		}]
	}`;

test("TestConvertGeminiResponseToOpenAIResponses_RestoresAdditionalNamespaceCustomToolCall", () => {
  const evs = run(
    [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"functions__exec","args":{"input":"pwd"}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-2.5-flash","responseId":"resp_custom_stream"}`,
      "data: [DONE]",
    ],
    "gemini-2.5-flash",
    additionalCustomRequest,
  );
  const added = evs.find((e) => e.event === "response.output_item.added" && e.data.str("item.type") === "custom_tool_call")!.data;
  const inputDone = evs.find((e) => e.event === "response.custom_tool_call_input.done")!.data;
  const done = evs.find((e) => e.event === "response.output_item.done" && e.data.str("item.type") === "custom_tool_call")!.data;
  const completed = evs.find((e) => e.event === "response.completed")!.data;
  expect(evs.filter((e) => e.event.startsWith("response.function_call_arguments")).length).toBe(0);
  for (const item of [added.get("item"), done.get("item"), completed.get("response.output.0")]) {
    expect(item.str("name")).toBe("exec");
    expect(item.str("namespace")).toBe("functions");
  }
  expect(inputDone.str("input")).toBe("pwd");
  expect(done.str("item.input")).toBe("pwd");
  expect(completed.str("response.output.0.type")).toBe("custom_tool_call");
  expect(completed.str("response.output.0.input")).toBe("pwd");
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_RestoresAdditionalNamespaceCustomToolCall", () => {
  const root = J.parse(
    nonStream("gemini-2.5-flash", additionalCustomRequest, "", `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"functions__exec","args":{"input":"pwd"}}}]}}],"modelVersion":"gemini-2.5-flash","responseId":"resp_custom_nonstream"}`),
  );
  expect([root.str("output.0.type"), root.str("output.0.name"), root.str("output.0.namespace"), root.str("output.0.input")]).toEqual(["custom_tool_call", "exec", "functions", "pwd"]);
});

test("TestConvertGeminiResponseToOpenAIResponses_RestoresAdditionalNamespaceFunctionCall", () => {
  const evs = run(
    [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"functions__continuity_probe","args":{"value":"PROBE"}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-2.5-flash","responseId":"resp_func_stream"}`,
      "data: [DONE]",
    ],
    "gemini-2.5-flash",
    additionalFunctionRequest,
  );
  const added = evs.find((e) => e.event === "response.output_item.added" && e.data.str("item.type") === "function_call")!.data;
  expect(evs.some((e) => e.event === "response.function_call_arguments.done")).toBe(true);
  const done = evs.find((e) => e.event === "response.output_item.done" && e.data.str("item.type") === "function_call")!.data;
  const completed = evs.find((e) => e.event === "response.completed")!.data;
  for (const item of [added.get("item"), done.get("item"), completed.get("response.output.0")]) {
    expect(item.str("name")).toBe("continuity_probe");
    expect(item.str("namespace")).toBe("functions");
  }
  expect(completed.str("response.output.0.type")).toBe("function_call");
  expect(J.parse(completed.str("response.output.0.arguments")).str("value")).toBe("PROBE");
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_RestoresAdditionalNamespaceFunctionCall", () => {
  const root = J.parse(
    nonStream("gemini-2.5-flash", additionalFunctionRequest, "", `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"functions__continuity_probe","args":{"value":"PROBE"}}}]}}],"modelVersion":"gemini-2.5-flash","responseId":"resp_func_nonstream"}`),
  );
  expect([root.str("output.0.type"), root.str("output.0.name"), root.str("output.0.namespace")]).toEqual(["function_call", "continuity_probe", "functions"]);
  expect(J.parse(root.str("output.0.arguments")).str("value")).toBe("PROBE");
});

test("TestConvertGeminiResponseToOpenAIResponses_MessageOutputItemDoneFields", () => {
  const evs = run(
    [`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7},"modelVersion":"gemini-2.5-flash","responseId":"resp_item_done_test"}`],
    "gemini-2.5-flash",
    `{"model":"gemini-2.5-flash","input":"Reply with exactly: hello"}`,
  );
  const done = evs.find((e) => e.event === "response.output_item.done" && e.data.str("item.type") === "message");
  expect(done).toBeDefined();
  expect(done!.data.isArray("item.content.0.annotations")).toBe(true);
  expect(done!.data.isArray("item.content.0.logprobs")).toBe(true);
});

test("TestConvertGeminiResponseToOpenAIResponses_PinsRequestPerStream", () => {
  const originalRequest = `{
		"model":"gemini-2.5-flash",
		"instructions":"pinned-instructions",
		"input":[{"type":"additional_tools","role":"developer","tools":[
			{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]}
		]}]
	}`;
  const chunks = [
    `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"starting"}]}}],"modelVersion":"gemini-2.5-flash","responseId":"resp_pinned"}`,
    `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"functions__exec","args":{"input":"pwd"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-flash","responseId":"resp_pinned"}`,
    "data: [DONE]",
  ];
  const state: TranslatorState = {};
  const evs = chunks.flatMap((chunk, i) => streamChunk("gemini-2.5-flash", i === 0 ? originalRequest : "", "", chunk, state).map(parseSSEEvent));
  const added = evs.find((e) => e.event === "response.output_item.added" && e.data.str("item.type") === "custom_tool_call")!.data;
  const completed = evs.find((e) => e.event === "response.completed")!.data;
  expect(added.str("item.name")).toBe("exec");
  expect(added.str("item.namespace")).toBe("functions");
  expect(completed.str("response.instructions")).toBe("pinned-instructions");

  const nilState: TranslatorState = {};
  streamChunk("gemini-2.5-flash", `{"model":"gemini-2.5-flash","instructions":"pinned-no-tools"}`, "", chunks[0]!, nilState);
  const later = streamChunk(
    "gemini-2.5-flash",
    `{"model":"gemini-2.5-flash","instructions":"later-instructions","tools":[{"type":"function","name":"mcp/search","parameters":{"type":"object"}}]}`,
    "",
    `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"mcp_search","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2},"modelVersion":"gemini-2.5-flash","responseId":"resp_pinned_nil"}`,
    nilState,
  ).map(parseSSEEvent);
  expect(later.find((e) => e.event === "response.output_item.added" && e.data.str("item.type") === "function_call")?.data.str("item.name")).toBe("mcp_search");
  expect(later.find((e) => e.event === "response.completed")?.data.str("response.instructions")).toBe("pinned-no-tools");
});

describe("TestConvertGeminiResponseToOpenAIResponses_NonNormalFinishReasonsMapToIncompleteContentFilter", () => {
  const req = `{"model":"gemini-4-argon"}`;
  for (const reason of ["MALFORMED_RESPONSE", "MALFORMED_FUNCTION_CALL", "SAFETY", "RECITATION", "PROHIBITED_CONTENT"]) {
    const body = `{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"${reason}"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11},"modelVersion":"gemini-4-argon","responseId":"resp_1"}`;
    test("stream/" + reason, () => {
      const evs = run(["data: " + body], "gemini-4-argon", req);
      expect(evs.some((e) => e.event === "response.completed")).toBe(false);
      const incomplete = evs.find((e) => e.event === "response.incomplete");
      expect(incomplete).toBeDefined();
      expect(incomplete!.data.str("response.status")).toBe("incomplete");
      expect(incomplete!.data.str("response.incomplete_details.reason")).toBe("content_filter");
    });
    test("nonstream/" + reason, () => {
      const out = nonStream("gemini-4-argon", req, "", body);
      expect(g(out, "status").str()).toBe("incomplete");
      expect(g(out, "incomplete_details.reason").str()).toBe("content_filter");
    });
  }
});
