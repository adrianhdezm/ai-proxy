// Ported from: internal/runtime/executor/openai_compat_executor_ttft_test.go
// Skipped cases: the TTFT/latency usage-record assertions (the usage reporter is not ported);
//   tool_call_responses_downstream (openai-response downstream is not served by this port).
// Kept: the observable stream behaviour of those fixtures — keepalive comments, role-only and
//   empty deltas, usage-only chunks with empty choices and multi-line data frames must all be
//   accepted and the stream must complete with a message_stop; a 429 bootstrap must fail.
import { afterAll, describe, expect, test } from "bun:test";
import { OpenAICompatExecutor } from "../../../src/executor/openai/index.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { FormatClaude } from "../../../src/translator/types.ts";
import { apiKeyAuth, drain, jsonResponse, parseClaudeEvents, sseChunkedResponse, startUpstream } from "./helpers.ts";

const upstream = startUpstream(() => jsonResponse("{}", 500));
afterAll(() => upstream.close());

const executor = new OpenAICompatExecutor();
const auth = apiKeyAuth({ baseURL: upstream.baseURL, apiKey: "k" });
const payload = `{"model":"glm-5.3-flash-unc","max_tokens":64,"messages":[{"role":"user","content":"hello"}],"stream":true}`;

const prelude = ': keepalive\n\ndata: {"model":"glm-5.3-flash-unc","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":0}}\n\n';

describe("OpenAICompatExecutor stream accepts early non-token frames", () => {
  const cases: Array<{ name: string; token: string; finish: string; wantType: string }> = [
    { name: "text", token: 'data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n', finish: "stop", wantType: "text_delta" },
    { name: "reasoning_content", token: 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n', finish: "stop", wantType: "thinking_delta" },
    { name: "reasoning", token: 'data: {"choices":[{"index":0,"delta":{"reasoning":"thinking"}}]}\n\n', finish: "stop", wantType: "thinking_delta" },
    { name: "multiline_sse_frame", token: 'data: {"choices":[\ndata: {"index":0,"delta":{"content":"hello"}}]}\n\n', finish: "stop", wantType: "text_delta" },
  ];
  for (const tt of cases) {
    test(tt.name, async () => {
      upstream.respond(() =>
        sseChunkedResponse([
          prelude,
          tt.token,
          'data: {"model":"glm-5.3-flash-unc","choices":[{"index":0,"delta":{},"finish_reason":"' + tt.finish + '"}],"usage":{"prompt_tokens":100,"completion_tokens":1,"total_tokens":101}}\n\ndata: [DONE]\n\n',
        ]),
      );
      const result = await executor.executeStream(auth, { model: "glm-5.3-flash-unc", payload, format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
      const { chunks, error } = await drain(result);
      expect(error).toBeUndefined();
      const events = parseClaudeEvents(chunks);
      expect(events[0]!.type).toBe("message_start");
      expect(events.map((e) => e.type)).toContain("content_block_delta");
      expect(events.some((e) => e.type === "content_block_delta" && e.payload.includes(`"type":"${tt.wantType}"`))).toBe(true);
      expect(events[events.length - 1]!.type).toBe("message_stop");
      const delta = events.find((e) => e.type === "message_delta")!;
      expect(JSON.parse(delta.payload).usage.output_tokens).toBe(1);
    });
  }
});

test("OpenAICompatExecutor stream bootstrap error surfaces the 429", async () => {
  upstream.respond(() => jsonResponse(`{"error":{"message":"rate limit"}}`, 429));
  let caught: unknown;
  try {
    await executor.executeStream(auth, { model: "glm-5.3-flash-unc", payload, format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(StatusError);
  expect((caught as StatusError).statusCode).toBe(429);
  expect((caught as StatusError).retryAfterMs).toBeUndefined();
});
