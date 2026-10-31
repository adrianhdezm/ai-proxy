// Ported from: test/codex_incomplete_stream_error_type_test.go
// Ported from: test/codex_stream_disconnect_failover_test.go
// Skipped cases: TestCodexStreamDisconnectAfterHeadersFailsOver, TestCodexStreamDisconnectAfterOutputDoesNotFailOver,
//   TestCodexStreamAbnormalDisconnectBeforeOutputFailsOver (executor-level failover, ported with Claude inbound in
//   test/executor/codex/stream_disconnect_failover.test.ts). The two Responses cases run through the real server
//   (createApp + POST /v1/responses) against a fake Codex backend instead of the gin handler.
// Also covers (new): end-to-end Responses requests routed to fake Codex, Anthropic, OpenAI chat and Gemini AI
//   Studio upstreams, streaming and non-streaming, checking the event sequence ends in response.completed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, type App } from "../../src/app.ts";
import type { Auth } from "../../src/auth/types.ts";
import { defaultConfig } from "../../src/config/load.ts";
import type { ApiKeyCredential, Config, ModelOverride } from "../../src/config/types.ts";
import { ModelRegistry, getAIStudioModels, getClaudeModels, getCodexProModels } from "../../src/registry/index.ts";
import type { PersistingTokenStore } from "../../src/store/index.ts";

class MemoryStore implements PersistingTokenStore {
  readonly kind = "memory";
  async save(auth: Auth): Promise<string> {
    return auth.id;
  }
  async list(): Promise<Auth[]> {
    return [];
  }
  async delete(): Promise<void> {}
}

function model(name: string): ModelOverride {
  return { name, alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false };
}

function credential(partial: Partial<ApiKeyCredential> & { apiKey: string }): ApiKeyCredential {
  return { baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

const claudeModel = getClaudeModels()[0]!.id;
const geminiModel = getAIStudioModels()[0]!.id;
const openaiModel = "gpt-test-chat";
const codexModel = getCodexProModels()[0]!.id;
// Served by one credential each (Go: gpt-5.4 / gpt-6-astra on a single fake credential).
const incompleteModel = "gpt-test-incomplete";
const disconnectModel = "gpt-test-disconnect";

const seen: { codex: string[]; anthropic: string[]; openai: string[]; gemini: string[] } = { codex: [], anthropic: [], openai: [], gemini: [] };
let anthropic: ReturnType<typeof Bun.serve>;
let openai: ReturnType<typeof Bun.serve>;
let codex: ReturnType<typeof Bun.serve>;
let gemini: ReturnType<typeof Bun.serve>;

const sse = (frames: Array<[string, unknown]>) => frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const dataEvent = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;

beforeAll(() => {
  anthropic = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      seen.anthropic.push(body);
      const parsed = JSON.parse(body) as { model: string };
      return new Response(
        sse([
          ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from claude" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }],
          ["message_stop", { type: "message_stop" }],
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  openai = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      seen.openai.push(text);
      const body = JSON.parse(text) as { stream?: boolean; model: string };
      if (!body.stream) {
        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello from openai" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      }
      const chunk = (delta: unknown, finish: string | null) => dataEvent({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      return new Response(chunk({ role: "assistant", content: "hello " }, null) + chunk({ content: "from openai" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  codex = Bun.serve({
    port: 0,
    async fetch(req) {
      const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const text = await req.text();
      seen.codex.push(text);
      const body = JSON.parse(text) as { model: string };
      if (key === "sk-codex-disconnect") return new Response("", { headers: { "content-type": "text/event-stream" } });
      if (key === "sk-codex-incomplete") {
        return new Response(
          [
            `{"type":"response.created","response":{"id":"resp_truncated"}}`,
            `{"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"edit","arguments":""}}`,
            `{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"path\\":\\"app/page.tsx\\"","sequence_number":3}`,
            `{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":",\\"text\\":\\"editor","sequence_number":4}`,
          ]
            .map((e) => `data: ${e}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const item = { id: "msg_c", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello from codex" }] };
      return new Response(
        dataEvent({ type: "response.created", response: { id: "r1", model: body.model } }) +
          dataEvent({ type: "response.output_item.added", output_index: 0, item: { id: "msg_c", type: "message", role: "assistant", content: [] } }) +
          dataEvent({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_c", delta: "hello from codex" }) +
          dataEvent({ type: "response.output_item.done", output_index: 0, item }) +
          dataEvent({ type: "response.completed", response: { id: "r1", model: body.model, status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  gemini = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.gemini.push(await req.text());
      const part = (text: string, finish?: string) =>
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text }] }, ...(finish ? { finishReason: finish } : {}) }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          modelVersion: geminiModel,
        });
      if (url.pathname.endsWith(":streamGenerateContent")) {
        return new Response(`data: ${part("hello ")}\n\ndata: ${part("from gemini", "STOP")}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(part("hello from gemini", "STOP"), { headers: { "content-type": "application/json" } });
    },
  });
});

afterAll(() => {
  anthropic?.stop(true);
  openai?.stop(true);
  codex?.stop(true);
  gemini?.stop(true);
});

function config(): Config {
  const cfg = defaultConfig();
  cfg.loggingLevel = "error";
  cfg.access.apiKeys = ["sk-proxy"];
  cfg.claudeApiKeys = [credential({ apiKey: "sk-ant", baseUrl: `http://127.0.0.1:${anthropic.port}` })];
  cfg.openaiApiKeys = [credential({ apiKey: "sk-openai", baseUrl: `http://127.0.0.1:${openai.port}/v1`, models: [model(openaiModel)] })];
  const codexBase = `http://127.0.0.1:${codex.port}`;
  cfg.codexApiKeys = [
    credential({ apiKey: "sk-codex-ok", baseUrl: codexBase, models: [model(codexModel)] }),
    credential({ apiKey: "sk-codex-incomplete", baseUrl: codexBase, models: [model(incompleteModel)] }),
    credential({ apiKey: "sk-codex-disconnect", baseUrl: codexBase, models: [model(disconnectModel)] }),
  ];
  cfg.geminiApiKeys = [credential({ apiKey: "gemini-key", baseUrl: `http://127.0.0.1:${gemini.port}` })];
  return cfg;
}

let app: App;
beforeAll(async () => {
  app = await createApp(config(), { store: new MemoryStore(), registry: new ModelRegistry(), autoRefresh: false });
});
afterAll(async () => {
  await app?.stop();
});

function responses(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-proxy", ...headers },
    body: JSON.stringify(body),
  });
}

/** The `type` of every data frame of a Responses SSE body, in order. */
function eventTypes(text: string): string[] {
  const types: string[] = [];
  for (const frame of text.split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "" || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { type?: string };
      if (typeof parsed.type === "string") types.push(parsed.type);
    } catch {
      types.push("<invalid>");
    }
  }
  return types;
}

function outputText(response: { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> }): string {
  return (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
}

const upstreams = [
  { name: "Codex", model: () => codexModel, text: "hello from codex", hits: () => seen.codex },
  { name: "Anthropic", model: () => claudeModel, text: "hello from claude", hits: () => seen.anthropic },
  { name: "OpenAI chat completions", model: () => openaiModel, text: "hello from openai", hits: () => seen.openai },
  { name: "Gemini AI Studio", model: () => geminiModel, text: "hello from gemini", hits: () => seen.gemini },
];

describe("POST /v1/responses through the real server", () => {
  for (const upstream of upstreams) {
    test(`${upstream.name}: non-streaming`, async () => {
      const before = upstream.hits().length;
      const res = await app.fetch(responses({ model: upstream.model(), input: "hi" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { object?: string; status?: string; output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; usage?: Record<string, unknown> };
      expect(upstream.hits().length).toBe(before + 1);
      expect(body.status).toBe("completed");
      expect(outputText(body)).toBe(upstream.text);
      expect(body.usage?.input_tokens_details).toBeDefined();
      expect(body.usage?.output_tokens_details).toBeDefined();
    });

    test(`${upstream.name}: streaming`, async () => {
      const res = await app.fetch(responses({ model: upstream.model(), input: "hi", stream: true }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      const types = eventTypes(text);
      expect(types[0]).toBe("response.created");
      expect(types.at(-1)).toBe("response.completed");
      expect(types).not.toContain("error");
      expect(types).not.toContain("response.failed");
      expect(text).toContain(upstream.text.split(" ").at(-1)!);
    });
  }

  test("Anthropic upstream receives a translated Claude Messages request", async () => {
    const before = seen.anthropic.length;
    await (await app.fetch(responses({ model: claudeModel, input: "hi", stream: true }))).text();
    const sent = JSON.parse(seen.anthropic[before]!) as { messages: unknown[]; stream: boolean };
    expect(Array.isArray(sent.messages)).toBe(true);
    expect(sent.stream).toBe(true);
  });

  test("OpenAI clients get the OpenAI model list", async () => {
    const res = await app.fetch(new Request("http://proxy.test/v1/models", { headers: { authorization: "Bearer sk-proxy", "user-agent": "OpenAI/Python 1.99.0" } }));
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toContain(codexModel);
  });
});

/** The error object of the last `error` / `response.failed` frame (Go: terminalStreamErrorDetail). */
function terminalStreamErrorDetail(body: string): Record<string, unknown> {
  let detail: Record<string, unknown> | undefined;
  for (const frame of body.split("\n\n")) {
    let data = "";
    for (const line of frame.split("\n")) if (line.startsWith("data: ")) data = line.slice(6);
    if (data === "") continue;
    let payload: { type?: string; error?: Record<string, unknown>; response?: { error?: Record<string, unknown> } };
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (payload.type === "error" && payload.error) detail = payload.error;
    if (payload.type === "response.failed" && payload.response?.error) detail = payload.response.error;
  }
  if (!detail) throw new Error(`no terminal error frame in SSE body:\n${body}`);
  return detail;
}

test("TestCodexIncompleteStreamIsNotTypedAsInvalidRequest", async () => {
  const res = await app.fetch(responses({ model: incompleteModel, input: "hello", stream: true }));
  const detail = terminalStreamErrorDetail(await res.text());
  expect(detail.code).toBe("request_timeout");
  expect(detail.type).not.toBe("invalid_request_error");
  expect(detail.type).toBe("server_error");
});

test("TestCodexStreamDisconnectExhaustionNotInvalidRequestError", async () => {
  const res = await app.fetch(responses({ model: disconnectModel, input: "hello", stream: true }));
  const body = (await res.json()) as { error: { message: string; type: string; code: string } };
  expect(res.status).not.toBe(200);
  expect(body.error.type).not.toBe("invalid_request_error");
  expect(body.error.type).toBe("server_error");
});
