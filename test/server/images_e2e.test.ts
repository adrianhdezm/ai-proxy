// New (no upstream test): /v1/images/generations and /v1/images/edits end to end through the real
// stack (createApp: HTTP server, inbound auth, AuthManager, the real Codex and OpenAI executors)
// against fake Codex and OpenAI upstreams on Bun.serve port 0: generation via a Codex API key
// (direct /images/generations, JSON and SSE), generation via an OpenAI API key, multipart edits
// (rewritten to JSON for Codex, passed through as multipart to OpenAI), the
// multimedia.disableImageGeneration switch (404 on both endpoints, no image_generation tool on
// Claude requests through Codex) and upstream failures mapped to the OpenAI error envelope.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../../src/app.ts";
import type { Auth } from "../../src/auth/types.ts";
import { defaultConfig } from "../../src/config/load.ts";
import type { ApiKeyCredential, Config } from "../../src/config/types.ts";
import { encodeMultipart, isUploadedFile, parseMultipartForm } from "../../src/executor/openai/images.ts";
import { ModelRegistry, getCodexProModels } from "../../src/registry/index.ts";
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

interface Captured {
  path: string;
  headers: Headers;
  bytes: Uint8Array;
  text: string;
}

function credential(partial: Partial<ApiKeyCredential> & { apiKey: string }): ApiKeyCredential {
  return { baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

const ev = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const codexHits: Captured[] = [];
const openaiHits: Captured[] = [];
let codex: ReturnType<typeof Bun.serve>;
let openai: ReturnType<typeof Bun.serve>;

async function capture(request: Request, into: Captured[]): Promise<Captured> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const captured = { path: new URL(request.url).pathname, headers: request.headers, bytes, text: new TextDecoder().decode(bytes) };
  into.push(captured);
  return captured;
}

beforeAll(() => {
  codex = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const got = await capture(request, codexHits);
      if (got.path === "/responses") {
        // Claude /v1/messages through Codex.
        const item = { id: "msg_c", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] };
        return new Response(ev({ type: "response.output_item.done", output_index: 0, item }) + ev({ type: "response.completed", response: { id: "r1", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      const body = JSON.parse(got.text) as { prompt: string; stream?: boolean };
      if (body.prompt === "fail") return new Response(`{"detail":"codex image backend unavailable"}`, { status: 503, headers: { "Content-Type": "application/json" } });
      if (body.stream) {
        return new Response(
          'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"UA==","partial_image_index":0}\n\n' +
            'event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"Q09ERVg=","usage":{"input_tokens":4,"output_tokens":6,"total_tokens":10}}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return Response.json({ created: 1761900000, data: [{ b64_json: "Q09ERVg=" }], usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } });
    },
  });
  openai = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const got = await capture(request, openaiHits);
      const contentType = got.headers.get("Content-Type") ?? "";
      if (contentType.startsWith("application/json") && (JSON.parse(got.text) as { prompt: string }).prompt === "fail") {
        return Response.json({ error: { message: "Invalid size '7x7'.", type: "invalid_request_error", param: "size", code: "invalid_value" } }, { status: 400 });
      }
      return Response.json({ created: 1761900001, data: [{ url: "https://img.example/1.png" }] });
    },
  });
});

afterAll(() => {
  codex?.stop(true);
  openai?.stop(true);
});

function config(disableImageGeneration = false): Config {
  const cfg = defaultConfig();
  cfg.loggingLevel = "error";
  cfg.access.apiKeys = ["sk-proxy"];
  cfg.multimedia.disableImageGeneration = disableImageGeneration;
  // No models: the Codex key advertises the Pro catalog, GPT Image built-ins included.
  cfg.codexApiKeys = [credential({ apiKey: "sk-codex", baseUrl: `http://127.0.0.1:${codex.port}` })];
  cfg.openaiApiKeys = [credential({ apiKey: "sk-openai", baseUrl: `http://127.0.0.1:${openai.port}/v1`, models: [{ name: "gpt-image-1", alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }] })];
  return cfg;
}

async function newApp(disable = false) {
  return createApp(config(disable), { store: new MemoryStore(), registry: new ModelRegistry(), autoRefresh: false });
}

function post(path: string, body: string | Uint8Array, contentType = "application/json"): Request {
  return new Request(`http://proxy.test${path}`, { method: "POST", headers: { "Content-Type": contentType, Authorization: "Bearer sk-proxy" }, body });
}

describe("/v1/images through the real stack", () => {
  test("generation via a Codex credential (direct /images/generations)", async () => {
    const app = await newApp();
    try {
      codexHits.length = 0;
      const res = await app.fetch(post("/v1/images/generations", JSON.stringify({ model: "gpt-image-2", prompt: "a lighthouse", size: "1024x1024" })));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(await res.json()).toEqual({ created: 1761900000, data: [{ b64_json: "Q09ERVg=" }], usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } });
      const hit = codexHits[0]!;
      expect(hit.path).toBe("/images/generations");
      expect(hit.headers.get("Authorization")).toBe("Bearer sk-codex");
      expect(JSON.parse(hit.text)).toEqual({ model: "gpt-image-2", prompt: "a lighthouse", size: "1024x1024" });
    } finally {
      await app.stop();
    }
  });

  test("streaming generation via a Codex credential forwards the image SSE", async () => {
    const app = await newApp();
    try {
      codexHits.length = 0;
      const res = await app.fetch(post("/v1/images/generations", JSON.stringify({ prompt: "a lighthouse", stream: true, partial_images: 1 })));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: image_generation.partial_image");
      expect(text).toContain('"b64_json":"Q09ERVg="');
      expect(JSON.parse(codexHits[0]!.text)).toMatchObject({ model: "gpt-image-2", stream: true, partial_images: 1 });
      expect(codexHits[0]!.headers.get("Accept")).toBe("text/event-stream");
    } finally {
      await app.stop();
    }
  });

  test("generation via an OpenAI API key", async () => {
    const app = await newApp();
    try {
      openaiHits.length = 0;
      const res = await app.fetch(post("/v1/images/generations", JSON.stringify({ model: "gpt-image-1", prompt: "a fox", response_format: "url" })));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ created: 1761900001, data: [{ url: "https://img.example/1.png" }] });
      const hit = openaiHits[0]!;
      expect(hit.path).toBe("/v1/images/generations");
      expect(hit.headers.get("Authorization")).toBe("Bearer sk-openai");
      expect(JSON.parse(hit.text)).toEqual({ model: "gpt-image-1", prompt: "a fox", response_format: "url" });
    } finally {
      await app.stop();
    }
  });

  test("multipart edits: rewritten to JSON for Codex, passed through as multipart to OpenAI", async () => {
    const app = await newApp();
    try {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfe]);
      const file = { name: "in.png", type: "image/png", data: png, arrayBuffer: async () => png.buffer };

      codexHits.length = 0;
      const codexForm = encodeMultipart([
        { name: "model", value: "gpt-image-2" },
        { name: "prompt", value: "add a hat" },
        { name: "n", value: "2" },
        { name: "image[]", value: file },
      ]);
      const codexRes = await app.fetch(post("/v1/images/edits", codexForm.bytes, codexForm.contentType));
      expect(codexRes.status).toBe(200);
      const codexHit = codexHits[0]!;
      expect(codexHit.path).toBe("/images/edits");
      expect(codexHit.headers.get("Content-Type")).toBe("application/json");
      expect(JSON.parse(codexHit.text)).toEqual({ model: "gpt-image-2", prompt: "add a hat", n: 2, images: [{ image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` }] });

      openaiHits.length = 0;
      const openaiForm = encodeMultipart([
        { name: "prompt", value: "add a hat" },
        { name: "model", value: "gpt-image-1" },
        { name: "image", value: file },
      ]);
      const openaiRes = await app.fetch(post("/v1/images/edits", openaiForm.bytes, openaiForm.contentType));
      expect(openaiRes.status).toBe(200);
      const openaiHit = openaiHits[0]!;
      expect(openaiHit.path).toBe("/v1/images/edits");
      const form = await parseMultipartForm(openaiHit.bytes, openaiHit.headers.get("Content-Type")!);
      expect(form.parts.map((p) => p.name)).toEqual(["model", "prompt", "image"]);
      expect(form.get("model")).toBe("gpt-image-1");
      const sent = form.get("image");
      expect(isUploadedFile(sent) && Array.from(sent.data)).toEqual(Array.from(png));
    } finally {
      await app.stop();
    }
  });

  test("failures use the OpenAI error envelope", async () => {
    const app = await newApp();
    try {
      const openaiRes = await app.fetch(post("/v1/images/generations", JSON.stringify({ model: "gpt-image-1", prompt: "fail", size: "7x7" })));
      expect(openaiRes.status).toBe(400);
      expect(await openaiRes.json()).toEqual({ error: { message: "Invalid size '7x7'.", type: "invalid_request_error", param: "size", code: "invalid_value" } });

      const codexRes = await app.fetch(post("/v1/images/generations", JSON.stringify({ model: "gpt-image-2", prompt: "fail" })));
      expect(codexRes.status).toBe(503);
      expect(await codexRes.json()).toEqual({ error: { message: "codex image backend unavailable", type: "server_error", code: "internal_server_error" } });

      const unsupported = await app.fetch(post("/v1/images/generations", JSON.stringify({ model: "gpt-5.4-mini", prompt: "x" })));
      expect(unsupported.status).toBe(400);
      expect(((await unsupported.json()) as { error: { type: string } }).error.type).toBe("invalid_request_error");

      const wrongMethod = await app.fetch(new Request("http://proxy.test/v1/images/generations", { headers: { Authorization: "Bearer sk-proxy" } }));
      expect(wrongMethod.status).toBe(405);
    } finally {
      await app.stop();
    }
  });

  test("disableImageGeneration: both endpoints 404 and Claude requests through Codex get no image tool", async () => {
    const claudeMessage = (model: string) =>
      new Request("http://proxy.test/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "sk-proxy" },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
    const codexModel = getCodexProModels().find((m) => !m.id.startsWith("gpt-image") && !m.id.endsWith("spark"))!.id;

    const disabled = await newApp(true);
    try {
      codexHits.length = 0;
      const gen = await disabled.fetch(post("/v1/images/generations", JSON.stringify({ prompt: "x" })));
      expect(gen.status).toBe(404);
      expect(((await gen.json()) as { error: { message: string } }).error.message).toBe("image generation is disabled");
      const edit = await disabled.fetch(post("/v1/images/edits", JSON.stringify({ prompt: "x", images: [{ image_url: "data:image/png;base64,AA==" }] })));
      expect(edit.status).toBe(404);
      expect(codexHits.length).toBe(0);

      const msg = await disabled.fetch(claudeMessage(codexModel));
      expect(msg.status).toBe(200);
      const tools = (JSON.parse(codexHits[0]!.text) as { tools?: Array<{ type: string }> }).tools ?? [];
      expect(tools.some((t) => t.type === "image_generation")).toBe(false);
    } finally {
      await disabled.stop();
    }

    const enabled = await newApp(false);
    try {
      codexHits.length = 0;
      const msg = await enabled.fetch(claudeMessage(codexModel));
      expect(msg.status).toBe(200);
      const tools = (JSON.parse(codexHits[0]!.text) as { tools?: Array<Record<string, unknown>> }).tools ?? [];
      expect(tools).toContainEqual({ type: "image_generation", output_format: "png" });
    } finally {
      await enabled.stop();
    }
  });
});
