// Ported from: internal/runtime/executor/codex_stream_bootstrap_buffering_test.go
// Skipped cases: every TestCodexWebsocketsExecutor_* case and executeWebsocketStreamInSession /
//   DoesNotNotifyDownstreamDisconnect / StillNotifiesDownstreamDisconnect / UnbufferedUpstreamErrorIsDeliveredBeforeDisconnectNotify /
//   PreOutputUpstreamErrorDoesNotNotifyDisconnect (websocket transport not ported);
//   TestCodexConfig_StreamBootstrapTimeoutDuration (duration-string parsing belongs to src/config; the executor takes ms).
//   Adaptations: fake upstreams are fetch stubs returning SSE bodies (Go: httptest servers); the time cases inject `now`
//   and advance it from the body's pull callback (Go: setCodexBootstrapNowForTest + a channel); Go's "none"/unset timeout is
//   streamBootstrapTimeoutMs 0. Go asserts a nil StreamResult on failover; here executeStream rejects (no result exists).
//   Go's Chat Completions downstream, which renders these frames as zero chunks, is a test-registered silent format.
//   The openai-response downstream is passed through untranslated as in the existing ported stream tests.
import { describe, expect, test } from "bun:test";
import {
  CodexExecutor,
  codexBootstrapMaxBufferedBytes,
  codexBootstrapMaxBufferedFrames,
  isCodexBootstrapBufferableEvent,
  isCodexOverloadBootstrapFailure,
} from "../../../src/executor/codex/index.ts";
import { StatusError, type StreamResult } from "../../../src/executor/types.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import { getAt, gstr } from "../../../src/util/gpath.ts";
import { tryParse } from "../../../src/util/json.ts";
import { apiKeyAuth, options, request, sseResponse, stubFetch } from "./helpers.ts";

const overloadEvent = `{"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null},"sequence_number":2}`;
const capacityEvent = `{"type":"error","error":{"message":"Selected model is at capacity. Please try a different model."},"sequence_number":2}`;
const invalidEvent = `{"type":"error","error":{"type":"invalid_request_error","code":"invalid_value","message":"Invalid input."},"sequence_number":2}`;
const createdEvent = `{"type":"response.created","response":{"id":"resp_1","model":"gpt-5.6-terra"}}`;
const inProgressEvent = `{"type":"response.in_progress","response":{"id":"resp_1"}}`;
const outputAddedEvent = `{"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","content":[]},"output_index":0}`;
const keepaliveEvent = `{"type":"keepalive","sequence_number":1}`;
const outputDeltaEvent = `{"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}`;
const completedEventBody = `{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`;
const moderationMetadataEvent = `{"type":"response.metadata","response_id":"resp_1","sequence_number":2,"metadata":{"openai_chatgpt_moderation_metadata":{"prompt":{"omnimod":{"protection_type":"omnimod"}}}}}`;

/** Stands in for Go's Chat Completions downstream: every Codex frame renders as zero chunks. */
const silentFormat = "test-silent-bootstrap";
defaultRegistry.register(silentFormat, "codex", undefined, { stream: () => [] });

/** Go: codexSSEServer: event:/data:/blank framing per event. */
function sseBody(...events: string[]): string {
  let body = "";
  for (const event of events) {
    const match = /"type":"([^"]*)"/.exec(event);
    body += `event: ${match ? match[1] : "message"}\n` + `data: ${event}\n\n`;
  }
  return body;
}

interface RunOptions {
  buffering?: boolean;
  timeoutMs?: number;
  format?: string;
  now?: () => number;
  signal?: AbortSignal;
}

function executorFor(response: () => Response, opts: RunOptions = {}): CodexExecutor {
  const { fetch } = stubFetch(response);
  return new CodexExecutor({ fetch, streamBootstrapBuffering: opts.buffering ?? true, streamBootstrapTimeoutMs: opts.timeoutMs, now: opts.now });
}

async function start(response: () => Response, opts: RunOptions = {}): Promise<{ result?: StreamResult; error?: unknown }> {
  const executor = executorFor(response, opts);
  try {
    const result = await executor.executeStream(
      apiKeyAuth(""),
      request("gpt-5.6-terra", `{"model":"gpt-5.6-terra","input":"hello"}`),
      options(opts.format ?? "openai-response", true, { signal: opts.signal }),
    );
    return { result };
  } catch (error) {
    return { error };
  }
}

/** Go: drainChunks: every payload (empty ones included, joined with "\n") and the first error. */
async function drainAll(result: StreamResult): Promise<{ combined: string; error: unknown }> {
  const payloads: string[] = [];
  try {
    for await (const chunk of result.chunks) payloads.push(chunk);
  } catch (error) {
    return { combined: payloads.join("\n"), error };
  }
  return { combined: payloads.join("\n"), error: undefined };
}

function statusOf(err: unknown): number {
  expect(err).toBeInstanceOf(StatusError);
  return (err as StatusError).statusCode;
}

/** A body whose parts are pulled one at a time; `beforePart(i)` runs right before part i is enqueued. */
function pacedResponse(parts: string[], beforePart?: (index: number) => void): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      beforePart?.(index);
      controller.enqueue(encoder.encode(parts[index]!));
      index++;
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("TestCodexExecutor_BootstrapBuffering", () => {
  test("OverloadFailsAttemptWithoutLeakingHandshake", async () => {
    const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, overloadEvent)));
    expect(result).toBeUndefined();
    expect(statusOf(error)).toBe(503);
  });

  test("CapacityFailsAttemptWithoutLeakingHandshake", async () => {
    const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, capacityEvent)));
    expect(result).toBeUndefined();
    expect(statusOf(error)).toBe(429);
  });

  test("OverloadAfterModerationMetadataFailsAttempt", async () => {
    const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, moderationMetadataEvent, overloadEvent)));
    expect(result).toBeUndefined();
    expect(statusOf(error)).toBe(503);
  });

  test("NonOverloadStaysInStream", async () => {
    const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, invalidEvent)));
    expect(error).toBeUndefined();
    const { combined, error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeDefined();
    expect(combined).toContain(`"type":"response.created"`);
    expect(statusOf(streamErr)).toBe(400);
  });

  test("BufferLimitReleasesStream", async () => {
    const events: string[] = [];
    for (let i = 0; i < codexBootstrapMaxBufferedFrames + 1; i++) events.push(`{"type":"response.in_progress","response":{"id":"resp_${i}"}}`);
    events.push(overloadEvent);
    const { result, error } = await start(() => sseResponse(sseBody(...events)));
    expect(error).toBeUndefined();
    const { error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeDefined();
  });

  test("BudgetsStaySmall (TestCodexBootstrapBudgetsStaySmall)", () => {
    expect(codexBootstrapMaxBufferedFrames).toBe(48);
    expect(codexBootstrapMaxBufferedBytes).toBe(1 << 20);
  });

  test("InStreamDeliveryNeedsRenderedFrames", async () => {
    const incomplete = `{"type":"response.incomplete","response":{"id":"resp_1","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}`;
    const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, outputAddedEvent, incomplete)), { format: silentFormat });
    expect(error).toBeUndefined();
    const { combined, error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeDefined();
    expect(combined).toBe("");
  });

  test("NonOverloadTerminalStaysInStream/empty incomplete", async () => {
    const incomplete = `{"type":"response.incomplete","response":{"id":"resp_1","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}`;
    const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, outputAddedEvent, incomplete)));
    expect(error).toBeUndefined();
    const { combined, error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeDefined();
    expect(combined).toContain(`"type":"response.created"`);
  });

  test("OversizedFrameIsNotAdmitted", async () => {
    const oversized = `{"type":"response.in_progress","response":{"id":"${"q".repeat(codexBootstrapMaxBufferedBytes * 2)}"}}`;
    const body = "data: " + oversized + "\n" + "data: " + overloadEvent + "\n\n";
    const { result, error } = await start(() => sseResponse(body));
    expect(error).toBeUndefined();
    await drainAll(result!);
  });

  test("ByteCapCountsUpstreamFrames", async () => {
    const frame = `{"type":"response.in_progress","response":{"id":"${"w".repeat(codexBootstrapMaxBufferedBytes / 8)}"}}`;
    const body = ("data: " + frame + "\n\n").repeat(10) + "data: " + overloadEvent + "\n\n";
    const { result, error } = await start(() => sseResponse(body), { format: silentFormat });
    expect(error).toBeUndefined();
    await drainAll(result!);
  });

  describe("BudgetBoundaryIsExact", () => {
    const overload = "data: " + overloadEvent + "\n\n";
    test("one line under the budget still fails over", async () => {
      const { error } = await start(() => sseResponse(": keepalive\n".repeat(codexBootstrapMaxBufferedFrames - 1) + overload));
      expect(error).toBeDefined();
    });
    test("exactly the budget still fails over", async () => {
      const { error } = await start(() => sseResponse(": keepalive\n".repeat(codexBootstrapMaxBufferedFrames) + overload));
      expect(error).toBeDefined();
    });
    test("one line over the budget releases", async () => {
      const { result, error } = await start(() => sseResponse(": keepalive\n".repeat(codexBootstrapMaxBufferedFrames + 1) + overload));
      expect(error).toBeUndefined();
      await drainAll(result!);
    });
  });

  test("EmptyDataFrameDoesNotReleaseStream", async () => {
    for (const frame of ["data:\n\n", "data: \n\n", "data:   \t\n\n"]) {
      const { result, error } = await start(() => sseResponse(frame + "data: " + overloadEvent + "\n\n"));
      expect(error).toBeDefined();
      expect(result).toBeUndefined();
    }
  });

  describe("BoundHoldsForEverySSEFraming", () => {
    const overload = "data: " + overloadEvent + "\n\n";
    const handshake = `{"type":"response.in_progress","response":{"id":"resp_1"}}`;
    const cases: Array<[string, string]> = [
      ["comment heartbeats without blank separators", ": keepalive\n".repeat(codexBootstrapMaxBufferedFrames * 4) + overload],
      ["data frames without blank separators", ("data: " + handshake + "\n").repeat(codexBootstrapMaxBufferedFrames * 4) + overload],
      ["three line framing", ("event: response.in_progress\ndata: " + handshake + "\n\n").repeat(codexBootstrapMaxBufferedFrames * 4) + overload],
      ["double blank separators", ("data: " + handshake + "\n\n\n").repeat(codexBootstrapMaxBufferedFrames * 4) + overload],
    ];
    for (const [name, body] of cases) {
      test(name, async () => {
        const { result, error } = await start(() => sseResponse(body), { format: silentFormat });
        expect(error).toBeUndefined();
        const { error: streamErr } = await drainAll(result!);
        expect(streamErr).toBeDefined();
      });
    }
  });

  test("ByteCapReleasesStream", async () => {
    const third = `{"type":"response.in_progress","response":{"id":"${"y".repeat(Math.floor(codexBootstrapMaxBufferedBytes / 3))}"}}`;
    const body = ("data: " + third + "\n\n").repeat(4) + "data: " + overloadEvent + "\n\n";
    const { result, error } = await start(() => sseResponse(body));
    expect(error).toBeUndefined();
    await drainAll(result!);
  });

  describe("NonContentFramesDoNotReleaseStream", () => {
    const cases: Array<[string, string]> = [
      ["keepalive", keepaliveEvent],
      ["output item added", outputAddedEvent],
      ["content part added", `{"type":"response.content_part.added","part":{"type":"output_text","text":""}}`],
      ["reasoning summary part added", `{"type":"response.reasoning_summary_part.added","part":{"type":"summary_text","text":""}}`],
    ];
    for (const [name, frame] of cases) {
      test(name, async () => {
        const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, frame, overloadEvent)));
        expect(result).toBeUndefined();
        expect(statusOf(error)).toBe(503);
      });
    }
  });

  describe("ContentFrameReleasesBeforeOverload", () => {
    const cases: Array<[string, string]> = [
      ["output text delta", outputDeltaEvent],
      ["web search call announced", `{"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"in_progress"},"output_index":0}`],
    ];
    for (const [name, frame] of cases) {
      test(name, async () => {
        const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, frame, overloadEvent)));
        expect(error).toBeUndefined();
        const { error: streamErr } = await drainAll(result!);
        expect(streamErr).toBeDefined();
      });
    }
  });

  test("CancelDuringBootstrapIsNotAnUpstreamFailure", async () => {
    // The body delivers response.created and then hangs; the caller cancels with frames already held.
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let pulls = 0;
    const response = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulls++;
            if (pulls === 1) {
              c.enqueue(encoder.encode("data: " + createdEvent + "\n\n"));
              return;
            }
            controller.abort();
            return new Promise<void>(() => {});
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    const { result, error } = await start(response, { signal: controller.signal });
    expect(result).toBeUndefined();
    // The caller's own cancellation surfaces itself, not an upstream classification.
    expect(error).toBe(controller.signal.reason);
  });

  describe("HeartbeatArithmeticPerFraming", () => {
    const overload = "event: error\ndata: " + overloadEvent + "\n\n";
    const cases: Array<[string, string, number]> = [
      ["three-line event:/data:/blank", "event: keepalive\ndata: " + keepaliveEvent + "\n\n", 15],
      ["two-line : keepalive comment", ": keepalive\n\n", 23],
      ["one-line : keepalive comment", ": keepalive\n", 47],
    ];
    const failsOver = async (heartbeats: number, heartbeat: string) => {
      const { result, error } = await start(() => sseResponse(heartbeat.repeat(heartbeats) + overload));
      if (result) await drainAll(result);
      return error !== undefined;
    };
    for (const [name, heartbeat, protectedCount] of cases) {
      test(name, async () => {
        expect(await failsOver(protectedCount, heartbeat)).toBe(true);
        expect(await failsOver(protectedCount + 1, heartbeat)).toBe(false);
      });
    }
  });

  test("ByteCapCountsTranslatedChunks", async () => {
    const padded = `{"type":"response.in_progress","response":{"id":"${"p".repeat(300 << 10)}"}}`;
    const { result, error } = await start(() => sseResponse(sseBody(padded, padded, overloadEvent)));
    expect(error).toBeUndefined();
    const { error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeDefined();
  });

  test("FlushesInOrderOnFirstOutput", async () => {
    const { result, error } = await start(() => sseResponse(sseBody(createdEvent, inProgressEvent, outputAddedEvent, outputDeltaEvent, completedEventBody)));
    expect(error).toBeUndefined();
    const { combined, error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeUndefined();
    const order = [`"type":"response.created"`, `"type":"response.in_progress"`, `"type":"response.output_item.added"`, `"type":"response.output_text.delta"`];
    let prev = -1;
    for (const marker of order) {
      const at = combined.indexOf(marker);
      expect(at).toBeGreaterThan(prev);
      prev = at;
    }
    for (const marker of order) expect(combined.split(marker).length - 1).toBe(1);
  });

  test("DefaultDisabledPassthrough", async () => {
    const { result, error } = await start(() => sseResponse(sseBody(createdEvent, overloadEvent)), { buffering: false });
    expect(error).toBeUndefined();
    const { error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeDefined();
    // The 503 restoration is scoped to the buffered path; unbuffered keeps 502.
    expect(statusOf(streamErr)).toBe(502);
  });

  test("ContextCancelDuringBootstrap", async () => {
    const controller = new AbortController();
    controller.abort();
    const { error } = await start(() => sseResponse(sseBody(createdEvent)), { signal: controller.signal });
    expect(error).toBeDefined();
    expect(error).toBe(controller.signal.reason);
  });
});

describe("TestCodexExecutor_BootstrapBuffering time budget", () => {
  const t0 = Date.UTC(2026, 8, 14, 12, 0, 0);

  test("TimeBudgetReleasesStream", async () => {
    let clock = t0;
    const parts = ["event: response.in_progress\ndata: " + inProgressEvent + "\n\n", "event: response.in_progress\ndata: " + inProgressEvent + "\n\n", "event: error\ndata: " + overloadEvent + "\n\n"];
    const { result, error } = await start(() => pacedResponse(parts, (i) => (i === 1 ? (clock += 11_000) : undefined)), { timeoutMs: 10_000, now: () => clock });
    expect(error).toBeUndefined();
    const { error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeDefined();
  });

  test("DisabledTimeBudget / DefaultUnsetTimeoutIsUnlimited", async () => {
    for (const timeoutMs of [0, undefined]) {
      let clock = t0;
      const parts = ["event: response.in_progress\ndata: " + inProgressEvent + "\n\n", "event: response.in_progress\ndata: " + inProgressEvent + "\n\n", "event: error\ndata: " + overloadEvent + "\n\n"];
      const { result, error } = await start(() => pacedResponse(parts, (i) => (i === 1 ? (clock += 100_000) : undefined)), { timeoutMs, now: () => clock });
      expect(error).toBeDefined();
      expect(result).toBeUndefined();
    }
  });

  test("OverloadDirectlyAfterTimeoutDeliveredInStream", async () => {
    let clock = t0;
    const parts = ["", "event: error\ndata: " + overloadEvent + "\n\n"];
    const { result, error } = await start(() => pacedResponse(parts, (i) => (i === 1 ? (clock += 11_000) : undefined)), { timeoutMs: 10_000, now: () => clock });
    expect(error).toBeUndefined();
    const { error: streamErr } = await drainAll(result!);
    expect(streamErr).toBeDefined();
  });
});

test("TestIsCodexBootstrapBufferableEvent", () => {
  const typeOf = (payload: string) => gstr(getAt(tryParse(payload), "type"));
  const hold = [
    `{"type":"response.created"}`,
    `{"type":"response.in_progress"}`,
    `{"type":"codex.rate_limits"}`,
    `{"type":"codex.response.metadata"}`,
    `{"type":"response.metadata","response_id":"resp_1","sequence_number":2,"metadata":{"openai_chatgpt_moderation_metadata":{"prompt":{}}}}`,
    keepaliveEvent,
    outputAddedEvent,
    `{"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning"}}`,
    `{"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","arguments":""}}`,
    `{"type":"response.output_item.added","item":{"id":"ct_1","type":"custom_tool_call","input":""}}`,
    `{"type":"response.output_item.added","item":{"id":"msg_2","type":"message","content":[{"type":"output_text","text":""}]}}`,
    `{"type":"response.output_item.added","item":{"id":"msg_3","type":"message","content":[{"type":"refusal","refusal":""}]}}`,
    `{"type":"response.output_item.added","item":{"id":"rs_2","type":"reasoning","summary":[{"type":"summary_text","text":""}]}}`,
    `{"type":"response.output_item.added","item":{"id":"rs_3","type":"reasoning","content":[{"type":"reasoning_text","text":""}]}}`,
    `{"type":"response.content_part.added","part":{"type":"text","text":""}}`,
    `{"type":"response.reasoning_summary_part.added","part":{"type":"reasoning_text","text":""}}`,
    `{"type":"response.content_part.added","part":{"type":"output_text","text":""}}`,
    `{"type":"response.reasoning_summary_part.added","part":{"type":"summary_text","text":""}}`,
    ``,
    `   `,
  ];
  for (const payload of hold) expect([payload, isCodexBootstrapBufferableEvent(typeOf(payload), payload)]).toEqual([payload, true]);

  const release = [
    `{"type":"response.output_text.delta","delta":"hi"}`,
    `{"type":"response.reasoning_summary_text.delta","delta":"x"}`,
    `{"type":"response.shell_call_command.delta","delta":"ls"}`,
    `{"type":"response.shell_call_output_content.delta","delta":{"stdout":"x"}}`,
    `{"type":"response.shell_call_output_content.done","output":[]}`,
    `{"type":"response.output_item.done","item":{"id":"m1","type":"message"}}`,
    `{"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"in_progress"}}`,
    `{"type":"response.output_item.added","item":{"id":"fs_1","type":"file_search_call"}}`,
    `{"type":"response.output_item.added","item":{"id":"ig_1","type":"image_generation_call"}}`,
    `{"type":"response.output_item.added","item":{"id":"x_1","type":"some_future_server_tool"}}`,
    `{"type":"response.content_part.added","part":{"type":"output_text","text":"already here"}}`,
    `{"type":"response.reasoning_summary_part.added","part":{"type":"summary_text","text":"already here"}}`,
    `{"type":"response.content_part.added","part":{"type":"output_audio","audio":"AAAA"}}`,
    `{"type":"response.content_part.added","part":{"type":"refusal","refusal":"I cannot help"}}`,
    `{"type":"response.output_item.added","item":{"id":"rf1","type":"message","content":[{"type":"refusal","refusal":"I cannot help"}]}}`,
    `{"type":"response.output_item.added","item":{"id":"m1","type":"message","content":[{"type":"output_text","text":"already generated"}]}}`,
    `{"type":"response.output_item.added","item":{"id":"r1","type":"reasoning","summary":[{"type":"summary_text","text":"already reasoned"}]}}`,
    `{"type":"response.output_item.added","item":{"id":"f1","type":"function_call","arguments":"{\\"path\\":\\"/\\"}"}}`,
    `{"type":"response.output_item.added","item":{"id":"c1","type":"custom_tool_call","input":"already here"}}`,
    `{"type":"response.output_item.added","item":{"id":"a1","type":"message","content":[{"type":"output_audio","audio":"AAAA"}]}}`,
    `{"type":"response.output_item.added","item":{"id":"i1","type":"message","content":[{"type":"output_image","image_url":"data:x"}]}}`,
    `{"type":"response.output_item.added","item":{"id":"r2","type":"reasoning","encrypted_content":"BLOB"}}`,
    `{"type":"response.output_item.added","item":{"id":"r3","type":"reasoning","content":[{"type":"reasoning_text","text":"already reasoned"}]}}`,
    `{"type":"response.web_search_call.searching","item_id":"ws_1"}`,
    completedEventBody,
    overloadEvent,
    `{"type":"response.some_future_event_we_have_never_seen"}`,
  ];
  for (const payload of release) expect([payload, isCodexBootstrapBufferableEvent(typeOf(payload), payload)]).toEqual([payload, false]);
});

test("TestIsCodexOverloadBootstrapFailureRejectsRequestFaults", () => {
  for (const body of [
    `{"error":{"type":"invalid_request_error","code":"invalid_value"}}`,
    `{"error":{"type":"authentication_error","code":"invalid_api_key"}}`,
    `{"error":{"type":"upstream_error","code":"unknown"}}`,
    `{"error":{"type":"server_error","code":"server_error","message":"An internal error occurred without retry advice"}}`,
  ]) {
    expect(isCodexOverloadBootstrapFailure(body)).toBe(false);
  }
  expect(isCodexOverloadBootstrapFailure(`{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}`)).toBe(true);
  expect(
    isCodexOverloadBootstrapFailure(
      `{"error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 2f5014c9-7cfe-4fb7-813e-ecb447da3edd in your message."}}`,
    ),
  ).toBe(true);
  expect(isCodexOverloadBootstrapFailure(`{"error":{"type":"server_error","code":"server_error","message":"You can retry your request"}}`)).toBe(true);
  expect(isCodexOverloadBootstrapFailure(`{"error":{"message":"Selected model is at capacity. Please try a different model."}}`)).toBe(true);
  expect(isCodexOverloadBootstrapFailure(`{"error":{"message":"Selected Model is at capacity"}}`)).toBe(true);
});
