// Ported from: sdk/api/handlers/openai/openai_responses_websocket_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_websocket_requests_memory_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_websocket_claimed_interrupt_test.go
// Skipped cases (this file covers the pure helpers; the socket-level cases live in responses_websocket.test.ts):
//   allocation / backing-storage cases (TestNormalizeResponseSubsequentRequestBoundsTranscriptAllocations,
//   TestResponsesWebsocketFallbackTurnBoundsTranscriptAllocations, TestResponsesWebsocketToolCacheScansDoNotCopyLargePayloads,
//   TestResponsesWebsocketToolCacheTurnDoesNotRetainRequestBackingStorage, TestMergeResponsesWebsocketInputBoundsLargeTranscriptAllocations,
//   TestNormalizeResponseSubsequentRequestDetachesSourceBuffers) and the generated reference comparison
//   TestMergeResponsesWebsocketInputMatchesReferenceAcrossGeneratedTranscripts (Go memory layout; JS has no shared buffers),
//   the "rejects invalid earlier duplicate input" subcase of TestResponsesWebsocketToolCacheScanPreservesJSONRequestSemantics
//   (JSON.parse keeps only the last duplicate key), TestAppendWebsocketEvent / TestSetWebsocketTimelineBody /
//   TestWebsocketTimelineLogFallsBackToMemoryWithoutSource (gin request-log plumbing; the in-memory timeline is covered).
import { describe, expect, test } from "bun:test";
import { isRequestFault } from "../../src/auth/manager/index.ts";
import { UpstreamWebsocketReplayRequiredError, UpstreamWebsocketTurnError } from "../../src/executor/codex/websockets/context.ts";
import { CodexWebsocketCloseError } from "../../src/executor/codex/websockets/connection.ts";
import { StatusError, type ErrorMessage } from "../../src/executor/types.ts";
import {
  ResponsesLocalInterrupt,
  WebsocketTimelineLog,
  buildResponsesWebsocketErrorPayload,
  collectResponsesWebsocketOutputItem,
  formatWebsocketTimelineEvent,
  newCollectedWebsocketOutput,
  recordPendingToolCallIDsFromPayload,
  responseCompletedOutputFromPayload,
  restoreResponsesWebsocketCompletionOutput,
  shouldExposeResponsesUpstreamError,
  shouldReleaseResponsesWebsocketPinnedAuth,
  shouldReplayResponsesWebsocketPinnedAuthFailure,
  truncateWebsocketCloseReason,
  websocketClosePayloadForUpstreamError,
  websocketJSONPayloadsFromChunk,
} from "../../src/server/responses_websocket_forward.ts";
import {
  codexLocalCompactionSummaryPrefix,
  dedupeResponsesWebsocketInputItemsByID,
  inputContainsFullTranscript,
  inputHasCodexLocalCompactionSummary,
  mergeResponsesWebsocketInput,
  normalizeResponsesWebsocketPassthroughRequest,
  normalizeResponsesWebsocketRequest,
  normalizeResponsesWebsocketRequestWithIncrementalState,
  normalizeResponsesWebsocketRequestWithMode,
  shouldReplaceWebsocketTranscript,
  syntheticResponsesWebsocketPrewarmPayloads,
} from "../../src/server/responses_websocket_requests.ts";
import {
  WebsocketToolOutputCache,
  defaultWebsocketToolCallCache,
  defaultWebsocketToolOutputCache,
  isCompleteResponsesWebsocketToolCall,
  prepareResponsesWebsocketFallbackTurn,
  recordResponsesWebsocketToolCallsFromPayloadWithCache,
  releaseResponsesWebsocketToolCaches,
  repairResponsesWebsocketToolCallsWithCache,
  repairResponsesWebsocketToolCallsWithCaches,
  repairResponsesWebsocketToolCallsWithoutRecording,
  retainResponsesWebsocketToolCaches,
  websocketDownstreamSessionKey,
} from "../../src/server/responses_websocket_toolcall_repair.ts";

type Obj = Record<string, unknown>;
const parse = (s: string | undefined) => JSON.parse(s ?? "null") as Obj;
const inputOf = (s: string | undefined) => parse(s).input as Obj[];
const ids = (s: string | undefined) => inputOf(s).map((item) => item.id);

describe("normalizeResponsesWebsocketRequest", () => {
  test("TestNormalizeResponsesWebsocketRequestCreate", () => {
    const out = normalizeResponsesWebsocketRequest(`{"type":"response.create","model":"test-model","stream":false,"input":[{"type":"message","id":"msg-1"}]}`, "", "");
    expect(out.error).toBeUndefined();
    expect("type" in parse(out.request)).toBe(false);
    expect(parse(out.request).stream).toBe(true);
    expect(parse(out.request).model).toBe("test-model");
    expect(out.lastRequest).toBe(out.request!);
  });

  test("create rejects a non-array input and a missing model", () => {
    expect(normalizeResponsesWebsocketRequest(`{"type":"response.create","model":"m","input":"x"}`, "", "").error?.statusCode).toBe(400);
    expect(normalizeResponsesWebsocketRequest(`{"type":"response.create","input":[]}`, "", "").error?.error.message).toBe("missing model in response.create request");
    expect(normalizeResponsesWebsocketRequest(`{"type":"response.bogus"}`, "", "").error?.error.message).toBe("unsupported websocket request type: response.bogus");
  });

  test("TestNormalizeResponsesWebsocketRequestCreateWithHistory", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.create","input":[{"type":"function_call_output","call_id":"call-1","id":"tool-out-1"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"message","id":"msg-1"}]}`,
      `[{"type":"function_call","id":"fc-1","call_id":"call-1"},{"type":"message","id":"assistant-1"}]`,
    );
    expect("type" in parse(out.request)).toBe(false);
    expect(parse(out.request).model).toBe("test-model");
    expect(ids(out.request)).toEqual(["msg-1", "fc-1", "assistant-1", "tool-out-1"]);
    expect(out.lastRequest).toBe(out.request!);
  });

  const historyRequest = `{"model":"test-model","stream":true,"instructions":"be helpful","input":[{"type":"message","id":"msg-1"}]}`;
  const historyOutput = `[{"type":"function_call","id":"fc-1","call_id":"call-1"},{"type":"message","id":"assistant-1"}]`;

  test("TestNormalizeResponsesWebsocketRequestWithPreviousResponseIDIncremental", () => {
    const out = normalizeResponsesWebsocketRequestWithMode(`{"type":"response.create","previous_response_id":"resp-1","input":[{"type":"function_call_output","call_id":"call-1","id":"tool-out-1"}]}`, historyRequest, historyOutput, true, false);
    const req = parse(out.request);
    expect("type" in req).toBe(false);
    expect(req.previous_response_id).toBe("resp-1");
    expect(ids(out.request)).toEqual(["tool-out-1"]);
    expect(req.model).toBe("test-model");
    expect(req.instructions).toBe("be helpful");
    expect(out.lastRequest).toBe(out.request!);
  });

  test("TestNormalizeResponsesWebsocketRequestInjectsPreviousResponseIDForIncremental", () => {
    const out = normalizeResponsesWebsocketRequestWithIncrementalState(`{"type":"response.create","input":[{"type":"function_call_output","call_id":"call-1","id":"tool-out-1"}]}`, historyRequest, historyOutput, "resp-1", [], true, false);
    expect(parse(out.request).previous_response_id).toBe("resp-1");
    expect(ids(out.request)).toEqual(["tool-out-1"]);
    expect(parse(out.request).instructions).toBe("be helpful");
  });

  test("TestNormalizeResponsesWebsocketRequestInjectsPreviousResponseIDWhenPendingOutputIsPresent", () => {
    const out = normalizeResponsesWebsocketRequestWithIncrementalState(`{"type":"response.create","input":[{"type":"function_call_output","call_id":"call-1","id":"tool-out-1"}]}`, historyRequest, "[]", "resp-1", ["call-1"], true, false);
    expect(parse(out.request).previous_response_id).toBe("resp-1");
    expect(ids(out.request)).toEqual(["tool-out-1"]);
  });

  test("TestNormalizeResponsesWebsocketRequestSkipsPreviousResponseIDWhenPendingOutputIsMissing", () => {
    const out = normalizeResponsesWebsocketRequestWithIncrementalState(
      `{"type":"response.create","input":[{"type":"message","role":"user","id":"summary-1","content":"compacted summary"}]}`,
      historyRequest,
      `[{"type":"function_call","id":"fc-1","call_id":"call-1"}]`,
      "resp-1",
      ["call-1"],
      true,
      false,
    );
    expect("previous_response_id" in parse(out.request)).toBe(false);
    expect(ids(out.request)).toEqual(["summary-1"]);
    expect(out.lastRequest).toBe(out.request!);
  });

  test("TestNormalizeResponsesWebsocketRequestReplacesCodexLocalCompactionTranscript", () => {
    const lastRequest = `{"model":"gpt-5.6-sol","stream":true,"instructions":"be helpful","input":[{"type":"message","role":"user","id":"old-user","content":[{"type":"input_text","text":"old prompt"}]},{"type":"function_call_output","id":"old-tool-output","call_id":"old-call","output":"old result"}]}`;
    const lastOutput = `[{"type":"function_call","id":"old-tool-call","call_id":"old-call","name":"lookup","arguments":"{}"},{"type":"message","role":"assistant","id":"old-assistant","content":[{"type":"output_text","text":"old answer"}]}]`;
    const input = [
      { type: "additional_tools", role: "developer", tools: [] },
      { role: "developer", id: "initial-context", content: "workspace context" },
      { type: "message", role: "user", id: "compacted-user", content: [{ type: "input_text", text: "retained context" }] },
      { role: "user", id: "local-summary", content: codexLocalCompactionSummaryPrefix + "\nThe compacted summary." },
      { type: "message", role: "developer", id: "turn-context", content: [{ type: "input_text", text: "current workspace context" }] },
      { role: "user", id: "incoming-user", content: "continue the task" },
    ];
    const raw = JSON.stringify({ type: "response.create", input, parallel_tool_calls: true, client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: "true" } });
    const out = normalizeResponsesWebsocketRequestWithMode(raw, lastRequest, lastOutput, false, false);
    const req = parse(out.request);
    expect("previous_response_id" in req).toBe(false);
    expect(req.input).toEqual(input);
    for (const stale of ["old-user", "old-tool-output", "old-tool-call", "old-assistant"]) expect(out.request).not.toContain(stale);
    expect(req.model).toBe("gpt-5.6-sol");
    expect(req.instructions).toBe("be helpful");
    expect(req.stream).toBe(true);
    expect(req.parallel_tool_calls).toBe(true);
    expect((req.client_metadata as Obj).ws_request_header_x_openai_internal_codex_responses_lite).toBe("true");
    expect(out.lastRequest).toBe(out.request!);
  });

  test("TestShouldReplaceWebsocketTranscriptCodexLocalCompactionSemantics", () => {
    const compacted = [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "initial context" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "retained context" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: codexLocalCompactionSummaryPrefix + "\nSummary body." }] },
    ];
    expect(shouldReplaceWebsocketTranscript({ type: "response.create" }, compacted)).toBe(true);
    for (const request of [`{"type":"response.create","previous_response_id":"resp-1"}`, `{"type":"response.create","previous_response_id":""}`, `{"type":"response.create","previous_response_id":null}`]) {
      expect(shouldReplaceWebsocketTranscript(parse(request), compacted)).toBe(false);
    }
    expect(shouldReplaceWebsocketTranscript({ type: "response.append" }, compacted)).toBe(false);
    const ordinary = [
      { type: "message", role: "developer", content: "Please summarize future messages." },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Please create a compacted summary of this text." }] },
    ];
    expect(shouldReplaceWebsocketTranscript({ type: "response.create" }, ordinary)).toBe(false);
  });

  const summaryText = codexLocalCompactionSummaryPrefix + "\nSummary body.";
  for (const [name, role, content, want] of [
    ["string content", "user", summaryText, true],
    ["multiple input text parts", "user", [{ type: "input_text", text: codexLocalCompactionSummaryPrefix }, { type: "input_text", text: "\nSummary body." }], true],
    ["non-text part before summary", "user", [{ type: "input_image", image_url: "data:image/png;base64,AA==" }, { type: "input_text", text: summaryText }], true],
    ["bare prefix", "user", codexLocalCompactionSummaryPrefix, false],
    ["prefix followed by space", "user", codexLocalCompactionSummaryPrefix + " Summary body.", false],
    ["summary after ordinary text", "user", [{ type: "input_text", text: "ordinary text" }, { type: "input_text", text: summaryText }], false],
    ["developer summary", "developer", summaryText, false],
  ] as const) {
    test(`TestCodexLocalCompactionSummaryContentShapes/${name}`, () => {
      expect(inputHasCodexLocalCompactionSummary([{ type: "message", role, content }])).toBe(want);
    });
  }

  const summary = { role: "user", content: summaryText };
  for (const [name, input, want] of [
    ["Responses Lite tools first", [{ type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec" }] }, summary], true],
    ["tools after message", [summary, { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec" }] }], false],
    ["tools with user role", [{ type: "additional_tools", role: "user", tools: [{ type: "custom", name: "exec" }] }, summary], false],
    ["tools missing array", [{ type: "additional_tools", role: "developer" }, summary], false],
    ["tools not array", [{ type: "additional_tools", role: "developer", tools: {} }, summary], false],
    ["tools empty", [{ type: "additional_tools", role: "developer", tools: [] }, summary], true],
    ["malformed tool", [{ type: "additional_tools", role: "developer", tools: [null] }, summary], false],
    ["arbitrary input item", [{ type: "unknown", role: "developer" }, summary], false],
  ] as const) {
    test(`TestCodexLocalCompactionSummaryAdditionalToolsConstraints/${name}`, () => {
      expect(inputHasCodexLocalCompactionSummary(input)).toBe(want);
    });
  }

  for (const [name, item, wantReplace] of [
    ["reasoning", { type: "reasoning", id: "reasoning-1" }, false],
    ["assistant", { type: "message", role: "assistant", id: "assistant-1" }, true],
    ["function call", { type: "function_call", call_id: "call-1" }, true],
    ["function call output", { type: "function_call_output", call_id: "call-1" }, false],
    ["custom tool call", { type: "custom_tool_call", call_id: "call-1" }, true],
    ["custom tool call output", { type: "custom_tool_call_output", call_id: "call-1" }, false],
  ] as const) {
    test(`TestCodexLocalCompactionSummaryRejectsOrdinaryHistoryItems/${name}`, () => {
      const input = [item, { type: "message", role: "user", content: [{ type: "input_text", text: summaryText }] }];
      expect(inputHasCodexLocalCompactionSummary(input)).toBe(false);
      expect(shouldReplaceWebsocketTranscript({ type: "response.create" }, input)).toBe(wantReplace);
    });
  }

  test("TestNormalizeResponsesWebsocketRequestWithPreviousResponseIDMergedWhenIncrementalDisabled", () => {
    const out = normalizeResponsesWebsocketRequestWithMode(
      `{"type":"response.create","previous_response_id":"resp-1","input":[{"type":"function_call_output","call_id":"call-1","id":"tool-out-1"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"message","id":"msg-1"}]}`,
      historyOutput,
      false,
      false,
    );
    expect("previous_response_id" in parse(out.request)).toBe(false);
    expect(ids(out.request)).toEqual(["msg-1", "fc-1", "assistant-1", "tool-out-1"]);
  });

  test("TestNormalizeResponsesWebsocketRequestAppend", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.append","input":[{"type":"message","id":"msg-2"},{"type":"message","id":"msg-3"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"message","id":"msg-1"}]}`,
      `[{"type":"message","id":"assistant-1"},{"type":"function_call_output","id":"tool-out-1"}]`,
    );
    expect(ids(out.request)).toEqual(["msg-1", "assistant-1", "tool-out-1", "msg-2", "msg-3"]);
    expect(out.lastRequest).toBe(out.request!);
  });

  test("TestNormalizeResponsesWebsocketRequestAppendWithoutCreate", () => {
    expect(normalizeResponsesWebsocketRequest(`{"type":"response.append","input":[]}`, "", "").error?.statusCode).toBe(400);
  });

  test("TestNormalizeResponsesWebsocketRequestTreatsTranscriptReplacementAsReset", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.create","input":[{"type":"function_call","id":"fc-compact","call_id":"call-1","name":"tool"},{"type":"message","id":"msg-2"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"message","id":"msg-1"},{"type":"function_call","id":"fc-1","call_id":"call-1"},{"type":"function_call_output","id":"tool-out-1","call_id":"call-1"},{"type":"message","id":"assistant-1","role":"assistant"}]}`,
      `[{"type":"message","id":"assistant-1","role":"assistant"}]`,
    );
    expect("previous_response_id" in parse(out.request)).toBe(false);
    expect(ids(out.request)).toEqual(["fc-compact", "msg-2"]);
  });

  test("TestNormalizeResponsesWebsocketRequestDoesNotTreatDeveloperMessageAsReplacement", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.create","input":[{"type":"message","id":"dev-1","role":"developer"},{"type":"message","id":"msg-2"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"message","id":"msg-1"}]}`,
      `[{"type":"message","id":"assistant-1","role":"assistant"}]`,
    );
    expect(ids(out.request)).toEqual(["msg-1", "assistant-1", "dev-1", "msg-2"]);
  });

  test("TestNormalizeResponsesWebsocketRequestDropsDuplicateFunctionCallsByCallID", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.create","input":[{"type":"message","id":"msg-2"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"function_call","id":"fc-1","call_id":"call-1"},{"type":"function_call_output","id":"tool-out-1","call_id":"call-1"}]}`,
      `[{"type":"function_call","id":"fc-1","call_id":"call-1","name":"tool"}]`,
    );
    expect(ids(out.request)).toEqual(["fc-1", "tool-out-1", "msg-2"]);
  });

  test("TestNormalizeResponsesWebsocketRequestDropsDuplicateInputItemsByID", () => {
    const out = normalizeResponsesWebsocketRequestWithMode(
      `{"type":"response.create","previous_response_id":"resp-1","input":[{"type":"function_call","id":"fc-1","call_id":"call-2","name":"tool"},{"type":"function_call_output","id":"tool-out-1","call_id":"call-2"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"message","id":"msg-1","role":"user"}]}`,
      `[{"type":"function_call","id":"fc-1","call_id":"call-1","name":"tool"}]`,
      false,
      true,
    );
    const input = inputOf(out.request);
    expect(input.map((i) => i.id)).toEqual(["msg-1", "fc-1", "tool-out-1"]);
    expect(input[1]!.call_id).toBe("call-2");
  });

  test("TestNormalizeResponsesWebsocketRequestTreatsCustomToolTranscriptReplacementAsReset", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.create","input":[{"type":"custom_tool_call","id":"ctc-compact","call_id":"call-1","name":"apply_patch"},{"type":"custom_tool_call_output","id":"tool-out-compact","call_id":"call-1"},{"type":"message","id":"msg-2"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"message","id":"msg-1"}]}`,
      `[{"type":"message","id":"assistant-1","role":"assistant"}]`,
    );
    expect(ids(out.request)).toEqual(["ctc-compact", "tool-out-compact", "msg-2"]);
  });

  test("TestNormalizeResponsesWebsocketRequestDropsDuplicateCustomToolCallsByCallID", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.create","input":[{"type":"message","id":"msg-2"}]}`,
      `{"model":"test-model","stream":true,"input":[{"type":"custom_tool_call","id":"ctc-1","call_id":"call-1","name":"apply_patch"},{"type":"custom_tool_call_output","id":"tool-out-1","call_id":"call-1"}]}`,
      `[{"type":"custom_tool_call","id":"ctc-1","call_id":"call-1","name":"apply_patch"}]`,
    );
    expect(ids(out.request)).toEqual(["ctc-1", "tool-out-1", "msg-2"]);
  });

  test("TestDedupeResponsesWebsocketInputItemsByIDAfterRepair", () => {
    const out = dedupeResponsesWebsocketInputItemsByID(`{"input":[{"type":"custom_tool_call","id":"ctc-1","call_id":"call-1","name":"tool"},{"type":"custom_tool_call","id":"ctc-1","call_id":"call-2","name":"tool"},{"type":"custom_tool_call_output","id":"tool-out-1","call_id":"call-2"}]}`);
    const input = inputOf(out);
    expect(input.map((i) => [i.id, i.call_id])).toEqual([
      ["ctc-1", "call-2"],
      ["tool-out-1", "call-2"],
    ]);
  });

  test("TestDedupeResponsesWebsocketInputItemsByIDKeepsReferencedToolCall", () => {
    const out = dedupeResponsesWebsocketInputItemsByID(`{"input":[{"type":"function_call","id":"fc-1","call_id":"call-1","name":"exec_command"},{"type":"function_call","id":"fc-1","call_id":"call-2","name":"exec_command"},{"type":"function_call_output","id":"fco-1","call_id":"call-1"}]}`);
    expect(inputOf(out).map((i) => [i.id, i.call_id])).toEqual([
      ["fc-1", "call-1"],
      ["fco-1", "call-1"],
    ]);
  });

  test("TestInputContainsFullTranscript*", () => {
    expect(inputContainsFullTranscript([{ type: "message", role: "user", content: "hello" }, { type: "message", role: "assistant", content: "hi there" }])).toBe(false);
    for (const type of ["compaction", "compaction_summary"]) expect(inputContainsFullTranscript([{ type: "message", role: "user" }, { type, encrypted_content: "summary" }])).toBe(true);
    for (const raw of [`[{"type":"function_call_output","call_id":"call-1","output":"result"}]`, `[{"type":"message","role":"user","content":"next question"}]`, `[]`]) {
      expect(inputContainsFullTranscript(JSON.parse(raw))).toBe(false);
    }
  });

  const compactLast = `{"model":"gpt-5.4","stream":true,"input":[{"type":"message","role":"user","id":"msg-1","content":"original long prompt"},{"type":"message","role":"assistant","id":"msg-2","content":"original long response"},{"type":"function_call","id":"fc-1","call_id":"call-old","name":"bash","arguments":"{}"},{"type":"function_call_output","id":"fco-1","call_id":"call-old","output":"old result"}]}`;
  const compactOutput = `[{"type":"message","role":"assistant","id":"msg-3","content":"another assistant reply"},{"type":"function_call","id":"fc-2","call_id":"call-stale","name":"read","arguments":"{}"}]`;
  const compactRaw = `{"type":"response.create","input":[{"type":"message","role":"user","id":"msg-1c","content":"compacted user msg"},{"type":"compaction","encrypted_content":"conversation summary"}]}`;

  test("TestNormalizeSubsequentRequestCompactSkipsMerge", () => {
    const input = inputOf(normalizeResponsesWebsocketRequest(compactRaw, compactLast, compactOutput).request);
    expect(input.length).toBe(2);
    expect(input[0]!.id).toBe("msg-1c");
    expect(input[1]!.type).toBe("compaction");
  });

  test("TestNormalizeSubsequentRequestCompactMergesWhenCompactionReplayUnsupported", () => {
    const input = inputOf(normalizeResponsesWebsocketRequestWithMode(compactRaw, compactLast, compactOutput, false, false).request);
    expect(input.map((i) => i.id)).toEqual(["msg-1", "msg-2", "fc-1", "fco-1", "msg-3", "fc-2", "msg-1c"]);
  });

  for (const type of ["response.create", "response.append"]) {
    test(`TestNormalizeSubsequentRequestReasoningContinuationWithPreviousResponseID/${type}`, () => {
      const out = normalizeResponsesWebsocketRequest(
        JSON.stringify({ type, previous_response_id: "resp-1", input: [{ type: "reasoning", id: "reasoning-1", summary: [] }, { type: "function_call_output", id: "output-1", call_id: "old-call", output: "result" }] }),
        `{"model":"gpt-5.6-terra","stream":true,"input":[{"type":"message","role":"user","id":"old-user","content":"long history"}]}`,
        `[{"type":"function_call","id":"old-call","call_id":"old-call","name":"lookup","arguments":"{}"}]`,
      );
      expect(parse(out.request).previous_response_id).toBe("resp-1");
      expect(ids(out.request)).toEqual(["reasoning-1", "output-1"]);
    });
  }

  test("TestNormalizeSubsequentRequestDropsConsumedCompactionTrigger", () => {
    const afterTrigger = normalizeResponsesWebsocketRequestWithMode(
      `{"type":"response.create","previous_response_id":"resp-before-compact","input":[{"type":"message","role":"user","id":"msg-tool-output","content":"done"},{"type":"compaction_trigger"}]}`,
      `{"model":"gpt-5.6-sol","stream":true,"input":[{"type":"message","role":"user","id":"msg-old","content":"old prompt"}]}`,
      "",
      false,
      false,
    ).lastRequest;
    const out = normalizeResponsesWebsocketRequestWithMode(
      `{"type":"response.create","input":[{"type":"message","role":"developer","id":"msg-new-context","content":"new context"},{"type":"compaction","id":"cmp-1","encrypted_content":"opaque"},{"type":"message","role":"user","id":"msg-next","content":"continue"}]}`,
      afterTrigger,
      `[{"type":"compaction","id":"cmp-1","encrypted_content":"opaque"}]`,
      false,
      false,
    );
    expect(inputOf(out.request).some((i) => i.type === "compaction_trigger")).toBe(false);
  });

  test("TestNormalizeSubsequentRequestIncrementalInputStillMerges", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.create","input":[{"type":"function_call_output","call_id":"call-1","id":"fco-1","output":"done"}]}`,
      `{"model":"gpt-5.4","stream":true,"input":[{"type":"message","role":"user","id":"msg-1","content":"hello"}]}`,
      `[{"type":"message","role":"assistant","id":"msg-2","content":"let me check"},{"type":"function_call","id":"fc-1","call_id":"call-1","name":"bash","arguments":"{}"}]`,
    );
    expect(ids(out.request)).toEqual(["msg-1", "msg-2", "fc-1", "fco-1"]);
  });

  test("TestNormalizeSubsequentRequestAssistantInputTriggersTranscriptReplacement", () => {
    const out = normalizeResponsesWebsocketRequest(
      `{"type":"response.append","input":[{"type":"message","role":"assistant","id":"msg-3","content":"patched assistant turn"}]}`,
      `{"model":"gpt-5.4","stream":true,"input":[{"type":"message","role":"user","id":"msg-1","content":"hello"}]}`,
      `[{"type":"message","role":"assistant","id":"msg-2","content":"prior assistant"}]`,
    );
    expect(ids(out.request)).toEqual(["msg-3"]);
  });

  test("passthrough requests keep their frame and fill the model (Go: normalizeResponsesWebsocketPassthroughRequest)", () => {
    const out = normalizeResponsesWebsocketPassthroughRequest(`{"type":"response.create","previous_response_id":"resp-1","input":[]}`, "gpt-5");
    expect(parse(out.request)).toEqual({ type: "response.create", previous_response_id: "resp-1", input: [], model: "gpt-5", stream: true });
    expect(normalizeResponsesWebsocketPassthroughRequest(`not json`, "gpt-5").error?.statusCode).toBe(400);
    expect(normalizeResponsesWebsocketPassthroughRequest(`{"type":"response.create"}`, "").error?.error.message).toBe("missing model in response.create request");
  });
});

describe("mergeResponsesWebsocketInput (Go: openai_responses_websocket_requests_memory_test.go)", () => {
  test("TestMergeResponsesWebsocketInputMatchesCompatibilityScenarios", () => {
    expect(mergeResponsesWebsocketInput(`{"input":null}`, "", [{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(mergeResponsesWebsocketInput(`{}`, "not-json", [{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(mergeResponsesWebsocketInput(`null`, "[]", [])).toEqual([]);
    // Case-insensitive "input", last one wins.
    expect(mergeResponsesWebsocketInput(`{"input":[{"id":"old"}],"INPUT":[{"id":"new"}]}`, "[]", [])).toEqual([{ id: "new" }]);
    // Ids are compared after trimming; the last occurrence is kept.
    expect(mergeResponsesWebsocketInput(`{"input":[{"id":" x ","v":1}]}`, `[{"id":"x","v":2}]`, [])).toEqual([{ id: "x", v: 2 }]);
  });

  test("TestMergeResponsesWebsocketInputReturnsCompatibleErrors", () => {
    expect(() => mergeResponsesWebsocketInput(`{"input":{}}`, "[]", [])).toThrow(/invalid previous request input/);
    expect(() => mergeResponsesWebsocketInput(`not-json`, "[]", [])).toThrow(/invalid previous request input/);
    expect(() => mergeResponsesWebsocketInput(`"string"`, "[]", [])).toThrow(/invalid previous request input/);
  });
});

describe("forward helpers", () => {
  test("TestWebsocketJSONPayloadsFromChunk", () => {
    const payloads = websocketJSONPayloadsFromChunk(`event: response.created\n\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\ndata: [DONE]\n`);
    expect(payloads.length).toBe(1);
    expect(parse(payloads[0]).type).toBe("response.created");
  });

  test("TestWebsocketJSONPayloadsFromPlainJSONChunk", () => {
    const payloads = websocketJSONPayloadsFromChunk(`{"type":"response.completed","response":{"id":"resp-1"}}`);
    expect(payloads.length).toBe(1);
    expect(parse(payloads[0]).type).toBe("response.completed");
  });

  test("TestResponseCompletedOutputFromPayload", () => {
    const output = JSON.parse(responseCompletedOutputFromPayload(parse(`{"type":"response.completed","response":{"id":"resp-1","output":[{"type":"message","id":"out-1"}]}}`), newCollectedWebsocketOutput()));
    expect(output.map((i: Obj) => i.id)).toEqual(["out-1"]);
  });

  test("TestResponseCompletedOutputFromPayloadDropsIncompleteCollectedToolCalls", () => {
    const collected = newCollectedWebsocketOutput();
    collected.byIndex.set(0, `{"type":"message","id":"msg-1"}`);
    collected.byIndex.set(1, `{"type":"function_call","call_id":"call-1","name":"exec"}`);
    collected.byIndex.set(2, `{"type":"custom_tool_call","call_id":"call-2","name":"exec","input":"pwd"}`);
    const output = JSON.parse(responseCompletedOutputFromPayload(parse(`{"type":"response.completed","response":{"id":"resp-1","output":[]}}`), collected));
    expect(output.map((i: Obj) => i.type)).toEqual(["message", "custom_tool_call"]);
  });

  test("TestRestoreResponsesWebsocketCompletionOutputPreservesNonEmptyOutput", () => {
    const payload = `{"type":"response.completed","response":{"id":"resp-1","output":[{"type":"message","id":"out-1"}]}}`;
    const collected = newCollectedWebsocketOutput();
    collected.byIndex.set(0, `{"type":"function_call","id":"call-1","call_id":"call-1"}`);
    expect(restoreResponsesWebsocketCompletionOutput(payload, parse(payload), collected)).toBe(payload);
  });

  test("TestRestoreResponsesWebsocketCompletionOutputReconcilesConflictingToolCall", () => {
    const payload = `{"type":"response.completed","response":{"id":"resp-1","output":[{"type":"message","id":"msg-1"},{"type":"function_call","call_id":"call-1","name":"exec"}]}}`;
    const collected = newCollectedWebsocketOutput();
    collected.byIndex.set(0, `{"type":"custom_tool_call","id":"ctc-1","call_id":"call-1","name":"exec","input":"pwd","status":"completed"}`);
    const restored = restoreResponsesWebsocketCompletionOutput(payload, parse(payload), collected);
    const output = (parse(restored).response as Obj).output as Obj[];
    expect(output.length).toBe(2);
    expect(output[0]).toEqual({ type: "message", id: "msg-1" });
    expect(output[1]!.type).toBe("custom_tool_call");
    expect(output[1]!.input).toBe("pwd");
    // The reconciled output replays as a valid tool call / output pair on the HTTP path.
    const next = normalizeResponsesWebsocketRequestWithIncrementalState(
      `{"type":"response.create","previous_response_id":"resp-1","input":[{"type":"custom_tool_call_output","call_id":"call-1","output":"ok"}]}`,
      `{"model":"gpt-test","stream":true,"input":[{"type":"message","id":"user-1","role":"user","content":"run pwd"}]}`,
      JSON.stringify(output),
      "resp-1",
      ["call-1"],
      false,
      false,
    );
    expect("previous_response_id" in parse(next.request)).toBe(false);
    const input = inputOf(next.request);
    expect(input.length).toBe(4);
    expect(input[2]!.type).toBe("custom_tool_call");
    expect(input[3]!.type).toBe("custom_tool_call_output");
    const cache = new WebsocketToolOutputCache(60_000, 10);
    recordResponsesWebsocketToolCallsFromPayloadWithCache(cache, "session-1", parse(`{"type":"response.output_item.done","item":{"type":"custom_tool_call","id":"ctc-1","call_id":"call-1","name":"exec","input":"pwd","status":"completed"}}`));
    recordResponsesWebsocketToolCallsFromPayloadWithCache(cache, "session-1", parse(restored));
    expect(parse(cache.get("session-1", "call-1")).input).toBe("pwd");
  });

  test("TestRestoreResponsesWebsocketCompletionOutputIgnoresIncompleteCollectedToolCall", () => {
    const payload = `{"type":"response.completed","response":{"id":"resp-1","output":[{"type":"function_call","call_id":"call-1","name":"exec"}]}}`;
    const collected = newCollectedWebsocketOutput();
    collected.byIndex.set(0, `{"type":"custom_tool_call","call_id":"call-1","name":"exec"}`);
    expect(restoreResponsesWebsocketCompletionOutput(payload, parse(payload), collected)).toBe(payload);
  });

  for (const [name, item, want] of [
    ["numeric call id", `{"type":"function_call","call_id":123,"name":"exec","arguments":"{}"}`, false],
    ["boolean name", `{"type":"function_call","call_id":"call-1","name":true,"arguments":"{}"}`, false],
    ["numeric arguments", `{"type":"function_call","call_id":"call-1","name":"exec","arguments":123}`, false],
    ["object custom input", `{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":{}}`, false],
    ["valid function call", `{"type":"function_call","call_id":"call-1","name":"exec","arguments":""}`, true],
    ["valid custom tool call", `{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":""}`, true],
  ] as const) {
    test(`TestIsCompleteResponsesWebsocketToolCallRequiresStringFields/${name}`, () => {
      expect(isCompleteResponsesWebsocketToolCall(JSON.parse(item))).toBe(want);
    });
  }

  test("TestResponsesWebsocketOutputCollectorRestoresCompletedOutput", () => {
    const collected = newCollectedWebsocketOutput();
    for (const payload of [
      `{"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"reply-1","role":"assistant"}}`,
      `{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"summary-1","summary":[]}}`,
      `{"type":"response.output_item.done","item":{"type":"function_call","id":"call-1","call_id":"call-1","name":"exec","arguments":"{}"}}`,
    ]) {
      collectResponsesWebsocketOutputItem(parse(payload), collected);
    }
    const output = JSON.parse(responseCompletedOutputFromPayload(parse(`{"type":"response.completed","response":{"id":"resp-1","output":[]}}`), collected));
    expect(output.map((i: Obj) => i.id)).toEqual(["summary-1", "reply-1", "call-1"]);
  });

  test("TestRecordPendingToolCallIDsFromPayloadDropsSatisfiedCalls", () => {
    const pending = new Set<string>();
    recordPendingToolCallIDsFromPayload(
      pending,
      parse(`{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call-1","id":"fc-1","name":"a","arguments":"{}"},{"type":"function_call_output","call_id":"call-1","id":"out-1"},{"type":"custom_tool_call","call_id":"call-2","id":"ctc-1","name":"b","input":""},{"type":"custom_tool_call_output","call_id":"call-2","id":"custom-out-1"}]}}`),
    );
    expect(pending.size).toBe(0);
    recordPendingToolCallIDsFromPayload(pending, parse(`{"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-3","name":"a","arguments":"{}"}}`));
    expect([...pending]).toEqual(["call-3"]);
  });

  for (const [status, want] of [
    [400, true],
    [409, true],
    [413, true],
    [422, true],
    [401, false],
    [408, false],
    [429, false],
    [500, false],
  ] as const) {
    test(`TestShouldExposeResponsesUpstreamError/${status}`, () => {
      expect(shouldExposeResponsesUpstreamError({ statusCode: status, error: new Error(String(status)) })).toBe(want);
    });
  }

  for (const [name, status, body, want] of [
    ["bad request", 400, "bad request", true],
    ["conflict", 409, "conflict", true],
    ["entity too large", 413, "too large", true],
    ["unprocessable", 422, "unprocessable", true],
    ["cyber policy at 502", 502, `{"error":{"type":"invalid_request","code":"cyber_policy","message":"flagged"}}`, true],
    ["context length exceeded at 500", 500, `{"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"too long"}}`, true],
    ["unauthorized", 401, "invalid token", false],
    ["payment required", 402, "insufficient credits", false],
    ["forbidden", 403, "forbidden", false],
    ["too many requests", 429, "usage limit reached", false],
    ["request timeout", 408, "timeout", false],
    ["bad gateway", 502, "bad gateway", false],
    ["upstream websocket drop", 500, `{"error":{"message":"websocket: close 1006 (abnormal closure): unexpected EOF","type":"server_error","code":"internal_server_error"}}`, false],
    ["no error message", 0, "", false],
  ] as const) {
    test(`TestResponsesUpstreamErrorBodyDrivesExposure/${name}`, () => {
      const msg = { statusCode: status, error: body === "" ? (undefined as unknown as Error) : new Error(body) } as ErrorMessage;
      expect(shouldExposeResponsesUpstreamError(msg)).toBe(want);
    });
  }

  test("TestShouldReplayResponsesWebsocketPinnedAuthFailure", () => {
    expect(shouldReplayResponsesWebsocketPinnedAuthFailure({ statusCode: 401, error: new Error("x") })).toBe(true);
    expect(shouldReplayResponsesWebsocketPinnedAuthFailure({ statusCode: 429, error: new Error("x") })).toBe(true);
    expect(shouldReplayResponsesWebsocketPinnedAuthFailure({ statusCode: 500, error: new Error("x") })).toBe(false);
    expect(shouldReplayResponsesWebsocketPinnedAuthFailure({ statusCode: 0, error: new StatusError(429, "x") })).toBe(true);
  });

  test("TestShouldReleaseResponsesWebsocketPinnedAuth", () => {
    for (const status of [401, 402, 403, 429, 408, 502, 503, 504]) expect(shouldReleaseResponsesWebsocketPinnedAuth({ statusCode: status, error: new Error("x") })).toBe(true);
    expect(shouldReleaseResponsesWebsocketPinnedAuth({ statusCode: 400, error: new Error("bad request") })).toBe(false);
    for (const text of ["stream closed before response.completed", "previous_response_not_found", "ws_failed", "upstream stream closed before first payload", "empty_stream"]) {
      expect(shouldReleaseResponsesWebsocketPinnedAuth({ statusCode: 400, error: new Error(text) })).toBe(true);
    }
    expect(shouldReleaseResponsesWebsocketPinnedAuth(undefined)).toBe(false);
  });

  test("TestTruncateWebsocketCloseReason", () => {
    expect(truncateWebsocketCloseReason("short", 123)).toBe("short");
    expect(truncateWebsocketCloseReason("abcdef", 3)).toBe("abc");
    expect(truncateWebsocketCloseReason("é".repeat(10), 5)).toBe("éé");
    expect(truncateWebsocketCloseReason("x", 0)).toBe("");
  });

  test("TestWriteWebsocketCloseForUpstreamErrorMirrorsMessageTooBig / TestWebsocketReplayCloseRequiresTypedSignal", () => {
    expect(websocketClosePayloadForUpstreamError(new CodexWebsocketCloseError(1009, "too large frame"))).toEqual({ code: 1009, reason: "too large frame" });
    const mapped = new StatusError(413, `{"error":{"message":"upstream websocket message too big","type":"invalid_request_error","code":"message_too_big"}}`);
    expect(websocketClosePayloadForUpstreamError(mapped)).toEqual({ code: 1009, reason: "upstream websocket message too big" });
    expect(websocketClosePayloadForUpstreamError(new StatusError(413, "too large"))).toBeUndefined();
    expect(websocketClosePayloadForUpstreamError(new UpstreamWebsocketReplayRequiredError())).toEqual({ code: 1012, reason: "upstream requires HTTP replay" });
    // Only the typed replay signal closes with 1012, not its JSON text.
    expect(websocketClosePayloadForUpstreamError(new StatusError(426, new UpstreamWebsocketReplayRequiredError().message))).toBeUndefined();
    expect(websocketClosePayloadForUpstreamError(new CodexWebsocketCloseError(1006, ""))).toBeUndefined();
  });

  test("buildResponsesWebsocketErrorPayload keeps the upstream envelope, headers and the turn event_id", () => {
    const upstream = buildResponsesWebsocketErrorPayload({ statusCode: 429, error: new Error(`{"status":429,"error":{"type":"usage_limit_reached","message":"limit"}}`), addon: new Headers({ "x-codex-primary-used-percent": "100" }) });
    expect(parse(upstream)).toEqual({ type: "error", status: 429, headers: { "x-codex-primary-used-percent": "100" }, error: { type: "usage_limit_reached", message: "limit" } });
    const plain = parse(buildResponsesWebsocketErrorPayload({ statusCode: 400, error: new Error("websocket request requires array field: input") }));
    expect(plain).toEqual({ type: "error", status: 400, error: { message: "websocket request requires array field: input", type: "invalid_request_error" } });
    const turn = parse(buildResponsesWebsocketErrorPayload({ statusCode: 502, error: new UpstreamWebsocketTurnError({ eventId: "evt-9" }) }));
    expect((turn.error as Obj).code).toBe("upstream_websocket_lost");
    expect((turn.error as Obj).event_id).toBe("evt-9");
    expect(isRequestFault(409, new UpstreamWebsocketTurnError({ fullContextRequired: true }))).toBe(true);
  });

  test("TestAppendWebsocketTimelineEvent", () => {
    const block = formatWebsocketTimelineEvent("request", `  {"type":"response.create"}\n`, Date.UTC(2026, 3, 1, 12, 34, 56, 789));
    expect(block).toContain("Timestamp: 2026-04-01T12:34:56.789Z");
    expect(block).toContain("Event: websocket.request");
    expect(block).toContain(`{"type":"response.create"}`);
    const timeline = new WebsocketTimelineLog(true);
    timeline.append("request", "{}", 0);
    timeline.append("response", "  ", 0);
    timeline.append("response", "[]", 0);
    expect(timeline.toString().split("Event:").length).toBe(3);
    expect(new WebsocketTimelineLog(false).toString()).toBe("");
  });

  test("syntheticResponsesWebsocketPrewarmPayloads (Go: syntheticResponsesWebsocketPrewarmPayloads)", () => {
    const [created, completed] = syntheticResponsesWebsocketPrewarmPayloads(`{"model":"gpt-5"}`, Date.UTC(2026, 0, 1), () => "fixed");
    expect(parse(created).type).toBe("response.created");
    expect((parse(created).response as Obj).id).toBe("resp_prewarm_fixed");
    expect((parse(completed).response as Obj).model).toBe("gpt-5");
    expect((parse(completed).response as Obj).created_at).toBe(Date.UTC(2026, 0, 1) / 1000);
  });
});

describe("tool call repair", () => {
  test("TestRepairResponsesWebsocketToolCallsInsertsCachedOutput", () => {
    const cache = new WebsocketToolOutputCache(60_000, 10);
    const warmed = repairResponsesWebsocketToolCallsWithCache(cache, "session-1", `{"previous_response_id":"resp-1","input":[{"type":"function_call_output","call_id":"call-1","output":"ok"}]}`);
    expect(inputOf(warmed)[0]!.call_id).toBe("call-1");
    const repaired = repairResponsesWebsocketToolCallsWithCache(cache, "session-1", `{"input":[{"type":"function_call","call_id":"call-1","name":"tool"},{"type":"message","id":"msg-1"}]}`);
    expect(inputOf(repaired).map((i) => i.type)).toEqual(["function_call", "function_call_output", "message"]);
  });

  for (const sessionKey of ["dedupe-session", ""]) {
    test(`TestRepairResponsesWebsocketToolCallsDeduplicatesInputItemsByID/session_key_"${sessionKey}"`, () => {
      const repaired = repairResponsesWebsocketToolCallsWithCache(new WebsocketToolOutputCache(60_000, 10), sessionKey, `{"input":[{"type":"message","id":"msg-1","content":"old"},{"type":"message","id":"msg-1","content":"new"}]}`);
      expect(inputOf(repaired).map((i) => i.content)).toEqual(["new"]);
    });
  }

  test("TestResponsesWebsocketToolCacheTurnCommitsOnlyOnSuccess", () => {
    const key = "tool-cache-turn-commit-session";
    try {
      const { turn } = prepareResponsesWebsocketFallbackTurn(key, `{"input":[{"type":"function_call_output","id":"fco-1","call_id":"call-1","output":"cached result"}]}`);
      const next = `{"input":[{"type":"function_call","id":"fc-next","call_id":"call-1","name":"lookup","arguments":"{}"}]}`;
      expect(inputOf(repairResponsesWebsocketToolCallsWithoutRecording(key, next)).length).toBe(0);
      turn!.commit();
      const after = inputOf(repairResponsesWebsocketToolCallsWithoutRecording(key, next));
      expect(after.length).toBe(2);
      expect(after[1]!.output).toBe("cached result");
    } finally {
      defaultWebsocketToolOutputCache.deleteSession(key);
      defaultWebsocketToolCallCache.deleteSession(key);
    }
  });

  test("TestResponsesWebsocketToolCacheRetainPreventsOverlappingReleaseDeletion", () => {
    const key = "tool-cache-overlapping-retain-session";
    retainResponsesWebsocketToolCaches(key);
    retainResponsesWebsocketToolCaches(key);
    prepareResponsesWebsocketFallbackTurn(key, `{"input":[{"type":"function_call_output","id":"fco-1","call_id":"call-1","output":"kept"}]}`).turn!.commit();
    releaseResponsesWebsocketToolCaches(key);
    expect(defaultWebsocketToolOutputCache.get(key, "call-1")).toBeDefined();
    releaseResponsesWebsocketToolCaches(key);
    expect(defaultWebsocketToolOutputCache.get(key, "call-1")).toBeUndefined();
  });

  test("TestResponsesWebsocketToolCacheScanPreservesJSONRequestSemantics", () => {
    const trailing = `{"input":[{"type":"function_call","id":"fc-1","call_id":"call-1","name":"lookup","arguments":"{}"}]} trailing`;
    const t1 = prepareResponsesWebsocketFallbackTurn("trailing-data-session", trailing);
    expect(t1.payload).toBe(trailing);
    expect(t1.turn!.calls.size + t1.turn!.outputs.size).toBe(0);
    const dup = `{"input":[{"type":"function_call","id":"fc-1","call_id":"call-1","name":"lookup","arguments":"{}"}],"input":[{"type":"message","id":"message-1","role":"user","content":"hello"}]}`;
    const t2 = prepareResponsesWebsocketFallbackTurn("duplicate-input-session", dup);
    expect(t2.payload).toBe(dup);
    expect(t2.turn!.calls.size + t2.turn!.outputs.size).toBe(0);
    const caseDup = prepareResponsesWebsocketFallbackTurn("duplicate-case-input-session", `{"input":[{"type":"message","id":"shadowed","role":"user","content":"ignore"}],"INPUT":[{"type":"function_call_output","id":"fco-1","call_id":"missing-call","output":"orphan"}]}`);
    expect(parse(caseDup.payload).INPUT).toEqual([]);
    const exactDup = prepareResponsesWebsocketFallbackTurn("duplicate-exact-input-session", `{"input":[{"type":"message","id":"shadowed","role":"user","content":"ignore"}],"input":[{"type":"function_call_output","id":"fco-1","call_id":"missing-call","output":"orphan"}]}`);
    expect(inputOf(exactDup.payload)).toEqual([]);
    const prevDup = prepareResponsesWebsocketFallbackTurn("duplicate-previous-response-session", `{"previous_response_id":"resp-first","previous_response_id":null,"input":[{"type":"function_call_output","id":"fco-1","call_id":"missing-call","output":"orphan"}]}`);
    expect(inputOf(prevDup.payload)).toEqual([]);
  });

  const cases: Array<[string, (o: WebsocketToolOutputCache, c: WebsocketToolOutputCache) => void, string, string[], string?]> = [
    ["TestRepairResponsesWebsocketToolCallsDropsOrphanFunctionCall", () => {}, `{"input":[{"type":"function_call","call_id":"call-1","name":"tool"},{"type":"message","id":"msg-1"}]}`, ["message"]],
    ["TestRepairResponsesWebsocketToolCallsInsertsCachedCallForOrphanOutput", (_o, c) => c.record("session-1", "call-1", `{"type":"function_call","call_id":"call-1","name":"tool"}`), `{"input":[{"type":"function_call_output","call_id":"call-1","output":"ok"},{"type":"message","id":"msg-1"}]}`, ["function_call", "function_call_output", "message"]],
    ["TestRepairResponsesWebsocketToolCallsKeepsPreviousResponseOutputIncremental", (_o, c) => c.record("session-1", "call-1", `{"type":"function_call","id":"fc-1","call_id":"call-1","name":"tool"}`), `{"previous_response_id":"resp-latest","input":[{"type":"function_call_output","call_id":"call-1","id":"tool-out-1","output":"ok"},{"type":"message","id":"msg-1"}]}`, ["function_call_output", "message"], "resp-latest"],
    ["TestRepairResponsesWebsocketToolCallsKeepsPreviousResponseCallIncremental", (o) => o.record("session-1", "call-1", `{"type":"function_call_output","call_id":"call-1","id":"tool-out-1","output":"ok"}`), `{"previous_response_id":"resp-latest","input":[{"type":"function_call","id":"fc-1","call_id":"call-1","name":"tool"},{"type":"message","id":"msg-1"}]}`, ["function_call", "message"], "resp-latest"],
    ["TestRepairResponsesWebsocketToolCallsDropsOrphanOutputWhenCallMissing", () => {}, `{"input":[{"type":"function_call_output","call_id":"call-1","output":"ok"},{"type":"message","id":"msg-1"}]}`, ["message"]],
    ["TestRepairResponsesWebsocketToolCallsInsertsCachedCustomToolOutput", (o) => o.record("session-1", "call-1", `{"type":"custom_tool_call_output","call_id":"call-1","output":"ok"}`), `{"input":[{"type":"custom_tool_call","call_id":"call-1","name":"apply_patch","input":"x"},{"type":"message","id":"msg-1"}]}`, ["custom_tool_call", "custom_tool_call_output", "message"]],
    ["TestRepairResponsesWebsocketToolCallsDropsOrphanCustomToolCall", () => {}, `{"input":[{"type":"custom_tool_call","call_id":"call-1","name":"apply_patch"},{"type":"message","id":"msg-1"}]}`, ["message"]],
    ["TestRepairResponsesWebsocketToolCallsInsertsCachedCustomToolCallForOrphanOutput", (_o, c) => c.record("session-1", "call-1", `{"type":"custom_tool_call","call_id":"call-1","name":"apply_patch","input":"x"}`), `{"input":[{"type":"custom_tool_call_output","call_id":"call-1","output":"ok"},{"type":"message","id":"msg-1"}]}`, ["custom_tool_call", "custom_tool_call_output", "message"]],
    ["TestRepairResponsesWebsocketToolCallsKeepsPreviousResponseCustomToolOutputIncremental", (_o, c) => c.record("session-1", "call-1", `{"type":"custom_tool_call","call_id":"call-1","name":"apply_patch"}`), `{"previous_response_id":"resp-latest","input":[{"type":"custom_tool_call_output","call_id":"call-1","output":"ok"},{"type":"message","id":"msg-1"}]}`, ["custom_tool_call_output", "message"], "resp-latest"],
    ["TestRepairResponsesWebsocketToolCallsDropsOrphanCustomToolOutputWhenCallMissing", () => {}, `{"input":[{"type":"custom_tool_call_output","call_id":"call-1","output":"ok"},{"type":"message","id":"msg-1"}]}`, ["message"]],
    ["standalone named function_call_output without call_id is kept", () => {}, `{"input":[{"type":"function_call_output","name":"heartbeat","output":"ok"},{"type":"function_call_output","output":"anon"}]}`, ["function_call_output"]],
  ];
  for (const [name, seed, raw, wantTypes, wantPrev] of cases) {
    test(name, () => {
      const outputCache = new WebsocketToolOutputCache(60_000, 10);
      const callCache = new WebsocketToolOutputCache(60_000, 10);
      seed(outputCache, callCache);
      const repaired = repairResponsesWebsocketToolCallsWithCaches(outputCache, callCache, "session-1", raw);
      expect(inputOf(repaired).map((i) => i.type)).toEqual(wantTypes);
      if (wantPrev) expect(parse(repaired).previous_response_id).toBe(wantPrev);
    });
  }

  test("TestRecordResponsesWebsocketToolCalls*", () => {
    const cache = new WebsocketToolOutputCache(60_000, 10);
    recordResponsesWebsocketToolCallsFromPayloadWithCache(cache, "s", parse(`{"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1"}}`));
    expect(cache.get("s", "call-1")).toBeUndefined();
    recordResponsesWebsocketToolCallsFromPayloadWithCache(cache, "s", parse(`{"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1","name":"tool","arguments":"{}"}}`));
    expect(parse(cache.get("s", "call-1")).name).toBe("tool");
    recordResponsesWebsocketToolCallsFromPayloadWithCache(cache, "s", parse(`{"type":"response.completed","response":{"output":[{"type":"custom_tool_call","call_id":"call-2","name":"apply_patch","input":"x"}]}}`));
    expect(parse(cache.get("s", "call-2")).type).toBe("custom_tool_call");
    recordResponsesWebsocketToolCallsFromPayloadWithCache(cache, "s", parse(`{"type":"response.output_item.done","item":{"type":"custom_tool_call","call_id":"call-3","name":"apply_patch","input":"y"}}`));
    expect(parse(cache.get("s", "call-3")).input).toBe("y");
  });

  test("the cache evicts the oldest call beyond its per-session bound and expires idle sessions", () => {
    let now = 0;
    const cache = new WebsocketToolOutputCache(1000, 2, () => now);
    cache.record("s", "a", "{}");
    cache.record("s", "b", "{}");
    cache.record("s", "c", "{}");
    expect(cache.get("s", "a")).toBeUndefined();
    expect(cache.get("s", "c")).toBe("{}");
    now = 5000;
    expect(cache.get("s", "c")).toBeUndefined();
  });

  test("websocketDownstreamSessionKey (Go: websocketDownstreamSessionKey)", () => {
    expect(websocketDownstreamSessionKey(new Headers({ "X-Client-Request-Id": "req-1", Session_id: "s" }))).toBe("req-1");
    expect(websocketDownstreamSessionKey(new Headers({ "X-Codex-Turn-Metadata": `{"session_id":"meta-1"}` }))).toBe("meta-1");
    expect(websocketDownstreamSessionKey(new Headers({ "Session-Id": "sid" }))).toBe("sid");
    expect(websocketDownstreamSessionKey(new Headers({ Session_id: "legacy" }))).toBe("legacy");
    expect(websocketDownstreamSessionKey(new Headers())).toBe("");
  });
});

describe("ResponsesLocalInterrupt", () => {
  test("TestResponsesLocalInterruptRetainsClaimedFrameAfterEnd", () => {
    const local = new ResponsesLocalInterrupt();
    local.begin(false);
    expect(local.deliver("frame-1")).toBe(true);
    local.end();
    expect(local.takeClaimed()).toBe("frame-1");
    expect(local.deliver("frame-2")).toBe(false);
  });

  test("TestResponsesLocalInterruptRejectsWhenQueueFull", () => {
    const local = new ResponsesLocalInterrupt();
    local.begin(false);
    expect(local.deliver("frame-1")).toBe(true);
    expect(local.deliver("frame-2")).toBe(false);
    expect(local.takeClaimed()).toBe("frame-1");
    expect(local.takeClaimed()).toBeUndefined();
  });

  test("TestResponsesLocalInterruptWebsocketOwnershipIsAtomic", () => {
    const local = new ResponsesLocalInterrupt();
    local.begin(true);
    expect(local.isActive()).toBe(true);
    expect(local.deliver("frame")).toBe(false);
    local.endWebsocketTurn();
    expect(local.deliver("frame")).toBe(true);
    let woke = false;
    local.onFrame(() => {
      woke = true;
    });
    expect(woke).toBe(true);
  });
});
