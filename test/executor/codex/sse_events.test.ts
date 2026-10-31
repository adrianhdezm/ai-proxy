// Ported from: internal/runtime/executor/codex_executor_sse_events_test.go
// Skipped cases: none. The buffered=true sub-cases and the bootstrap-budget cases are at the end of
//   this file; the time-budget cases inject `now` and advance it from the body's pull callback
//   (Go: setCodexBootstrapNowForTest). Streams use an openai-response inbound request, which this port passes through untranslated
//   (each upstream line becomes one chunk, as the Go openai-response translator did for these events);
//   the non-stream case uses a Claude request and checks the Claude response.
import { describe, expect, test } from "bun:test";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import { apiKeyAuth, claudePayload, drain, getString, getValue, jsonValid, options, request, sseResponse, stubFetch } from "./helpers.ts";

async function codexStreamChunks(stream: string, buffered = false): Promise<string[]> {
  const { fetch } = stubFetch(() => sseResponse(stream));
  const executor = new CodexExecutor({ fetch, streamBootstrapBuffering: buffered });
  const result = await executor.executeStream(apiKeyAuth(""), request("gpt-5.4", `{"model":"gpt-5.4","input":"hello"}`), options("openai-response", true));
  const { chunks, error } = await drain(result);
  if (error) throw error;
  return chunks;
}

function codexAllocationStream(deltas: number, deltaSize: number): string {
  let stream = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_alloc","model":"gpt-5.4"}}\n\n';
  stream += 'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_alloc","type":"message","role":"assistant","content":[]}}\n\n';
  stream += 'data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n';
  for (let i = 0; i < deltas; i++) {
    stream += `: comment-${String(i).padStart(4, "0")}\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":${JSON.stringify(String.fromCharCode(97 + (i % 26)).repeat(deltaSize))}}\n\n`;
  }
  stream += 'data: {"type":"response.completed","response":{"id":"resp_alloc","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":128,"total_tokens":133}}}\n\n';
  return stream;
}

test("TestCodexExecuteStreamTreatsAnEventSplitAcrossDataLinesAsOneEvent", async () => {
  const completed = `{"type":"response.completed","response":{"id":"resp_split","model":"gpt-5.4","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}`;
  const cut = completed.indexOf(`"output":`);
  const created =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_split","model":"gpt-5.4"}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}\n\n';
  const oneLine = created + "event: response.completed\ndata: " + completed + "\n\n";
  const split = created + "event: response.completed\ndata: " + completed.slice(0, cut) + "\ndata: " + completed.slice(cut) + "\n\n";
  const want = await codexStreamChunks(oneLine);
  const got = await codexStreamChunks(split);
  expect(got).toEqual(want);
  const terminal = want[want.length - 1]!;
  expect(terminal).toContain(`"response.completed"`);
  expect(jsonValid(terminal.replace(/^data: /, ""))).toBe(true);
});

test("TestCodexExecuteStreamPassesADoneSentinelAfterTheCompletedEvent", async () => {
  const warnings: unknown[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const chunks = await codexStreamChunks(codexAllocationStream(2, 16) + "data: [DONE]\n\n");
    expect(chunks.some((c) => c.includes(`"response.completed"`))).toBe(true);
  } finally {
    console.warn = origWarn;
  }
  expect(warnings.filter((w) => String(w).includes("not valid JSON"))).toEqual([]);
});

test("TestCodexExecuteNonStreamReadsAnEventSplitAcrossDataLines", async () => {
  const completed = `{"type":"response.completed","response":{"id":"resp_split","object":"response","model":"gpt-5.4","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}`;
  const cut = completed.indexOf(`"output":`);
  const stream = "event: response.completed\r\ndata: " + completed.slice(0, cut) + "\r\ndata: " + completed.slice(cut) + "\r\n\r\n";
  const { fetch } = stubFetch(() => sseResponse(stream));
  const executor = new CodexExecutor({ fetch });
  const resp = await executor.execute(apiKeyAuth(""), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", false));
  expect(getString(resp.payload, "id")).toBe("resp_split");
  const content = getValue(resp.payload, "content") as Array<{ type: string; text: string }>;
  expect(content.length).toBe(1);
  expect(content[0]!.text).toBe("hi");
});

test("TestCodexExecuteStreamKeepsAnInvalidSplitEventInvalid", async () => {
  const stream =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_bad","model":"gpt-5.4"}}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_bad","status":"comp\ndata: leted","output":[]}}\n\n';
  const chunks = await codexStreamChunks(stream);
  const last = chunks[chunks.length - 1]!;
  const values = last.split("\n").map((line) => line.replace(/^data:/, "").replace(/^ /, ""));
  expect(last.startsWith("data: ")).toBe(true);
  expect(last.split("\ndata: ").length - 1).toBe(1);
  expect(jsonValid(values.join("\n"))).toBe(false);
});

test("TestCodexExecuteStreamAssemblesSplitEventsWithAndWithoutBootstrapBuffering (unbuffered)", async () => {
  const stream =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_split","model":"gpt-5.4"}}\n\n' +
    'data: {"type":"response.in_progress","response":{"id":"resp_split","output":[\ndata: {"x":1},\ndata: {"x":1}]}}\n\n' +
    'data: {"type":"response.completed","response":{"id":"resp_split","status":"completed",\ndata: "output":[]}}\n\n';
  const chunks = await codexStreamChunks(stream);
  expect(chunks.filter((c) => c === 'data: {"x":1},').length).toBe(0);
  const last = chunks[chunks.length - 1]!;
  expect(last).toContain(`"response.completed"`);
  expect(jsonValid(last.replace(/^data: /, ""))).toBe(true);
});

describe("TestCodexExecuteStreamMinimalReproFromIssue6575", () => {
  test("unbuffered", async () => {
    const stream =
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed",\ndata: "output":[]}}\n\n';
    const chunks = await codexStreamChunks(stream);
    expect(chunks.length).toBeGreaterThan(0);
    const last = chunks[chunks.length - 1]!;
    expect(last).toContain(`"response.completed"`);
    expect(jsonValid(last.replace(/^data: /, ""))).toBe(true);
  });

  test("Claude inbound: the split completion still ends the Claude stream", async () => {
    const stream =
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed",\ndata: "output":[]}}\n\n';
    const { fetch } = stubFetch(() => sseResponse(stream));
    const executor = new CodexExecutor({ fetch });
    const result = await executor.executeStream(apiKeyAuth(""), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", true));
    const { chunks, error } = await drain(result);
    expect(error).toBeUndefined();
    const joined = chunks.join("");
    expect(joined).toContain("event: message_start");
    expect(joined).toContain("event: message_stop");
  });
});

// ---------------------------------------------------------------------------
// buffered=true sub-cases and bootstrap budgets while assembling split events
// ---------------------------------------------------------------------------

const overloadEvent = `{"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null},"sequence_number":2}`;

/** Runs a buffered stream; returns the chunks, the stream error and whether executeStream itself failed. */
async function bufferedRun(response: () => Response, now?: () => number, timeoutMs?: number): Promise<{ chunks: string[]; error: unknown; startError: unknown }> {
  const { fetch } = stubFetch(response);
  const executor = new CodexExecutor({ fetch, streamBootstrapBuffering: true, now, streamBootstrapTimeoutMs: timeoutMs });
  let result;
  try {
    result = await executor.executeStream(apiKeyAuth(""), request("gpt-5.4", `{"model":"gpt-5.4","input":"hello"}`), options("openai-response", true));
  } catch (startError) {
    return { chunks: [], error: undefined, startError };
  }
  const { chunks, error } = await drain(result);
  return { chunks, error, startError: undefined };
}

function pacedResponse(parts: string[], beforePart: (index: number) => void): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= parts.length) {
          controller.close();
          return;
        }
        beforePart(index);
        controller.enqueue(encoder.encode(parts[index]!));
        index++;
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

test("TestCodexExecuteStreamTreatsAnEventSplitAcrossDataLinesAsOneEvent (buffered=true)", async () => {
  const completed = `{"type":"response.completed","response":{"id":"resp_split","model":"gpt-5.4","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}`;
  const cut = completed.indexOf(`"output":`);
  const created =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_split","model":"gpt-5.4"}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}\n\n';
  const want = await codexStreamChunks(created + "event: response.completed\ndata: " + completed + "\n\n", true);
  const got = await codexStreamChunks(created + "event: response.completed\ndata: " + completed.slice(0, cut) + "\ndata: " + completed.slice(cut) + "\n\n", true);
  expect(got).toEqual(want);
  const terminal = want[want.length - 1]!;
  expect(terminal).toContain(`"response.completed"`);
  expect(jsonValid(terminal.replace(/^data: /, ""))).toBe(true);
});

test("TestCodexExecuteStreamAssemblesSplitEventsWithAndWithoutBootstrapBuffering (buffered=true)", async () => {
  const stream =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_split","model":"gpt-5.4"}}\n\n' +
    'data: {"type":"response.in_progress","response":{"id":"resp_split","output":[\ndata: {"x":1},\ndata: {"x":1}]}}\n\n' +
    'data: {"type":"response.completed","response":{"id":"resp_split","status":"completed",\ndata: "output":[]}}\n\n';
  const chunks = await codexStreamChunks(stream, true);
  expect(chunks.filter((c) => c === 'data: {"x":1},').length).toBe(0);
  const last = chunks[chunks.length - 1]!;
  expect(last).toContain(`"response.completed"`);
  expect(jsonValid(last.replace(/^data: /, ""))).toBe(true);
});

test("TestCodexExecuteStreamMinimalReproFromIssue6575 (buffered=true)", async () => {
  const stream =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed",\ndata: "output":[]}}\n\n';
  const chunks = await codexStreamChunks(stream, true);
  expect(chunks.length).toBeGreaterThan(0);
  const last = chunks[chunks.length - 1]!;
  expect(last).toContain(`"response.completed"`);
  expect(jsonValid(last.replace(/^data: /, ""))).toBe(true);
});

test("TestCodexExecuteStreamSplitHandshakeExceedingLineBudgetReleasesBootstrapWithoutFailover", async () => {
  let stream = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_split","model":"gpt-5.4"}}\n\n';
  stream += 'data: {"type":"response.in_progress","response":{"id":"resp_split","items":[\n';
  stream += "data: \n".repeat(50);
  stream += "data: ]}}\n\n";
  stream += 'event: error\ndata: {"type":"error","error":{"type":"server_error","code":"server_overloaded","message":"The server had an error while processing your request.","param":"input"}}\n\n';
  const { error, startError } = await bufferedRun(() => sseResponse(stream));
  expect(startError).toBeUndefined();
  expect(error).toBeDefined();
});

test("TestCodexExecuteStreamEventExceedsBudgetWhileAssemblingReleasesStream", async () => {
  let stream = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_split","model":"gpt-5.4"}}\n\n';
  stream += 'data: {"type":"response.in_progress","response":{"id":"resp_split","items":[\n';
  stream += "data: \n".repeat(43);
  stream += 'data: {"key_at_boundary":123},\n';
  stream += 'data: {"key_after_boundary":456}\n';
  stream += "data: ]}}\n";
  stream += 'event: error\ndata: {"type":"error","error":{"type":"server_error","code":"server_overloaded","message":"overloaded"}}\n\n';
  const { chunks, error, startError } = await bufferedRun(() => sseResponse(stream));
  expect(startError).toBeUndefined();
  expect(error).toBeDefined();
  const inProgress = chunks.filter((c) => c.includes("response.in_progress")).pop() ?? "";
  expect(inProgress).toContain(`"key_at_boundary":123`);
  expect(inProgress).toContain(`"key_after_boundary":456`);
  expect(jsonValid(inProgress.replace(/^data: /, ""))).toBe(true);
});

test("TestCodexExecuteStreamEventExceedsTimeBudgetWhileAssemblingReleasesStream", async () => {
  let clock = Date.UTC(2026, 8, 14, 12);
  const parts = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_t"}}\n\n' + 'data: {"type":"response.in_progress","response":{"id":"resp_t","items":[\n',
    'data: {"t_item":1}\ndata: ]}}\n\n' + "event: error\ndata: " + overloadEvent + "\n\n",
  ];
  const { chunks, error, startError } = await bufferedRun(
    () => pacedResponse(parts, (i) => (i === 1 ? (clock += 11_000) : undefined)),
    () => clock,
    10_000,
  );
  expect(startError).toBeUndefined();
  expect(error).toBeDefined();
  const body = chunks.join("\n");
  expect(body).toContain("response.in_progress");
  expect(body).toContain(`"t_item":1`);
});

test("TestCodexExecuteStreamSplitCompletedAfterOutputAndClockAdvance", async () => {
  let clock = Date.UTC(2026, 8, 14, 12);
  const completed = `{"type":"response.completed","response":{"id":"resp_clock","model":"gpt-5.4","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}`;
  const cut = completed.indexOf(`"output":`);
  const parts = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_clock","model":"gpt-5.4"}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"ok"}\n\n',
    "event: response.completed\ndata: " + completed.slice(0, cut) + "\ndata: " + completed.slice(cut) + "\n\n",
  ];
  const { chunks, error, startError } = await bufferedRun(
    () => pacedResponse(parts, (i) => (i === 1 ? (clock += 20_000) : undefined)),
    () => clock,
    10_000,
  );
  expect(startError).toBeUndefined();
  expect(error).toBeUndefined();
  const body = chunks.join("\n");
  expect(body).toContain("response.completed");
  expect(body).toContain(`"id":"resp_clock"`);
});

test("TestCodexExecuteStreamMixedFramingCommentInsideSplitEventCountsBudget", async () => {
  let stream = 'data: {"type":"response.in_progress","items":[\n';
  stream += "data: \n".repeat(46);
  stream += ": keepalive-1\n";
  stream += ": keepalive-2\n";
  stream += "event: error\ndata: " + overloadEvent + "\n\n";
  stream += "data: ]}}\n\n";
  const { error, startError } = await bufferedRun(() => sseResponse(stream));
  expect(startError).toBeUndefined();
  expect(error).toBeDefined();
});

test("TestCodexExecuteStreamEventExceedsByteBudgetWhileAssemblingReleasesStream", async () => {
  let stream = 'data: {"type":"response.in_progress","items":[\n';
  const large = "x".repeat(250 * 1024);
  for (let i = 0; i < 5; i++) stream += `data: ${JSON.stringify(large)},\n`;
  stream += 'data: "last"]}\n\n';
  stream += "event: error\ndata: " + overloadEvent + "\n\n";
  const { error, startError } = await bufferedRun(() => sseResponse(stream));
  expect(startError).toBeUndefined();
  expect(error).toBeDefined();
});
