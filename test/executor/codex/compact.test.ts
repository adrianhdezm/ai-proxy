// Ported from: internal/runtime/executor/codex_executor_compact_test.go
// Skipped cases: TestCodexExecutorCompactUseSIWCAppliesSIWCRulesBeforePayloadFinalizer (SIWC credentials and
//   payload config rules are not ported).
import { afterAll, describe, expect, test } from "bun:test";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { apiKeyAuth, options, request, sseResponse, startUpstream } from "./helpers.ts";

describe("codex executor compact", () => {
  let respond: (body: string) => Response = () => new Response("{}");
  const upstream = startUpstream((req) => respond(req.body));
  afterAll(() => upstream.close());

  for (const tc of [
    { name: "missing instructions", payload: `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":"history"},{"type":"compaction_trigger"}]}` },
    { name: "null instructions", payload: `{"model":"gpt-5.4","instructions":null,"input":[{"type":"message","role":"user","content":"history"},{"type":"compaction_trigger"}]}` },
  ]) {
    test(`TestCodexExecutorCompactAddsDefaultInstructionsWithoutInjectingImageTool/${tc.name}`, async () => {
      const answer = `{"id":"resp_1","object":"response.compaction","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`;
      respond = () => new Response(answer, { headers: { "Content-Type": "application/json" } });
      const before = upstream.requests.length;
      const resp = await new CodexExecutor().execute(apiKeyAuth(upstream.url), request("gpt-5.4", tc.payload), options("openai-response", false, { alt: "responses/compact" }));
      const seen = upstream.requests[before]!;
      expect(seen.path).toBe("/responses/compact");
      const body = JSON.parse(seen.body);
      expect(body.instructions).toBe("");
      expect(body.tools).toBeUndefined();
      expect(body.input).toHaveLength(2);
      expect(body.input[1].type).toBe("compaction_trigger");
      expect(resp.payload).toBe(answer);
    });
  }

  describe("TestCodexExecutorReplayedWebSearchCallHistoryEnsuresWebSearchTool_Issue6770", () => {
    const hasWebSearchCall = (body: string) => (JSON.parse(body).input as Array<{ type: string }>).some((item) => item.type === "web_search_call");
    const countWebSearchTools = (body: string) => ((JSON.parse(body).tools ?? []) as Array<{ type: string }>).filter((tool) => tool.type === "web_search").length;
    const compactionPayloadWithEmptyTools = `{"model":"gpt-6.1-sol","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"search docs"}]},{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"openai responses web search"}},{"id":"ws_2","type":"web_search_call","status":"completed","action":{"type":"open_page","url":"https://platform.openai.com/docs"}},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Found docs."}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"Summarize conversation"}]}],"tools":[],"tool_choice":"auto"}`;
    const protectionError = `data: {"type":"error","error":{"message":"response protection is unavailable","type":"internal_error","param":null,"code":null}}\n\n`;

    test("ExecuteStream with empty tools injects web_search and avoids 502 response protection error", async () => {
      respond = (body) =>
        hasWebSearchCall(body) && countWebSearchTools(body) === 0
          ? sseResponse(protectionError)
          : sseResponse(`data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"summary"}]}],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n`);
      const before = upstream.requests.length;
      const result = await new CodexExecutor({ streamBootstrapBuffering: true }).executeStream(apiKeyAuth(upstream.url, "test", { plan_type: "plus" }), request("gpt-6.1-sol", compactionPayloadWithEmptyTools), options("openai-response", true));
      for await (const _chunk of result.chunks) {
        // drain; a terminal error would throw
      }
      expect(countWebSearchTools(upstream.requests[before]!.body)).toBe(1);
    });

    test("Execute non-stream with image generation disabled still injects web_search", async () => {
      respond = (body) =>
        hasWebSearchCall(body) && countWebSearchTools(body) === 0
          ? sseResponse(protectionError)
          : sseResponse(`data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n`);
      const before = upstream.requests.length;
      await new CodexExecutor({ disableImageGeneration: true }).execute(apiKeyAuth(upstream.url), request("gpt-6.1-sol", compactionPayloadWithEmptyTools), options("openai-response", false));
      const body = upstream.requests[before]!.body;
      expect(countWebSearchTools(body)).toBe(1);
      expect(JSON.parse(body).tools).toHaveLength(1);
    });

    test("Execute compact endpoint injects web_search when input replays web_search_call", async () => {
      respond = (body) =>
        hasWebSearchCall(body) && countWebSearchTools(body) === 0
          ? new Response(`{"error":{"message":"response protection is unavailable","type":"internal_error","param":null,"code":null}}`, { status: 502 })
          : new Response(`{"id":"resp_compact_1","object":"response.compaction","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}`, { headers: { "Content-Type": "application/json" } });
      const before = upstream.requests.length;
      const compactPayload = `{"model":"gpt-6.1-sol","input":[{"type":"message","role":"user","content":"history"},{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"q"}},{"type":"compaction_trigger"}]}`;
      await new CodexExecutor().execute(apiKeyAuth(upstream.url), request("gpt-6.1-sol", compactPayload), options("openai-response", false, { alt: "responses/compact" }));
      expect(countWebSearchTools(upstream.requests[before]!.body)).toBe(1);
    });
  });

  test("compact refuses streaming (Go: ExecuteStream with Alt responses/compact)", async () => {
    const err = await new CodexExecutor()
      .executeStream(apiKeyAuth(upstream.url), request("gpt-5.4", `{"model":"gpt-5.4","input":"hi"}`), options("openai-response", true, { alt: "responses/compact" }))
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect((err as StatusError).statusCode).toBe(400);
  });

  test("non-stream Responses output gets complete usage details (Go: EnsureResponsesUsageDetails)", async () => {
    respond = () => sseResponse(`data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n`);
    const resp = await new CodexExecutor().execute(apiKeyAuth(upstream.url), request("gpt-5.4", `{"model":"gpt-5.4","input":"hi"}`), options("openai-response", false));
    const usage = JSON.parse(resp.payload).usage;
    expect(usage.input_tokens_details).toEqual({ cached_tokens: 0 });
    expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 0 });
  });
});
