// Ported from: internal/runtime/executor/claude_issue_6120_test.go
// Ported from: internal/runtime/executor/claude_issue7000_test.go
// Ported from: internal/runtime/executor/claude_issue7000_regression_test.go
// Ported from: internal/runtime/executor/claude_issue_6698_test.go
// Ported from: internal/runtime/executor/claude_mid_system_model_test.go
// Ported from: internal/runtime/executor/claude_executor_stop_reasons_test.go
// Skipped cases: claude_issue7000_regression_test.go: TestKimiExecutor_Issue7000DoesNotRewriteDelegatedToolChoice (Kimi
// not ported), the "chat" rows of TestClaudeExecutor_Issue7000OpenAITranslation (OpenAI chat-completions inbound not
// ported), TestClaudeExecutor_Issue7000OAuthPreservesThinkingHistory (preserved-thinking block_binding not ported), the
// local-count half of TestClaudeExecutor_Issue7000CountTokensUpstreamAndLocal (local token estimation not ported; count
// tokens always calls upstream), TestClaudeExecutor_Issue7000PayloadRulesRemainFinal and
// TestClaudeExecutor_Issue7000LocalCountPayloadRulesRemainFinal (payload config rules not ported).
// claude_issue_6698_test.go: the "openai chat" rows (OpenAI chat-completions inbound not ported) and
// TestClaudeExecutor_AdaptiveOnlyGeminiBudgetAndAuto (Gemini inbound not ported).
// claude_mid_system_model_test.go: TestClaudeExecutor_PayloadOverrideCannotSmuggleLegacyMidSystemMessage,
// TestClaudeExecutor_PayloadOverrideDoesNotClaimMatchingCallerTurn, TestClaudeExecutor_PayloadOverrideDoesNotRerunSystemPlacement
// and TestClaudeExecutorPayloadRepairsLegacyMidSystemMessage (payload config rules not ported); the chat, Gemini and
// Interactions rows of TestTranslatedRequestNeverPairsLegacyModelWithMidSystemMessage (those inbound formats are not ported).
// claude_executor_stop_reasons_test.go: TestClaudeExecutorChatContextWindowExceededMapsToLength and
// TestClaudeExecutorChatRefusalStaysSuccessful (OpenAI chat-completions response translation not ported).
// The Go round-tripper on the request context is the ClaudeExecutorConfig.fetch injection (fakeFetch); Go's
// upstreamModelNormalizer field is ClaudeExecutorConfig.upstreamModelNormalizer.
import { describe, expect, test } from "bun:test";
import { AuthManager } from "../../../src/auth/manager/index.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { ClaudeWebSearchResultCache } from "../../../src/cache/claude_web_search_result_cache.ts";
import { applyCloaking, claudeCodeCLIIdentity } from "../../../src/executor/claude/cloaking.ts";
import { type ClaudeExecutorConfig, createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudePayloadHasMidSystemMessage } from "../../../src/executor/claude/request_shape.ts";
import { validateClaudeMidSystemMessageModel } from "../../../src/executor/claude/cloaking.ts";
import { type ExecOptions, StatusError } from "../../../src/executor/types.ts";
import { ModelRegistry } from "../../../src/registry/index.ts";
import type { Format } from "../../../src/translator/types.ts";
import { type CapturedFetch, claudeOAuthTestMetadata, claudeOpts, drain, fakeFetch, startUpstream } from "./helpers.ts";

const claudeIssue6698SSE =
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n` +
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n` +
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n` +
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

const parse = (s: string): any => JSON.parse(s);

/** Answers JSON, SSE or count_tokens depending on the captured request (Go: captureClaudeIssue7000's transport). */
function issueUpstream(handler?: (req: CapturedFetch, call: number) => Response | undefined) {
  return fakeFetch((req, call) => {
    const custom = handler?.(req, call);
    if (custom) return custom;
    if (new URL(req.url).pathname.endsWith("/count_tokens")) return new Response(`{"input_tokens":17}`, { headers: { "Content-Type": "application/json" } });
    const body = parse(req.body);
    const model = String(body.model ?? "");
    if (body.stream) return new Response(claudeIssue6698SSE.replaceAll("claude-opus-5-5", model), { headers: { "Content-Type": "text/event-stream" } });
    return new Response(
      `{"id":"msg_issue7000","type":"message","role":"assistant","model":"${model}","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":17,"output_tokens":1}}`,
      { headers: { "Content-Type": "application/json" } },
    );
  });
}

type Method = "Execute" | "ExecuteStream" | "CountTokens";

async function capture(cfg: Omit<ClaudeExecutorConfig, "fetch">, auth: ReturnType<typeof newAuth>, model: string, payload: string, method: Method, opts: Partial<ExecOptions> = {}) {
  const upstream = issueUpstream();
  const exec = createClaudeExecutor({ ...cfg, fetch: upstream.fetch });
  const format = (opts.sourceFormat ?? "claude") as Format;
  const req = { model, payload, format };
  const options = claudeOpts({ ...opts, stream: method === "ExecuteStream" });
  if (method === "Execute") await exec.execute(auth, req, options);
  else if (method === "ExecuteStream") await drain(await exec.executeStream(auth, req, options));
  else {
    const resp = await exec.countTokens(auth, req, options);
    expect(parse(resp.payload).input_tokens).toBe(17);
  }
  const last = upstream.requests[upstream.requests.length - 1];
  expect(last).toBeDefined();
  return { body: parse(last!.body), headers: last!.headers, requests: upstream.requests };
}

const keyAuth = (key: string, extra: Record<string, string> = {}) => newAuth({ id: "", provider: "claude", attributes: { api_key: key, ...extra } });

describe("claude_issue_6120_test.go", () => {
  const payload = `{"model":"claude-opus-5-5","system":[{"type":"text","text":"caller system"}],"messages":[{"role":"user","content":"hello"}]}`;
  const directOAuth = (extra: Record<string, string> = {}) =>
    newAuth({ id: "", provider: "claude", attributes: { api_key: "sk-ant-oat-direct-messages-test", ...extra }, metadata: claudeOAuthTestMetadata() });
  const incoming = () => new Headers({ "User-Agent": "pi (linux; x64)", "Anthropic-Beta": "caller-beta-2099-01-01" });
  const hasIdentity = (body: any) => Array.isArray(body.system) && body.system.some((b: any) => b.text === claudeCodeCLIIdentity);

  test("ClaudeExecutor_DirectMessagesOAuthDefaultsToCloak_Issue6120", async () => {
    const cloak = applyCloaking({}, directOAuth(), payload, "sk-ant-oat-direct-messages-test", false);
    expect(cloak.cloaked).toBe(true);
    expect(hasIdentity(parse(cloak.payload))).toBe(true);

    const { body, headers } = await capture({}, directOAuth({ base_url: "https://api.anthropic.com" }), "claude-opus-5-5", payload, "Execute", { headers: incoming() });
    const ua = headers.get("User-Agent") ?? "";
    expect(ua).not.toBe("pi (linux; x64)");
    expect(ua).toContain("claude-cli");
    expect(headers.get("X-App")).toBe("cli");
    const betas = headers.get("Anthropic-Beta") ?? "";
    expect(betas).toContain("claude-code-20250219");
    expect(betas).toContain("oauth-2025-04-20");
    expect(hasIdentity(body)).toBe(true);
  });

  test("ClaudeExecutor_DirectMessagesOAuthDefaultsToCloakStream_Issue6120", async () => {
    const { body, headers } = await capture({}, directOAuth({ base_url: "https://api.anthropic.com" }), "claude-opus-5-5", payload, "ExecuteStream", { headers: incoming() });
    expect(headers.get("User-Agent") ?? "").toContain("claude-cli");
    expect(headers.get("X-App")).toBe("cli");
    const betas = headers.get("Anthropic-Beta") ?? "";
    expect(betas).toContain("claude-code-20250219");
    expect(betas).toContain("oauth-2025-04-20");
    expect(hasIdentity(body)).toBe(true);
  });
});

describe("claude_issue7000_test.go", () => {
  const tools = `[{"name":"lookup_weather","description":"Look up the weather for a city.","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false},"cache_control":{"type":"ephemeral"}}]`;
  const messages = `[{"role":"user","content":[{"type":"text","text":"What is the weather in Paris?"}]}]`;
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
    for (const [choiceName, choice] of [
      ["any", `{"type":"any","disable_parallel_tool_use":true}`],
      ["tool", `{"type":"tool","name":"lookup_weather","disable_parallel_tool_use":true}`],
    ] as const) {
      for (const method of ["Execute", "ExecuteStream"] as const) {
        test(`ClaudeExecutor_Issue7000ForcedToolChoiceFallsBackToAuto/${model}/${choiceName}/${method}`, async () => {
          const payload = `{"model":"${model}","max_tokens":4096,"tools":${tools},"tool_choice":${choice},"messages":${messages},"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`;
          const { body } = await capture({}, keyAuth("sk-ant-api03-issue7000"), model, payload, method);
          expect(body.tool_choice.type).toBe("auto");
          expect(body.tool_choice.disable_parallel_tool_use).toBe(true);
          expect(body.tool_choice.name).toBeUndefined();
          expect(body.thinking.type).toBe("adaptive");
          expect(body.output_config.effort).toBe("high");
          expect(body.tools).toEqual(parse(tools));
          expect(body.messages).toEqual(parse(messages));
        });
      }
    }
  }
});

describe("claude_issue7000_regression_test.go", () => {
  const issueTools = `[{"name":"lookup_weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]`;
  const issuePayload = (model: string, choice: string) =>
    `{"model":"${model}","max_tokens":4096,"messages":[{"role":"user","content":"Weather in Paris?"}],"tools":${issueTools}${choice !== "" ? `,"tool_choice":${choice}` : ""}}`;
  const forced = `{"type":"tool","name":"lookup_weather","disable_parallel_tool_use":false}`;
  const auto = `{"type":"auto","disable_parallel_tool_use":false}`;
  const cases: Array<{ name: string; route: string; bodyModel?: string; choice?: string; normalized?: string; want?: string }> = [
    { name: "opus date", route: "claude-opus-5-5-20260901", choice: forced, want: auto },
    { name: "sonnet bracket", route: "claude-sonnet-5-5[1m]", choice: forced, want: auto },
    { name: "high date bracket thinking suffix", route: "claude-opus-5-5-high-20260901[1m](high)", choice: forced, want: auto },
    { name: "reasoning variant", route: "claude-sonnet-5-5-reasoning", choice: forced, want: auto },
    { name: "old opus", route: "claude-opus-5", choice: forced, want: forced },
    { name: "old sonnet", route: "claude-sonnet-4-6", choice: forced, want: forced },
    { name: "haiku", route: "claude-haiku-5-5", choice: forced, want: forced },
    { name: "near match opus", route: "claude-opus-5-50", choice: forced, want: forced },
    { name: "near match sonnet", route: "claude-sonnet-5-50", choice: forced, want: forced },
    { name: "invalid family variant", route: "claude-opus-5-5-custom", choice: forced, want: forced },
    { name: "auto", route: "claude-opus-5-5", choice: auto, want: auto },
    { name: "none", route: "claude-sonnet-5-5", choice: `{"type":"none"}`, want: `{"type":"none"}` },
    { name: "omitted", route: "claude-opus-5-5" },
    { name: "body cannot spoof target", route: "claude-opus-5", bodyModel: "claude-opus-5-5", choice: forced, want: forced },
    { name: "body cannot hide target", route: "claude-opus-5-5", bodyModel: "custom-alias", choice: forced, want: auto },
    { name: "alias resolved upstream", route: "custom-alias", normalized: "claude-sonnet-5-5", choice: forced, want: auto },
    { name: "upstream is old despite alias", route: "claude-opus-5-5", normalized: "claude-opus-5", choice: forced, want: forced },
  ];
  for (const tc of cases) {
    test(`ClaudeExecutor_Issue7000ModelAndChoiceBoundaries/${tc.name}`, async () => {
      const cfg: Omit<ClaudeExecutorConfig, "fetch"> = tc.normalized ? { upstreamModelNormalizer: () => tc.normalized! } : {};
      const { body } = await capture(cfg, keyAuth("key-issue7000"), tc.route, issuePayload(tc.bodyModel ?? tc.route, tc.choice ?? ""), "Execute");
      expect(body.tool_choice).toEqual(tc.want ? parse(tc.want) : undefined);
    });
  }

  const schema = `{"type":"object","properties":{"issue7000_title":{"type":"string"}},"required":["issue7000_title"],"additionalProperties":false}`;
  for (const choice of [`"required"`, `{"type":"function","name":"lookup_weather"}`]) {
    for (const withSchema of [false, true]) {
      test(`ClaudeExecutor_Issue7000OpenAITranslation/responses/${choice}/${withSchema ? "schema" : "plain"}`, async () => {
        let payload =
          `{"model":"claude-sonnet-5-5","input":[{"role":"user","content":[{"type":"input_text","text":"Weather in Paris?"}]}],"reasoning":{"effort":"high"},` +
          `"tools":[{"type":"function","name":"lookup_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"tool_choice":${choice},"parallel_tool_calls":false`;
        if (withSchema) payload += `,"text":{"format":{"type":"json_schema","name":"weather","strict":true,"schema":${schema}}}`;
        const { body } = await capture({}, keyAuth("key-issue7000"), "claude-sonnet-5-5", payload + "}", "ExecuteStream", { sourceFormat: "openai-response" });
        expect(body.tool_choice.type).toBe("auto");
        expect(body.tool_choice.disable_parallel_tool_use).toBe(true);
        expect(body.tool_choice.name).toBeUndefined();
        expect(body.tools[0].name).toBe("lookup_weather");
        expect(body.tools[0].input_schema.required[0]).toBe("city");
        expect(body.thinking.type).toBe("adaptive");
        expect(body.output_config.effort).toBe("high");
        if (withSchema) {
          const system = JSON.stringify(body.system ?? "");
          expect(system).toContain("issue7000_title");
          expect(system).toContain("JSON");
        }
        expect(body.output_config.format).toBeUndefined();
      });
    }
  }

  test("ClaudeExecutor_Issue7000KeepsNativeOutputFormat", async () => {
    const format = `{"type":"json_schema","schema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}`;
    const root = parse(issuePayload("claude-opus-5-5", `{"type":"any"}`));
    root.output_config = { effort: "high", format: parse(format) };
    root.thinking = { type: "adaptive" };
    const { body } = await capture({}, keyAuth("key-issue7000"), "claude-opus-5-5", JSON.stringify(root), "Execute");
    expect(body.output_config.format).toEqual(parse(format));
    expect(body.tool_choice.type).toBe("auto");
    expect(body.output_config.effort).toBe("high");
  });

  for (const choice of [`{"type":"any","disable_parallel_tool_use":true}`, `{"type":"tool","name":"lookup_weather","disable_parallel_tool_use":true}`]) {
    test(`ClaudeExecutor_Issue7000CountTokensUpstreamAndLocal/${choice}`, async () => {
      const { body, headers } = await capture({}, keyAuth("key-issue7000"), "claude-sonnet-5-5", issuePayload("spoofed-body-model", choice), "CountTokens");
      expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
      expect(body.model).toBe("claude-sonnet-5-5");
      expect(headers.get("X-Api-Key")).toBe("key-issue7000");
    });
  }

  for (const stream of [false, true]) {
    test(`ClaudeExecutor_Issue7000ManagerRetryKeepsAuto/${stream ? "ExecuteStream" : "Execute"}`, async () => {
      const model = "claude-sonnet-5-5";
      const upstream = issueUpstream((_req, call) => {
        if (call === 1) throw new Error("unexpected EOF");
        return undefined;
      });
      const registry = new ModelRegistry();
      const manager = new AuthManager({ registry, sleep: async () => {}, random: () => 0 });
      manager.setRetryConfig(1, 0, 0);
      manager.registerExecutor(createClaudeExecutor({ fetch: upstream.fetch }));
      const authID = crypto.randomUUID() + "-issue7000";
      registry.registerClient(authID, "claude", [{ id: model, type: "claude" }]);
      manager.register(newAuth({ id: authID, provider: "claude", attributes: { api_key: "key-issue7000" } }));
      const payload = issuePayload(model, `{"type":"tool","name":"lookup_weather","disable_parallel_tool_use":true}`);
      const req = { model, payload, format: "claude" as const };
      if (stream) await drain(await manager.executeStream(["claude"], req, claudeOpts({ stream: true })));
      else await manager.execute(["claude"], req, claudeOpts());
      expect(upstream.requests.length).toBe(2);
      for (const sent of upstream.requests) expect(parse(sent.body).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
      expect(parse(payload).tool_choice.type).toBe("tool");
    });
  }
});

describe("claude_issue_6698_test.go", () => {
  const sources: Array<{ name: string; format: Format; payload: string }> = [
    {
      name: "claude",
      format: "claude",
      payload: `{"model":"MODEL","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"disabled","display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`,
    },
    {
      name: "openai responses",
      format: "openai-response",
      payload: `{"model":"MODEL","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"reasoning":{"effort":"none"}}`,
    },
  ];
  for (const model of ["claude-sonnet-5-5", "claude-sonnet-5-5[1m]"]) {
    for (const source of sources) {
      for (const stream of [false, true]) {
        test(`ClaudeExecutor_Sonnet55ThinkingOffSendsBetweenTools/${model} ${source.name}${stream ? " stream" : ""}`, async () => {
          const { body } = await capture({}, keyAuth("key-between-tools", { cloak_mode: "always" }), model, source.payload.replaceAll("MODEL", model), stream ? "ExecuteStream" : "Execute", {
            sourceFormat: source.format,
          });
          expect(body.thinking).toEqual({ type: "between_tools" });
          expect(body.output_config?.effort).toBeUndefined();
          expect(body.context_management).toBeUndefined();
        });
      }
    }
  }

  const disabledSources: Array<{ name: string; format: Format; payload: string }> = [
    { name: "claude", format: "claude", payload: `{"model":"MODEL","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"disabled"}}` },
    sources[1]!,
  ];
  for (const model of ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-fable-5", "claude-fable-5-1"]) {
    for (const source of disabledSources) {
      test(`ClaudeExecutor_AdaptiveOnlyThinkingOffKeepsThinkingHidden/${model} ${source.name}`, async () => {
        const { body } = await capture({}, keyAuth("key-disabled-fallback", { cloak_mode: "always" }), model, source.payload.replaceAll("MODEL", model), "Execute", { sourceFormat: source.format });
        expect(body.thinking.type).toBe("adaptive");
        expect(body.output_config.effort).toBe("low");
        expect(body.thinking.display).toBe("omitted");
      });
    }
  }
});

describe("claude_mid_system_model_test.go", () => {
  const midSystemLegacyPayload = (model: string) =>
    `{"model":"${model}","max_tokens":32,` +
    `"system":[{"type":"text","text":"Top rule"}],` +
    `"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]},` +
    `{"role":"system","content":[{"type":"text","text":"Mid rule"}]}],` +
    `"metadata":{"user_id":"{\\"device_id\\":\\"0000000000000000000000000000000000000000000000000000000000000000\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"11111111-2222-4333-8444-555555555555\\"}"}}`;
  const midSystemAuth = (extra: Record<string, string> = {}) => keyAuth("key-123", { cloak_mode: "always", ...extra });

  async function send(method: Method, model: string, payload: string, auth = midSystemAuth(), opts: Partial<ExecOptions> = {}) {
    const upstream = issueUpstream();
    const exec = createClaudeExecutor({ fetch: upstream.fetch });
    const req = { model, payload, format: (opts.sourceFormat ?? "claude") as Format };
    const options = claudeOpts({ ...opts, stream: method === "ExecuteStream" });
    let err: unknown;
    try {
      if (method === "Execute") await exec.execute(auth, req, options);
      else if (method === "ExecuteStream") await drain(await exec.executeStream(auth, req, options));
      else await exec.countTokens(auth, req, options);
    } catch (e) {
      err = e;
    }
    const last = upstream.requests[upstream.requests.length - 1];
    return { err, called: upstream.requests.length > 0, body: last ? parse(last.body) : undefined };
  }

  function assertMidSystemRejected(result: { err: unknown; called: boolean }): void {
    expect(result.err).toBeInstanceOf(StatusError);
    expect(result.called).toBe(false);
    expect((result.err as StatusError).statusCode).toBe(400);
    expect((result.err as StatusError).requestScoped).toBe(true);
    expect((result.err as Error).message).toContain("role 'system' is not supported on this model");
  }

  for (const [name, model, method] of [
    ["execute", "claude-haiku-4-5-20251001", "Execute"],
    ["execute stream", "claude-haiku-4-5-20251001", "ExecuteStream"],
    ["count tokens", "claude-haiku-4-5-20251001", "CountTokens"],
    ["execute legacy sonnet", "claude-sonnet-4-6", "Execute"],
  ] as const) {
    test(`ClaudeExecutor_LegacyMidSystemMessageRejectedOnEveryUpstreamPath/${name}`, async () => {
      assertMidSystemRejected(await send(method, model, midSystemLegacyPayload(model)));
    });
  }

  test("ClaudeExecutor_ConfirmedNativeLegacyMidSystemMessageForwarded", async () => {
    const headers = new Headers({
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Content-Type": "application/json",
      "User-Agent": "claude-cli/2.1.280 (external, cli)",
      "X-App": "cli",
      "Anthropic-Beta":
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "X-Claude-Code-Session-Id": "11111111-2222-4333-8444-555555555555",
      "X-Client-Request-Id": "66666666-7777-4888-8999-aaaaaaaaaaaa",
      "X-Stainless-Lang": "js",
      "X-Stainless-Runtime": "node",
      "X-Stainless-Package-Version": "0.112.1",
      "X-Stainless-Runtime-Version": "v26.3.0",
      "X-Stainless-OS": "MacOS",
      "X-Stainless-Arch": "arm64",
      "X-Stainless-Retry-Count": "0",
      "X-Stainless-Timeout": "600",
    });
    const result = await send("Execute", "claude-haiku-4-5-20251001", midSystemLegacyPayload("claude-haiku-4-5-20251001"), midSystemAuth(), { headers });
    expect(result.err).toBeUndefined();
    expect(result.called).toBe(true);
    expect(result.body.messages.some((m: any) => m.role === "system")).toBe(true);
  });

  test("ClaudeExecutor_LegacyMidSystemMessageForwardedToThirdPartyGateway", async () => {
    const result = await send("Execute", "claude-haiku-4-5-20251001", midSystemLegacyPayload("claude-haiku-4-5-20251001"), keyAuth("key-123", { base_url: "https://gateway.example" }));
    expect(result.err).toBeUndefined();
    expect(result.called).toBe(true);
  });

  for (const model of ["claude-sonnet-5", "claude-sonnet-9"]) {
    test(`ClaudeExecutor_SupportedModelMidSystemMessageForwarded/${model}`, async () => {
      const result = await send("Execute", model, midSystemLegacyPayload(model));
      expect(result.err).toBeUndefined();
      expect(result.called).toBe(true);
    });
  }

  test("ClaudeExecutor_LegacyMidSystemMessageOptInStillRebuilds", async () => {
    const result = await send("Execute", "claude-haiku-4-5-20251001", midSystemLegacyPayload("claude-haiku-4-5-20251001"), midSystemAuth({ rebuild_mid_system_message: "true" }));
    expect(result.err).toBeUndefined();
    expect(result.called).toBe(true);
    expect(result.body.messages.some((m: any) => m.role === "system")).toBe(false);
  });

  test("TranslatedRequestNeverPairsLegacyModelWithMidSystemMessage/openai responses with instructions", async () => {
    const legacyModel = "claude-haiku-4-5-20251001";
    const payload = `{"model":"${legacyModel}","instructions":"Top rule","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}`;
    const result = await send("Execute", legacyModel, payload, midSystemAuth(), { sourceFormat: "openai-response" });
    expect(result.err).toBeUndefined();
    expect(result.called).toBe(true);
    expect(result.body.model).toBe(legacyModel);
    expect(result.body.messages.length).toBeGreaterThan(0);
    for (const m of result.body.messages) expect(String(m.role).toLowerCase()).not.toBe("system");
  });

  for (const [name, payload, want] of [
    ["mid conversation turn", `{"messages":[{"role":"user","content":"a"},{"role":"system","content":"s"}]}`, true],
    ["role casing is ignored", `{"messages":[{"role":"SySTeM","content":"s"}]}`, true],
    ["surrounding whitespace is ignored", `{"messages":[{"role":" system ","content":"s"}]}`, true],
    ["only user and assistant turns", `{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}`, false],
    ["top level system field is not a turn", `{"system":[{"type":"text","text":"s"}],"messages":[{"role":"user","content":"a"}]}`, false],
    ["messages missing", `{"model":"claude-haiku-4-5"}`, false],
    ["messages is not an array", `{"messages":"system"}`, false],
    ["messages holds a bare string", `{"messages":["system"]}`, false],
    ["system appears only in content", `{"messages":[{"role":"user","content":"role: system"}]}`, false],
  ] as const) {
    test(`ClaudePayloadHasMidSystemMessage/${name}`, () => {
      expect(claudePayloadHasMidSystemMessage(payload)).toBe(want);
    });
  }

  const turn = `,"messages":[{"role":"user","content":"a"},{"role":"system","content":"s"}]}`;
  for (const tc of [
    { name: "legacy model is rejected", payload: `{"model":"claude-haiku-4-5-20251001"` + turn, wantError: true },
    { name: "vendor prefixed legacy model is rejected", payload: `{"model":"anthropic/claude-sonnet-4-6"` + turn, wantError: true },
    { name: "model casing is ignored", payload: `{"model":"Claude-Haiku-4-5-20251001"` + turn, wantError: true },
    { name: "confirmed native keeps the passthrough", payload: `{"model":"claude-haiku-4-5-20251001"` + turn, confirmed: true },
    { name: "third party gateway decides for itself", payload: `{"model":"claude-haiku-4-5-20251001"` + turn, thirdParty: true },
    { name: "supported model is forwarded", payload: `{"model":"claude-sonnet-5"` + turn },
    { name: "unknown model stays optimistic", payload: `{"model":"claude-sonnet-9"` + turn },
    { name: "legacy model without the turn is forwarded", payload: `{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"a"}]}` },
  ]) {
    test(`ValidateClaudeMidSystemMessageModel/${tc.name}`, () => {
      let err: unknown;
      try {
        validateClaudeMidSystemMessageModel(tc.payload, tc.confirmed === true, tc.thirdParty !== true);
      } catch (e) {
        err = e;
      }
      expect(err !== undefined).toBe(tc.wantError === true);
      if (err) expect((err as Error).message).toContain(parse(tc.payload).model);
    });
  }
});

describe("claude_executor_stop_reasons_test.go", () => {
  for (const stream of [false, true]) {
    test(`ClaudeExecutorPauseTurnContinuationRestoresFinishedSearchAndKeepsPausedOne/${stream ? "stream" : "non-stream"}`, async () => {
      const paused =
        [
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p","type":"message","model":"claude-opus-5-5","role":"assistant","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}`,
          `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_done","name":"web_search","input":{}}}`,
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"done query\\"}"}}`,
          `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
          `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_done","content":[{"type":"web_search_result","url":"https://example.com/d","title":"D","encrypted_content":"ENC_DONE"}]}}`,
          `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
          `event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"server_tool_use","id":"srvtoolu_paused","name":"web_search","input":{}}}`,
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"paused query\\"}"}}`,
          `event: content_block_stop\ndata: {"type":"content_block_stop","index":2}`,
          `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":3}}`,
          `event: message_stop\ndata: {"type":"message_stop"}`,
        ].join("\n\n") + "\n\n";
      const server = startUpstream(() => new Response(paused, { headers: { "Content-Type": "text/event-stream" } }));
      try {
        const executor = createClaudeExecutor({ webSearchResultCache: { enabled: true, ttlMs: 30 * 60_000, limit: 16 }, webSearchResultStore: new ClaudeWebSearchResultCache() });
        const auth = keyAuth("key-pause", { base_url: server.url });
        const run = async (input: string): Promise<any> => {
          const payload = `{"model":"claude-opus-5-5","stream":${stream},"tools":[{"type":"web_search"}],"input":[${input}]}`;
          const req = { model: "claude-opus-5-5", payload, format: "openai-response" as const };
          const opts: ExecOptions = { stream, sourceFormat: "openai-response", responseFormat: "openai-response", originalRequest: payload, metadata: { execution_session_id: "session-pause" } };
          if (!stream) return parse((await executor.execute(auth, req, opts)).payload);
          let terminal: any;
          for (const chunk of await drain(await executor.executeStream(auth, req, opts))) {
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = parse(line.slice("data: ".length));
              if (data.type === "response.completed") terminal = data.response;
            }
          }
          return terminal;
        };

        const user = `{"type":"message","role":"user","content":[{"type":"input_text","text":"research"}]}`;
        const first = await run(user);
        expect(first.end_turn).toBe(false);
        // Codex history: output items without web_search_call results.
        const history = [user];
        for (const item of first.output as any[]) {
          const copy = { ...item };
          if (copy.type === "web_search_call") delete copy.results;
          history.push(JSON.stringify(copy));
        }
        await run(history.join(","));

        expect(server.requests.length).toBe(2);
        const messages = parse(server.requests[1]!.body).messages as any[];
        const last = messages[messages.length - 1];
        const blocks = last.content as any[];
        expect(last.role).toBe("assistant");
        expect(blocks.map((b) => b.type).join(",")).toBe("server_tool_use,web_search_tool_result,server_tool_use");
        expect(blocks[1].content[0].encrypted_content).toBe("ENC_DONE");
        expect(blocks[2].id).toBe("srvtoolu_paused");
        expect(blocks[2].input.query).toBe("paused query");
      } finally {
        server.stop();
      }
    });
  }
});
