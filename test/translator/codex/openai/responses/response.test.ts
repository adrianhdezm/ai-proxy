// Ported from: internal/translator/codex/openai/responses/codex_openai-responses_response_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { getAt, gstr } from "../../../../../src/util/gpath.ts";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import {
  convertCodexResponseToOpenAIResponses,
  convertCodexResponseToOpenAIResponsesNonStream,
} from "../../../../../src/translator/codex/openai/responses/index.ts";
import { ApplyPatchResponsesBridge, normalizeApplyPatchResponsesRequest } from "../../../../../src/translator/common/apply_patch_responses.ts";

function get(body: string, path: string): unknown {
  const text = body.startsWith("data:") ? body.slice(5).trim() : body;
  return getAt(JSON.parse(text), path);
}
function str(body: string, path: string): string {
  return gstr(get(body, path));
}
function stream(model: string, original: string, translated: string, raw: string, state: TranslatorState = {}): string[] {
  return convertCodexResponseToOpenAIResponses(emptyContext, model, original, translated, raw, state);
}
function nonStream(model: string, raw: string, state: TranslatorState = {}): string {
  return convertCodexResponseToOpenAIResponsesNonStream(emptyContext, model, "", "", raw, state);
}

test("ConvertCodexResponseToOpenAIResponses_CreatedIncludesOriginalRequestModel", () => {
  const request = `{"model":"original-codex-model"}`;
  const translated = `{"model":"translated-codex-model"}`;
  for (const [eventName, raw] of Object.entries({
    "response.created": `data: {"type":"response.created","response":{"id":"resp_1"}}`,
    "response.in_progress": `data: {"type":"response.in_progress","response":{"id":"resp_1"}}`,
  })) {
    const outputs = stream("fallback-model", request, translated, raw);
    expect(outputs.length, eventName).toBe(1);
    expect(outputs[0]!.startsWith("data: ")).toBe(true);
    expect(str(outputs[0]!, "response.model")).toBe("original-codex-model");
  }
  // Falls back to the routed model, and leaves an existing model alone.
  expect(str(stream("fallback-model", "", "", `data: {"type":"response.created","response":{"id":"r"}}`)[0]!, "response.model")).toBe("fallback-model");
  const withModel = `data: {"type":"response.created","response":{"id":"r","model":"upstream"}}`;
  expect(stream("fallback-model", request, translated, withModel)).toEqual([withModel]);
  // Non-data lines pass through untouched.
  expect(stream("m", request, translated, "event: response.created")).toEqual(["event: response.created"]);
  expect(stream("m", request, translated, "")).toEqual([""]);
});

test("ConvertCodexResponseToOpenAIResponsesNonStreamIncomplete", () => {
  const raw = `{"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`;
  const out = nonStream("gpt-5.5", raw);
  expect(str(out, "status")).toBe("incomplete");
  expect(str(out, "incomplete_details.reason")).toBe("max_output_tokens");
  // Non-terminal events yield nothing; a bare response object passes through.
  expect(nonStream("gpt-5.5", `{"type":"response.output_text.delta","delta":"x"}`)).toBe("");
  expect(nonStream("gpt-5.5", `{"id":"resp_2","output":[]}`)).toBe(`{"id":"resp_2","output":[]}`);
});

const searchItem = `{"id":"ws_fixture_0123456789abcdef0123456789abcdef","type":"web_search_call","status":"completed","action":{"type":"search","queries":["python asyncio documentation"],"query":"python asyncio documentation","sources":[{"type":"url","url":"https://docs.python.org/3.13/library/asyncio.html"},{"type":"url","url":"https://docs.python.org/3/library/asyncio-task.html?highlight=n"}]}}`;
const messageItem = `{"id":"msg_fixture_0123456789abcdef0123456789abcdef","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Python docs","annotations":[{"type":"url_citation","start_index":0,"end_index":11,"title":"asyncio","url":"https://docs.python.org/3/library/asyncio.html?trk=article-ssr-frontend-pulse_little-text-block&utm_source=openai"}]}]}`;
const citationURL = "https://docs.python.org/3/library/asyncio.html?trk=article-ssr-frontend-pulse_little-text-block&utm_source=openai";

test("ConvertCodexResponseToOpenAIResponses_PreservesWebSearchSources", () => {
  const done = `data: {"type":"response.output_item.done","output_index":0,"item":${searchItem}}`;
  let outputs = stream("gpt-6-luna", "", "", done);
  expect(outputs.length).toBe(1);
  expect(str(outputs[0]!, "item.id")).toBe("ws_fixture_0123456789abcdef0123456789abcdef");
  const sources = get(outputs[0]!, "item.action.sources") as unknown[];
  expect(sources.length).toBe(2);
  expect(gstr(getAt(sources[0], "url"))).toBe("https://docs.python.org/3.13/library/asyncio.html");
  expect(gstr(getAt(sources[1], "url"))).toBe("https://docs.python.org/3/library/asyncio-task.html?highlight=n");

  const completed = `data: {"type":"response.completed","response":{"id":"resp_04f9","status":"completed","output":[${searchItem},${messageItem}]}}`;
  outputs = stream("gpt-6-luna", "", "", completed);
  expect(outputs.length).toBe(1);
  expect(str(outputs[0]!, "response.output.0.action.sources.1.url")).toBe("https://docs.python.org/3/library/asyncio-task.html?highlight=n");
  expect(str(outputs[0]!, "response.output.1.id")).toBe("msg_fixture_0123456789abcdef0123456789abcdef");
  expect(str(outputs[0]!, "response.output.1.content.0.annotations.0.url")).toBe(citationURL);
});

test("ConvertCodexResponseToOpenAIResponsesNonStream_PreservesWebSearchSources", () => {
  const raw = `{"type":"response.completed","response":{"id":"resp_04f9","status":"completed","output":[{"id":"ws_fixture_0123456789abcdef0123456789abcdef","type":"web_search_call","status":"completed","action":{"type":"search","query":"python asyncio documentation","sources":[{"type":"url","url":"https://docs.python.org/3.13/library/asyncio.html"},{"type":"url","url":"https://docs.python.org/3/library/asyncio-task.html?highlight=n"}]}},${messageItem}]}}`;
  const out = nonStream("gpt-6-luna", raw);
  expect(str(out, "output.0.id")).toBe("ws_fixture_0123456789abcdef0123456789abcdef");
  const sources = get(out, "output.0.action.sources") as unknown[];
  expect(sources.length).toBe(2);
  expect(gstr(getAt(sources[0], "url"))).toBe("https://docs.python.org/3.13/library/asyncio.html");
  expect(gstr(getAt(sources[1], "url"))).toBe("https://docs.python.org/3/library/asyncio-task.html?highlight=n");
  expect(str(out, "output.1.content.0.annotations.0.type")).toBe("url_citation");
  expect(str(out, "output.1.content.0.annotations.0.url")).toBe(citationURL);
});

test("ConvertCodexResponseToOpenAIResponses_MissingSourcesStayAbsentWithCitation", () => {
  const missingSearch = `{"id":"ws_missing","type":"web_search_call","status":"completed","action":{"type":"search","query":"python asyncio documentation"}}`;
  const cited = `{"id":"msg_cited","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Python docs","annotations":[{"type":"url_citation","start_index":0,"end_index":11,"title":"asyncio","url":"${citationURL}"}]}]}`;

  let outputs = stream("gpt-6-luna", "", "", `data: {"type":"response.output_item.done","output_index":0,"item":${missingSearch}}`);
  expect(outputs.length).toBe(1);
  expect(get(outputs[0]!, "item.action.sources")).toBeUndefined();

  outputs = stream("gpt-6-luna", "", "", `data: {"type":"response.completed","response":{"id":"resp_missing","status":"completed","output":[${missingSearch},${cited}]}}`);
  expect(outputs.length).toBe(1);
  expect(get(outputs[0]!, "response.output.0.action.sources")).toBeUndefined();
  expect(str(outputs[0]!, "response.output.1.content.0.annotations.0.type")).toBe("url_citation");

  const out = nonStream("gpt-6-luna", `{"type":"response.completed","response":{"id":"resp_missing","status":"completed","output":[${missingSearch},${cited}]}}`);
  expect(get(out, "output.0.action.sources")).toBeUndefined();
  expect(str(out, "output.1.content.0.annotations.0.url")).toBe(citationURL);
});

test("ApplyPatchResponsesActualRequestGatesNativeCodex", () => {
  const original = `{"tools":[{"type":"custom","name":"apply_patch"}]}`;
  const [bridged, errNormalize] = normalizeApplyPatchResponsesRequest(original);
  expect(errNormalize).toBeUndefined();
  const raw = `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"apply_patch","arguments":"{\\"input\\":\\"p\\"}"}}`;
  // Native Codex: no bridge in the state, the event is untouched.
  expect(stream("m", original, original, raw, {})).toEqual([raw]);
  // Configuration supplying the bridged request alone must not enable bridging.
  expect(stream("m", original, bridged, raw, {})).toEqual([raw]);
  // An executor-owned bridge converts the same Codex wire format.
  let out = stream("m", original, bridged, raw, { value: new ApplyPatchResponsesBridge(original) });
  expect(out.length).toBe(3);
  expect(gstr(getAt(JSON.parse(out[2]!.slice(6)), "item.input"))).toBe("p");
  const failed = new ApplyPatchResponsesBridge(original);
  out = stream("m", original, bridged, `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","name":"apply_patch","arguments":"{}"}}`, { value: failed });
  expect(out.length).toBe(1);
  expect(gstr(getAt(JSON.parse(out[0]!.slice(6)), "type"))).toBe("response.failed");
  expect(failed.toolInputError()).toBeDefined();
});
