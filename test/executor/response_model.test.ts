// Ported from: internal/runtime/executor/helps/response_model_test.go
// Ported from: internal/runtime/executor/helps/response_model_multiprovider_test.go
// Ported from: internal/runtime/executor/helps/stream_response_model_observer_test.go
// Ported from: internal/runtime/executor/response_model_multiprovider_test.go
// Skipped cases: the usage-record halves (buildRecord / Publish into usage plugins: TestUsageReporterRecordsSubstituted
//   CodexResponseModelAndWarnsOnce record fields, TestUsageReporterAdditionalModelRecordOmitsResponseModel,
//   TestStreamUsageBufferMultiProviderResponseModelPropagation, Test{Claude,Gemini,OpenAICompat}UsageRecordCarriesResponseModel)
//   are re-expressed on ResponseModelReporter: this port records usage at the HTTP layer, so the executors only keep the
//   observed response model and emit the substitution warning. TestUsageReporterWarnsOnceUnderConcurrentObservationsAndPublishes
//   runs sequentially (no goroutines). TestGeminiInteractionsUsageRecordCarriesResponseModel (Interactions API dropped),
//   TestDevin* (Devin dropped).
// New cases: the AI Studio and OpenAI executors observe the raw upstream frames and warn once per attempt.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  ResponseModelReporter,
  StreamResponseModelObserver,
  defaultMaxLinesPerStreamEvent,
  defaultMaxStreamModelBufferBound,
  extractCodexResponseModelEvent,
  extractResponseModelEvent,
  isModelSubstituted,
  maxResponseModelLength,
} from "../../src/executor/response_model.ts";
import { AIStudioExecutor } from "../../src/executor/gemini/aistudio.ts";
import { OpenAICompatExecutor } from "../../src/executor/openai/index.ts";
import { newAuth } from "../../src/auth/types.ts";

function reporter(provider: string, model: string, authIndex?: string): { r: ResponseModelReporter; warnings: string[] } {
  const warnings: string[] = [];
  const r = new ResponseModelReporter({ provider, model, authIndex, warn: (m) => warnings.push(m) });
  return { r, warnings };
}

const substitution = (ws: string[]) => ws.filter((w) => w.includes("upstream served model"));

describe("extractCodexResponseModelEvent", () => {
  const cases: Array<[string, string, string]> = [
    ["sse response created", `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.6-luna"}}`, "gpt-5.6-luna"],
    ["sse response created without space after data prefix", `data:{"type":"response.created","response":{"model":"gpt-6-astra"}}`, "gpt-6-astra"],
    ["raw json response completed", `{"type":"response.completed","response":{"model":"gpt-5.6-luna","usage":{"total_tokens":12}}}`, "gpt-5.6-luna"],
    ["response in progress", `{"type":"response.in_progress","response":{"model":"gpt-5.6-terra"}}`, "gpt-5.6-terra"],
    ["response incomplete", `{"type":"response.incomplete","response":{"model":"gpt-5.6-sol"}}`, "gpt-5.6-sol"],
    ["response done", `{"type":"response.done","response":{"model":"gpt-5.3-codex-spark"}}`, "gpt-5.3-codex-spark"],
    ["model value is trimmed", `{"type":"response.created","response":{"model":"  gpt-6-astra  "}}`, "gpt-6-astra"],
    ["output text delta is ignored", `data: {"type":"response.output_text.delta","delta":"hi","response":{"model":"gpt-5.6-luna"}}`, ""],
    ["output item done is ignored", `{"type":"response.output_item.done","item":{"type":"message"}}`, ""],
    ["rate limits event is ignored", `{"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":12}}}`, ""],
    ["terminal failure event is ignored", `{"type":"error","error":{"code":"server_is_overloaded"}}`, ""],
    ["responses compact object", `{"id":"resp_1","object":"response.compaction","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`, ""],
    ["images api response", `{"created":1745539200,"data":[{"b64_json":"aGk="}]}`, ""],
    ["image generation completed event", `data: {"type":"image_generation.completed","b64_json":"aGk="}`, ""],
    ["non string model value", `{"type":"response.created","response":{"model":123}}`, ""],
    ["object model value", `{"type":"response.created","response":{"model":{"id":"gpt-5.6-luna"}}}`, ""],
    ["oversized model value", `{"type":"response.created","response":{"model":"${"m".repeat(maxResponseModelLength + 1)}"}}`, ""],
    ["model value at the length limit", `{"type":"response.created","response":{"model":"${"m".repeat(maxResponseModelLength)}"}}`, "m".repeat(maxResponseModelLength)],
    ["done marker", "data: [DONE]", ""],
    ["sse event line", "event: response.created", ""],
    ["empty payload", "", ""],
    ["malformed json", `{"type":"response.created","response":{"model":"gpt-5.6-luna"`, ""],
    ["response without model", `{"type":"response.created","response":{"id":"resp_1"}}`, ""],
  ];
  for (const [name, payload, want] of cases) {
    test(name, () => {
      expect(extractCodexResponseModelEvent(payload).model).toBe(want);
    });
  }
});

describe("isModelSubstituted", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["silent substitution", "gpt-6-astra", "gpt-5.6-luna", true],
    ["same model", "gpt-6-astra", "gpt-6-astra", false],
    ["thinking suffix stripped from requested", "gpt-6-astra(high)", "gpt-6-astra", false],
    ["thinking suffix stripped from served", "gpt-6-astra", "gpt-6-astra(high)", false],
    ["thinking suffix on both sides", "gpt-6-astra(high)", "gpt-6-astra(low)", false],
    ["thinking suffix with substitution", "gpt-6-astra(high)", "gpt-5.6-luna", true],
    ["numeric thinking suffix", "gpt-5.6-terra(16384)", "gpt-5.6-terra", false],
    ["case insensitive requested", "GPT-6-Astra", "gpt-6-astra", false],
    ["case insensitive served", "gpt-6-astra", "  GPT-6-ASTRA  ", false],
    ["served pins dashed date", "gpt-5.6-terra", "gpt-5.6-terra-2026-05-13", false],
    ["served pins compact date", "gpt-5.6-sol", "gpt-5.6-sol-20260513", false],
    ["requested pins dashed date", "gpt-5.6-terra-2026-05-13", "gpt-5.6-terra", false],
    ["requested pins compact date", "gpt-5.6-sol-20260513", "gpt-5.6-sol", false],
    ["different dates on both sides", "gpt-5.6-terra-2026-05-13", "gpt-5.6-terra-2026-06-01", true],
    ["incomplete date suffix", "gpt-5.6-sol", "gpt-5.6-sol-2026-5-13", true],
    ["non date suffix", "gpt-5.5", "gpt-5.5-codex", true],
    ["date suffix with trailing tag", "gpt-5.6-luna", "gpt-5.6-luna-2026-05-13-preview", true],
    ["spark unchanged", "gpt-5.3-codex-spark", "gpt-5.3-codex-spark", false],
    ["review model unchanged", "codex-auto-review", "codex-auto-review", false],
    ["review model substituted", "codex-auto-review", "gpt-5.6-luna", true],
    ["empty served", "gpt-6-astra", "", false],
    ["blank served", "gpt-6-astra", "   ", false],
    ["empty requested", "", "gpt-5.6-luna", false],
    // TestIsModelSubstitutedMultiProvider
    ["claude dated alias match", "claude-3-7-sonnet", "claude-3-7-sonnet-20250219", false],
    ["claude latest alias match", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022", false],
    ["claude substitution opus to sonnet", "claude-opus-5", "claude-sonnet-5", true],
    ["claude thinking suffix match", "claude-3-7-sonnet(high)", "claude-3-7-sonnet", false],
    ["gemini dated alias match", "gemini-2.5-flash", "gemini-2.5-flash-2025-05-20", false],
    ["gemini preview is substitution", "gemini-2.5-flash", "gemini-2.5-flash-preview", true],
    ["gemini numeric version alias match", "gemini-1.5-pro", "gemini-1.5-pro-002", false],
    ["gemini substitution pro to flash", "gemini-2.5-pro", "gemini-2.5-flash", true],
    ["openai dated alias match", "gpt-4o", "gpt-4o-2024-08-06", false],
    ["openai substitution gpt-4o to gpt-4o-mini", "gpt-4o", "gpt-4o-mini", true],
    ["openai provider prefix match", "openai/gpt-4o", "gpt-4o", false],
    ["devin provider prefix match", "devin/swe-2", "swe-2", false],
  ];
  for (const [name, requested, served, want] of cases) {
    test(name, () => {
      expect(isModelSubstituted(requested, served)).toBe(want);
    });
  }
});

describe("extractResponseModelEvent (multi-provider)", () => {
  const cases: Array<[string, string, string, string, boolean]> = [
    ["claude sse message_start", "claude", `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-7-sonnet-20250219"}}`, "claude-3-7-sonnet-20250219", false],
    ["claude sse message_stop", "claude", `data: {"type":"message_stop"}`, "", true],
    ["claude raw json non-stream message", "claude", `{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-5-haiku-20241022","content":[{"type":"text","text":"hello"}]}`, "claude-3-5-haiku-20241022", true],
    ["gemini sse chunk with modelVersion", "gemini", `data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"modelVersion":"gemini-2.5-flash"}`, "gemini-2.5-flash", false],
    ["gemini sse terminal chunk with finishReason", "gemini", `data: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}],"modelVersion":"gemini-2.5-flash"}`, "gemini-2.5-flash", true],
    ["gemini raw json non-stream with modelVersion", "gemini", `{"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}],"modelVersion":"gemini-2.5-pro"}`, "gemini-2.5-pro", true],
    ["antigravity wrapped response.modelVersion", "antigravity", `data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]}}],"modelVersion":"gemini-3.7-flash"}}`, "gemini-3.7-flash", false],
    ["gemini interactions sse interaction.completed with model", "gemini", `data: {"event_type":"interaction.completed","interaction":{"id":"i1","status":"requires_action","usage":{"total_input_tokens":2,"total_output_tokens":3,"total_tokens":5},"service_tier":"standard","model":"gemini-3.1-flash-lite"}}`, "gemini-3.1-flash-lite", true],
    ["gemini interactions sse interaction.created with model", "gemini", `data: {"event_type":"interaction.created","interaction":{"id":"i1","model":"gemini-3.1-flash-lite"}}`, "gemini-3.1-flash-lite", false],
    ["gemini interactions sse interaction.completed without model", "gemini", `data: {"event_type":"interaction.completed","interaction":{"id":"i1","status":"completed"}}`, "", true],
    ["gemini-interactions provider sse interaction.completed with model", "gemini-interactions", `data: {"event_type":"interaction.completed","interaction":{"id":"i1","status":"completed","model":"gemini-3.1-flash-lite"}}`, "gemini-3.1-flash-lite", true],
    ["openai sse chat completion chunk", "openai", `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{"content":"hi"}}]}`, "gpt-4o-2024-08-06", false],
    ["openai sse chat completion terminal chunk", "openai", `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`, "gpt-4o-2024-08-06", true],
    ["openai raw json chat completion", "openai", `{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4o-2024-08-06","choices":[{"index":0,"message":{"role":"assistant","content":"hello"}}]}`, "gpt-4o-2024-08-06", true],
    ["xai sse chat completion chunk", "xai", `data: {"id":"chatcmpl-x1","object":"chat.completion.chunk","model":"grok-beta","choices":[{"index":0,"delta":{"content":"hi"}}]}`, "grok-beta", false],
    ["generic fallback with model", "custom", `{"model":"custom-model-v1","object":"chat.completion"}`, "custom-model-v1", true],
    ["generic interactions sse interaction.completed with model", "custom", `data: {"event_type":"interaction.completed","interaction":{"model":"custom-model-v2"}}`, "custom-model-v2", true],
  ];
  for (const [name, provider, payload, model, terminal] of cases) {
    test(name, () => {
      expect(extractResponseModelEvent(payload, provider)).toEqual({ model, terminal });
    });
  }
});

const codexSubstitutedStream = `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.6-luna"}}
data: {"type":"response.in_progress","response":{"id":"resp_1","model":"gpt-5.6-luna"}}
data: {"type":"response.output_text.delta","delta":"hello"}
data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.6-luna","usage":{"input_tokens":5,"output_tokens":7,"total_tokens":12}}}
data: [DONE]`;

describe("ResponseModelReporter (Go: UsageReporter response model)", () => {
  test("records a substituted codex response model and warns once at publish", () => {
    const { r, warnings } = reporter("codex", "gpt-6-astra", "auth-index-7");
    for (const line of codexSubstitutedStream.split("\n")) r.observeResponseModel(line);
    expect(r.responseModel()).toBe("gpt-5.6-luna");
    expect(r.model).toBe("gpt-6-astra");
    // Observing events must not log anything; the warning belongs to the attempt.
    expect(substitution(warnings)).toEqual([]);
    r.publish();
    r.publish();
    const ws = substitution(warnings);
    expect(ws).toEqual([`codex executor: upstream served model "gpt-5.6-luna" for requested model "gpt-6-astra" (auth_index=auth-index-7)`]);
    expect(ws[0]).not.toContain("example.com");
    expect(ws[0]).not.toContain("auth_file");
  });

  test("does not warn when the codex response model matches", () => {
    const { r, warnings } = reporter("codex", "gpt-6-astra(high)");
    r.observeResponseModel(`data: {"type":"response.created","response":{"model":"gpt-6-astra-2026-05-13"}}`);
    r.publish();
    expect(r.responseModel()).toBe("gpt-6-astra-2026-05-13");
    expect(substitution(warnings)).toEqual([]);
  });

  test("ignores payloads without a response model; a missing credential is labelled nil", () => {
    const { r, warnings } = reporter("codex", "gpt-6-astra");
    r.observeResponseModel(`data: {"type":"response.created","response":{"model":"gpt-5.6-luna"}}`);
    r.observeResponseModel(`data: {"type":"response.output_text.delta","delta":"hello"}`);
    r.publish();
    expect(r.responseModel()).toBe("gpt-5.6-luna");
    const ws = substitution(warnings);
    expect(ws.length).toBe(1);
    expect(ws[0]!.endsWith("(auth_index=nil)")).toBe(true);
  });

  test("warns once under repeated observations and publishes", () => {
    const { r, warnings } = reporter("codex", "gpt-6-astra", "auth-index-7");
    const created = `data: {"type":"response.created","response":{"model":"gpt-5.6-luna"}}`;
    const completed = `data: {"type":"response.completed","response":{"model":"gpt-5.6-luna","usage":{"total_tokens":4}}}`;
    for (let i = 0; i < 32; i++) {
      r.observeResponseModel(i % 2 === 0 ? created : completed);
      r.publish();
    }
    expect(r.responseModel()).toBe("gpt-5.6-luna");
    expect(substitution(warnings).length).toBe(1);
  });

  test("repeated substitutions across attempts are not throttled", () => {
    const warnings: string[] = [];
    const attempt = (authIndex: string, served = "gpt-5.6-luna") => {
      const r = new ResponseModelReporter({ provider: "codex", model: "gpt-6-astra", authIndex, warn: (m) => warnings.push(m) });
      r.observeResponseModel(`{"type":"response.completed","response":{"model":"${served}"}}`);
      r.publish();
    };
    attempt("auth-index-7");
    attempt("auth-index-7");
    expect(substitution(warnings).length).toBe(2);
    attempt("auth-index-8");
    expect(substitution(warnings).length).toBe(3);
    attempt("auth-index-7", "GPT-5.6-LUNA");
    expect(substitution(warnings).length).toBe(4);
  });

  test("a terminal event finalizes the response model", () => {
    const { r } = reporter("codex", "gpt-5.4-mini");
    r.observeResponseModel(`data: {"type":"response.completed","response":{"model":"gpt-5.4-mini"}}`);
    expect(r.isResponseModelFinal()).toBe(true);
    r.observeResponseModel(`data: {"type":"response.created","response":{"model":"other"}}`);
    r.setResponseModel("other");
    expect(r.responseModel()).toBe("gpt-5.4-mini");
  });

  const providers: Array<[string, string, string, string, string]> = [
    ["claude", "claude-opus-5", "claude-sonnet-5", `data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5"}}`, `claude executor: upstream served model "claude-sonnet-5" for requested model "claude-opus-5"`],
    ["gemini", "gemini-2.5-pro", "gemini-2.5-flash", `data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"modelVersion":"gemini-2.5-flash"}`, `gemini executor: upstream served model "gemini-2.5-flash" for requested model "gemini-2.5-pro"`],
    ["openai", "gpt-4o", "gpt-4o-mini", `data: {"id":"chatcmpl-1","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hi"}}]}`, `openai executor: upstream served model "gpt-4o-mini" for requested model "gpt-4o"`],
    ["gemini-interactions", "gemini-2.5-pro", "gemini-3.1-flash-lite", `data: {"event_type":"interaction.completed","interaction":{"id":"i1","status":"completed","service_tier":"standard","model":"gemini-3.1-flash-lite"}}`, `gemini-interactions executor: upstream served model "gemini-3.1-flash-lite" for requested model "gemini-2.5-pro"`],
  ];
  for (const [provider, requested, served, chunk, expected] of providers) {
    test(`multi-provider substitution warning: ${provider}`, () => {
      const { r, warnings } = reporter(provider, requested, "auth-" + provider);
      r.observeResponseModel(chunk);
      expect(r.responseModel()).toBe(served);
      r.publish();
      const ws = substitution(warnings);
      expect(ws.length).toBe(1);
      expect(ws[0]).toContain(expected);
    });
  }

  // Go: Test{Claude,Gemini,OpenAICompat}UsageRecordCarriesResponseModel, reduced to the observed model.
  test("records the response model per provider", () => {
    const claude = reporter("claude", "claude-opus-5").r;
    claude.observeResponseModel(`data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5"}}`);
    expect(claude.responseModel()).toBe("claude-sonnet-5");
    const gemini = reporter("gemini", "gemini-2.5-pro").r;
    gemini.observeResponseModel(`data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"modelVersion":"gemini-2.5-flash"}`);
    expect(gemini.responseModel()).toBe("gemini-2.5-flash");
    const openai = reporter("openai", "gpt-4o").r;
    openai.observeResponseModel(`{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4o-2024-08-06","choices":[]}`);
    expect(openai.responseModel()).toBe("gpt-4o-2024-08-06");
  });
});

describe("StreamResponseModelObserver", () => {
  const observer = (model = "dall-e-3") => {
    const { r } = reporter("openai-compat", model);
    return { r, o: new StreamResponseModelObserver(r) };
  };

  test("JSON split across network chunk boundaries", () => {
    const { r, o } = observer();
    for (const c of [`data: {"id":"img_1","cre`, `ated":1700000000,"mo`, `del":"dall-e-3","data":[]}` + "\n\n"]) o.feed(c);
    o.finish();
    expect(r.responseModel()).toBe("dall-e-3");
  });

  test("multiple SSE events packed into a single chunk", () => {
    const { r, o } = observer();
    o.feed('event: ping\ndata: {}\n\nevent: progress\ndata: {"percent":50}\n\nevent: completion\ndata: {"model":"dall-e-3","status":"completed"}\n\n');
    o.finish();
    expect(r.responseModel()).toBe("dall-e-3");
  });

  test("chunks starting with an event: prefix", () => {
    const { r, o } = observer("flux-pro");
    o.feed("event: image_generation\n");
    o.feed('data: {"model":"flux-pro"}\n\n');
    o.finish();
    expect(r.responseModel()).toBe("flux-pro");
  });

  test("multi-line data fields within one SSE event", () => {
    const { r, o } = observer();
    o.feed('event: message\ndata: {\ndata: "model": "dall-e-3"\ndata: }\n\n');
    o.finish();
    expect(r.responseModel()).toBe("dall-e-3");
  });

  test("an oversized line is discarded and the next event still parses", () => {
    const { r, o } = observer();
    o.feed("data: " + "A".repeat(defaultMaxStreamModelBufferBound + 1000));
    o.feed('\n\nevent: result\ndata: {"model":"dall-e-3"}\n\n');
    o.finish();
    expect(r.responseModel()).toBe("dall-e-3");
  });

  test("finish flushes an incomplete non-SSE line", () => {
    const { r, o } = observer();
    o.feed(`{"created":123,"mo`);
    o.feed(`del":"dall-e-3"}`);
    o.finish();
    expect(r.responseModel()).toBe("dall-e-3");
  });

  test("repeated empty data lines stay bounded", () => {
    const { r, o } = observer();
    const chunk = "data:\n".repeat(100);
    for (let i = 0; i < 50; i++) o.feed(chunk);
    expect(o.frame.length).toBeLessThanOrEqual(defaultMaxLinesPerStreamEvent);
    expect(o.frame.length).toBe(0);
    o.feed('\n\nevent: completion\ndata: {"model":"dall-e-3"}\n\n');
    o.finish();
    expect(r.responseModel()).toBe("dall-e-3");
  });

  test("an event over the bound is dropped up to its boundary", () => {
    const { r, o } = observer();
    const line = "data: " + "x".repeat(1024) + "\n";
    for (let i = 0; i < 100; i++) o.feed(line);
    expect(o.frame.length).toBe(0);
    o.feed('\n\ndata: {"model":"dall-e-3"}\n\n');
    o.finish();
    expect(r.responseModel()).toBe("dall-e-3");
  });
});

describe("executors warn about a substituted upstream model", () => {
  let warn: ReturnType<typeof spyOn> | undefined;
  afterEach(() => warn?.mockRestore());

  const servedWarnings = (): string[] =>
    (warn!.mock.calls as unknown[][]).map((args) => args.map(String).join(" ")).filter((line) => line.includes("upstream served model"));

  test("AI Studio stream and non-stream", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const frame = `{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}],"modelVersion":"gemini-2.5-flash"}`;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname.includes("stream")
          ? new Response("data: " + frame + "\n\n", { headers: { "Content-Type": "text/event-stream" } })
          : Response.json(JSON.parse(frame)),
    });
    try {
      const exec = new AIStudioExecutor();
      const auth = newAuth({ id: "a", provider: "aistudio", label: "idx-1", attributes: { api_key: "k", base_url: `http://127.0.0.1:${server.port}` } });
      const payload = `{"model":"gemini-2.5-pro","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`;
      await exec.execute(auth, { model: "gemini-2.5-pro", payload, format: "claude" }, { stream: false, sourceFormat: "claude" });
      expect(servedWarnings()).toEqual([expect.stringContaining(`aistudio executor: upstream served model "gemini-2.5-flash" for requested model "gemini-2.5-pro" (auth_index=idx-1)`)]);
      const result = await exec.executeStream(auth, { model: "gemini-2.5-pro", payload, format: "claude" }, { stream: true, sourceFormat: "claude" });
      for await (const _ of result.chunks) void _;
      expect(servedWarnings().length).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("OpenAI chat completions stream", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\ndata: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    try {
      const exec = new OpenAICompatExecutor();
      const auth = newAuth({ id: "o", provider: "openai", attributes: { api_key: "k", base_url: `http://127.0.0.1:${server.port}/v1` } });
      const payload = `{"model":"gpt-4o","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`;
      const result = await exec.executeStream(auth, { model: "gpt-4o", payload, format: "claude" }, { stream: true, sourceFormat: "claude" });
      for await (const _ of result.chunks) void _;
      expect(servedWarnings()).toEqual([expect.stringContaining(`openai executor: upstream served model "gpt-4o-mini" for requested model "gpt-4o" (auth_index=nil)`)]);
    } finally {
      server.stop(true);
    }
  });
});
