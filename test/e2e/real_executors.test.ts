// New (no upstream test): end-to-end through the real stack. The HTTP server,
// AuthManager and the real executors from createExecutors(config) are driven
// with Claude Messages requests against fake upstream servers on Bun.serve
// port 0: Anthropic (passthrough + 429 failover), OpenAI chat completions,
// the Codex Responses backend and Gemini AI Studio (translated back to Claude).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "../../src/app.ts";
import type { Auth } from "../../src/auth/types.ts";
import { defaultConfig } from "../../src/config/load.ts";
import type { ApiKeyCredential, Config } from "../../src/config/types.ts";
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

function credential(partial: Partial<ApiKeyCredential> & { apiKey: string }): ApiKeyCredential {
  return { baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

const claudeModel = getClaudeModels()[0]!.id;
const geminiModel = getAIStudioModels()[0]!.id;
const openaiModel = "gpt-test-chat";
const codexModel = getCodexProModels()[0]!.id;
const codexHits: string[] = [];

const anthropicHits: string[] = [];
const sse = (frames: Array<[string, unknown]>) => frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

function claudeStream(model: string): string {
  return sse([
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from claude" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

let anthropic: ReturnType<typeof Bun.serve>;
let openai: ReturnType<typeof Bun.serve>;
let gemini: ReturnType<typeof Bun.serve>;
let codex: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  anthropic = Bun.serve({
    port: 0,
    async fetch(req) {
      // Non-Anthropic base URLs get the key as a Bearer token.
      const key = req.headers.get("x-api-key") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      anthropicHits.push(key);
      const body = (await req.json()) as { stream?: boolean; model: string };
      if (key === "sk-ant-exhausted") {
        return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "120" },
        });
      }
      if (body.stream) return new Response(claudeStream(body.model), { headers: { "content-type": "text/event-stream" } });
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "hello from claude" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    },
  });
  openai = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { stream?: boolean; model: string };
      if (!body.stream) {
        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello from openai" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      }
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "hello " }, null) + chunk({ content: "from openai" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  codex = Bun.serve({
    port: 0,
    async fetch(req) {
      const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      codexHits.push(key);
      const body = (await req.json()) as { model: string };
      const ev = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
      if (key === "sk-codex-limited") {
        const err = { type: "usage_limit_reached", message: "You've hit your usage limit.", resets_in_seconds: 3600 };
        return new Response(ev({ type: "response.created", response: { id: "r0", model: body.model } }) + ev({ type: "error", status: 429, error: err }), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      const item = { id: "msg_c", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello from codex" }] };
      return new Response(
        ev({ type: "response.created", response: { id: "r1", model: body.model } }) +
          ev({ type: "response.output_item.added", output_index: 0, item: { id: "msg_c", type: "message", role: "assistant", content: [] } }) +
          ev({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_c", part: { type: "output_text", text: "" } }) +
          ev({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_c", delta: "hello from codex" }) +
          ev({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_c", text: "hello from codex" }) +
          ev({ type: "response.output_item.done", output_index: 0, item }) +
          ev({ type: "response.completed", response: { id: "r1", model: body.model, status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  gemini = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
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
  gemini?.stop(true);
  codex?.stop(true);
});

function config(): Config {
  const cfg = defaultConfig();
  cfg.loggingLevel = "error";
  cfg.access.apiKeys = ["sk-proxy"];
  const anthropicBase = `http://127.0.0.1:${anthropic.port}`;
  cfg.claudeApiKeys = [
    credential({ apiKey: "sk-ant-exhausted", baseUrl: anthropicBase, priority: 1 }),
    credential({ apiKey: "sk-ant-healthy", baseUrl: anthropicBase }),
  ];
  cfg.openaiApiKeys = [credential({ apiKey: "sk-openai", baseUrl: `http://127.0.0.1:${openai.port}/v1`, models: [{ name: openaiModel, alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }] })];
  const codexBase = `http://127.0.0.1:${codex.port}`;
  const codexModels = [{ name: codexModel, alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }];
  cfg.codexApiKeys = [
    credential({ apiKey: "sk-codex-limited", baseUrl: codexBase, priority: 1, models: codexModels }),
    credential({ apiKey: "sk-codex-ok", baseUrl: codexBase, models: codexModels }),
  ];
  cfg.geminiApiKeys = [credential({ apiKey: "gemini-key", baseUrl: `http://127.0.0.1:${gemini.port}` })];
  return cfg;
}

function messages(model: string, stream: boolean): Request {
  return new Request("http://proxy.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-proxy" },
    body: JSON.stringify({ model, max_tokens: 64, stream, messages: [{ role: "user", content: "hi" }] }),
  });
}

function sseEvents(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("event: "))
    .map((l) => l.slice(7));
}

test("Claude: 429 on the preferred key fails over to the healthy key and cools the first", async () => {
  const app = await createApp(config(), { store: new MemoryStore(), registry: new ModelRegistry(), autoRefresh: false });
  try {
    anthropicHits.length = 0;
    const res = await app.fetch(messages(claudeModel, false));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]!.text).toBe("hello from claude");
    expect(anthropicHits).toEqual(["sk-ant-exhausted", "sk-ant-healthy"]);

    const cooled = app.manager.list().find((a) => a.attributes.api_key === "sk-ant-exhausted")!;
    const state = Object.values(cooled.modelStates ?? {})[0];
    expect(state?.quota.exceeded).toBe(true);

    // The cooled key is skipped on the next request, which also streams.
    anthropicHits.length = 0;
    const stream = await app.fetch(messages(claudeModel, true));
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const events = sseEvents(await stream.text());
    expect(events[0]).toBe("message_start");
    expect(events.at(-1)).toBe("message_stop");
    expect(anthropicHits).toEqual(["sk-ant-healthy"]);
  } finally {
    await app.stop();
  }
});

test("OpenAI API key: Claude request is translated to chat completions and back", async () => {
  const app = await createApp(config(), { store: new MemoryStore(), registry: new ModelRegistry(), autoRefresh: false });
  try {
    const res = await app.fetch(messages(openaiModel, false));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; content: Array<{ type: string; text: string }>; stop_reason: string };
    expect(body.type).toBe("message");
    expect(body.content[0]).toMatchObject({ type: "text", text: "hello from openai" });
    expect(body.stop_reason).toBe("end_turn");

    const stream = await app.fetch(messages(openaiModel, true));
    const text = await stream.text();
    const events = sseEvents(text);
    expect(events[0]).toBe("message_start");
    expect(events.at(-1)).toBe("message_stop");
    expect(text).toContain("from openai");
  } finally {
    await app.stop();
  }
});

test("Gemini AI Studio key: Claude request is translated to generateContent and back", async () => {
  const app = await createApp(config(), { store: new MemoryStore(), registry: new ModelRegistry(), autoRefresh: false });
  try {
    const res = await app.fetch(messages(geminiModel, false));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text: string }> };
    expect(body.content.map((c) => c.text).join("")).toContain("hello from gemini");

    const stream = await app.fetch(messages(geminiModel, true));
    const text = await stream.text();
    const events = sseEvents(text);
    expect(events[0]).toBe("message_start");
    expect(events.at(-1)).toBe("message_stop");
    expect(text).toContain("from gemini");
  } finally {
    await app.stop();
  }
});

test("Codex: a mid-stream usage limit cools the account and the next request uses the other key", async () => {
  const app = await createApp(config(), { store: new MemoryStore(), registry: new ModelRegistry(), autoRefresh: false });
  try {
    codexHits.length = 0;
    // The limited key streams response.created and then a terminal usage_limit_reached error.
    // Codex is streamed upstream even for non-stream clients, so the error arrives before any
    // translated output: the manager fails over within the same request.
    const res = await app.fetch(messages(codexModel, false));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text: string }> };
    expect(body.content.map((c) => c.text).join("")).toContain("hello from codex");
    expect(codexHits).toEqual(["sk-codex-limited", "sk-codex-ok"]);

    const limited = app.manager.list().find((a) => a.attributes.api_key === "sk-codex-limited")!;
    expect(limited.quota.reason).toBe("credential_quota");
    expect(limited.quota.nextRecoverAt).toBeGreaterThan(Date.now() + 50 * 60 * 1000);

    codexHits.length = 0;
    const stream = await app.fetch(messages(codexModel, true));
    const text = await stream.text();
    const events = sseEvents(text);
    expect(events[0]).toBe("message_start");
    expect(events.at(-1)).toBe("message_stop");
    expect(text).toContain("hello from codex");
    expect(codexHits).toEqual(["sk-codex-ok"]);
  } finally {
    await app.stop();
  }
});
