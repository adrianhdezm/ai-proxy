// Ported from: internal/runtime/executor/issue6258_terminal_test.go
// Ported from: internal/runtime/executor/aistudio_multiframe_test.go
// Skipped cases: issue6258_terminal_test.go: the vertex_api_key, vertex_service_account and antigravity provider rows
//   (Vertex and Antigravity dropped; the "gemini" row is the AI Studio API-key executor here).
//   aistudio_multiframe_test.go: TestSplitRelayFrames and TestAIStudioStreamKeepsPrettyJSONChunkWhole (websocket relay
//   transport not ported: the HTTP path reads SSE lines), the openai (chat) response-format row (OpenAI chat inbound not
//   served) and the usage-plugin record assertion (usage is recorded at the HTTP layer; the terminal frame's usage is
//   checked in the translated output instead). The relay "chunks" become network writes of one SSE body.
import { describe, expect, test } from "bun:test";
import { AIStudioExecutor } from "../../../src/executor/gemini/aistudio.ts";
import { aistudioAuth, drain, hangingSSE, sse, startFakeUpstream } from "./helpers.ts";

const content = `{"responseId":"executor-6258","candidates":[{"content":{"parts":[{"text":"answer"}]}}]}`;
const usage = `{"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":10,"thoughtsTokenCount":50,"totalTokenCount":160}}`;
const patchRequest = `{"tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","definition":"start: patch"}}]}],"input":"patch a file"}`;
const patchResponse = `{"responseId":"patch","candidates":[{"content":{"parts":[{"functionCall":{"name":"functions__apply_patch","args":{"input":"  *** Begin Patch\\n*** End Patch\\n "}}}]},"finishReason":"STOP"}]}`;
const patchInput = "  *** Begin Patch\n*** End Patch\n ";

function frame(body: string, trace: boolean): string {
  if (trace) body = body.slice(0, -1) + `,"traceId":"trace-6258"}`;
  return "data: " + body + "\n\n";
}

interface ResponsesEvent {
  type: string;
  response?: Record<string, any>;
  item?: { id?: string };
}

function events(text: string): ResponsesEvent[] {
  const out: ResponsesEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const ev = JSON.parse(line.slice(5).trim());
      if (ev && typeof ev.type === "string") out.push(ev);
    } catch {
      // not JSON
    }
  }
  return out;
}

const terminalTypes = new Set(["response.completed", "response.incomplete", "response.failed"]);

async function startStream(baseUrl: string, payload: string, signal?: AbortSignal) {
  const exec = new AIStudioExecutor();
  return exec.executeStream(aistudioAuth(baseUrl), { model: "gemini-3.7-flash", payload, format: "openai-response" }, {
    stream: true,
    sourceFormat: "openai-response",
    responseFormat: "openai-response",
    originalRequest: payload,
    signal,
  });
}

/** Go: issue6258ExecutorTerminal — exactly one completed terminal and one output_item.done per output item. */
function expectOneCompletedTerminal(text: string): Record<string, any> {
  let response: Record<string, any> | undefined;
  let terminals = 0;
  const done = new Map<string, number>();
  for (const ev of events(text)) {
    if (terminalTypes.has(ev.type)) {
      terminals++;
      response = ev.response;
    } else if (ev.type === "response.output_item.done") {
      const id = ev.item?.id ?? "";
      done.set(id, (done.get(id) ?? 0) + 1);
    }
  }
  expect(terminals).toBe(1);
  expect(response?.status).toBe("completed");
  for (const item of (response?.output ?? []) as Array<{ id: string }>) expect(done.get(item.id)).toBe(1);
  return response!;
}

describe("TestIssue6258ExecutorResponsesSplitUsage", () => {
  for (const trace of [false, true]) {
    test(`gemini/trace=${trace}`, async () => {
      const up = startFakeUpstream(() => sse([content, `{"candidates":[{"finishReason":"STOP"}]}`, usage].map((b) => frame(b, trace)).join("")));
      try {
        const result = await startStream(up.url, `{"input":"hello","stream":true}`);
        const { text, error } = await drain(result);
        expect(error).toBeUndefined();
        const response = expectOneCompletedTerminal(text);
        expect(response.usage.input_tokens).toBe(100);
        expect(response.usage.output_tokens).toBe(60);
        expect(response.usage.total_tokens).toBe(160);
        expect(response.usage.output_tokens_details.reasoning_tokens).toBe(50);
      } finally {
        up.stop();
      }
    });
  }
});

test("TestIssue6258ExecutorReadErrorHasNoTerminal (gemini)", async () => {
  // Go truncated the HTTP body (Content-Length beyond the payload); here an injected fetch hands back a body that
  // fails with a read error after the first frame.
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(frame(content, false)));
      else controller.error(new Error("unexpected EOF"));
    },
  });
  const exec = new AIStudioExecutor({ fetch: (async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } })) as never });
  const payload = `{"input":"hello","stream":true}`;
  const result = await exec.executeStream(aistudioAuth("http://upstream.invalid"), { model: "gemini-3.7-flash", payload, format: "openai-response" }, {
    stream: true,
    sourceFormat: "openai-response",
    responseFormat: "openai-response",
    originalRequest: payload,
  });
  const { text, error } = await drain(result);
  expect(error).toBeDefined();
  const evs = events(text);
  expect(evs.some((e) => e.type === "response.output_text.delta")).toBe(true);
  expect(evs.filter((e) => terminalTypes.has(e.type))).toEqual([]);
});

test("TestIssue6258ExecutorCancellationHasNoTerminal (gemini)", async () => {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const up = startFakeUpstream(() => hangingSSE(frame(content, false), released));
  const controller = new AbortController();
  try {
    const result = await startStream(up.url, `{"input":"hello","stream":true}`, controller.signal);
    let started = false;
    let terminals = 0;
    try {
      for await (const chunk of result.chunks) {
        for (const ev of events(chunk)) {
          if (ev.type === "response.output_text.delta" && !started) {
            started = true;
            controller.abort();
          }
          if (terminalTypes.has(ev.type)) terminals++;
        }
      }
    } catch {
      // a cancelled stream may end with the abort error; it must not synthesize a terminal
    }
    expect(started).toBe(true);
    expect(terminals).toBe(0);
  } finally {
    release();
    up.stop();
  }
});

describe("TestIssue6258ExecutorCleanEOFControl", () => {
  for (const patch of [false, true]) {
    test(`gemini/apply_patch=${patch}`, async () => {
      const body = patch ? patchResponse : content;
      const payload = patch ? patchRequest : `{"input":"hello","stream":true}`;
      const up = startFakeUpstream(() => sse(frame(body, false)));
      try {
        const { text, error } = await drain(await startStream(up.url, payload));
        expect(error).toBeUndefined();
        const response = expectOneCompletedTerminal(text);
        if (patch) {
          const item = (response.output as Array<Record<string, unknown>>).find((o) => o.type === "custom_tool_call");
          expect(item?.input).toBe(patchInput);
          expect(item?.name).toBe("apply_patch");
          expect(item?.namespace).toBe("functions");
        } else {
          expect(response.output[0].content[0].text).toBe("answer");
        }
      } finally {
        up.stop();
      }
    });
  }
});

describe("TestAIStudioStreamTranslatesEveryFrameOfAChunk", () => {
  const frameA = `{"candidates":[{"content":{"role":"model","parts":[{"text":"AAA"}]}}],"modelVersion":"gemini-3.1-pro-preview"}`;
  const frameB = `{"candidates":[{"content":{"role":"model","parts":[{"text":"BBB"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":4,"totalTokenCount":15},"modelVersion":"gemini-3.1-pro-preview"}`;
  const formats = [
    { name: "openai-response", format: "openai-response" as const, payload: `{"model":"gemini-3.1-pro-preview","input":"hi","stream":true}`, markers: ["AAA", "BBB", "event: response.completed", `"input_tokens":11`, `"output_tokens":4`] },
    { name: "claude", format: "claude" as const, payload: `{"model":"gemini-3.1-pro-preview","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"stream":true}`, markers: ["AAA", "BBB", "event: message_stop", `"stop_reason":"end_turn"`, `"input_tokens":11`, `"output_tokens":4`] },
  ];
  const bodies: Record<string, string> = {
    "one frame per write": "data: " + frameA + "\n\n" + "data: " + frameB + "\n\n",
    crlf: "data: " + frameA + "\r\n\r\ndata: " + frameB + "\r\n\r\n",
    "event lines": "event: message\ndata: " + frameA + "\n\nevent: message\ndata: " + frameB + "\n\n",
    "trailing keep-alive": "data: " + frameA + "\n\ndata: " + frameB + "\n\n: keep-alive\n\n",
  };
  for (const tc of formats) {
    for (const [label, body] of Object.entries(bodies)) {
      test(`${tc.name}: ${label}`, async () => {
        const up = startFakeUpstream(() => sse(body));
        try {
          const result = await new AIStudioExecutor().executeStream(aistudioAuth(up.url), { model: "gemini-3.1-pro-preview", payload: tc.payload, format: tc.format }, {
            stream: true,
            sourceFormat: tc.format,
            originalRequest: tc.payload,
          });
          const { text, error } = await drain(result);
          expect(error).toBeUndefined();
          for (const marker of tc.markers) expect(text).toContain(marker);
        } finally {
          up.stop();
        }
      });
    }
  }
});
