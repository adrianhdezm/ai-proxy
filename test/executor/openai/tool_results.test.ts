// Ported from: internal/runtime/executor/openai_compat_executor_tool_results_test.go
// Ported from: internal/runtime/executor/helps/openai_compat_tool_results_test.go
// Skipped cases: none. The per-model input-modalities option is read from the credential's
//   model overrides (`inputModalities`) instead of config.OpenAICompatibility.Models.
import { afterAll, describe, expect, test } from "bun:test";
import {
  OpenAICompatExecutor,
  claudeToolResultImageRelayNotice,
  normalizeOpenAIToolResultsTextOnly,
  openAIToolResultImageOmittedText,
  shouldNormalizeOpenAIToolResultsForModel,
  type OpenAICompatModelOption,
} from "../../../src/executor/openai/index.ts";
import { FormatClaude, FormatOpenAI } from "../../../src/translator/types.ts";
import { apiKeyAuth, configWithModels, drain, getString, getValue, jsonResponse, modelOverride, simpleChatCompletion, sseResponse, startUpstream } from "./helpers.ts";

const upstream = startUpstream(() => jsonResponse(simpleChatCompletion));
afterAll(() => upstream.close());

const toolResultPayload = JSON.stringify({
  model: "claude-client",
  max_tokens: 64,
  messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "inspect_image", input: {} }] },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text", text: "image inspected" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
          ],
        },
      ],
    },
  ],
});

async function run(stream: boolean, inputModalities: string[] | undefined): Promise<string> {
  upstream.requests.length = 0;
  upstream.respond(() => (stream ? sseResponse("data: [DONE]\n\n") : jsonResponse(simpleChatCompletion)));
  const cfg = configWithModels([modelOverride({ name: "mapped-model", alias: "claude-client", inputModalities })]);
  const executor = new OpenAICompatExecutor(cfg);
  const auth = apiKeyAuth({ baseURL: upstream.baseURL, apiKey: "test", configIndex: 0 });
  const req = { model: "mapped-model", payload: toolResultPayload, format: FormatClaude };
  const opts = { stream, sourceFormat: FormatClaude, responseFormat: FormatOpenAI };
  if (stream) {
    const { error } = await drain(await executor.executeStream(auth, req, opts));
    expect(error).toBeUndefined();
  } else {
    await executor.execute(auth, req, opts);
  }
  return upstream.lastBody();
}

describe("OpenAICompatExecutor tool result content by input modalities", () => {
  const cases: Array<{ name: string; stream: boolean; inputModalities: string[] | undefined; wantString: boolean }> = [
    { name: "non-stream text-only", stream: false, inputModalities: ["text"], wantString: true },
    { name: "stream text-only", stream: true, inputModalities: ["text"], wantString: true },
    { name: "non-stream multimodal", stream: false, inputModalities: ["text", "image"], wantString: false },
    { name: "non-stream unspecified", stream: false, inputModalities: undefined, wantString: false },
  ];
  for (const tt of cases) {
    test(tt.name, async () => {
      const body = await run(tt.stream, tt.inputModalities);
      const toolContent = getValue(body, "messages.1.content");
      expect(typeof toolContent).toBe("string");
      if (tt.wantString) {
        expect(toolContent).toBe("image inspected\n\n" + openAIToolResultImageOmittedText);
        expect(body).not.toContain("image_url");
      } else {
        expect(toolContent).toBe("image inspected");
        expect(body).toContain("image_url");
      }
    });
  }
});

describe("text-only model does not receive image_url", () => {
  for (const stream of [false, true]) {
    test(stream ? "stream" : "non-stream", async () => {
      const body = await run(stream, ["text"]);
      expect(body).not.toContain("image_url");
    });
  }
});

function messagesOf(body: string): Array<Record<string, unknown>> {
  const v = getValue(body, "messages");
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

describe("normalizeOpenAIToolResultsTextOnly relayed images", () => {
  test("synthetic relay message is dropped and tool is marked", () => {
    const input = `{"messages":[
      {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"inspect_image","arguments":"{}"}}]},
      {"role":"tool","tool_call_id":"call_1","content":"image inspected"},
      {"role":"user","content":[
        {"type":"text","text":"Images returned by the preceding tool call(s):"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}
      ]}
    ]}`;
    const got = normalizeOpenAIToolResultsTextOnly(input);
    expect(got).not.toContain("image_url");
    const messages = messagesOf(got);
    expect(messages.length).toBe(2);
    expect(messages[1]!.content).toBe("image inspected\n\n" + openAIToolResultImageOmittedText);
  });

  test("placeholder tool content is replaced with omitted marker", () => {
    const input = `{"messages":[
      {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"inspect_image","arguments":"{}"}}]},
      {"role":"tool","tool_call_id":"call_1","content":"[Tool returned image content; the images follow in the next user message.]"},
      {"role":"user","content":[
        {"type":"text","text":"Images returned by the preceding tool call(s):"},
        {"type":"image_url","image_url":{"url":"https://example.com/img.png"}}
      ]}
    ]}`;
    const got = normalizeOpenAIToolResultsTextOnly(input);
    expect(got).not.toContain("image_url");
    const messages = messagesOf(got);
    expect(messages.length).toBe(2);
    expect(messages[1]!.content).toBe(openAIToolResultImageOmittedText);
  });

  test("merged user message retains user prompt while stripping relay images", () => {
    const input = `{"messages":[
      {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"inspect_image","arguments":"{}"}}]},
      {"role":"tool","tool_call_id":"call_1","content":"image inspected"},
      {"role":"user","content":[
        {"type":"text","text":"Images returned by the preceding tool call(s):"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}},
        {"type":"text","text":"What color is the car?"}
      ]}
    ]}`;
    const got = normalizeOpenAIToolResultsTextOnly(input);
    expect(got).not.toContain("image_url");
    const messages = messagesOf(got);
    expect(messages.length).toBe(3);
    expect(messages[1]!.content).toBe("image inspected\n\n" + openAIToolResultImageOmittedText);
    const userContent = JSON.stringify(messages[2]!.content);
    expect(userContent).not.toContain(claudeToolResultImageRelayNotice);
    expect(userContent).toContain("What color is the car?");
  });

  test("multiple preceding tools where one is placeholder", () => {
    const input = `{"messages":[
      {"role":"assistant","content":"","tool_calls":[
        {"id":"call_1","type":"function","function":{"name":"tool1","arguments":"{}"}},
        {"id":"call_2","type":"function","function":{"name":"tool2","arguments":"{}"}}
      ]},
      {"role":"tool","tool_call_id":"call_1","content":"text result only"},
      {"role":"tool","tool_call_id":"call_2","content":"[Tool returned image content; the images follow in the next user message.]"},
      {"role":"user","content":[
        {"type":"text","text":"Images returned by the preceding tool call(s):"},
        {"type":"image_url","image_url":{"url":"https://example.com/tool2.png"}}
      ]}
    ]}`;
    const got = normalizeOpenAIToolResultsTextOnly(input);
    expect(got).not.toContain("image_url");
    const messages = messagesOf(got);
    expect(messages.length).toBe(3);
    expect(messages[1]!.content).toBe("text result only");
    expect(messages[2]!.content).toBe(openAIToolResultImageOmittedText);
  });

  test("multiple preceding tools where image tool precedes text tool", () => {
    const input = `{"messages":[
      {"role":"assistant","content":"","tool_calls":[
        {"id":"call_1","type":"function","function":{"name":"tool1","arguments":"{}"}},
        {"id":"call_2","type":"function","function":{"name":"tool2","arguments":"{}"}}
      ]},
      {"role":"tool","tool_call_id":"call_1","content":"[Tool returned image content; the images follow in the next user message.]"},
      {"role":"tool","tool_call_id":"call_2","content":"text result only"},
      {"role":"user","content":[
        {"type":"text","text":"Images returned by the preceding tool call(s):"},
        {"type":"image_url","image_url":{"url":"https://example.com/tool1.png"}}
      ]}
    ]}`;
    const got = normalizeOpenAIToolResultsTextOnly(input);
    expect(got).not.toContain("image_url");
    const messages = messagesOf(got);
    expect(messages.length).toBe(3);
    expect(messages[1]!.content).toBe(openAIToolResultImageOmittedText);
    expect(messages[2]!.content).toBe("text result only");
  });
});

test("normalizeOpenAIToolResultsTextOnly flattens tool arrays and leaves other roles alone", () => {
  const input = `{"messages":[
    {"role":"assistant","content":[{"type":"text","text":"before"}]},
    {"role":"tool","tool_call_id":"call_1","content":[
      {"type":"text","text":"image inspected"},
      {"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}
    ]},
    {"role":"tool","tool_call_id":"call_2","content":"already text"},
    {"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.com/user.png"}}]}
  ]}`;
  const got = normalizeOpenAIToolResultsTextOnly(input);
  expect(getValue(got, "messages.1.content")).toBe("image inspected\n\n" + openAIToolResultImageOmittedText);
  expect(getString(got, "messages.2.content")).toBe("already text");
  expect(Array.isArray(getValue(got, "messages.0.content"))).toBe(true);
  expect(Array.isArray(getValue(got, "messages.3.content"))).toBe(true);
});

describe("normalizeOpenAIToolResultsTextOnly image and unknown content", () => {
  const cases = [
    { name: "image-only array", input: `{"messages":[{"role":"tool","content":[{"type":"image_url","image_url":{"url":"https://example.com/image.png"}}]}]}`, want: openAIToolResultImageOmittedText },
    { name: "image object", input: `{"messages":[{"role":"tool","content":{"type":"image","source":{"type":"base64","data":"AA=="}}}]}`, want: openAIToolResultImageOmittedText },
    { name: "unknown object", input: `{"messages":[{"role":"tool","content":[{"type":"custom","value":1}]}]}`, want: `{"type":"custom","value":1}` },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      expect(getString(normalizeOpenAIToolResultsTextOnly(tt.input), "messages.0.content")).toBe(tt.want);
    });
  }
});

describe("shouldNormalizeOpenAIToolResultsForModel", () => {
  const compat: OpenAICompatModelOption[] = [
    { name: "upstream-text", alias: "alias-text", inputModalities: ["text"] },
    { name: "upstream-multimodal", alias: "alias-multimodal", inputModalities: ["text", "image"] },
    { name: "upstream-unspecified", alias: "alias-unspecified" },
    { name: "upstream-uppercase", alias: "alias-uppercase", inputModalities: ["TEXT"] },
    { name: "pool-text", alias: "shared-alias", inputModalities: ["text"] },
    { name: "pool-image", alias: "shared-alias", inputModalities: ["text", "image"] },
  ];
  const cases = [
    { name: "upstream text", upstreamModel: "upstream-text", requestedModel: "", want: true },
    { name: "upstream suffix", upstreamModel: "upstream-text(high)", requestedModel: "", want: true },
    { name: "requested alias", upstreamModel: "unknown", requestedModel: "alias-text", want: true },
    { name: "multimodal", upstreamModel: "upstream-multimodal", requestedModel: "", want: false },
    { name: "unspecified", upstreamModel: "upstream-unspecified", requestedModel: "", want: false },
    { name: "case insensitive modality", upstreamModel: "upstream-uppercase", requestedModel: "", want: true },
    { name: "mixed alias pool", upstreamModel: "unknown", requestedModel: "shared-alias", want: false },
    { name: "unknown", upstreamModel: "unknown", requestedModel: "missing", want: false },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      expect(shouldNormalizeOpenAIToolResultsForModel(compat, tt.upstreamModel, tt.requestedModel)).toBe(tt.want);
    });
  }

  test("nil compatibility config does not enable normalization", () => {
    expect(shouldNormalizeOpenAIToolResultsForModel(undefined, "upstream-text", "alias-text")).toBe(false);
  });
});
