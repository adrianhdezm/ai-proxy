// Ported from: internal/runtime/executor/issue6381_responses_eof_test.go
// Skipped cases: none. The scanner read error (Go: an io.Reader failing after two frames, injected through the
//   "cliproxy.roundtripper" context transport) is an injected fetch whose body errors after the same frames.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { OpenAICompatExecutor } from "../../../src/executor/openai/index.ts";
import { drain, sseResponse, startUpstream } from "./helpers.ts";

const responsesRequest = `{"model":"test","input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}],"stream":true}`;
const applyPatchRequest = `{"model":"test","input":[{"role":"user","content":"edit a.txt"}],"tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"start: patch"}}]}`;
const applyPatchPartial = String.raw`{"input":"*** Begin Patch\n*** Add File: a.txt\n+hello\n`;
const applyPatchRemainder = String.raw`*** End Patch\n"}`;

/** Go: applyPatchTestFrames("chat", name) with the trailing [DONE] removed. */
function applyPatchChatFrames(name: string): string {
  const first = `data: {"id":"r1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":${JSON.stringify(name)},"arguments":${JSON.stringify(applyPatchPartial)}}}]}}]}\n\n`;
  const last = `data: {"id":"r1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(applyPatchRemainder)}}}]},"finish_reason":"tool_calls"}]}\n\n`;
  return first + last;
}

async function runResponses(baseURL: string | undefined, payload: string, fetchImpl?: unknown): Promise<{ output: string; error: unknown }> {
  const exec = new OpenAICompatExecutor(undefined, fetchImpl ? { fetch: fetchImpl as never } : {});
  const auth = newAuth({ id: "custom-compat", provider: "openai", attributes: { base_url: baseURL ?? "http://responses.test/v1", api_key: "test" } });
  const result = await exec.executeStream(auth, { model: "test", payload, format: "openai-response" }, {
    stream: true,
    sourceFormat: "openai-response",
    responseFormat: "openai-response",
    originalRequest: payload,
  });
  const { chunks, error } = await drain(result);
  return { output: chunks.join(""), error };
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("OpenAI-compatible Responses stream EOF handling", () => {
  test("TestOpenAICompatExecutorResponsesEOFAfterFinishReasonCompletesStream", async () => {
    const reply = [
      `data: {"id":"chatcmpl-eof","object":"chat.completion.chunk","created":1773896263,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}`,
      "",
      `data: {"id":"chatcmpl-eof","object":"chat.completion.chunk","created":1773896263,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
      "",
      `data: {"id":"chatcmpl-eof","object":"chat.completion.chunk","created":1773896263,"model":"test","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`,
      "",
    ].join("\n");
    const up = startUpstream(() => sseResponse(reply));
    try {
      const { output, error } = await runResponses(up.baseURL, responsesRequest);
      expect(error).toBeUndefined();
      expect(count(output, `"type":"response.completed"`)).toBe(1);
      expect(output).toContain(`"input_tokens":3`);
      expect(output).toContain(`"output_tokens":1`);
    } finally {
      up.close();
    }
  });

  test("TestOpenAICompatExecutorResponsesEOFAfterApplyPatchFinishReasonCompletesStream", async () => {
    const up = startUpstream(() => sseResponse(applyPatchChatFrames("apply_patch")));
    try {
      const { output, error } = await runResponses(up.baseURL, applyPatchRequest);
      expect(error).toBeUndefined();
      expect(count(output, `"type":"response.completed"`)).toBe(1);
      expect(output).not.toContain(`"type":"response.failed"`);
    } finally {
      up.close();
    }
  });

  test("TestOpenAICompatExecutorResponsesScannerErrorDoesNotSynthesizeCompletion", async () => {
    const frames = [
      `data: {"id":"chatcmpl-reset","object":"chat.completion.chunk","created":1773896263,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\n`,
      `data: {"id":"chatcmpl-reset","object":"chat.completion.chunk","created":1773896263,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    ];
    let index = 0;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < frames.length) controller.enqueue(new TextEncoder().encode(frames[index++]!));
            else controller.error(new Error("synthetic upstream read error"));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    const { output, error } = await runResponses(undefined, responsesRequest, fetchImpl);
    expect(output).toContain(`"type":"response.output_text.delta"`);
    expect(error).toBeDefined();
    expect(output).not.toContain(`"type":"response.completed"`);
  });

  test("TestOpenAICompatExecutorResponsesEOFBeforeFinishReasonFailsStream", async () => {
    const reply = `data: {"id":"chatcmpl-truncated","object":"chat.completion.chunk","created":1773896263,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n`;
    const up = startUpstream(() => sseResponse(reply));
    try {
      const { output, error } = await runResponses(up.baseURL, responsesRequest);
      expect(output).toContain(`"type":"response.output_text.delta"`);
      expect(error).toBeDefined();
      expect(output).not.toContain(`"type":"response.completed"`);
    } finally {
      up.close();
    }
  });
});
