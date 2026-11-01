// Ported from: internal/runtime/executor/custom_magic_headers_test.go
// Skipped cases: TestCustomMagicHeaders_GeminiInteractions / _CPASessionID_GeminiInteractions (Interactions API dropped),
//   _GeminiVertex (Vertex dropped), _XAI / _CPASessionID_XAI (xAI dropped), every other TestCustomMagicHeaders_CPASessionID_*
//   case (the $CPA-SESSION-ID value comes from upstream's session-affinity session extraction, an optional routing mode not
//   ported; util.SessionIDResolver has no production resolver here, and its expansion is covered by
//   test/util/header_helpers.test.ts).
// Adapted: inbound payloads are Claude Messages (or OpenAI Responses for Codex) since OpenAI-chat and Gemini inbound are
//   not served; the Go httptest servers are Bun.serve on port 0.
import { afterAll, describe, expect, test } from "bun:test";
import { newAuth } from "../../src/auth/types.ts";
import { OpenAICompatExecutor } from "../../src/executor/openai/index.ts";
import { FormatOpenAIImage } from "../../src/executor/openai/images.ts";
import { AIStudioExecutor } from "../../src/executor/gemini/aistudio.ts";
import { ClaudeExecutor } from "../../src/executor/claude/executor.ts";
import { CodexExecutor } from "../../src/executor/codex/index.ts";
import { RequestPathMetadataKey } from "../../src/executor/types.ts";

interface Seen {
  path: string;
  headers: Headers;
}

function server(respond: (req: Request) => Response) {
  const seen: Seen[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      await req.text();
      seen.push({ path: new URL(req.url).pathname, headers: req.headers });
      return respond(req);
    },
  });
  return { url: `http://127.0.0.1:${s.port}`, seen, last: () => seen[seen.length - 1]!.headers, stop: () => s.stop(true) };
}

const claudePayload = `{"model":"m","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`;
const chatJSON = () => Response.json({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
const chatSSE = () =>
  new Response('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  });

describe("OpenAI compatible executor", () => {
  const up = server((req) => {
    const path = new URL(req.url).pathname;
    if (path.includes("/images/")) return Response.json({ created: 1, data: [{ b64_json: "aGk=" }] });
    return (req.headers.get("Accept") ?? "").includes("text/event-stream") ? chatSSE() : chatJSON();
  });
  afterAll(() => up.stop());
  const auth = (attrs: Record<string, string> = {}) => newAuth({ id: "o", provider: "openai", attributes: { base_url: up.url + "/v1", api_key: "test-key", ...attrs } });
  const req = { model: "gpt-4o", payload: claudePayload, format: "claude" as const };

  test("TestCustomMagicHeaders_OpenAICompat", async () => {
    await new OpenAICompatExecutor().execute(
      auth({ "header:X-Claude-Code-Session-Id": "$ABC", "header:X-Forwarded-Session": "$X-Client-Session", "header:X-Missing": "$NONEXISTENT", "header:X-Static": "static-value" }),
      req,
      { stream: false, sourceFormat: "claude", headers: new Headers({ Abc: "session-abc-value", "X-Client-Session": "client-session-uuid-123" }) },
    );
    const h = up.last();
    expect(h.get("X-Claude-Code-Session-Id")).toBe("session-abc-value");
    expect(h.get("X-Forwarded-Session")).toBe("client-session-uuid-123");
    expect(h.get("X-Static")).toBe("static-value");
    expect(h.has("X-Missing")).toBe(false);
  });

  describe("TestOpenAICompatExecutor_UserAgentPassthroughAndDefault", () => {
    test("Execute defaults to cli-proxy-openai-compat when downstream User-Agent is absent", async () => {
      await new OpenAICompatExecutor().execute(auth(), req, { stream: false, sourceFormat: "claude" });
      expect(up.last().get("User-Agent")).toBe("cli-proxy-openai-compat");
    });

    test("Execute forwards downstream User-Agent when present", async () => {
      await new OpenAICompatExecutor().execute(auth(), req, { stream: false, sourceFormat: "claude", headers: new Headers({ "User-Agent": "downstream-compat-client/1.0" }) });
      expect(up.last().get("User-Agent")).toBe("downstream-compat-client/1.0");
    });

    test("ExecuteStream forwards downstream User-Agent when present", async () => {
      const result = await new OpenAICompatExecutor().executeStream(auth(), req, { stream: true, sourceFormat: "claude", headers: new Headers({ "User-Agent": "downstream-stream-client/1.0" }) });
      for await (const _ of result.chunks) void _;
      expect(up.last().get("User-Agent")).toBe("downstream-stream-client/1.0");
    });

    test("Execute images and ExecuteStream images forward downstream User-Agent", async () => {
      const imageReq = { model: "gpt-image-1", payload: `{"model":"gpt-image-1","prompt":"draw a cat"}`, format: FormatOpenAIImage };
      const meta = { [RequestPathMetadataKey]: "/v1/images/generations" };
      await new OpenAICompatExecutor().execute(auth(), imageReq, { stream: false, sourceFormat: FormatOpenAIImage, metadata: meta, headers: new Headers({ "User-Agent": "downstream-image-client/1.0" }) });
      expect(up.last().get("User-Agent")).toBe("downstream-image-client/1.0");
      const result = await new OpenAICompatExecutor().executeStream(auth(), imageReq, {
        stream: true,
        sourceFormat: FormatOpenAIImage,
        metadata: meta,
        headers: new Headers({ "User-Agent": "downstream-image-stream-client/1.0" }),
      });
      for await (const _ of result.chunks) void _;
      expect(up.last().get("User-Agent")).toBe("downstream-image-stream-client/1.0");
    });

    test("configured header:User-Agent overrides downstream User-Agent", async () => {
      await new OpenAICompatExecutor().execute(auth({ "header:User-Agent": "configured-compat-ua/3.0" }), req, {
        stream: false,
        sourceFormat: "claude",
        headers: new Headers({ "User-Agent": "downstream-compat-client/1.0" }),
      });
      expect(up.last().get("User-Agent")).toBe("configured-compat-ua/3.0");
    });
  });

  test("TestCustomMagicHeaders_OpenAICompat_Stream", async () => {
    const result = await new OpenAICompatExecutor().executeStream(
      auth({ "header:X-Claude-Code-Session-Id": "$ABC", "header:X-Empty-Var": "$   ", "header:X-Only-Dollar": "$", "header:X-Missing": "$NONEXISTENT" }),
      req,
      { stream: true, sourceFormat: "claude", headers: new Headers({ Abc: "stream-session-abc" }) },
    );
    for await (const _ of result.chunks) void _;
    const h = up.last();
    expect(h.get("X-Claude-Code-Session-Id")).toBe("stream-session-abc");
    for (const name of ["X-Missing", "X-Empty-Var", "X-Only-Dollar"]) expect(h.has(name)).toBe(false);
  });
});

test("TestCustomMagicHeaders_Gemini", async () => {
  const up = server(() => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }] }));
  try {
    const auth = newAuth({
      id: "g",
      provider: "aistudio",
      attributes: { base_url: up.url, api_key: "gemini-key", "header:X-Claude-Code-Session-Id": "$ABC", "header:X-Missing": "$NONEXISTENT", "header:X-Static": "gemini-static" },
    });
    await new AIStudioExecutor().execute(auth, { model: "gemini-2.5-flash", payload: claudePayload, format: "claude" }, { stream: false, sourceFormat: "claude", headers: new Headers({ Abc: "gemini-session-abc" }) });
    const h = up.last();
    expect(h.get("X-Claude-Code-Session-Id")).toBe("gemini-session-abc");
    expect(h.get("X-Static")).toBe("gemini-static");
    expect(h.has("X-Missing")).toBe(false);
  } finally {
    up.stop();
  }
});

test("TestCustomMagicHeaders_Claude", async () => {
  const up = server(() => Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-3-7-sonnet-20250219", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } }));
  try {
    const auth = newAuth({ id: "c", provider: "claude", attributes: { base_url: up.url, api_key: "sk-ant-test", "header:X-Claude-Code-Session-Id": "$ABC", "header:X-Missing": "$NONEXISTENT" } });
    await new ClaudeExecutor().execute(
      auth,
      { model: "claude-3-7-sonnet-20250219", payload: `{"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`, format: "claude" },
      { stream: false, sourceFormat: "claude", headers: new Headers({ Abc: "claude-session-value" }) },
    );
    const h = up.last();
    expect(h.get("X-Claude-Code-Session-Id")).toBe("claude-session-value");
    expect(h.has("X-Missing")).toBe(false);
  } finally {
    up.stop();
  }
});

test("TestCustomMagicHeaders_Codex", async () => {
  const up = server(
    () =>
      new Response('data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","background":false,"error":null,"output":[]}}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  try {
    const auth = newAuth({ id: "x", provider: "codex", attributes: { base_url: up.url, api_key: "codex-key", "header:X-Claude-Code-Session-Id": "$ABC", "header:X-Missing": "$NONEXISTENT" } });
    await new CodexExecutor({ disableCloaking: true }).execute(
      auth,
      { model: "gpt-5-codex", payload: `{"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`, format: "openai-response" },
      { stream: false, sourceFormat: "openai-response", headers: new Headers({ Abc: "codex-session-value" }) },
    );
    const h = up.last();
    expect(h.get("X-Claude-Code-Session-Id")).toBe("codex-session-value");
    expect(h.has("X-Missing")).toBe(false);
  } finally {
    up.stop();
  }
});
