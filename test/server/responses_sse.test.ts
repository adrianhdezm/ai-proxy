// Ported from: sdk/api/handlers/openai/openai_responses_handlers_stream_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_framing_metadata_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_framing_recovery_test.go
// Skipped cases: TestSSEFrameAccumulatorKeepsEmptyCommentInMultilineData and
//   TestSSEFrameAccumulatorRecoversFragmentedJSON (the websocket frame accumulator; websockets are not ported).
//   Adaptation: Go's forwardResponsesStream(data, errs) channels become a chunk iterator that ends or throws a
//   StatusError; the handler's NormalizeTerminalError is the same executionErrorMessage + sanitize pipeline.
import { describe, expect, test } from "bun:test";
import { StatusError } from "../../src/executor/types.ts";
import { executionErrorMessage } from "../../src/server/errors.ts";
import { forwardResponsesStream } from "../../src/server/responses_handlers.ts";
import {
  ResponsesSSEFramer,
  isCodexResponsesClientRequest,
  responsesSSEDataPayload,
  responsesSSENeedsLineBreak,
  responsesStreamErrorText,
  sanitizeResponsesStreamErrorMessage,
} from "../../src/server/responses_sse.ts";
import type { ErrorMessage } from "../../src/executor/types.ts";
import { chunkIterator } from "./helpers.ts";

const codexUA = "Codex Desktop/26.803.41515";

/** Go: h.forwardResponsesStream(c, flusher, cancel, data, errs, framer) over a recorder. */
async function forward(chunks: string[], options: { userAgent?: string; error?: unknown; framer?: ResponsesSSEFramer; initial?: string } = {}): Promise<{ body: string; terminal: ErrorMessage | undefined }> {
  const codexClient = isCodexResponsesClientRequest(new Headers(options.userAgent ? { "User-Agent": options.userAgent } : {}));
  let terminal: ErrorMessage | undefined;
  const stream = forwardResponsesStream({
    initial: options.initial ?? "",
    framer: options.framer ?? new ResponsesSSEFramer(),
    plan: { kind: "forward" },
    iterator: chunkIterator(chunks, options.error)[Symbol.asyncIterator](),
    codexClient,
    normalize: (err) => sanitizeResponsesStreamErrorMessage(executionErrorMessage(err))!,
    onDone: (t) => {
      terminal = t;
    },
  });
  const body = await new Response(stream).text();
  return { body, terminal };
}

function feed(framer: ResponsesSSEFramer, ...chunks: string[]): string {
  return chunks.map((chunk) => framer.writeChunk(chunk)).join("");
}

function payloadOf(frame: string): any {
  const { payload, found } = responsesSSEDataPayload(frame);
  expect(found).toBe(true);
  return JSON.parse(payload);
}

describe("openai_responses_handlers_stream_test", () => {
  test("TestResponsesSSEFramerWaitsForEventFieldAfterData", () => {
    const framer = new ResponsesSSEFramer();
    expect(framer.writeChunk(`data: {"response":{"id":"resp-1","status":"completed"}}`)).toBe("");
    const got = framer.writeChunk("event: response.completed");
    expect(framer.terminalEvent).toBe("response.completed");
    expect(got).toContain("data: ");
    expect(got).toContain("event: response.completed");
  });

  test("TestResponsesSSEFramerFlushesMultilineDataWithoutDelimiter", () => {
    const framer = new ResponsesSSEFramer();
    const out = framer.writeChunk('event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"id":"resp-1","status":"completed"}}') + framer.flush();
    expect(framer.terminalEvent).toBe("response.completed");
    expect(out).toContain("response.completed");
  });

  test("TestResponsesSSEFramerUsesPayloadErrorOverCompletedEvent", () => {
    const framer = new ResponsesSSEFramer({ failureEvent: "response.failed" });
    const out = framer.writeChunk('data: {"type":"response.failed","response":{"status":"failed"}}\nevent: response.completed\n\n');
    expect(framer.terminalEvent).toBe("response.failed");
    expect(out).not.toContain("event: response.completed");
    expect(out.split("event: response.failed").length - 1).toBe(1);
  });

  test("TestResponsesSSEFramerUsesErrorEventOverPayloadType", () => {
    let framer = new ResponsesSSEFramer();
    framer.writeChunk('event: error\ndata: {"type":"provider.error","message":"failed"}\n\n');
    expect(framer.terminalEvent).toBe("error");
    framer = new ResponsesSSEFramer();
    framer.writeChunk('data: {"response":{"error":{"message":"failed"}}}\n\n');
    expect(framer.terminalEvent).toBe("error");
  });

  for (const tc of [
    { name: "standard client", userAgent: "openai-python/1.0" },
    { name: "codex client", userAgent: codexUA },
  ]) {
    test(`TestForwardResponsesStreamPreservesResponseFailedEventAndEnvelopeForAllClients/${tc.name}`, async () => {
      const { body } = await forward(
        [
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":1,"output_index":0,"item":{"id":"msg_1_0","type":"message","status":"incomplete","role":"assistant","content":[{"type":"output_text","text":"partial"}]}}\n\n',
          'event: response.failed\ndata: {"type":"response.failed","sequence_number":2,"response":{"id":"msg_1","object":"response","created_at":1700000000,"status":"failed","error":{"code":"context_length_exceeded","message":"Claude stopped because the conversation filled the model context window (stop_reason: model_context_window_exceeded)."},"output":[{"id":"msg_1_0","type":"message","status":"incomplete","role":"assistant","content":[{"type":"output_text","text":"partial"}]}],"usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}\n\n',
        ],
        { userAgent: tc.userAgent },
      );
      expect(body.split("event: response.failed").length - 1).toBe(1);
      expect(body).not.toContain("event: error");
      const parts = body.trim().split("\n\n");
      const payload = payloadOf(parts[parts.length - 1]!);
      expect(payload.response.id).toBe("msg_1");
      expect(payload.response.status).toBe("failed");
      expect(payload.response.error.code).toBe("context_length_exceeded");
      expect(payload.response.output).toHaveLength(1);
      expect(payload.response.usage.total_tokens).toBe(14);
    });
  }

  test("TestForwardResponsesStreamResponseFailedPreservesLongOutputWhileSanitizingError", async () => {
    const longText = "a".repeat(3000);
    const longEncrypted = "c".repeat(3000);
    const frame = `event: response.failed\ndata: {"type":"response.failed","sequence_number":3,"response":{"id":"msg_long","object":"response","status":"failed","error":{"code":"context_length_exceeded","message":"window exceeded Bearer secret-token-123"},"output":[{"id":"rs_1","type":"reasoning","status":"completed","encrypted_content":"${longEncrypted}","summary":[]},{"id":"msg_1","type":"message","status":"incomplete","role":"assistant","content":[{"type":"output_text","text":"${longText}"}]},{"id":"fc_1","type":"function_call","status":"incomplete","call_id":"call_1","name":"write","arguments":{"raw":"${"b".repeat(3000)}"}}],"usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}}\n\n`;
    const { body } = await forward([frame]);
    const payload = payloadOf(body.trim());
    expect(payload.response.output[0].encrypted_content).toBe(longEncrypted);
    expect(payload.response.output[1].content[0].text).toBe(longText);
    expect(payload.response.output[2].arguments.raw).toHaveLength(3000);
    expect(payload.response.error.message).not.toContain("secret-token-123");
    expect(payload.response.error.message).toContain("[REDACTED]");
  });

  test("TestForwardResponsesStreamSeparatesDataOnlySSEChunks", async () => {
    const { body } = await forward([
      'data: {"type":"response.output_item.done","item":{"type":"function_call","arguments":"{}"}}',
      'data: {"type":"response.completed","response":{"id":"resp-1","output":[]}}',
    ]);
    const parts = body.trim().split("\n\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('data: {"type":"response.output_item.done","item":{"type":"function_call","arguments":"{}"}}');
    expect(parts[1]).toBe('data: {"type":"response.completed","response":{"id":"resp-1","output":[{"type":"function_call","arguments":"{}"}]}}');
  });

  test("TestForwardResponsesStreamRepairsEmptyCompletedOutputFromDoneItems", async () => {
    const { body } = await forward([
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs-1","summary":[]}}',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"shell","arguments":"{\\"cmd\\":\\"pwd\\"}","status":"completed"}}',
      'data: {"type":"response.completed","response":{"id":"resp-1","output":[]}}',
    ]);
    const parts = body.trim().split("\n\n");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(parts[2]!.slice("data: ".length));
    expect(payload.response.output).toHaveLength(2);
    expect(payload.response.output[1].name).toBe("shell");
    expect(payload.response.output[1].arguments).toBe('{"cmd":"pwd"}');
  });

  test("TestForwardResponsesStreamRepairsMixedIndexedAndUnindexedDoneItems", async () => {
    const { body } = await forward([
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"shell","arguments":"{}","status":"completed"}}',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
      'data: {"type":"response.completed","response":{"id":"resp-1","output":[]}}',
    ]);
    const parts = body.trim().split("\n\n");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(parts[2]!.slice("data: ".length));
    expect(payload.response.output).toHaveLength(2);
    expect(payload.response.output[0].name).toBe("shell");
    expect(payload.response.output[1].id).toBe("msg-1");
  });

  test("TestForwardResponsesStreamRepairsMultilineCompletedOutputAsSSEDataLines", async () => {
    const { body } = await forward([
      'data: {"type":"response.output_item.done","item":{"type":"function_call","arguments":"{}"}}',
      'data: {"type":"response.completed",\ndata: "response":{"id":"resp-1","output":[]}}\n\n',
    ]);
    const parts = body.trim().split("\n\n");
    expect(parts).toHaveLength(2);
    for (const line of parts[1]!.split("\n")) {
      if (line !== "") expect(line.startsWith("data: ")).toBe(true);
    }
    expect(payloadOf(parts[1]!).response.output).toHaveLength(1);
  });

  test("TestForwardResponsesStreamReassemblesSplitSSEEventChunks", async () => {
    const { body } = await forward(["event: response.created", 'data: {"type":"response.created","response":{"id":"resp-1"}}', "\n"]);
    expect(body.startsWith('event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\n')).toBe(true);
    expect(body).toContain("event: error");
  });

  test("TestForwardResponsesStreamPreservesValidFullSSEEventChunks", async () => {
    const chunk = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\n';
    const { body } = await forward([chunk]);
    expect(body.startsWith(chunk)).toBe(true);
    expect(body).toContain("event: error");
  });

  test("TestForwardResponsesStreamBuffersSplitDataPayloadChunks", async () => {
    const { body } = await forward(['data: {"type":"response.created"', ',"response":{"id":"resp-1"}}']);
    expect(body.startsWith('data: {"type":"response.created","response":{"id":"resp-1"}}\n\n')).toBe(true);
    expect(body).toContain("event: error");
  });

  test("TestResponsesSSENeedsLineBreakSkipsChunksThatAlreadyStartWithNewline", () => {
    expect(responsesSSENeedsLineBreak("event: response.created", "\n")).toBe(false);
    expect(responsesSSENeedsLineBreak("event: response.created", "\r\n")).toBe(false);
  });

  test("TestForwardResponsesStreamDropsIncompleteTrailingDataChunkOnFlush", async () => {
    const { body } = await forward(['data: {"type":"response.created"']);
    expect(body).not.toContain('data: {"type":"response.created"');
    expect(body).toContain("event: error");
  });

  test("TestForwardResponsesStreamErrorEventPreservesNestedError", async () => {
    const errText = `{"error":{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber","param":null}}`;
    const { body } = await forward(
      ['event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n', 'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":1}\n\n'],
      { userAgent: "codex_vscode/0.153.4 (Ubuntu 22.4.0; x86_64)", error: new StatusError(400, errText) },
    );
    expect(body).toContain("event: error\n");
    const parts = body.trim().split("\n\n");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const last = parts[parts.length - 1]!.trim();
    expect(last.startsWith("event: error\ndata: ")).toBe(true);
    const payload = JSON.parse(last.slice("event: error\ndata: ".length));
    expect(payload.type).toBe("error");
    expect(payload.sequence_number).toBe(2);
    expect(payload.error.type).toBe("invalid_request");
    expect(payload.error.code).toBe("cyber_policy");
    expect("param" in payload.error).toBe(true);
    expect(payload.error.param).toBeNull();
  });

  test("TestResponsesSSEFramerRepairErrorPayloadCalculatesCorrectSequenceNumber", () => {
    const framer1 = new ResponsesSSEFramer();
    const out1 = framer1.writeChunk('event: error\ndata: {"error":{"code":"bad_request"}}\n\n');
    expect(JSON.parse(out1.trim().slice("event: error\ndata: ".length)).sequence_number).toBe(0);

    const framer2 = new ResponsesSSEFramer();
    framer2.writeChunk('event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n');
    framer2.writeChunk('event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":1}\n\n');
    const out2 = framer2.writeChunk('event: error\ndata: {"error":{"code":"cyber_policy"}}\n\n');
    expect(JSON.parse(out2.trim().slice("event: error\ndata: ".length)).sequence_number).toBe(2);
  });

  test("TestForwardResponsesStreamErrorEventPreservesExplicitSequenceNumber", async () => {
    const { body } = await forward([], { userAgent: "codex_vscode/0.153.4", error: new StatusError(400, `{"error":{"type":"invalid_request","code":"custom"},"sequence_number":9}`) });
    const first = body.trim().split("\n\n")[0]!.trim();
    expect(JSON.parse(first.slice("event: error\ndata: ".length)).sequence_number).toBe(9);
  });

  test("TestResponsesStreamErrorTextSanitizesNestedSensitiveFieldsAndDotKeys", () => {
    const input = `{"error":{"metadata":{"message":"Bearer test-secret"},"vendor.detail":"Bearer test-secret","access_token":"test-secret","normal_key":"safe_value"},"sequence_number":3}`;
    const parsed = JSON.parse(responsesStreamErrorText({ statusCode: 400, error: new Error(input) }, 400));
    expect(parsed.sequence_number).toBe(3);
    expect(parsed.error.access_token).toBe("[REDACTED]");
    expect(parsed.error["vendor.detail"]).toBe("Bearer [REDACTED]");
    expect(parsed.error.metadata.message).toBe("Bearer [REDACTED]");
    expect(parsed.error.normal_key).toBe("safe_value");
  });

  test("TestResponsesStreamErrorTextPreservesTokenCountersAndLargeInts", () => {
    const input = `{"error":{"input_tokens":42,"token_limit":8192,"request_id":9007199254740993,"access_token":"secret123"}}`;
    const out = responsesStreamErrorText({ statusCode: 400, error: new Error(input) }, 400);
    expect(out).toContain("9007199254740993");
    expect(out).not.toContain("9007199254740992");
    const parsed = JSON.parse(out);
    expect(parsed.error.access_token).toBe("[REDACTED]");
    expect(parsed.error.input_tokens).toBe(42);
    expect(parsed.error.token_limit).toBe(8192);
  });

  const privateFrames = {
    rateLimits: 'event: codex.rate_limits\ndata: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":42}}}\n\n',
    metadata: 'event: codex.response.metadata\ndata: {"type":"codex.response.metadata","headers":{"x-turn-state":"turn-1"}}\n\n',
    created: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\n',
    timing: 'event: responsesapi.websocket_timing\ndata: {"type":"responsesapi.websocket_timing","timing":{"duration_ms":100}}\n\n',
    subscription:
      'event: response.subscription_usage\ndata: {"subscription":{"tier":"1234567890123456","weekly":{"resets_at":1792368000,"used_percent":80},"window":{"resets_at":1792272519,"used_percent":10,"window_duration_mins":300}},"type":"response.subscription_usage"}\n\n',
    moderation: 'event: response.metadata\ndata: {"type":"response.metadata","metadata":{"openai_chatgpt_moderation_metadata":{"prompt":{}}}}\n\n',
    completed: 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}\n\n',
  };

  test("TestResponsesSSEFramer_FiltersUpstreamPrivateEvents", () => {
    const framer = new ResponsesSSEFramer({ failureEvent: "error" });
    const got = feed(framer, privateFrames.rateLimits, privateFrames.metadata, privateFrames.created, privateFrames.timing, privateFrames.subscription, privateFrames.moderation, privateFrames.completed);
    for (const leaked of ["codex.rate_limits", "event: response.metadata", "openai_chatgpt_moderation_metadata", "codex.response.metadata", "responsesapi.websocket_timing", "response.subscription_usage", "1234567890123456"]) {
      expect(got).not.toContain(leaked);
    }
    expect(got).toContain("event: response.created");
    expect(got).toContain("event: response.completed");
  });

  test("TestForwardResponsesStream_FiltersUpstreamPrivateEvents", async () => {
    const { body } = await forward([privateFrames.rateLimits, privateFrames.metadata, privateFrames.created, privateFrames.timing, privateFrames.completed]);
    for (const leaked of ["codex.rate_limits", "codex.response.metadata", "responsesapi.websocket_timing"]) expect(body).not.toContain(leaked);
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.completed");
  });

  test("TestResponsesSSEFramer_PreservesMetadataForCodexClient", () => {
    const framer = new ResponsesSSEFramer({ failureEvent: "response.failed", isCodexClient: true });
    const got = feed(framer, privateFrames.metadata, privateFrames.created, privateFrames.moderation, privateFrames.completed);
    expect(got).toContain("codex.response.metadata");
    expect(got).toContain("event: response.metadata");
    expect(got).toContain("event: response.created");
    expect(got).toContain("event: response.completed");
  });

  test("TestResponsesSSEFramer_FiltersDataOnlyPrivateEventsAndNonJSON", () => {
    const framer = new ResponsesSSEFramer({ failureEvent: "error" });
    const got = feed(
      framer,
      'data: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":42}}}\n\n',
      "event: codex.rate_limits\ndata: not-json-data\n\n",
      "event: codex.response.metadata\n\n",
      privateFrames.created,
      privateFrames.completed,
    );
    expect(got).not.toContain("codex.rate_limits");
    expect(got).not.toContain("not-json-data");
    expect(got).not.toContain("codex.response.metadata");
    expect(got).toContain("event: response.created");
    expect(got).toContain("event: response.completed");
  });

  test("TestResponsesSSEFramer_CodexClientFiltersRateLimitsAndTiming", () => {
    const framer = new ResponsesSSEFramer({ failureEvent: "response.failed", isCodexClient: true });
    const got = feed(framer, privateFrames.rateLimits, privateFrames.metadata, privateFrames.timing, privateFrames.subscription, privateFrames.created, privateFrames.completed);
    expect(got).not.toContain("codex.rate_limits");
    expect(got).not.toContain("responsesapi.websocket_timing");
    expect(got).not.toContain("response.subscription_usage");
    expect(got).not.toContain("1234567890123456");
    expect(got).toContain("codex.response.metadata");
    expect(got).toContain("event: response.created");
    expect(got).toContain("event: response.completed");
  });
});

describe("openai_responses_framing_metadata_test", () => {
  const completedFrame = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const noLeak = (got: string) => {
    expect(got).not.toContain("response.metadata");
    expect(got).not.toContain("event: error");
  };

  for (const tc of [
    { name: "standard-lf", lineEnding: "\n", isCodexClient: false },
    { name: "codex-lf", lineEnding: "\n", isCodexClient: true },
    { name: "standard-crlf", lineEnding: "\r\n", isCodexClient: false },
    { name: "codex-crlf", lineEnding: "\r\n", isCodexClient: true },
  ]) {
    test(`TestResponsesSSEFramerFragmentedMetadataDataField/${tc.name}`, () => {
      const payload = `{"type":"response.metadata","metadata":{"marker":"private"}}`;
      const prefix = `event: response.metadata${tc.lineEnding}data:`;
      const frame = prefix + " " + payload + tc.lineEnding + tc.lineEnding;
      for (const split of [prefix.length, prefix.length + 1]) {
        const framer = new ResponsesSSEFramer({ isCodexClient: tc.isCodexClient });
        const got = feed(framer, frame.slice(0, split), frame.slice(split), completedFrame);
        if (tc.isCodexClient) expect(got).toContain(prefix + " " + payload);
        else {
          expect(got).not.toContain("response.metadata");
          expect(got).not.toContain("private");
        }
        expect(got).toContain("response.completed");
      }
    });
  }

  test("TestForwardResponsesStreamEmptyMetadataBeforeFragmentedCompletion", async () => {
    for (let split = 1; split <= "event:".length; split++) {
      const { body } = await forward(["event: response.metadata\ndata:", completedFrame.slice(0, split), completedFrame.slice(split)]);
      noLeak(body);
      expect(body).toContain("event: response.completed");
    }
  });

  test("TestForwardResponsesStreamEmptyMetadataBeforeLeadingSeparator", async () => {
    for (const prefix of ["\n", "\r\n", ": keepalive\n", "id: event-42\n", "retry: 1000\n", "x-extra: value\n"]) {
      const { body } = await forward(["event: response.metadata\ndata:", prefix + completedFrame]);
      noLeak(body);
      expect(body).toContain("response.completed");
    }
  });

  test("TestForwardResponsesStreamEmptyMetadataBeforeFragmentedFields", async () => {
    for (const prefix of ["id: event-42\n", "retry: 1000\n", "x-extra: value\n"]) {
      const field = prefix + completedFrame;
      for (let split = 1; split < prefix.indexOf(":") + 1; split++) {
        const { body } = await forward(["event: response.metadata\ndata:", field.slice(0, split), field.slice(split)]);
        noLeak(body);
        expect(body).toContain("response.completed");
      }
    }
  });

  test("TestForwardResponsesStreamEmptyMetadataBeforeDataOnlyCompletion", async () => {
    const completed = 'data: {"type":"response.completed"}\n\n';
    for (let split = 1; split <= "data:".length; split++) {
      const { body } = await forward(["event: response.metadata\ndata:", completed.slice(0, split), completed.slice(split)]);
      noLeak(body);
      expect(body).toContain("response.completed");
    }
  });

  test("TestForwardResponsesStreamEmptyMetadataBeforeDataThenEvent", async () => {
    const created = `data: {"response":{"id":"resp-1","status":"completed"}}`;
    const completed = "event: response.completed\n\n";
    for (let split = 1; split <= "event:".length; split++) {
      const { body } = await forward(["event: response.metadata\ndata:", created, completed.slice(0, split), completed.slice(split)]);
      noLeak(body);
      expect(body).toContain("event: response.completed");
      expect(body).toContain("resp-1");
    }
    const { body } = await forward(["event: response.metadata\ndata:", created + "\n" + completed]);
    noLeak(body);
    expect(body).toContain("event: response.completed");
    expect(body).toContain("resp-1");
  });

  test("TestForwardResponsesStreamEmptyMetadataBeforeDataFieldThenEvent", async () => {
    for (const field of ["id: event-42", "retry: 1000", ": keepalive", "x-extra: value"]) {
      for (let split = 1; split <= field.length; split++) {
        const { body } = await forward([
          "event: response.metadata\ndata:",
          `data: {"response":{"id":"resp-1","status":"completed"}}`,
          field.slice(0, split),
          field.slice(split),
          "event: response.completed\n\n",
        ]);
        noLeak(body);
        expect(body).toContain("event: response.completed");
        expect(body).toContain("resp-1");
      }
    }
  });

  test("TestForwardResponsesStreamEmptyMetadataBeforeDataAndFragmentedEventAfterLineBreak", async () => {
    const event = "event: response.completed\n\n";
    for (const field of ["", "id: event-42\n", ": keepalive\n"]) {
      for (let split = 1; split < "event:".length; split++) {
        const chunks = ["event: response.metadata\ndata:", 'data: {"response":{"id":"resp-1","status":"completed"}}\n'];
        if (field !== "") chunks.push(field);
        chunks.push(event.slice(0, split), event.slice(split));
        const { body } = await forward(chunks);
        noLeak(body);
        expect(body).toContain("event: response.completed");
        expect(body).toContain("resp-1");
      }
    }
  });

  test("TestForwardResponsesStreamEmptyMetadataBeforeDataWithFragmentedEvent", async () => {
    const event = "event: response.completed\n\n";
    for (const field of ["", "id: event-42\n", ": keepalive\n"]) {
      for (let split = 1; split < "event:".length; split++) {
        const { body } = await forward(["event: response.metadata\ndata:", 'data: {"response":{"id":"resp-1","status":"completed"}}\n' + field + event.slice(0, split), event.slice(split)]);
        noLeak(body);
        expect(body).toContain("event: response.completed");
        expect(body).toContain("resp-1");
      }
    }
  });

  test("TestResponsesSSEFramerPreservesEmptyEvent", () => {
    const framer = new ResponsesSSEFramer();
    expect(framer.writeChunk("event: custom\ndata:")).toBe("");
    expect(framer.writeChunk("\n\n")).toBe("event: custom\ndata:\n\n");
  });

  test("TestResponsesSSEFramerMetadataWithFieldPrefixInJSONString", () => {
    for (const marker of ["data: private", "event: private", "id: private", "retry: private", ": private", `escaped " data: private`, `escaped \\ event: private`]) {
      for (const isCodexClient of [false, true]) {
        const payload = `{"type":"response.metadata","metadata":{"marker":${JSON.stringify(marker)}}}`;
        const frame = "data: " + payload + "\n\n";
        let field = frame.indexOf(marker.replace(/^escaped " /, ""));
        if (field < 0) field = frame.indexOf("event: private");
        expect(field).toBeGreaterThanOrEqual(0);
        const framer = new ResponsesSSEFramer({ isCodexClient });
        const got = feed(framer, frame.slice(0, field), frame.slice(field), completedFrame);
        if (isCodexClient) expect(got).toContain(payload);
        else {
          expect(got).not.toContain("response.metadata");
          expect(got).not.toContain("private");
        }
        expect(got).toContain("response.completed");
      }
    }
  });

  test("TestResponsesSSEFramerFiltersMalformedPrivatePayload", () => {
    const framer = new ResponsesSSEFramer();
    const got = feed(framer, 'data: {"type":"response.metadata","metadata":{"marker":"private"}\n\n', completedFrame);
    expect(got).not.toContain("response.metadata");
    expect(got).not.toContain("private");
  });

  test("TestResponsesSSEFramerKeepsEmptyCommentInMultilineData", () => {
    const framer = new ResponsesSSEFramer();
    const got = feed(framer, `data: {"type"`, ":", `data: :"response.metadata","metadata":{"marker":"private"}}` + "\n\n", completedFrame);
    expect(got).not.toContain("response.metadata");
    expect(got).not.toContain("private");
    expect(got).toContain("response.completed");
  });
});

describe("openai_responses_framing_recovery_test", () => {
  const cases: { name: string; chunks: string[] }[] = [
    { name: "multiline-json", chunks: [`data: {"type"`, `:"response.metadata",` + "\ndata: " + `"metadata":{"marker":"private"}}` + "\n\n"] },
    { name: "multiple-colons", chunks: [`data: {"type"`, `:"response.metadata","metadata"`, `:{"marker":"private"}}` + "\n\n"] },
    { name: "real-comment", chunks: [`data: {"type"`, `:"response.metadata",` + "\n: keepalive\ndata: " + `"metadata":{"marker":"private"}}` + "\n\n"] },
    { name: "split-data-field", chunks: [`data`, `: {"type":"response.metadata","metadata":{"marker":"private"}}` + "\n\n"] },
    { name: "multiple-colons-with-comment", chunks: [`data: {"type"`, `:"response.metadata",` + "\n: keepalive\ndata: " + `"metadata"`, `:{"marker":"private"}}` + "\n\n"] },
    { name: "separate-comment-with-split-key", chunks: [`data: {"type"`, `: keepalive`, `data: :"response.metadata","metadata"`, `:{"marker":"private"}}` + "\n\n"] },
    { name: "colon-before-string-field", chunks: [`data: {"type":"response.metadata","metadata":{"marker"`, `:"`, `data: private"}}` + "\n\n"] },
  ];
  for (const tc of cases) {
    for (const isCodexClient of [false, true]) {
      test(`TestResponsesSSEFramerRecoversFragmentedJSON/${tc.name}/${isCodexClient ? "codex" : "standard"}`, () => {
        const framer = new ResponsesSSEFramer({ isCodexClient });
        const got = feed(framer, ...tc.chunks, 'event: response.completed\ndata: {"type":"response.completed"}\n\n');
        if (isCodexClient) {
          const frames = got.split("\n\n");
          const { payload, found } = responsesSSEDataPayload(frames[0]!);
          expect(found).toBe(true);
          const parsed = JSON.parse(payload);
          expect(parsed.type).toBe("response.metadata");
          expect(parsed.metadata.marker).toBe(tc.name === "colon-before-string-field" ? "data: private" : "private");
          if (tc.chunks.join("").includes(": keepalive")) expect(got).toContain(": keepalive");
        } else {
          expect(got).not.toContain("response.metadata");
          expect(got).not.toContain("private");
        }
        expect(got).toContain("response.completed");
      });
    }
  }
});
