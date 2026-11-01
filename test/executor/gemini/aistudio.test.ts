// Ported from: internal/runtime/executor/gemini_executor_test.go, internal/runtime/executor/gemini_executor_signature_test.go, internal/runtime/executor/gemini_missing_terminal_upstream_repro_test.go, internal/runtime/executor/gemini_executor_terminal_disconnect_test.go, internal/runtime/executor/aistudio_executor_test.go, internal/runtime/executor/aistudio_issue6258_terminal_test.go
// Skipped cases:
//   gemini_executor_test.go: TestGeminiExecutorExecutePrependsLeadingUserForIssue4959ResponsesHistory (OpenAI Responses inbound not ported),
//     TestGeminiExecutorAppliesPayloadRulesAfterLeadingUserNormalization (payload config rules not ported),
//     every TestGeminiExecutorInteractions* / TestGeminiExecutorNativeInteractions* / TestNativeInteractionsSourceFormat* (Interactions API dropped),
//     TestGeminiExecutorClaudeMalformedFunctionCallSplitUsageAndConductorFailure / ...CancelAfterErrorPreservesUsageAndConductorFailure (usage plugin + Go conductor),
//     usage-record assertions everywhere (no usage reporter in this port), TestGeminiExecutorPromptFeedbackBlockWithoutCandidatesReturnsError openai/openai_responses rows
//     (no OpenAI inbound translators to Gemini) and its 502 status (this port returns 400 requestScoped), TestGeminiAndVertexOpenAIStreamTruncationReturnsError
//     vertex rows (Vertex dropped) and openai_chat row (re-expressed with Claude inbound);
//   gemini_executor_signature_test.go: every TestGeminiVertexExecutor* case (Vertex dropped);
//   gemini_missing_terminal_upstream_repro_test.go: the manager/cooldown half (asserted here through the StatusError flags the manager keys on);
//   gemini_executor_terminal_disconnect_test.go: the OpenAI Responses inbound and usage-record assertions (re-expressed with Claude inbound: EOF after STOP, cancel, read error);
//   aistudio_executor_test.go: TestAIStudioTranslateRequestPreservesSummaryFromOriginalRequest and ...Issue4959ResponsesHistory (OpenAI Responses inbound),
//     ...PayloadOverrideWinsThinkingNormalization (payload rules), every websocket relay / TTFT / apply_patch / MalformedFunctionCall relay case (relay transport dropped);
//   aistudio_issue6258_terminal_test.go: relay HTTPResp rows and the apply_patch row (relay transport / apply_patch dropped).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIStudioExecutor, createAIStudioExecutor, prepareAIStudioRequest } from "../../../src/executor/gemini/index.ts";
import { type ExecOptions, StatusError } from "../../../src/executor/types.ts";
import { geminiSkipThoughtSignatureValidator } from "../../../src/signature/index.ts";
import { getAt } from "../../../src/util/gpath.ts";
import { aistudioAuth, claudeEvents, drain, erroringSSE, type FakeUpstream, hangingSSE, json, sse, startFakeUpstream } from "./helpers.ts";

const okBody = `{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}`;
const geminiOpts: ExecOptions = { stream: false, sourceFormat: "gemini" };
const claudeOpts: ExecOptions = { stream: false, sourceFormat: "claude", responseFormat: "claude" };

let upstream: FakeUpstream;
let exec: AIStudioExecutor;

beforeAll(() => {
  upstream = startFakeUpstream(() => json(okBody));
  exec = createAIStudioExecutor();
});
afterAll(() => upstream.stop());

function lastBody(): Record<string, unknown> {
  return JSON.parse(upstream.requests[upstream.requests.length - 1]!.body);
}

function roles(body: Record<string, unknown>): string {
  return (body.contents as unknown[]).map((c) => String(getAt(c, "role"))).join(",");
}

describe("request shaping (gemini_executor_test.go)", () => {
  test("TestGeminiExecutorExecuteCapsMaxOutputTokensBeforeUpstream", async () => {
    upstream.setHandler(() => json(okBody));
    await exec.execute(aistudioAuth(upstream.url), { model: "gemini-3.1-pro-preview", payload: `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":500000}}`, format: "gemini" }, geminiOpts);
    expect(getAt(lastBody(), "generationConfig.maxOutputTokens")).toBe(65536);
  });

  test("TestGeminiExecutorExecutePrependsLeadingUser", async () => {
    upstream.setHandler(() => json(okBody));
    const payload = `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"key":"value"}}}]},{"role":"user","parts":[{"functionResponse":{"name":"lookup","response":{"result":"ok"}}}]}]}`;
    await exec.execute(aistudioAuth(upstream.url), { model: "gemini-3.7-flash", payload, format: "gemini" }, geminiOpts);
    const body = lastBody();
    expect(roles(body)).toBe("user,model,user");
    expect(getAt(body, "contents.0.parts.0.text")).toBe("");
  });

  test("TestGeminiExecutorExecuteAppendsTrailingUserForTrailingModelTurn", async () => {
    upstream.setHandler(() => json(okBody));
    const payload = `{"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"text":"answer"}]}]}`;
    await exec.execute(aistudioAuth(upstream.url), { model: "gemini-3.7-flash", payload, format: "gemini" }, geminiOpts);
    const body = lastBody();
    expect(roles(body)).toBe("user,model,user");
    expect(getAt(body, "contents.2.parts.0.text")).toBe("");
  });

  test("TestGeminiExecutorCountTokensPrependsLeadingUser", async () => {
    upstream.setHandler(() => json(`{"totalTokens":7}`));
    const req = { model: "gemini-3.7-flash", payload: `{"contents":[{"role":"model","parts":[{"text":"prior output"}]}]}`, format: "gemini" };
    await exec.countTokens(aistudioAuth(upstream.url), req, geminiOpts);
    let body = lastBody();
    expect(upstream.requests.at(-1)!.path).toBe("/v1beta/models/gemini-3.7-flash:countTokens");
    expect(roles(body)).toBe("user,model");
    expect(getAt(body, "contents.0.parts.0.text")).toBe("");
    expect(getAt(body, "contents.1.parts.0.text")).toBe("prior output");

    await exec.execute(aistudioAuth(upstream.url), { ...req, metadata: { action: "countTokens" } }, geminiOpts);
    body = lastBody();
    expect(upstream.requests.at(-1)!.path).toBe("/v1beta/models/gemini-3.7-flash:countTokens");
    expect(roles(body)).toBe("user,model");
  });

  test("TestGeminiExecutor_PrepareRequest_EmptyAPIKey_OmitsAuthHeaders (adapted to the request path)", async () => {
    upstream.setHandler(() => json(okBody));
    const auth = aistudioAuth(upstream.url, "", { auth_kind: "apikey", "header:Custom-Token": "gemini-secret" });
    const headers = new Headers({ Authorization: "Bearer preexisting-bearer", "x-goog-api-key": "preexisting-key" });
    await exec.execute(auth, { model: "gemini-2.5-flash", payload: `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`, format: "gemini" }, { ...geminiOpts, headers });
    const sent = upstream.requests.at(-1)!.headers;
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("x-goog-api-key")).toBeNull();
    expect(sent.get("custom-token")).toBe("gemini-secret");
  });
});

describe("request cleanup (aistudio_executor_test.go)", () => {
  test("TestAIStudioTranslateRequestNormalizesThinkingLevel", () => {
    const payload = `{"contents":[{"role":"user","parts":[{"text":"Human: Hi"}]}],"model":"gemini-3.8-flash","generationConfig":{"thinkingConfig":{"thinkingLevel":"high","includeThoughts":true}}}`;
    const body = JSON.parse(prepareAIStudioRequest({ model: "gemini-3.8-flash", payload, format: "gemini" }, geminiOpts, "generate"));
    expect(getAt(body, "generationConfig.thinkingConfig.thinkingLevel")).toBe("HIGH");
    expect(getAt(body, "generationConfig.thinkingConfig.includeThoughts")).toBe(true);
  });

  test("TestAIStudioTranslateRequestAppendsTrailingUserForTrailingModelTurn", () => {
    const payload = `{"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"text":"answer"}]}]}`;
    const body = JSON.parse(prepareAIStudioRequest({ model: "gemini-3.7-flash", payload, format: "gemini" }, geminiOpts, "generate"));
    expect(roles(body)).toBe("user,model,user");
    expect(getAt(body, "contents.2.parts.0.text")).toBe("");
  });

  test("TestAIStudioTranslateRequestCountTokensPreservesTrailingModelTurn", () => {
    const payload = `{"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"text":"answer"}]}]}`;
    const body = JSON.parse(prepareAIStudioRequest({ model: "gemini-3.7-flash", payload, format: "gemini", metadata: { action: "countTokens" } }, geminiOpts, "executeCountTokens"));
    expect(roles(body)).toBe("user,model");
  });

  test("session_id removed and countTokens strips generation-only fields (New)", () => {
    const payload = `{"session_id":"s1","contents":[{"role":"user","parts":[{"text":"hi"}]}],"tools":[{"functionDeclarations":[]}],"safetySettings":[],"generationConfig":{"temperature":1}}`;
    const gen = JSON.parse(prepareAIStudioRequest({ model: "gemini-2.5-flash", payload, format: "gemini" }, geminiOpts, "generate"));
    expect(gen.session_id).toBeUndefined();
    expect(gen.generationConfig.temperature).toBe(1);
    const count = JSON.parse(prepareAIStudioRequest({ model: "gemini-2.5-flash", payload, format: "gemini" }, geminiOpts, "countTokens"));
    expect(count.session_id).toBeUndefined();
    expect(count.tools).toBeUndefined();
    expect(count.generationConfig).toBeUndefined();
    expect(count.safetySettings).toBeUndefined();
    expect(count.model).toBe("gemini-2.5-flash");
  });
});

const claudeCAISSample =
  "CAISqwIKiAEIEBgCKkBHRlRBsNiptQUWfPoOhuQKwi5LnncZVO9bB5jqOs76D7uBtgktML0zqJtNmLHXHHcgD6lk4MQu4QBXzFd1lbC3Mg5jbGF1ZGUtZmFibGUtNTgBQgh0aGlua2luZ1okZDk3NDM5NzUtNGJiMC00OTM2LTllMjgtZDViMGQyMWJkYzQ4EgxCGh+XVFFFeySAjtAaDL/A1LltGu6MMJ+eXSIwsN0oBpDrqLv22UBfkMnTotnIbkvkOyb9xZHgigG6OZVHaI3gThm+maLKmgO5PrFLKlDFYp+YZksy/wKwszJlnLTPzAK+NUlfzagOE1ymtZTXhAYK260XyFYmg/te/C231+Fr/hoX+EJoUBnrn0gD7hqMISOT+TaFEuOXYsN517GfaxgB";

/** protowire: field 2 (bytes) { field 1 (bytes) 01 0c 39 d6 c7 34 }. */
const nativeGemini3ThoughtSignature = Buffer.from([0x12, 0x08, 0x0a, 0x06, 0x01, 0x0c, 0x39, 0xd6, 0xc7, 0x34]).toString("base64");

function claudeRequestWithThinkingSignature(sig: string) {
  return {
    model: "gemini-2.5-flash",
    format: "claude",
    payload: JSON.stringify({
      model: "claude-3-7-sonnet-20250219",
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "Let me think...", signature: sig }, { type: "text", text: "Here is the response." }] },
        { role: "user", content: [{ type: "text", text: "Follow up question." }] },
      ],
    }),
  };
}

function functionCallPayload(sig: string): string {
  return JSON.stringify({
    contents: [
      { role: "model", parts: [{ functionCall: { name: "search", args: { q: "go" } }, thoughtSignature: sig }] },
      { role: "user", parts: [{ functionResponse: { name: "search", response: { result: "found" } } }] },
    ],
  });
}

describe("thought signatures (gemini_executor_signature_test.go, non-Vertex)", () => {
  test("TestGeminiExecutorExecute_SanitizesClaudeCAISSignature", async () => {
    upstream.setHandler(() => json(okBody));
    await exec.execute(aistudioAuth(upstream.url), claudeRequestWithThinkingSignature(claudeCAISSample), { stream: false, sourceFormat: "claude" });
    const raw = upstream.requests.at(-1)!.body;
    expect(raw.includes(claudeCAISSample)).toBe(false);
  });

  test("TestGeminiExecutorExecuteStream_SanitizesClaudeCAISSignature", async () => {
    upstream.setHandler(() => sse(`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"chunk"}]}}]}\n\n`));
    const res = await exec.executeStream(aistudioAuth(upstream.url), claudeRequestWithThinkingSignature(claudeCAISSample), { stream: true, sourceFormat: "claude" });
    await drain(res);
    expect(upstream.requests.at(-1)!.body.includes(claudeCAISSample)).toBe(false);
  });

  test("TestGeminiExecutorCountTokens_SanitizesClaudeCAISSignature", async () => {
    upstream.setHandler(() => json(`{"totalTokens": 42}`));
    await exec.countTokens(aistudioAuth(upstream.url), claudeRequestWithThinkingSignature(claudeCAISSample), { stream: false, sourceFormat: "claude" });
    expect(upstream.requests.at(-1)!.body.includes(claudeCAISSample)).toBe(false);
  });

  test("TestGeminiExecutorExecute_FunctionCall_ReplacesClaudeSignatureWithBypass", async () => {
    upstream.setHandler(() => json(okBody));
    await exec.execute(aistudioAuth(upstream.url), { model: "gemini-2.5-flash", payload: functionCallPayload(claudeCAISSample), format: "gemini" }, geminiOpts);
    expect(getAt(lastBody(), "contents.1.parts.0.thoughtSignature")).toBe(geminiSkipThoughtSignatureValidator);
  });

  test("TestGeminiExecutorExecute_PreservesNativeGeminiSignature", async () => {
    upstream.setHandler(() => json(okBody));
    await exec.execute(aistudioAuth(upstream.url), { model: "gemini-2.5-flash", payload: functionCallPayload(nativeGemini3ThoughtSignature), format: "gemini" }, geminiOpts);
    expect(getAt(lastBody(), "contents.1.parts.0.thoughtSignature")).toBe(nativeGemini3ThoughtSignature);
  });

  test("TestGeminiExecutorExecute_UnsignedRequestNotCorrupted", async () => {
    upstream.setHandler(() => json(okBody));
    await exec.execute(aistudioAuth(upstream.url), { model: "gemini-2.5-flash", payload: `{"contents":[{"role":"user","parts":[{"text":"Hello world"}]}]}`, format: "gemini" }, geminiOpts);
    expect(getAt(lastBody(), "contents.0.parts.0.text")).toBe("Hello world");
  });

  test("TestGeminiExecutorExecute_ClaudeToolCallsSeparatedByTextKeepBypassSignatures", async () => {
    upstream.setHandler(() => json(okBody));
    const payload = JSON.stringify({
      model: "gemini-4-argon",
      max_tokens: 16,
      tools: [{ name: "Read", description: "read file", input_schema: { type: "object", properties: { p: { type: "string" } } } }],
      messages: [
        { role: "user", content: "read files" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { p: "/x1" } },
            { type: "text", text: "more" },
            { type: "tool_use", id: "t2", name: "Read", input: { p: "/x2" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "t2", content: "ok" },
          ],
        },
      ],
    });
    await exec.execute(aistudioAuth(upstream.url), { model: "gemini-4-argon", payload, format: "claude" }, { stream: false, sourceFormat: "claude" });
    const body = lastBody();
    expect(getAt(body, "contents.1.parts.0.thoughtSignature")).toBe(geminiSkipThoughtSignatureValidator);
    expect(getAt(body, "contents.1.parts.1.text")).toBe("more");
    expect(getAt(body, "contents.1.parts.2.thoughtSignature")).toBe(geminiSkipThoughtSignatureValidator);
  });
});

const claudeReq = (model = "gemini-2.5-flash") => ({ model, format: "claude", payload: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }) });

describe("Claude inbound end to end (New)", () => {
  test("non-stream: URL, x-goog-api-key, Claude message out", async () => {
    upstream.setHandler(() => json(`{"candidates":[{"content":{"role":"model","parts":[{"text":"hello there"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7},"modelVersion":"gemini-2.5-flash"}`));
    const res = await exec.execute(aistudioAuth(upstream.url, "secret-key"), claudeReq("gemini-2.5-flash(1024)"), claudeOpts);
    const sent = upstream.requests.at(-1)!;
    expect(sent.path).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(sent.search).toBe("");
    expect(sent.headers.get("x-goog-api-key")).toBe("secret-key");
    expect(sent.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(sent.body);
    expect(body.model).toBe("gemini-2.5-flash");
    expect(getAt(body, "generationConfig.thinkingConfig.thinkingBudget")).toBe(1024);
    const out = JSON.parse(res.payload);
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.content[0]).toMatchObject({ type: "text", text: "hello there" });
    expect(out.stop_reason).toBe("end_turn");
    expect(res.metadata?.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  });

  test("stream: ?alt=sse, Claude SSE ending in message_stop", async () => {
    upstream.setHandler(() =>
      sse(
        `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\r\n\r\n` +
          `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n`,
      ),
    );
    const res = await exec.executeStream(aistudioAuth(upstream.url), claudeReq(), { ...claudeOpts, stream: true });
    const { text, error } = await drain(res);
    expect(error).toBeUndefined();
    const sent = upstream.requests.at(-1)!;
    expect(sent.path).toBe("/v1beta/models/gemini-2.5-flash:streamGenerateContent");
    expect(sent.search).toBe("?alt=sse");
    const events = claudeEvents(text);
    expect(events[0]).toBe("message_start");
    expect(events.at(-1)).toBe("message_stop");
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('"text":"lo"');
  });

  test("countTokens returns Claude input_tokens", async () => {
    upstream.setHandler(() => json(`{"totalTokens":42}`));
    const res = await exec.countTokens(aistudioAuth(upstream.url), claudeReq(), claudeOpts);
    expect(JSON.parse(res.payload)).toEqual({ input_tokens: 42 });
  });

  test("429 with RetryInfo -> StatusError 429 retryAfterMs", async () => {
    const body = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }] } });
    upstream.setHandler(() => json(body, 429));
    const err = (await exec.execute(aistudioAuth(upstream.url), claudeReq(), claudeOpts).catch((e) => e)) as StatusError;
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(12_000);
    const errStream = (await exec.executeStream(aistudioAuth(upstream.url), claudeReq(), { ...claudeOpts, stream: true }).catch((e) => e)) as StatusError;
    expect(errStream.statusCode).toBe(429);
    expect(errStream.retryAfterMs).toBe(12_000);
  });

  test("refresh returns the auth unchanged", async () => {
    const auth = aistudioAuth(upstream.url);
    expect(await exec.refresh(auth)).toBe(auth);
  });
});

describe("prompt blocks (TestGeminiExecutorPromptFeedbackBlockWithoutCandidatesReturnsError)", () => {
  const cases = [
    {
      name: "claude_empty_candidates_without_message",
      body: `{"candidates":[],"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"},"usageMetadata":{"promptTokenCount":413751,"totalTokenCount":413751},"modelVersion":"gemini-4-argon"}`,
      want: "upstream blocked the prompt: PROHIBITED_CONTENT",
    },
    {
      name: "claude_with_message (re-expressed openai_with_message)",
      body: `{"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"The prompt is blocked due to safety"},"usageMetadata":{"promptTokenCount":413751,"totalTokenCount":413751},"modelVersion":"gemini-4-argon"}`,
      want: "upstream blocked the prompt: SAFETY - The prompt is blocked due to safety",
    },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      upstream.setHandler((r) => (r.path.endsWith(":streamGenerateContent") ? sse(`data: ${tc.body}\n\n`) : json(tc.body)));
      const err = (await exec.execute(aistudioAuth(upstream.url), claudeReq("gemini-4-argon"), claudeOpts).catch((e) => e)) as StatusError;
      expect(err).toBeInstanceOf(StatusError);
      expect(err.statusCode).toBe(400);
      expect(err.requestScoped).toBe(true);
      expect(err.message).toContain(tc.want);

      const res = await exec.executeStream(aistudioAuth(upstream.url), claudeReq("gemini-4-argon"), { ...claudeOpts, stream: true });
      const { error } = await drain(res);
      expect(error).toBeInstanceOf(StatusError);
      expect((error as StatusError).statusCode).toBe(400);
      expect((error as StatusError).requestScoped).toBe(true);
      expect((error as StatusError).message).toContain(tc.want);
    });
  }
});

describe("MALFORMED_FUNCTION_CALL (TestGeminiExecutorClaudeMalformedFunctionCallReturnsRetryableError)", () => {
  test("non-stream and stream surface a retryable 502 api_error", async () => {
    const malformed = `{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"MALFORMED_FUNCTION_CALL"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":10,"thoughtsTokenCount":313,"totalTokenCount":443},"modelVersion":"gemini-4-argon"}`;
    upstream.setHandler((r) => (r.path.endsWith(":streamGenerateContent") ? sse(`data: ${malformed}\n\n`) : json(malformed)));
    const err = (await exec.execute(aistudioAuth(upstream.url), claudeReq("gemini-4-argon"), claudeOpts).catch((e) => e)) as StatusError;
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(502);
    expect(getAt(JSON.parse(err.message), "error.type")).toBe("api_error");

    const res = await exec.executeStream(aistudioAuth(upstream.url), claudeReq("gemini-4-argon"), { ...claudeOpts, stream: true });
    const { text, error } = await drain(res);
    expect((error as StatusError).statusCode).toBe(502);
    expect(text).not.toContain(`"stop_reason":"refusal"`);
    expect(text).toContain("event: error\n");
    expect(text).toContain(`"type":"api_error"`);
  });
});

describe("terminal handling (gemini_missing_terminal_upstream_repro_test.go, issue 6258, terminal disconnect)", () => {
  const partial = `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial answer"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}\n\n`;
  const complete = `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"complete answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}\n\n`;

  test("normal_terminal", async () => {
    upstream.setHandler(() => sse(complete));
    const { text, error } = await drain(await exec.executeStream(aistudioAuth(upstream.url), claudeReq("gemini-3.1-pro-preview"), { ...claudeOpts, stream: true }));
    expect(error).toBeUndefined();
    expect(claudeEvents(text).at(-1)).toBe("message_stop");
  });

  test("partial_then_missing_terminal -> 502 streamTruncated (no failover, no cooldown)", async () => {
    upstream.setHandler(() => sse(partial));
    const { text, error } = await drain(await exec.executeStream(aistudioAuth(upstream.url), claudeReq("gemini-3.1-pro-preview"), { ...claudeOpts, stream: true }));
    expect(text).toContain("partial answer");
    expect(claudeEvents(text)).not.toContain("message_stop");
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).streamTruncated).toBe(true);
    expect((error as StatusError).message).toContain("before finishReason");
  });

  test("empty_200_missing_terminal -> 502 streamTruncated (also the openai_chat truncation row, re-expressed for Claude)", async () => {
    upstream.setHandler(() => sse(""));
    const { chunks, error } = await drain(await exec.executeStream(aistudioAuth(upstream.url), claudeReq("gemini-3.1-pro-preview"), { ...claudeOpts, stream: true }));
    expect(chunks.length).toBe(0);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).streamTruncated).toBe(true);
    expect((error as StatusError).message).toContain("before finishReason");
  });

  test("real_http_502_control -> plain StatusError 502 (failover allowed)", async () => {
    upstream.setHandler(() => json(`{"error":{"code":502,"message":"mock upstream rejection","status":"UNAVAILABLE"}}`, 502));
    const err = (await exec.executeStream(aistudioAuth(upstream.url), claudeReq("gemini-3.1-pro-preview"), { ...claudeOpts, stream: true }).catch((e) => e)) as StatusError;
    expect(err.statusCode).toBe(502);
    expect(err.streamTruncated).toBe(false);
    expect(err.requestScoped).toBe(false);
    expect(err.message).toContain("mock upstream rejection");
  });

  test("issue 6258 stop_without_usage completes with the content", async () => {
    upstream.setHandler(() => sse(`data: {"responseId":"executor-6258","candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}\n\n`));
    const { text, error } = await drain(await exec.executeStream(aistudioAuth(upstream.url), claudeReq(), { ...claudeOpts, stream: true }));
    expect(error).toBeUndefined();
    expect(text).toContain('"text":"answer"');
    expect(claudeEvents(text).at(-1)).toBe("message_stop");
  });

  test("terminal disconnect: before_completion_read_error rethrows the transport error", async () => {
    // A broken transfer is simulated with an injected fetch (a Bun.serve stream error aborts before headers).
    const brokenExec = createAIStudioExecutor({ fetch: async () => erroringSSE(`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]}}]}\n\n`) });
    const { text, error } = await drain(await brokenExec.executeStream(aistudioAuth("http://127.0.0.1:9"), claudeReq(), { ...claudeOpts, stream: true }));
    expect(text).toContain('"text":"OK"');
    expect(error).toBeDefined();
    expect(error instanceof StatusError && error.streamTruncated).toBe(false);
  });

  test("terminal disconnect: before_completion_cancel ends quietly", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    upstream.setHandler(() => hangingSSE(`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]}}]}\n\n`, released));
    const controller = new AbortController();
    const res = await exec.executeStream(aistudioAuth(upstream.url), claudeReq(), { ...claudeOpts, stream: true, signal: controller.signal });
    const seen: string[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of res.chunks) {
        seen.push(chunk);
        if (chunk.includes("content_block_delta")) controller.abort();
      }
    } catch (err) {
      thrown = err;
    }
    release();
    expect(seen.join("")).toContain('"text":"OK"');
    expect(thrown).toBeUndefined();
  });
});
