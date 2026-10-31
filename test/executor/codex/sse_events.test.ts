// Ported from: internal/runtime/executor/codex_executor_sse_events_test.go
// Skipped cases: the buffered=true sub-cases and every bootstrap-budget case
//   (TestCodexExecuteStreamSplitHandshakeExceedingLineBudgetReleasesBootstrapWithoutFailover,
//   ...EventExceedsBudgetWhileAssemblingReleasesStream, ...EventExceedsTimeBudgetWhileAssemblingReleasesStream,
//   ...SplitCompletedAfterOutputAndClockAdvance, ...MixedFramingCommentInsideSplitEventCountsBudget,
//   ...EventExceedsByteBudgetWhileAssemblingReleasesStream): bootstrap buffering is not ported.
//   Streams use an openai-response inbound request, which this port passes through untranslated
//   (each upstream line becomes one chunk, as the Go openai-response translator did for these events);
//   the non-stream case uses a Claude request and checks the Claude response.
import { describe, expect, test } from "bun:test";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import { apiKeyAuth, claudePayload, drain, getString, getValue, jsonValid, options, request, sseResponse, stubFetch } from "./helpers.ts";

async function codexStreamChunks(stream: string): Promise<string[]> {
  const { fetch } = stubFetch(() => sseResponse(stream));
  const executor = new CodexExecutor({ fetch });
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
