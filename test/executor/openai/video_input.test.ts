// Ported from: internal/runtime/executor/openai_compat_executor_video_test.go
// Skipped cases: the "openai" (chat completions inbound) source rows (OpenAI chat inbound is not served).
import { afterAll, describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { OpenAICompatExecutor } from "../../../src/executor/openai/index.ts";
import { drain, jsonResponse, sseResponse, startUpstream } from "./helpers.ts";

const payload = `{"model":"client-alias","input":[{"role":"user","content":[{"type":"input_text","text":"Describe the videos."},{"type":"input_video","video_url":"https://example.com/clip.mp4?part=1&name=a%20b","processing":"agentic"},{"type":"input_video","video_url":"data:video/mp4;base64,AAECAwQ="}]}]}`;

describe("TestOpenAICompatExecutor_VideoInput (openai-response)", () => {
  const up = startUpstream((req) =>
    req.body.includes(`"stream":true`)
      ? sseResponse(
          'data: {"id":"chatcmpl-video","object":"chat.completion.chunk","created":1,"model":"video-model","choices":[{"index":0,"delta":{"role":"assistant","content":"blue, red, green"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-video","object":"chat.completion.chunk","created":1,"model":"video-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        )
      : jsonResponse(`{"id":"chatcmpl-video","object":"chat.completion","created":1,"model":"video-model","choices":[{"index":0,"message":{"role":"assistant","content":"blue, red, green"},"finish_reason":"stop"}]}`),
  );
  afterAll(() => up.close());
  const auth = newAuth({ id: "o", provider: "openai", attributes: { base_url: up.baseURL, api_key: "test-key" } });

  for (const stream of [false, true]) {
    test(`stream=${stream}`, async () => {
      const req = { model: "video-model", payload, format: "openai-response" as const };
      let response: string;
      if (stream) {
        const { chunks, error } = await drain(await new OpenAICompatExecutor().executeStream(auth, req, { stream: true, sourceFormat: "openai-response" }));
        expect(error).toBeUndefined();
        response = chunks.join("");
      } else {
        response = (await new OpenAICompatExecutor().execute(auth, req, { stream: false, sourceFormat: "openai-response" })).payload;
      }
      expect(response).toContain("blue, red, green");
      const captured = up.requests[up.requests.length - 1]!;
      expect(captured.url).toBe("/v1/chat/completions");
      const body = JSON.parse(captured.body);
      expect(body.model).toBe("video-model");
      const content = body.messages[0].content;
      expect(content.length).toBe(3);
      expect(content[0].text).toBe("Describe the videos.");
      ["https://example.com/clip.mp4?part=1&name=a%20b", "data:video/mp4;base64,AAECAwQ="].forEach((url, i) => {
        expect(content[i + 1].type).toBe("video_url");
        expect(content[i + 1].video_url.url).toBe(url);
      });
      expect(content[1].video_url.processing).toBe("agentic");
    });
  }
});
