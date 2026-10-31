// Ported from: internal/translator/gemini/openai/responses/gemini_openai-responses_web_search_test.go
// Skipped cases: none (registry fixtures register ModelInfo objects carrying the Go SupportsWebSearch /
// NativeCapabilities.WebSearch fields as supportsWebSearch / nativeCapabilities.webSearch)
import { afterEach, describe, expect, test } from "bun:test";
import { getGlobalRegistry } from "../../../../../src/registry/index.ts";
import type { ModelInfo } from "../../../../../src/registry/types.ts";
import {
  allowsResponsesWebSearchToolChoice,
  buildResponsesURLCitations,
  buildResponsesURLCitationsForMessages,
  extractResponsesWebSearchQuery,
  type GeminiPartMapping,
  hasResponsesWebSearchTool,
  hasValidWebGrounding,
  mergeCitationAnnotations,
  mergeGroundingMetadata,
  modelSupportsWebSearch,
} from "../../../../../src/translator/gemini/openai/responses/web_search.ts";
import type { TranslatorState } from "../../../../../src/translator/types.ts";
import { g, J, nonStream, streamChunk, toGemini } from "./helpers.ts";

const registered: string[] = [];
afterEach(() => {
  for (const id of registered.splice(0)) getGlobalRegistry().unregisterClient(id);
});

function registerTestWebSearchModel(clientID: string, provider: string, modelID: string, supportsSearch: boolean, extra: Record<string, unknown> = {}): void {
  getGlobalRegistry().registerClient(clientID, provider, [{ id: modelID, type: "", supportsWebSearch: supportsSearch, ...extra } as unknown as ModelInfo]);
  registered.push(clientID);
}

interface Collected {
  eventTypes: string[];
  byType: Map<string, J[]>;
  frames: string[];
}

function collect(frames: string[]): Collected {
  const eventTypes: string[] = [];
  const byType = new Map<string, J[]>();
  for (const ev of frames) {
    let currentType = "";
    for (const line of ev.split("\n")) {
      if (line.startsWith("event: ")) {
        currentType = line.slice("event: ".length);
        eventTypes.push(currentType);
      }
      if (line.startsWith("data: ") && currentType !== "") {
        const list = byType.get(currentType) ?? [];
        list.push(J.parse(line.slice("data: ".length)));
        byType.set(currentType, list);
      }
    }
  }
  return { eventTypes, byType, frames };
}

function by(c: Collected, type: string): J[] {
  return c.byType.get(type) ?? [];
}

/** Streams chunks with the same request as original and translated request (Go passed req, req). */
function stream(model: string, req: string, chunks: string[], state: TranslatorState = {}, translated = req): Collected {
  const frames: string[] = [];
  for (const chunk of chunks) frames.push(...streamChunk(model, req, translated, chunk, state));
  return collect(frames);
}

function findWebSearchCallDone(payloads: J[]): J {
  return payloads.find((p) => p.str("item.type") === "web_search_call") ?? new J(undefined);
}

function findMessageOutputItemDone(payloads: J[]): J {
  return payloads.find((p) => p.str("item.type") === "message") ?? new J(undefined);
}

function hasGoogleSearch(out: string): boolean {
  return g(out, "tools").arr().some((t) => t.exists("googleSearch"));
}

test("TestConvertOpenAIResponsesRequestToGemini_WebSearchCapabilityGate", () => {
  registerTestWebSearchModel("client-capable", "antigravity", "gemini-search-capable", true);
  registerTestWebSearchModel("client-incapable", "antigravity", "gemini-search-incapable", false);
  const req = `{"model":"dummy","input":"test query","tools":[{"type":"web_search"}]}`;
  expect(hasGoogleSearch(toGemini("gemini-search-capable", req))).toBe(true);
  expect(hasGoogleSearch(toGemini("gemini-search-incapable", req))).toBe(false);
});

test("TestConvertOpenAIResponsesRequestToGemini_WebSearchAllowedDomains", () => {
  registerTestWebSearchModel("client-domains", "antigravity", "gemini-search-domains", true);
  const out = toGemini("gemini-search-domains", `{"model":"gemini-search-domains","input":"search query","tools":[{"type":"web_search","filters":{"allowed_domains":["go.dev","github.com"]}}]}`);
  expect(g(out, "tools.0.googleSearch.includedDomains").arr().map((d) => d.str())).toEqual(["go.dev", "github.com"]);
});

test("TestConvertOpenAIResponsesRequestToGemini_WebSearchToolChoiceNoneSuppresses", () => {
  registerTestWebSearchModel("client-suppress", "antigravity", "gemini-search-suppress", true);
  const out = toGemini("gemini-search-suppress", `{"model":"gemini-search-suppress","input":"search query","tools":[{"type":"web_search"}],"tool_choice":"none"}`);
  expect(hasGoogleSearch(out)).toBe(false);
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_GroundingMetadata", () => {
  const out = nonStream(
    "gemini-test",
    "",
    "",
    `{"responseId":"resp_test123","candidates":[{"content":{"role":"model","parts":[{"text":"Go 1.27 is the latest release."}]},
			"groundingMetadata":{"webSearchQueries":["latest Go release"],"groundingChunks":[{"web":{"uri":"https://go.dev/dl/","title":"Download Go"}}],
				"groundingSupports":[{"groundingChunkIndices":[0],"segment":{"startIndex":0,"endIndex":7,"text":"Go 1.27"}}]}}],
		"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":8,"totalTokenCount":23}}`,
  );
  const outputs = g(out, "output").arr();
  expect(outputs.length).toBe(2);
  const ws = outputs[0]!;
  expect([ws.str("type"), ws.str("action.type"), ws.str("action.query")]).toEqual(["web_search_call", "search", "latest Go release"]);
  expect(ws.arr("action.sources").map((s) => s.str("url"))).toEqual(["https://go.dev/dl/"]);
  const msg = outputs[1]!;
  expect(msg.str("type")).toBe("message");
  const citations = msg.arr("content.0.annotations");
  expect(citations.length).toBe(1);
  expect([citations[0]!.str("type"), citations[0]!.str("url"), citations[0]!.str("title"), citations[0]!.int("start_index"), citations[0]!.int("end_index")]).toEqual([
    "url_citation",
    "https://go.dev/dl/",
    "Download Go",
    0,
    7,
  ]);
  expect(g(out, "tool_usage.web_search.num_requests").int()).toBe(1);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_WebSearch", () => {
  registerTestWebSearchModel("client-stream", "antigravity", "gemini-search-stream", true);
  const req = `{"model":"gemini-search-stream","input":"search query","tools":[{"type":"web_search"}]}`;
  const c = stream("gemini-search-stream", req, [
    `data: {
		"responseId": "stream_resp_1",
		"candidates": [{"content": {"role": "model","parts": [{"text": "Found information."}]},
			"groundingMetadata": {"webSearchQueries": ["search query"],"groundingChunks": [{"web": {"uri": "https://example.com", "title": "Example"}}],
				"groundingSupports": [{"groundingChunkIndices": [0],"segment": {"startIndex": 0, "endIndex": 5, "text": "Found"}}]}}]
	}`,
    `data: {"candidates": [{"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15}}`,
  ]);
  for (const expected of [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.web_search_call.searching",
    "response.web_search_call.completed",
    "response.output_item.done",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.completed",
  ])
    expect(c.eventTypes).toContain(expected);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_NoGroundingDoesNotEmitWebSearchCall", () => {
  registerTestWebSearchModel("client-noground", "antigravity", "gemini-search-noground", true);
  const req = `{"model":"gemini-search-noground","input":"Calculate 2+2","tools":[{"type":"web_search"}]}`;
  const c = stream("gemini-search-noground", req, [
    `data: {"responseId":"stream_noground_1","candidates":[{"content":{"role":"model","parts":[{"text":"2+2=4"}]}}]}`,
    `data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":5,"totalTokenCount":10}}`,
  ]);
  for (const ev of c.frames) {
    expect(ev).not.toContain("web_search_call");
    expect(ev).not.toContain(`"tool_usage"`);
  }
});

test("TestBuildResponsesURLCitations_RuneOffsetConversion", () => {
  const gm = JSON.parse(`{"groundingChunks":[{"web":{"uri":"https://go.dev","title":"Go"}}],
		"groundingSupports":[{"groundingChunkIndices":[0],"segment":{"startIndex":26,"endIndex":33}},{"groundingChunkIndices":[0],"segment":{"startIndex":33,"endIndex":20}}]}`);
  const citations = buildResponsesURLCitations(gm, "Go语言的最新版本是Go 1.27。");
  expect(citations.length).toBe(1);
  expect([citations[0]!.start_index, citations[0]!.end_index]).toEqual([10, 17]);
});

test("TestConvertOpenAIResponsesRequestToGemini_WebSearchOnlyToolChoiceRequiredNoFunctions", () => {
  registerTestWebSearchModel("client-req", "antigravity", "gemini-search-only-req", true);
  const out = toGemini("gemini-search-only-req", `{"model":"gemini-search-only-req","input":"search query","tools":[{"type":"web_search"}],"tool_choice":"required"}`);
  expect(g(out, "tools.0.googleSearch").exists()).toBe(true);
  expect(g(out, "toolConfig.functionCallingConfig").exists()).toBe(false);
});

test("TestHasValidWebGrounding", () => {
  const p = (s: string): unknown => JSON.parse(s);
  expect(hasValidWebGrounding(p(`{}`))).toBe(false);
  expect(hasValidWebGrounding(p(`{"groundingChunks": [{"other": "something"}]}`))).toBe(false);
  expect(hasValidWebGrounding(p(`{"groundingSupports": [{"groundingChunkIndices": [0]}]}`))).toBe(false);
  expect(
    hasValidWebGrounding(p(`{"groundingChunks":[{"retrievedContext":{"uri":"rag-doc-1","title":"Internal Doc"}}],"groundingSupports":[{"groundingChunkIndices":[0],"segment":{"startIndex":0,"endIndex":10}}]}`)),
  ).toBe(false);
  expect(hasValidWebGrounding(p(`{"groundingChunks":[{"web":{"uri":""}}],"groundingSupports":[{"groundingChunkIndices":[0]}]}`))).toBe(false);
  expect(hasValidWebGrounding(p(`{"webSearchQueries": ["query"]}`))).toBe(true);
  expect(hasValidWebGrounding(p(`{"groundingChunks": [{"web": {"uri": "https://example.com"}}]}`))).toBe(true);
  expect(hasValidWebGrounding(p(`{"groundingChunks":[{"retrievedContext":{"uri":"rag-doc-1"}}],"webSearchQueries":["actual query"]}`))).toBe(true);
});

test("TestModelSupportsWebSearch_StaticVetoTakesPrecedence", () => {
  registerTestWebSearchModel("client-veto", "antigravity", "gemini-veto-test-model", true, { nativeCapabilities: { webSearch: false } });
  expect(modelSupportsWebSearch("gemini-veto-test-model")).toBe(false);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_LateGroundingMetadataAndCJKOffsets", () => {
  registerTestWebSearchModel("client-late-grounding", "antigravity", "gemini-search-late-grounding", true);
  const req = `{"model":"gemini-search-late-grounding","input":"Go最新版本是多少？","tools":[{"type":"web_search"}]}`;
  const c = stream("gemini-search-late-grounding", req, [
    `data: {"responseId":"stream_late_1","candidates":[{"content":{"role":"model","parts":[{"text":"Go语言的最新版本是"}]}}]}`,
    `data: {"responseId":"stream_late_1","candidates":[{"content":{"role":"model","parts":[{"text":"Go 1.27。"}]},
			"groundingMetadata":{"webSearchQueries":["Go release"],"groundingChunks":[{"web":{"uri":"https://go.dev/doc/devel/release","title":"Go Releases"}}],
				"groundingSupports":[{"groundingChunkIndices":[0],"segment":{"startIndex":26,"endIndex":33}}]},"finishReason":"STOP"}],
		"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}`,
  ]);
  const completed = by(c, "response.completed").pop()!;
  const partDone = by(c, "response.content_part.done").filter((p) => p.exists("part.annotations.0")).pop();
  const itemDone = by(c, "response.output_item.done").filter((p) => p.str("item.type") === "message").pop()!;
  let wsAdded = -1;
  let wsDone = -1;
  let msgAdded = -1;
  let msgDone = -1;
  let completedIdx = -1;
  c.eventTypes.forEach((typ, i) => {
    if (typ === "response.output_item.added") {
      if (wsAdded === -1) wsAdded = i;
      else if (msgAdded === -1) msgAdded = i;
    }
    if (typ === "response.output_item.done") {
      if (wsDone === -1) wsDone = i;
      else if (msgDone === -1) msgDone = i;
    }
    if (typ === "response.completed") completedIdx = i;
  });
  expect([wsAdded, wsDone, msgAdded, msgDone].every((x) => x >= 0)).toBe(true);
  expect(wsDone < msgAdded).toBe(true);
  expect(msgDone < completedIdx).toBe(true);
  expect(partDone).toBeDefined();
  expect([partDone!.int("part.annotations.0.start_index"), partDone!.int("part.annotations.0.end_index")]).toEqual([10, 17]);
  expect(itemDone.int("item.content.0.annotations.0.start_index")).toBe(10);
  const outputs = completed.arr("response.output");
  expect(outputs.length).toBeGreaterThanOrEqual(2);
  expect([outputs[0]!.str("type"), outputs[1]!.str("type")]).toEqual(["web_search_call", "message"]);
  const wsID = outputs[0]!.str("id");
  expect(wsID.startsWith("ws_") && !wsID.startsWith("ws_resp_")).toBe(true);
  expect(completed.int("response.tool_usage.web_search.num_requests")).toBe(1);
});

test("TestAllowsResponsesWebSearchToolChoice_AllowedTools", () => {
  expect(allowsResponsesWebSearchToolChoice(JSON.parse(`{"tool_choice":{"type":"allowed_tools","mode":"auto","tools":[{"type":"function","name":"lookup"},{"type":"web_search"}]}}`))).toBe(true);
  expect(allowsResponsesWebSearchToolChoice(JSON.parse(`{"tool_choice":{"type":"allowed_tools","mode":"auto","tools":[{"type":"function","name":"lookup"}]}}`))).toBe(false);
  expect(allowsResponsesWebSearchToolChoice(JSON.parse(`{"tool_choice":{"type":"allowed_tools","mode":"auto","tools":[{"type":"web_search_preview_2025_03_11"}]}}`))).toBe(true);
});

test("TestResponsesWebSearchToolTypeAliases", () => {
  for (const toolType of ["web_search", "web_search_2025_08_26", "web_search_preview", "web_search_preview_2025_03_11"]) {
    expect(hasResponsesWebSearchTool({ tools: [{ type: toolType }] })).toBe(true);
    expect(allowsResponsesWebSearchToolChoice({ tool_choice: { type: toolType } })).toBe(true);
  }
});

test("TestConvertOpenAIResponsesRequestToGemini_WebSearchPreview20250311", () => {
  registerTestWebSearchModel("client-preview-20250311", "antigravity", "gemini-search-preview-20250311", true);
  const out = toGemini(
    "gemini-search-preview-20250311",
    `{"model":"gemini-search-preview-20250311","input":"search query","tools":[{"type":"web_search_preview_2025_03_11"}],"tool_choice":{"type":"web_search_preview_2025_03_11"}}`,
  );
  expect(g(out, "tools.0.googleSearch").exists()).toBe(true);
});

test("TestExtractResponsesWebSearchQuery_MultipleTextParts", () => {
  expect(extractResponsesWebSearchQuery(JSON.parse(`{"input":[{"type":"input_text","text":"Who is"},{"type":"input_text","text":"the current Go release lead?"}]}`))).toBe(
    "Who is\nthe current Go release lead?",
  );
  expect(extractResponsesWebSearchQuery(JSON.parse(`{"input":[{"role":"user","content":[{"type":"input_text","text":"Part A"},{"type":"input_text","text":"Part B"}]}]}`))).toBe("Part A\nPart B");
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_ModelAliasUsesEffectiveRequest", () => {
  const resolvedModel = "gemini-3.7-flash-high";
  registerTestWebSearchModel("client-alias-test", "antigravity", resolvedModel, true);
  const originalReq = `{"model":"my-unregistered-alias","input":"Search latest news","tools":[{"type":"web_search"}]}`;
  const effectiveReq = `{"model":"${resolvedModel}","contents":[{"role":"user","parts":[{"text":"Search latest news"}]}],"tools":[{"googleSearch":{}}]}`;
  const c = stream(
    resolvedModel,
    originalReq,
    [
      `data: {"responseId":"stream_alias_1","candidates":[{"content":{"role":"model","parts":[{"text":"Breaking news:"}]}}]}`,
      `data: {"responseId":"stream_alias_1","candidates":[{"content":{"role":"model","parts":[{"text":" Go 1.27 released."}]},"groundingMetadata":{"webSearchQueries":["latest news"],"groundingChunks":[{"web":{"uri":"https://example.com","title":"News"}}]},"finishReason":"STOP"}]}`,
      "[DONE]",
    ],
    {},
    effectiveReq,
  );
  const outputs = by(c, "response.completed").pop()!.arr("response.output");
  expect(outputs.length).toBeGreaterThanOrEqual(2);
  expect([outputs[0]!.str("type"), outputs[1]!.str("type")]).toEqual(["web_search_call", "message"]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_InterleavedTextAndFunctionCallPreservesTrailingText", () => {
  registerTestWebSearchModel("client-interleaved", "antigravity", "gemini-search-interleaved", true);
  const req = `{"model":"gemini-search-interleaved","input":"search and calc","tools":[{"type":"web_search"},{"type":"function","function":{"name":"calculate"}}]}`;
  const c = stream("gemini-search-interleaved", req, [
    `data: {"responseId":"stream_interleaved_1","candidates":[{"content":{"role":"model","parts":[{"text":"Text A"}]}}]}`,
    `data: {"responseId":"stream_interleaved_1","candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"calculate","args":{"expr":"1+1"}}}]}}]}`,
    `data: {"responseId":"stream_interleaved_1","candidates":[{"content":{"role":"model","parts":[{"text":"Text B"}]}}]}`,
    `data: {"responseId":"stream_interleaved_1","candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}}`,
  ]);
  expect(by(c, "response.output_text.delta").some((d) => d.str("delta").includes("Text B"))).toBe(true);
  const outputs = by(c, "response.completed").pop()!.arr("response.output");
  expect(outputs.length).toBe(3);
  expect([outputs[0]!.str("type"), outputs[0]!.str("content.0.text")]).toEqual(["message", "Text A"]);
  expect([outputs[1]!.str("type"), outputs[1]!.str("name")]).toEqual(["function_call", "calculate"]);
  expect([outputs[2]!.str("type"), outputs[2]!.str("content.0.text")]).toEqual(["message", "Text B"]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_OutputIndexMatchesCompletedOrderWithLateGrounding", () => {
  registerTestWebSearchModel("client-late-order", "antigravity", "gemini-search-late-order", true);
  const req = `{"model":"gemini-search-late-order","input":"test query","tools":[{"type":"web_search"},{"type":"function","function":{"name":"query_db"}}]}`;
  const c = stream("gemini-search-late-order", req, [
    `data: {"responseId":"stream_late_order_1","candidates":[{"content":{"role":"model","parts":[{"text":"Searching database..."}]}}]}`,
    `data: {"responseId":"stream_late_order_1","candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"query_db","args":{}}}]}}]}`,
    `data: {"responseId":"stream_late_order_1","candidates":[{"content":{"role":"model","parts":[{"text":"Results found."}]}}]}`,
    `data: {"responseId":"stream_late_order_1","candidates":[{"groundingMetadata":{"webSearchQueries":["test query"],"groundingChunks":[{"web":{"uri":"https://example.com/db","title":"DB"}}]}}]}`,
    `data: {"responseId":"stream_late_order_1","candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}}`,
  ]);
  const added = by(c, "response.output_item.added");
  const outputs = by(c, "response.completed").pop()!.arr("response.output");
  expect(outputs.length).toBe(added.length);
  added.forEach((a, i) => {
    expect([outputs[i]!.str("type"), outputs[i]!.str("id")]).toEqual([a.str("item.type"), a.str("item.id")]);
  });
});

function messages(out: string): J[] {
  return g(out, "output")
    .arr()
    .filter((i) => i.str("type") === "message");
}

describe("TestConvertGeminiResponseToOpenAIResponses_CitationsRespectPartIndexAndMessage", () => {
  test("multi-part within single message", () => {
    const out = nonStream(
      "gemini-test",
      "",
      "",
      `{"responseId":"resp_multipart_1","candidates":[{"content":{"role":"model","parts":[{"text":"Intro "},{"text":"Fact"}]},
				"groundingMetadata":{"webSearchQueries":["fact query"],"groundingChunks":[{"web":{"uri":"https://example.com/fact","title":"Fact Source"}}],
					"groundingSupports":[{"groundingChunkIndices":[0],"segment":{"partIndex":1,"startIndex":0,"endIndex":4,"text":"Fact"}}]}}],
			"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":5,"totalTokenCount":10}}`,
    );
    const msg = messages(out)[0]!;
    const citations = msg.arr("content.0.annotations");
    expect(citations.length).toBe(1);
    expect([citations[0]!.int("start_index"), citations[0]!.int("end_index")]).toEqual([6, 10]);
  });
  test("multi-message separated by function calls", () => {
    const out = nonStream(
      "gemini-test",
      "",
      "",
      `{"responseId":"resp_multimsg_1","candidates":[{"content":{"role":"model","parts":[{"text":"First intro "},{"functionCall":{"name":"search","args":{}}},{"text":"Second fact"}]},
				"groundingMetadata":{"webSearchQueries":["second query"],"groundingChunks":[{"web":{"uri":"https://example.com/second","title":"Second Source"}}],
					"groundingSupports":[{"groundingChunkIndices":[0],"segment":{"partIndex":2,"startIndex":7,"endIndex":11,"text":"fact"}}]}}],
			"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}}`,
    );
    const [first, second] = messages(out);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.arr("content.0.annotations").length).toBe(0);
    const c2 = second!.arr("content.0.annotations");
    expect(c2.length).toBe(1);
    expect([c2[0]!.int("start_index"), c2[0]!.int("end_index")]).toEqual([7, 11]);
  });
  test("non-ASCII CJK text multi-part", () => {
    const out = nonStream(
      "gemini-test",
      "",
      "",
      `{"responseId":"resp_cjk_1","candidates":[{"content":{"role":"model","parts":[{"text":"Go语言的最新版本是"},{"text":"Go 1.27。"}]},
				"groundingMetadata":{"webSearchQueries":["Go最新版本"],"groundingChunks":[{"web":{"uri":"https://go.dev","title":"Go"}}],
					"groundingSupports":[{"groundingChunkIndices":[0],"segment":{"partIndex":1,"startIndex":0,"endIndex":7,"text":"Go 1.27"}}]}}],
			"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}}`,
    );
    const citations = messages(out)[0]!.arr("content.0.annotations");
    expect(citations.length).toBe(1);
    expect([citations[0]!.int("start_index"), citations[0]!.int("end_index")]).toEqual([10, 17]);
  });
  test("citation span across multiple messages", () => {
    const out = nonStream(
      "gemini-test",
      "",
      "",
      `{"responseId":"resp_multimsg_span_1","candidates":[{"content":{"role":"model","parts":[{"text":"Hello ","partIndex":0},{"functionCall":{"name":"search","args":{}},"partIndex":1},{"text":"world","partIndex":0}]},
				"groundingMetadata":{"webSearchQueries":["span query"],"groundingChunks":[{"web":{"uri":"https://example.com/span","title":"Span Source"}}],
					"groundingSupports":[{"groundingChunkIndices":[0],"segment":{"partIndex":0,"startIndex":0,"endIndex":11,"text":"Hello world"}}]}}],
			"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}}`,
    );
    const [first, second] = messages(out);
    const c1 = first!.arr("content.0.annotations");
    const c2 = second!.arr("content.0.annotations");
    expect(c1.map((c) => [c.int("start_index"), c.int("end_index"), c.str("url")])).toEqual([[0, 6, "https://example.com/span"]]);
    expect(c2.map((c) => [c.int("start_index"), c.int("end_index"), c.str("url")])).toEqual([[0, 5, "https://example.com/span"]]);
  });
});

describe("TestBuildResponsesURLCitationsForMessages_MultiMessageSpan", () => {
  const gm = (start: number, end: number, uri = "https://example.com/span"): unknown =>
    JSON.parse(`{"groundingChunks":[{"web":{"uri":"${uri}","title":"T"}}],"groundingSupports":[{"segment":{"partIndex":0,"startIndex":${start},"endIndex":${end}},"groundingChunkIndices":[0]}]}`);
  const mappings = (a: string, b: string): GeminiPartMapping[] => [
    { partIndex: 0, messageIndex: 0, startRuneInMsg: 0, partText: a },
    { partIndex: 0, messageIndex: 1, startRuneInMsg: 0, partText: b },
  ];
  const ranges = (res: Map<number, Record<string, unknown>[]> | undefined, idx: number): unknown[] => (res?.get(idx) ?? []).map((c) => [c.start_index, c.end_index]);
  test("citation span covering two messages", () => {
    const res = buildResponsesURLCitationsForMessages(gm(0, 11), mappings("Hello ", "world"), ["Hello ", "world"]);
    expect(res?.size).toBe(2);
    expect(ranges(res, 0)).toEqual([[0, 6]]);
    expect(ranges(res, 1)).toEqual([[0, 5]]);
  });
  test("citation partial overlap across two messages", () => {
    const res = buildResponsesURLCitationsForMessages(gm(2, 9), mappings("Hello ", "world"), ["Hello ", "world"]);
    expect(res?.size).toBe(2);
    expect(ranges(res, 0)).toEqual([[2, 6]]);
    expect(ranges(res, 1)).toEqual([[0, 3]]);
  });
  test("citation span with non-ASCII CJK runes across two messages", () => {
    const res = buildResponsesURLCitationsForMessages(gm(0, 13, "https://example.com/cjk"), mappings("你好 ", "世界"), ["你好 ", "世界"]);
    expect(res?.size).toBe(2);
    expect(ranges(res, 0)).toEqual([[0, 3]]);
    expect(ranges(res, 1)).toEqual([[0, 2]]);
  });
});

describe("TestConvertGeminiResponseToOpenAIResponsesStream_DisablesBufferingWhenSearchDisabled", () => {
  test("tool_choice none disables buffering", () => {
    registerTestWebSearchModel("client-nobuffer", "antigravity", "gemini-search-nobuffer", true);
    const req = `{"model":"gemini-search-nobuffer","input":"test query","tools":[{"type":"web_search"}],"tool_choice":"none"}`;
    const c = stream("gemini-search-nobuffer", req, [`data: {"responseId":"stream_nobuffer_1","candidates":[{"content":{"role":"model","parts":[{"text":"Immediate stream text"}]}}]}`]);
    expect(c.eventTypes).toContain("response.output_text.delta");
  });
  test("upstream request without googleSearch disables buffering", () => {
    registerTestWebSearchModel("client-nobuffer", "antigravity", "gemini-search-nobuffer", true);
    const originalReq = `{"model":"gemini-search-nobuffer","input":"test query","tools":[{"type":"web_search"},{"type":"function","function":{"name":"func1"}}]}`;
    const upstreamReq = `{"model":"gemini-search-nobuffer","contents":[{"role":"user","parts":[{"text":"test query"}]}],"tools":[{"functionDeclarations":[{"name":"func1"}]}]}`;
    const c = stream("gemini-search-nobuffer", originalReq, [`data: {"responseId":"stream_nobuffer_2","candidates":[{"content":{"role":"model","parts":[{"text":"Immediate stream text"}]}}]}`], {}, upstreamReq);
    expect(c.eventTypes).toContain("response.output_text.delta");
  });
});

const tx = (id: string, parts: string): string => `data: {"responseId":"${id}","candidates":[{"content":{"role":"model","parts":[${parts}]}}]}`;
const gmf = (id: string, gm: string): string => `data: {"responseId":"${id}","candidates":[{"groundingMetadata":${gm}}]}`;
const stop = (id: string): string => `data: {"responseId":"${id}","candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}}`;
const supp = (idx: number[], start: number, end: number, partIndex?: number): string =>
  `{"groundingChunkIndices":${JSON.stringify(idx)},"segment":{${partIndex !== undefined ? `"partIndex":${partIndex},` : ""}"startIndex":${start},"endIndex":${end}}}`;
const web = (uri: string, title = ""): string => `{"web":{"uri":"${uri}"${title !== "" ? `,"title":"${title}"` : ""}}}`;
const completedOf = (c: Collected): J => by(c, "response.completed").at(-1) ?? new J(undefined);
const completedMessages = (c: Collected): J[] =>
  completedOf(c)
    .arr("response.output")
    .filter((i) => i.str("type") === "message");
const spans = (msg: J | undefined): number[][] => (msg?.arr("content.0.annotations") ?? []).map((a) => [a.int("start_index"), a.int("end_index")]);
const wsReq = (model: string, input = "test query"): string => `{"model":"${model}","input":"${input}","tools":[{"type":"web_search"}]}`;

describe("TestConvertGeminiResponseToOpenAIResponsesStream_MultiChunkCitationsAndExplicitPartIndex", () => {
  const model = "gemini-search-multichunk-citations";
  const req = wsReq(model);
  test("citation spanning across multiple streamed chunks", () => {
    registerTestWebSearchModel("client-mc-citations", "antigravity", model, true);
    const c = stream(model, req, [
      tx("stream_mc_1", `{"text":"Hello "}`),
      tx("stream_mc_1", `{"text":"world"}`),
      gmf("stream_mc_1", `{"webSearchQueries":["hello query"],"groundingChunks":[${web("https://example.com/hello", "Hello")}],"groundingSupports":[${supp([0], 0, 11, 0)}]}`),
      stop("stream_mc_1"),
    ]);
    const msg = completedMessages(c)[0];
    expect(msg?.str("content.0.text")).toBe("Hello world");
    expect(spans(msg)).toEqual([[0, 11]]);
  });
  test("citation spanning across multiple streamed chunks without partIndex", () => {
    registerTestWebSearchModel("client-mc-citations", "antigravity", model, true);
    const c = stream(model, req, [
      tx("stream_mc_1b", `{"text":"Hello "}`),
      tx("stream_mc_1b", `{"text":"world"}`),
      gmf("stream_mc_1b", `{"webSearchQueries":["hello query"],"groundingChunks":[${web("https://example.com/hello", "Hello")}],"groundingSupports":[${supp([0], 0, 11)}]}`),
      stop("stream_mc_1b"),
    ]);
    expect(spans(completedMessages(c)[0])).toEqual([[0, 11]]);
  });
  test("citation referencing text in subsequent chunk", () => {
    registerTestWebSearchModel("client-mc-citations", "antigravity", model, true);
    const c = stream(model, req, [
      tx("stream_mc_2", `{"text":"Hello "}`),
      tx("stream_mc_2", `{"text":"world"}`),
      gmf("stream_mc_2", `{"webSearchQueries":["world query"],"groundingChunks":[${web("https://example.com/world", "World")}],"groundingSupports":[${supp([0], 6, 11, 0)}]}`),
      stop("stream_mc_2"),
    ]);
    expect(spans(completedMessages(c)[0])).toEqual([[6, 11]]);
  });
  test("streaming with explicit partIndex across parts", () => {
    registerTestWebSearchModel("client-mc-citations", "antigravity", model, true);
    const c = stream(model, req, [
      tx("stream_mc_3", `{"partIndex":0,"text":"Intro "}`),
      tx("stream_mc_3", `{"partIndex":1,"text":"Fact"}`),
      gmf("stream_mc_3", `{"webSearchQueries":["fact query"],"groundingChunks":[${web("https://example.com/fact", "Fact")}],"groundingSupports":[${supp([0], 0, 4, 1)}]}`),
      stop("stream_mc_3"),
    ]);
    expect(spans(completedMessages(c)[0])).toEqual([[6, 10]]);
  });
  test("streaming with explicit partIndex across multiple chunks of same part", () => {
    registerTestWebSearchModel("client-mc-citations", "antigravity", model, true);
    const c = stream(model, req, [
      tx("stream_mc_4", `{"partIndex":0,"text":"Intro "}`),
      tx("stream_mc_4", `{"partIndex":0,"text":"continuation "}`),
      tx("stream_mc_4", `{"partIndex":1,"text":"Fact"}`),
      gmf(
        "stream_mc_4",
        `{"webSearchQueries":["all queries"],"groundingChunks":[${web("https://example.com/intro", "Intro")},${web("https://example.com/fact", "Fact")}],"groundingSupports":[${supp([0], 0, 19, 0)},${supp([1], 0, 4, 1)}]}`,
      ),
      stop("stream_mc_4"),
    ]);
    expect(spans(completedMessages(c)[0])).toEqual([
      [0, 19],
      [19, 23],
    ]);
  });
});

const addedList = (c: Collected): [number, string][] => by(c, "response.output_item.added").map((a) => [a.int("output_index"), a.str("item.type")]);

describe("TestConvertGeminiResponseToOpenAIResponsesStream_InterleavedTextAndThought", () => {
  const model = "gemini-search-interleaved-thought";
  test("without grounding metadata preserves text -> thought -> text order", () => {
    registerTestWebSearchModel("client-interleaved-th", "antigravity", model, true);
    const c = stream(model, wsReq(model), [tx("stream_it_1", `{"text":"Text A"}`), tx("stream_it_1", `{"thought":true,"text":"Reasoning R"}`), tx("stream_it_1", `{"text":"Text B"}`), stop("stream_it_1")]);
    expect(addedList(c)).toEqual([
      [0, "message"],
      [1, "reasoning"],
      [2, "message"],
    ]);
    const outputs = completedOf(c).arr("response.output");
    expect(outputs.map((o) => [o.str("type"), o.str("content.0.text")])).toEqual([
      ["message", "Text A"],
      ["reasoning", ""],
      ["message", "Text B"],
    ]);
  });
  test("with grounding metadata preserves text -> thought -> text order and attaches citations", () => {
    registerTestWebSearchModel("client-interleaved-th", "antigravity", model, true);
    const c = stream(model, wsReq(model), [
      tx("stream_it_2", `{"text":"Text A"}`),
      tx("stream_it_2", `{"thought":true,"text":"Reasoning R"}`),
      `data: {"responseId":"stream_it_2","candidates":[{"content":{"role":"model","parts":[{"text":"Text B"}]},
				"groundingMetadata":{"webSearchQueries":["search B"],"groundingChunks":[${web("https://example.com/a", "A Source")},${web("https://example.com/b", "B Source")}],
					"groundingSupports":[${supp([0], 0, 6, 0)},${supp([1], 0, 6, 2)}]}}]}`,
      stop("stream_it_2"),
    ]);
    expect(addedList(c)).toEqual([
      [0, "message"],
      [1, "reasoning"],
      [2, "web_search_call"],
      [3, "message"],
    ]);
    const outputs = completedOf(c).arr("response.output");
    expect(outputs.length).toBe(4);
    expect([outputs[0]!.str("content.0.text"), outputs[3]!.str("content.0.text")]).toEqual(["Text A", "Text B"]);
    expect(outputs[0]!.arr("content.0.annotations").map((a) => a.str("url"))).toEqual(["https://example.com/a"]);
    expect(outputs[3]!.arr("content.0.annotations").map((a) => a.str("url"))).toEqual(["https://example.com/b"]);
  });
});

describe("TestConvertGeminiResponseToOpenAIResponsesStream_ConsecutiveBufferedTextChunksAfterClosure", () => {
  const model = "gemini-search-consecutive-buffered";
  const helloGM = `{"webSearchQueries":["hello query"],"groundingChunks":[${web("https://example.com/hello", "Hello")},${web("https://example.com/world", "World")}],"groundingSupports":[${supp([0], 0, 11, 2)},${supp([1], 6, 11, 2)}]}`;
  const check = (c: Collected): void => {
    const outputs = completedOf(c).arr("response.output");
    expect(outputs.length).toBeGreaterThanOrEqual(4);
    const last = outputs[outputs.length - 1]!;
    expect([last.str("type"), last.str("content.0.text")]).toEqual(["message", "Hello world"]);
    expect(spans(last)).toEqual([
      [0, 11],
      [6, 11],
    ]);
  };
  test("function call followed by multiple consecutive buffered text chunks and late-arriving grounding metadata", () => {
    registerTestWebSearchModel("client-consec-buf", "antigravity", model, true);
    const req = `{"model":"${model}","input":"test query","tools":[{"type":"web_search"},{"type":"function","name":"test_tool"}]}`;
    check(
      stream(model, req, [
        tx("stream_cbc_1", `{"text":"text A"}`),
        tx("stream_cbc_1", `{"functionCall":{"name":"test_tool","args":{}}}`),
        tx("stream_cbc_1", `{"text":"Hello "}`),
        tx("stream_cbc_1", `{"text":"world"}`),
        gmf("stream_cbc_1", helloGM),
        stop("stream_cbc_1"),
      ]),
    );
  });
  test("thought followed by multiple consecutive buffered text chunks and late-arriving grounding metadata", () => {
    registerTestWebSearchModel("client-consec-buf", "antigravity", model, true);
    check(
      stream(model, wsReq(model), [
        tx("stream_cbc_2", `{"text":"text A"}`),
        tx("stream_cbc_2", `{"thought":true,"text":"Reasoning R"}`),
        tx("stream_cbc_2", `{"text":"Hello "}`),
        tx("stream_cbc_2", `{"text":"world"}`),
        gmf("stream_cbc_2", helloGM),
        stop("stream_cbc_2"),
      ]),
    );
  });
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_ConsecutiveFunctionCallsAdvancePartIndex", () => {
  const model = "gemini-consecutive-fc-part-index";
  registerTestWebSearchModel("client-consecutive-fc", "antigravity", model, true);
  const req = `{"model":"${model}","input":"test query","tools":[{"type":"web_search"},{"type":"function","function":{"name":"func_a","parameters":{"type":"object"}}},{"type":"function","function":{"name":"func_b","parameters":{"type":"object"}}}]}`;
  const c = stream(model, req, [
    tx("stream_fc_adv_1", `{"text":"Initial text."}`),
    tx("stream_fc_adv_1", `{"functionCall":{"name":"func_a","args":{}}}`),
    tx("stream_fc_adv_1", `{"functionCall":{"name":"func_b","args":{}}}`),
    tx("stream_fc_adv_1", `{"text":"Trailing citation text."}`),
    `data: {"responseId":"stream_fc_adv_1","candidates":[{"groundingMetadata":{"webSearchQueries":["test query"],"groundingChunks":[${web("https://example.com/trailing", "Trailing Source")}],
			"groundingSupports":[${supp([0], 0, 8, 3)}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":20,"totalTokenCount":25}}`,
  ]);
  const trailing = completedMessages(c).find((m) => m.str("content.0.text") === "Trailing citation text.");
  expect(trailing).toBeDefined();
  const cites = trailing!.arr("content.0.annotations");
  expect(cites.map((a) => [a.str("url"), a.int("start_index"), a.int("end_index")])).toEqual([["https://example.com/trailing", 0, 8]]);
});

describe("TestMergeGroundingMetadata", () => {
  const p = (s: string): unknown => JSON.parse(s);
  const m = (gm: unknown): J => new J(gm);
  const indices = (gm: J, i: number): number[] => gm.arr(`groundingSupports.${i}.groundingChunkIndices`).map((x) => x.int());
  const uris = (gm: J): string[] => gm.arr("groundingChunks").map((c) => c.str("web.uri"));
  const citeURLs = (gm: unknown, text: string): string[] => buildResponsesURLCitations(gm, text).map((c) => String(c.url));
  const s = (start: number, end: number, idx: number[]): string => `{"segment":{"startIndex":${start},"endIndex":${end},"partIndex":0},"groundingChunkIndices":${JSON.stringify(idx)}}`;
  test("merging disjoint chunks and supports with index remapping", () => {
    const merged = m(
      mergeGroundingMetadata(
        p(`{"webSearchQueries":["query1"],"groundingChunks":[${web("https://example.com/1", "Title 1")}],"groundingSupports":[${s(0, 5, [0])}]}`),
        p(`{"webSearchQueries":["query2"],"groundingChunks":[${web("https://example.com/2", "Title 2")}],"groundingSupports":[${s(6, 10, [1])}]}`),
      ),
    );
    expect(merged.arr("webSearchQueries").map((q) => q.str())).toEqual(["query1", "query2"]);
    expect(uris(merged)).toEqual(["https://example.com/1", "https://example.com/2"]);
    expect(merged.arr("groundingSupports").length).toBe(2);
    expect([indices(merged, 0)[0], indices(merged, 1)[0]]).toEqual([0, 1]);
  });
  test("incremental supports without chunks referencing previously seen chunk", () => {
    const merged = m(mergeGroundingMetadata(p(`{"webSearchQueries":["query1"],"groundingChunks":[${web("https://example.com/1", "Title 1")}]}`), p(`{"groundingSupports":[${s(0, 5, [0])}]}`)));
    expect(uris(merged)).toEqual(["https://example.com/1"]);
    expect(merged.arr("groundingSupports").length).toBe(1);
    expect(indices(merged, 0)).toEqual([0]);
  });
  test("overlapping chunks deduplication and remapping", () => {
    const merged = m(
      mergeGroundingMetadata(
        p(`{"groundingChunks":[{"web":{"uri":"https://example.com/1","title":""}}]}`),
        p(`{"groundingChunks":[${web("https://example.com/1", "Title 1")},${web("https://example.com/2", "Title 2")}],"groundingSupports":[${s(0, 5, [0, 2])}]}`),
      ),
    );
    expect(merged.arr("groundingChunks").length).toBe(2);
    expect(merged.str("groundingChunks.0.web.title")).toBe("Title 1");
    expect(merged.arr("groundingSupports").length).toBe(1);
    expect(indices(merged, 0)).toEqual([0, 1]);
  });
  test("deduplication of identical supports", () => {
    const merged = m(mergeGroundingMetadata(p(`{"groundingChunks":[{"web":{"uri":"https://example.com/1"}}],"groundingSupports":[${s(0, 5, [0])}]}`), p(`{"groundingSupports":[${s(0, 5, [0])},${s(6, 10, [0])}]}`)));
    expect(merged.arr("groundingSupports").length).toBe(2);
  });
  test("incremental grounding queries then supports then chunks preserves indices", () => {
    const merged1 = mergeGroundingMetadata(p(`{"webSearchQueries":["query1"]}`), p(`{"groundingSupports":[${s(0, 5, [0])}]}`));
    expect(m(merged1).arr("groundingSupports").length).toBe(1);
    expect(indices(m(merged1), 0)).toEqual([0]);
    const merged2 = mergeGroundingMetadata(merged1, p(`{"groundingChunks":[${web("https://example.com/1", "Title 1")}]}`));
    expect(uris(m(merged2))).toEqual(["https://example.com/1"]);
    expect(indices(m(merged2), 0)).toEqual([0]);
    expect(citeURLs(merged2, "Hello world")).toEqual(["https://example.com/1"]);
  });
  test("supports arrive first with index 1 then identical duplicate URL chunks arrive and deduplicate", () => {
    const merged = mergeGroundingMetadata(p(`{"groundingSupports":[${s(0, 11, [1])}]}`), p(`{"groundingChunks":[${web("https://example.com/dup", "Dup 1")},${web("https://example.com/dup", "Dup 2")}]}`));
    expect(uris(m(merged))).toEqual(["https://example.com/dup"]);
    expect(m(merged).arr("groundingSupports").length).toBe(1);
    expect(indices(m(merged), 0)).toEqual([0]);
    expect(citeURLs(merged, "Hello world")).toEqual(["https://example.com/dup"]);
  });
  test("queries in frame 1 then duplicate chunks [A, A, B] in frame 2 then supports [2] in frame 3", () => {
    const merged1 = mergeGroundingMetadata(
      p(`{"webSearchQueries":["test query"]}`),
      p(`{"groundingChunks":[${web("https://example.com/A", "Title A1")},${web("https://example.com/A", "Title A2")},${web("https://example.com/B", "Title B")}]}`),
    );
    expect(uris(m(merged1))).toEqual(["https://example.com/A", "https://example.com/B"]);
    const merged2 = mergeGroundingMetadata(merged1, p(`{"groundingSupports":[${s(0, 5, [2])},${s(6, 11, [1])}]}`));
    expect(m(merged2).arr("groundingSupports").length).toBe(2);
    expect([indices(m(merged2), 0), indices(m(merged2), 1)]).toEqual([[1], [0]]);
    expect(citeURLs(merged2, "Alpha Beta.")).toEqual(["https://example.com/B", "https://example.com/A"]);
  });
  test("existing pending support resolves to cumulative raw index rather than subsequent frame local chunk index", () => {
    const merged1 = mergeGroundingMetadata(undefined, p(`{"groundingChunks":[${web("https://example.com/A", "Chunk A")}],"groundingSupports":[${s(0, 5, [1])}]}`));
    const merged2 = mergeGroundingMetadata(merged1, p(`{"groundingChunks":[${web("https://example.com/B", "Chunk B")},${web("https://example.com/C", "Chunk C")}]}`));
    expect(uris(m(merged2))).toEqual(["https://example.com/A", "https://example.com/B", "https://example.com/C"]);
    expect(m(merged2).arr("groundingSupports").length).toBe(1);
    expect(indices(m(merged2), 0)).toEqual([1]);
    expect(citeURLs(merged2, "Alpha.")).toEqual(["https://example.com/B"]);
  });
  test("existing pending support and new frame support with same numeric index resolve correctly", () => {
    const merged1 = mergeGroundingMetadata(undefined, p(`{"groundingChunks":[${web("https://example.com/A", "Chunk A")}],"groundingSupports":[${s(0, 5, [1])}]}`));
    const merged2 = mergeGroundingMetadata(merged1, p(`{"groundingChunks":[${web("https://example.com/B", "Chunk B")},${web("https://example.com/C", "Chunk C")}],"groundingSupports":[${s(6, 11, [1])}]}`));
    expect(m(merged2).arr("groundingSupports").length).toBe(2);
    expect([indices(m(merged2), 0), indices(m(merged2), 1)]).toEqual([[1], [1]]);
    expect(citeURLs(merged2, "Alpha Beta.")).toEqual(["https://example.com/B", "https://example.com/B"]);
  });
  test("deduplicated frame 1 chunks resolve frame 2 cumulative support index correctly", () => {
    const merged1 = mergeGroundingMetadata(undefined, p(`{"groundingChunks":[${web("https://example.com/A", "Chunk A")},${web("https://example.com/A", "Chunk A")}]}`));
    const merged2 = mergeGroundingMetadata(merged1, p(`{"groundingChunks":[${web("https://example.com/B", "Chunk B")}],"groundingSupports":[${s(0, 5, [1])}]}`));
    expect(uris(m(merged2))).toEqual(["https://example.com/A", "https://example.com/B"]);
    expect(m(merged2).arr("groundingSupports").length).toBe(1);
    expect(indices(m(merged2), 0)).toEqual([0]);
    expect(citeURLs(merged2, "Alpha.")).toEqual(["https://example.com/A"]);
  });
  test("deduplicated frame 1 chunks [A, A] resolve frame 2 chunks [B, C] cumulative support [1] to A not C", () => {
    const merged1 = mergeGroundingMetadata(undefined, p(`{"groundingChunks":[${web("https://example.com/A", "Chunk A")},${web("https://example.com/A", "Chunk A")}]}`));
    const merged2 = mergeGroundingMetadata(merged1, p(`{"groundingChunks":[${web("https://example.com/B", "Chunk B")},${web("https://example.com/C", "Chunk C")}],"groundingSupports":[${s(0, 5, [1])}]}`));
    expect(uris(m(merged2))).toEqual(["https://example.com/A", "https://example.com/B", "https://example.com/C"]);
    expect(m(merged2).arr("groundingSupports").length).toBe(1);
    expect(indices(m(merged2), 0)).toEqual([0]);
    expect(citeURLs(merged2, "Alpha.")).toEqual(["https://example.com/A"]);
  });
});

test("TestMergeCitationAnnotations", () => {
  const c1 = { type: "url_citation", url: "https://example.com/1", title: "", start_index: 0, end_index: 5 };
  const c2 = { type: "url_citation", url: "https://example.com/1", title: "Title 1", start_index: 0, end_index: 5 };
  const c3 = { type: "url_citation", url: "https://example.com/2", title: "Title 2", start_index: 6, end_index: 10 };
  expect(mergeCitationAnnotations([], [c1]).length).toBe(1);
  const merged = mergeCitationAnnotations([c1], [c2, c3]);
  expect(merged.length).toBe(2);
  expect(merged[0]!.title).toBe("Title 1");
  expect(merged[1]!.url).toBe("https://example.com/2");
});

/** A Gemini stream frame with optional parts, groundingMetadata and STOP+usage. */
function fr(id: string, parts: string | undefined, gm: string | undefined, finish = false): string {
  const cand: string[] = [];
  if (parts !== undefined) cand.push(`"content":{"parts":[${parts}],"role":"model"}`);
  if (gm !== undefined) cand.push(`"groundingMetadata":${gm}`);
  if (finish) cand.push(`"finishReason":"STOP"`);
  const usage = finish ? `,"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}` : "";
  return `data: {"responseId":"${id}","candidates":[{${cand.join(",")}}]${usage}}`;
}
const sp = (start: number, end: number, idx: number[], partIndex = 0): string => supp(idx, start, end, partIndex);
const cites = (msg: J | undefined): [string, number, number][] => (msg?.arr("content.0.annotations") ?? []).map((a) => [a.str("url"), a.int("start_index"), a.int("end_index")]);
const firstOfType = (c: Collected, type: string): J | undefined =>
  completedOf(c)
    .arr("response.output")
    .find((o) => o.str("type") === type);

test("TestConvertGeminiResponseToOpenAIResponsesStream_MultipleGroundingUpdates", () => {
  const model = "gemini-multi-grounding-stream";
  registerTestWebSearchModel("client-multi-gm", "antigravity", model, true);
  const req = wsReq(model, "test search");
  const state: TranslatorState = {};
  const e1 = stream(model, req, [fr("stream_multi_gm_1", `{"text":"Alpha "}`, `{"webSearchQueries":["query alpha"],"groundingChunks":[${web("https://example.com/alpha", "Alpha")}],"groundingSupports":[${sp(0, 5, [0])}]}`)], state);
  expect(by(e1, "response.web_search_call.completed").length).toBe(0);
  expect(findWebSearchCallDone(by(e1, "response.output_item.done")).exists()).toBe(false);
  const rest = stream(model, req, [fr("stream_multi_gm_1", `{"text":"Beta."}`, `{"webSearchQueries":["query beta"],"groundingChunks":[${web("https://example.com/beta", "Beta")}],"groundingSupports":[${sp(6, 10, [1])}]}`), fr("stream_multi_gm_1", undefined, undefined, true)], state);
  const all = collect([...e1.frames, ...rest.frames]);
  const msg = firstOfType(all, "message");
  expect(msg?.str("content.0.text")).toBe("Alpha Beta.");
  expect(cites(msg)).toEqual([
    ["https://example.com/alpha", 0, 5],
    ["https://example.com/beta", 6, 10],
  ]);
  const ws = firstOfType(all, "web_search_call");
  const sources = ws!.arr("action.sources").map((s) => s.str("url"));
  expect(sources.length).toBe(2);
  const wsDone = findWebSearchCallDone(by(all, "response.output_item.done"));
  expect(wsDone.exists()).toBe(true);
  expect(wsDone.arr("item.action.sources").map((s) => s.str("url"))).toEqual(sources);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_IncrementalSupportsWithoutChunks", () => {
  const model = "gemini-incr-supports-stream";
  registerTestWebSearchModel("client-incr-sup", "antigravity", model, true);
  const c = stream(model, wsReq(model, "test search"), [
    fr("stream_incr_sup_1", `{"text":"Hello world."}`, `{"webSearchQueries":["query hw"],"groundingChunks":[${web("https://example.com/hw", "Hello World")}]}`),
    fr("stream_incr_sup_1", undefined, `{"groundingSupports":[${sp(0, 5, [0])}]}`, true),
  ]);
  expect(cites(firstOfType(c, "message"))).toEqual([["https://example.com/hw", 0, 5]]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_IncrementalGroundingQueriesSupportsChunks", () => {
  const model = "gemini-incr-q-s-c-stream";
  registerTestWebSearchModel("client-incr-qsc", "antigravity", model, true);
  const req = wsReq(model, "test search");
  const state: TranslatorState = {};
  const e1 = stream(model, req, [fr("stream_incr_qsc_1", `{"text":"Hello world."}`, `{"webSearchQueries":["query hw"]}`)], state);
  const added = by(e1, "response.output_item.added");
  expect(added.length).toBeGreaterThan(0);
  expect(added[0]!.str("item.status")).toBe("in_progress");
  expect(by(e1, "response.web_search_call.completed").length).toBe(0);
  expect(findWebSearchCallDone(by(e1, "response.output_item.done")).exists()).toBe(false);
  const rest = stream(
    model,
    req,
    [fr("stream_incr_qsc_1", undefined, `{"groundingSupports":[${sp(0, 5, [0])}]}`), fr("stream_incr_qsc_1", undefined, `{"groundingChunks":[${web("https://example.com/hw", "Hello World")}]}`, true)],
    state,
  );
  const all = collect([...e1.frames, ...rest.frames]);
  expect(cites(firstOfType(all, "message"))).toEqual([["https://example.com/hw", 0, 5]]);
  const sources = firstOfType(all, "web_search_call")!.arr("action.sources").map((s) => s.str("url"));
  expect(sources).toEqual(["https://example.com/hw"]);
  expect(findWebSearchCallDone(by(all, "response.output_item.done")).arr("item.action.sources").map((s) => s.str("url"))).toEqual(sources);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_LateSourcesAfterInterleavedFinalization", () => {
  const model = "gemini-late-sources-after-fc";
  registerTestWebSearchModel("client-late-src-fc", "antigravity", model, true);
  const req = `{"model":"${model}","input":"test search","tools":[{"type":"web_search"},{"type":"function","name":"lookup"}]}`;
  const state: TranslatorState = {};
  const e1 = stream(model, req, [fr("stream_late_src_fc_1", `{"text":"Alpha "}`, `{"webSearchQueries":["query alpha"],"groundingChunks":[${web("https://example.com/alpha", "Alpha")}]}`)], state);
  expect(by(e1, "response.web_search_call.completed").length).toBe(0);
  const e2 = stream(model, req, [fr("stream_late_src_fc_1", `{"functionCall":{"name":"lookup","args":{}}}`, undefined)], state);
  expect(by(e2, "response.web_search_call.completed").length).toBeGreaterThan(0);
  const earlyDone = findWebSearchCallDone(by(e2, "response.output_item.done"));
  expect(earlyDone.arr("item.action.sources").map((s) => s.str("url"))).toEqual(["https://example.com/alpha"]);
  const rest = stream(model, req, [fr("stream_late_src_fc_1", undefined, `{"webSearchQueries":["query beta"],"groundingChunks":[${web("https://example.com/beta", "Beta")}]}`), fr("stream_late_src_fc_1", undefined, undefined, true)], state);
  const all = collect([...e1.frames, ...e2.frames, ...rest.frames]);
  const ws = firstOfType(all, "web_search_call")!;
  expect(new Set(ws.arr("action.sources").map((s) => s.str("url")))).toEqual(new Set(["https://example.com/alpha", "https://example.com/beta"]));
  const queries = new Set(ws.arr("action.queries").map((q) => q.str()));
  expect(queries.has("query alpha") && queries.has("query beta")).toBe(true);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_CitationsSpanAcrossMessages", () => {
  const model = "gemini-stream-citation-span";
  registerTestWebSearchModel("client-citation-span", "antigravity", model, true);
  const c = stream(model, wsReq(model), [
    tx("stream_span_1", `{"text":"Hello ","partIndex":0}`),
    tx("stream_span_1", `{"functionCall":{"name":"search","args":{}},"partIndex":1}`),
    tx("stream_span_1", `{"text":"world","partIndex":0}`),
    `data: {"responseId":"stream_span_1","candidates":[{"groundingMetadata":{"webSearchQueries":["span query"],"groundingChunks":[${web("https://example.com/span", "Span")}],"groundingSupports":[${supp([0], 0, 11, 0)}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}}`,
  ]);
  const msgs = completedMessages(c);
  expect(msgs.length).toBe(2);
  expect(cites(msgs[0])).toEqual([["https://example.com/span", 0, 6]]);
  expect(cites(msgs[1])).toEqual([["https://example.com/span", 0, 5]]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_SupportsArriveFirstThenDuplicateChunksDeduplicate", () => {
  const model = "gemini-stream-dup-chunks-dedup";
  registerTestWebSearchModel("client-dup-chunks", "antigravity", model, true);
  const c = stream(model, wsReq(model, "test dup search"), [
    fr("stream_dup_dedup_1", `{"text":"Hello world."}`, undefined),
    fr("stream_dup_dedup_1", undefined, `{"groundingSupports":[${sp(0, 11, [1])}]}`),
    fr("stream_dup_dedup_1", undefined, `{"groundingChunks":[${web("https://example.com/dup", "Dup 1")},${web("https://example.com/dup", "Dup 2")}]}`, true),
  ]);
  expect(cites(firstOfType(c, "message"))).toEqual([["https://example.com/dup", 0, 11]]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_SignatureBoundaryContinuationTextChunks", () => {
  const model = "gemini-sig-boundary-continuation";
  registerTestWebSearchModel("client-sig-boundary", "antigravity", model, true);
  const sig = "EjQKMgEMOdbHO0Gd+c9Mxk4ELwPGbpCEcp2mFfYYLix2UVtBH3fL8GECc4+JITVnHF4qZDsA";
  const c = stream(model, `{"model":"${model}","input":"test query"}`, [
    tx("stream_sbc_1", `{"text":"Hello ","thoughtSignature":"${sig}","partIndex":0}`),
    tx("stream_sbc_1", `{"text":"beautiful ","partIndex":1}`),
    tx("stream_sbc_1", `{"text":"world"}`),
    `data: {"responseId":"stream_sbc_1","candidates":[{"groundingMetadata":{"webSearchQueries":["world query"],"groundingChunks":[${web("https://example.com/world", "World")}],"groundingSupports":[${supp([0], 0, 15, 1)}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15}}`,
  ]);
  const msgs = completedMessages(c);
  expect(msgs.map((m) => m.str("content.0.text"))).toEqual(["Hello ", "beautiful world"]);
  expect(cites(msgs[1])).toEqual([["https://example.com/world", 0, 15]]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_Frame2DuplicateChunksThenFrame3Supports", () => {
  const model = "gemini-stream-frame2-dup-chunks-frame3-sup";
  registerTestWebSearchModel("client-f2-f3", "antigravity", model, true);
  const c = stream(model, wsReq(model, "test dup search separate frames"), [
    fr("stream_f2_f3_1", `{"text":"Alpha Beta."}`, `{"webSearchQueries":["test query"]}`),
    fr("stream_f2_f3_1", undefined, `{"groundingChunks":[${web("https://example.com/A", "Title A1")},${web("https://example.com/A", "Title A2")},${web("https://example.com/B", "Title B")}]}`),
    fr("stream_f2_f3_1", undefined, `{"groundingSupports":[${sp(0, 5, [2])}]}`, true),
  ]);
  expect(cites(firstOfType(c, "message"))).toEqual([["https://example.com/B", 0, 5]]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_PendingSupportResolvesToCumulativeRawChunk", () => {
  const model = "gemini-stream-pending-support-raw-chunk";
  registerTestWebSearchModel("client-pending-sup", "antigravity", model, true);
  const c = stream(model, wsReq(model, "test pending support cumulative resolution"), [
    fr("stream_pend_1", `{"text":"Alpha Beta."}`, `{"webSearchQueries":["test query"],"groundingChunks":[${web("https://example.com/A", "Chunk A")}],"groundingSupports":[${sp(0, 5, [1])}]}`),
    fr("stream_pend_1", undefined, `{"groundingChunks":[${web("https://example.com/B", "Chunk B")},${web("https://example.com/C", "Chunk C")}]}`, true),
  ]);
  expect(cites(firstOfType(c, "message"))).toEqual([["https://example.com/B", 0, 5]]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_DeduplicatedChunksResolveFrame2CumulativeSupport", () => {
  const model = "gemini-stream-dedup-frame2-cumulative-support";
  registerTestWebSearchModel("client-dedup-f2-sup", "antigravity", model, true);
  const c = stream(model, wsReq(model, "test dedup cumulative resolution"), [
    fr("stream_dedup_f2_1", `{"text":"Alpha."}`, `{"webSearchQueries":["test query"],"groundingChunks":[${web("https://example.com/A", "Chunk A")},${web("https://example.com/A", "Chunk A")}]}`),
    fr("stream_dedup_f2_1", undefined, `{"groundingChunks":[${web("https://example.com/B", "Chunk B")}],"groundingSupports":[${sp(0, 5, [1])}]}`, true),
  ]);
  expect(cites(firstOfType(c, "message"))).toEqual([["https://example.com/A", 0, 5]]);
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_DeduplicatedFrame1ChunksFrame2ChunksAndSupportResolvesToFrame1", () => {
  const model = "gemini-stream-dedup-f1-f2-support-resolves-f1";
  registerTestWebSearchModel("client-dedup-f1-f2-sup", "antigravity", model, true);
  const c = stream(model, wsReq(model, "test dedup cumulative resolution with multiple frame 2 chunks"), [
    fr("stream_dedup_f1_f2_1", `{"text":"Alpha."}`, `{"webSearchQueries":["test query"],"groundingChunks":[${web("https://example.com/A", "Chunk A")},${web("https://example.com/A", "Chunk A")}]}`),
    fr("stream_dedup_f1_f2_1", undefined, `{"groundingChunks":[${web("https://example.com/B", "Chunk B")},${web("https://example.com/C", "Chunk C")}],"groundingSupports":[${sp(0, 5, [1])}]}`, true),
  ]);
  expect(cites(firstOfType(c, "message"))).toEqual([["https://example.com/A", 0, 5]]);
});

describe("TestConvertGeminiResponseToOpenAIResponses_NonWebGrounding_NoWebSearchCallOrUsage", () => {
  const model = "gemini-search-rag-test";
  const req = wsReq(model, "Summarize company policy");
  const ragGM = `{"groundingChunks":[{"retrievedContext":{"uri":"policy-doc-42","title":"Employee Handbook"}}],"groundingSupports":[${supp([0], 0, 40, 0)}]}`;
  test("stream", () => {
    registerTestWebSearchModel("client-rag-test", "antigravity", model, true);
    const c = stream(model, req, [
      tx("stream_rag_test_1", `{"text":"According to the internal policy document, vacation is 20 days."}`),
      gmf("stream_rag_test_1", ragGM),
      `data: {"responseId":"stream_rag_test_1","candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":16,"totalTokenCount":24}}`,
    ]);
    for (const ev of c.frames) expect(ev).not.toContain("web_search_call");
    const completed = completedOf(c);
    expect(completed.exists()).toBe(true);
    expect(completed.exists("response.tool_usage.web_search")).toBe(false);
    for (const out of completed.arr("response.output")) expect(out.str("type")).not.toBe("web_search_call");
  });
  test("non_stream", () => {
    registerTestWebSearchModel("client-rag-test", "antigravity", model, true);
    const out = nonStream(
      model,
      req,
      req,
      `{"responseId":"nonstream_rag_test_1","candidates":[{"content":{"role":"model","parts":[{"text":"According to the internal policy document, vacation is 20 days."}]},"groundingMetadata":${ragGM},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":16,"totalTokenCount":24}}`,
      {},
    );
    expect(g(out, "tool_usage.web_search").exists()).toBe(false);
    for (const o of g(out, "output").arr()) expect(o.str("type")).not.toBe("web_search_call");
  });
});

describe("TestConvertGeminiResponseToOpenAIResponsesStream_LateCitations_AnnotationAdded", () => {
  const model = "gemini-search-late-cite-test";
  test("message closed early by function call followed by late grounding metadata", () => {
    registerTestWebSearchModel("client-late-cite-test", "antigravity", model, true);
    const req = `{"model":"${model}","input":"What is the weather in Paris?","tools":[{"type":"web_search"},{"type":"function","function":{"name":"get_weather"}}]}`;
    const state: TranslatorState = {};
    const e1 = stream(model, req, [tx("stream_lc_fc_1", `{"text":"Paris is sunny today."}`)], state);
    const e2 = stream(model, req, [tx("stream_lc_fc_1", `{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}`)], state);
    expect(by(e2, "response.content_part.done").some((p) => p.arr("part.annotations").length === 0)).toBe(true);
    const e3 = stream(
      model,
      req,
      [
        `data: {"responseId":"stream_lc_fc_1","candidates":[{"groundingMetadata":{"webSearchQueries":["Paris weather today"],"groundingChunks":[${web("https://weather.example.com/paris", "Paris Weather")}],"groundingSupports":[${supp([0], 0, 5, 0)}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":15,"totalTokenCount":25}}`,
      ],
      state,
    );
    const all = collect([...e1.frames, ...e2.frames, ...e3.frames]);
    const anns = by(all, "response.output_text.annotation.added");
    expect(anns.length).toBe(1);
    const annEv = anns[0]!;
    expect([annEv.str("type"), annEv.int("output_index"), annEv.int("content_index"), annEv.int("annotation_index")]).toEqual(["response.output_text.annotation.added", 0, 0, 0]);
    expect(annEv.str("response_id")).not.toBe("");
    expect([annEv.str("annotation.type"), annEv.str("annotation.url"), annEv.str("annotation.title"), annEv.int("annotation.start_index"), annEv.int("annotation.end_index")]).toEqual([
      "url_citation",
      "https://weather.example.com/paris",
      "Paris Weather",
      0,
      5,
    ]);
    expect(all.eventTypes.indexOf("response.output_text.annotation.added")).toBeLessThan(all.eventTypes.indexOf("response.completed"));
    const msgOutput = completedOf(all).get("response.output.0");
    expect(msgOutput.str("type")).toBe("message");
    expect(annEv.str("item_id")).not.toBe("");
    expect(annEv.str("item_id")).toBe(msgOutput.str("id"));
    expect(cites(msgOutput)).toEqual([["https://weather.example.com/paris", 0, 5]]);
  });
  test("message closed early by thought boundary followed by multiple late citations", () => {
    registerTestWebSearchModel("client-late-cite-test", "antigravity", model, true);
    const c = stream(model, wsReq(model, "Provide details on Alpha and Beta"), [
      tx("stream_lc_tb_1", `{"text":"Alpha is active. Beta is ready."}`),
      tx("stream_lc_tb_1", `{"thought":true,"text":"Analyzing downstream steps..."}`),
      `data: {"responseId":"stream_lc_tb_1","candidates":[{"groundingMetadata":{"webSearchQueries":["Alpha and Beta status"],"groundingChunks":[${web("https://example.com/alpha", "Alpha Doc")},${web("https://example.com/beta", "Beta Doc")}],
				"groundingSupports":[${supp([0], 0, 5, 0)},${supp([1], 17, 21, 0)}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}`,
    ]);
    const anns = by(c, "response.output_text.annotation.added");
    expect(anns.map((a) => [a.int("annotation_index"), a.int("output_index"), a.str("annotation.url")])).toEqual([
      [0, 0, "https://example.com/alpha"],
      [1, 0, "https://example.com/beta"],
    ]);
    const msg = firstOfType(c, "message")!;
    for (const a of anns) expect(a.str("item_id")).toBe(msg.str("id"));
    expect(cites(msg).map((x) => x[0])).toEqual(["https://example.com/alpha", "https://example.com/beta"]);
  });
});

test("TestConvertGeminiResponseToOpenAIResponsesStream_WebSearchBufferingSignatureBoundary", () => {
  const model = "gemini-search-sig-boundary-buffering";
  registerTestWebSearchModel("client-search-sig-boundary-buf", "antigravity", model, true);
  const sig = "EjQKMgEMOdbHO0Gd+c9Mxk4ELwPGbpCEcp2mFfYYLix2UVtBH3fL8GECc4+JITVnHF4qZDsA";
  const c = stream(model, wsReq(model, "test search query"), [
    tx("stream_sb_buf_1", `{"text":"signed chunk A","thoughtSignature":"${sig}"}`),
    tx("stream_sb_buf_1", `{"text":"unsigned chunk B"}`),
    `data: {"responseId":"stream_sb_buf_1","candidates":[{"groundingMetadata":{"webSearchQueries":["test search query"],"groundingChunks":[${web("https://example.com/info", "Example Info")}],"groundingSupports":[${supp([0], 0, 16)}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}`,
  ]);
  expect(completedMessages(c).map((m) => m.str("content.0.text"))).toEqual(["signed chunk A", "unsigned chunk B"]);
  const translated = toGemini(model, JSON.stringify({ model, input: completedOf(c).get("response.output").v }));
  const visible = g(translated, "contents.0.parts")
    .arr()
    .filter((p) => !p.bool("thought") && p.str("text") !== "");
  expect(visible.map((p) => [p.str("text"), p.str("thoughtSignature")])).toEqual([
    ["signed chunk A", sig],
    ["unsigned chunk B", ""],
  ]);
});

describe("TestConvertGeminiResponseToOpenAIResponsesStream_CitationAnnotationAddedTimings", () => {
  const model = "gemini-search-ann-added-timings";
  const assertAnnotationMatches = (c: Collected, wantURL: string, wantTitle: string, wantStart: number, wantEnd: number, late: boolean): void => {
    const anns = by(c, "response.output_text.annotation.added");
    expect(anns.length).toBe(1);
    const annEv = anns[0]!;
    expect(annEv.str("type")).toBe("response.output_text.annotation.added");
    expect(annEv.str("response_id")).not.toBe("");
    expect(annEv.str("item_id")).not.toBe("");
    expect([annEv.int("content_index"), annEv.int("annotation_index")]).toEqual([0, 0]);
    expect([annEv.str("annotation.type"), annEv.str("annotation.url"), annEv.str("annotation.title"), annEv.int("annotation.start_index"), annEv.int("annotation.end_index")]).toEqual([
      "url_citation",
      wantURL,
      wantTitle,
      wantStart,
      wantEnd,
    ]);
    const msgDone = findMessageOutputItemDone(by(c, "response.output_item.done"));
    expect(msgDone.exists()).toBe(true);
    expect(annEv.str("item_id")).toBe(msgDone.str("item.id"));
    expect(annEv.int("output_index")).toBe(msgDone.int("output_index"));
    if (!late) expect(msgDone.arr("item.content.0.annotations").map((a) => a.str("url"))).toEqual([wantURL]);
    const completedMsg = by(c, "response.completed")[0]!.arr("response.output").find((o) => o.str("type") === "message");
    expect(completedMsg?.arr("content.0.annotations").map((a) => a.str("url"))).toEqual([wantURL]);
    const annIdx = c.eventTypes.indexOf("response.output_text.annotation.added");
    const completedIdx = c.eventTypes.indexOf("response.completed");
    let msgDoneIdx = -1;
    let doneSeen = 0;
    c.eventTypes.forEach((t, i) => {
      if (t !== "response.output_item.done") return;
      const payload = by(c, "response.output_item.done")[doneSeen++]!;
      if (payload.str("item.type") === "message" && msgDoneIdx === -1) msgDoneIdx = i;
    });
    expect(annIdx >= 0 && completedIdx >= 0 && annIdx < completedIdx).toBe(true);
    if (late) expect(msgDoneIdx >= 0 && annIdx > msgDoneIdx).toBe(true);
    else expect(msgDoneIdx >= 0 && annIdx < msgDoneIdx).toBe(true);
  };
  const helloGM = `{"webSearchQueries":["hello query"],"groundingChunks":[${web("https://example.com/hello", "Hello")}],"groundingSupports":[${supp([0], 0, 5, 0)}]}`;
  test("early metadata before message closes", () => {
    registerTestWebSearchModel("client-ann-added-timings", "antigravity", model, true);
    const c = stream(model, wsReq(model, "search query"), [
      `data: {"responseId":"stream_ann_early_1","candidates":[{"content":{"role":"model","parts":[{"text":"Hello world."}]},"groundingMetadata":${helloGM}}]}`,
      tx("stream_ann_early_1", `{"text":" More."}`),
      stop("stream_ann_early_1"),
    ]);
    assertAnnotationMatches(c, "https://example.com/hello", "Hello", 0, 5, false);
  });
  test("same-frame metadata with message close", () => {
    registerTestWebSearchModel("client-ann-added-timings", "antigravity", model, true);
    const c = stream(model, wsReq(model, "search query"), [
      `data: {"responseId":"stream_ann_same_1","candidates":[{"content":{"role":"model","parts":[{"text":"Hello world."}]},"groundingMetadata":${helloGM},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":8,"totalTokenCount":13}}`,
    ]);
    assertAnnotationMatches(c, "https://example.com/hello", "Hello", 0, 5, false);
  });
  test("late metadata after message closes", () => {
    registerTestWebSearchModel("client-ann-added-timings", "antigravity", model, true);
    const req = `{"model":"${model}","input":"What is the weather in Paris?","tools":[{"type":"web_search"},{"type":"function","function":{"name":"get_weather"}}]}`;
    const c = stream(model, req, [
      tx("stream_ann_late_1", `{"text":"Paris is sunny today."}`),
      tx("stream_ann_late_1", `{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}`),
      `data: {"responseId":"stream_ann_late_1","candidates":[{"groundingMetadata":{"webSearchQueries":["Paris weather today"],"groundingChunks":[${web("https://weather.example.com/paris", "Paris Weather")}],"groundingSupports":[${supp([0], 0, 5, 0)}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":15,"totalTokenCount":25}}`,
    ]);
    assertAnnotationMatches(c, "https://weather.example.com/paris", "Paris Weather", 0, 5, true);
  });
});

test("TestConvertOpenAIResponsesRequestToGemini_MixedWebSearchAndFunctions", () => {
  const model = "gemini-search-mixed";
  registerTestWebSearchModel("client-mixed", "gemini", model, true);
  const fn = `{"type":"function","name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}`;
  const out = toGemini(model, `{"model":"${model}","input":"weather in Paris","tools":[{"type":"web_search"},${fn}],"tool_choice":"auto"}`);
  expect(g(out, "toolConfig.includeServerSideToolInvocations").bool()).toBe(true);
  expect(g(out, "toolConfig.functionCallingConfig.mode").str()).toBe("AUTO");
  expect(g(out, "tools.0.googleSearch").exists()).toBe(true);
  expect(g(out, "tools.1.functionDeclarations.0.name").exists()).toBe(true);
  expect(g(toGemini(model, `{"model":"${model}","input":"weather in Paris","tools":[{"type":"web_search"}]}`), "toolConfig.includeServerSideToolInvocations").exists()).toBe(false);
  expect(g(toGemini(model, `{"model":"${model}","input":"weather in Paris","tools":[${fn}]}`), "toolConfig.includeServerSideToolInvocations").exists()).toBe(false);
  expect(g(toGemini(model, `{"model":"${model}","input":"weather in Paris","tools":[{"type":"web_search"},${fn}],"tool_choice":"none"}`), "toolConfig.includeServerSideToolInvocations").exists()).toBe(false);
});
