// Ported from: internal/translator/openai/openai/responses/echo_perf_test.go, internal/translator/openai/openai/responses/responses_compatibility_digest_test.go, internal/translator/openai/openai/responses/responses_request_state_test.go, internal/translator/openai/openai/responses/responses_perf_test.go
// Skipped cases: BenchmarkResponsesEchoShortStreams, BenchmarkResponsesLongHistory, BenchmarkResponsesStreamLongRequest (benchmarks;
//   responsesPerfRequest is kept as a fixture builder), TestResponsesEchoGoldenOutputs/duplicate-keys (gjson reads the first of
//   duplicate keys, JSON.parse the last; the case is checked for the last-wins echo instead of the Go hash)
import { describe, expect, test } from "bun:test";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import {
  convertOpenAIChatCompletionsResponseToOpenAIResponses,
  convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream,
  convertOpenAIResponsesRequestToOpenAIChatCompletions,
} from "../../../../../src/translator/openai/openai/responses/index.ts";
import { sha256Hex } from "./helpers.ts";

export function responsesPerfRequest(turns: number): string {
  const items = [`{"role":"user","content":"start"}`];
  for (let i = 0; i < turns; i++) {
    items.push(
      `{"type":"function_call","call_id":"c${i}","namespace":"editor","name":"read","arguments":"{}"}`,
      `{"type":"function_call_output","call_id":"c${i}","output":"${"x".repeat(8192)}"}`,
    );
  }
  return `{"model":"test","instructions":"${"x".repeat(65536)}","tools":[{"type":"namespace","name":"editor","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]}],"input":[${items.join(",")}]}`;
}

function echoChunk(extra: string): string {
  return `data: {"id":"chatcmpl-1","created":1700000000,"object":"chat.completion.chunk","choices":[{"index":0,"delta":{${extra}}}]}`;
}

function runEchoStream(request: string): string {
  const chunks = [
    echoChunk(`"role":"assistant","content":""`),
    echoChunk(`"reasoning_content":"think"`),
    echoChunk(`"content":"Hel"`),
    echoChunk(`"content":"lo"`),
    `data: {"id":"chatcmpl-1","created":1700000000,"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"editor__read","arguments":"{\\"path\\":\\"/tmp/x\\"}"}}]}}]}`,
    `data: {"id":"chatcmpl-1","created":1700000000,"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}`,
    `data: [DONE]`,
  ];
  const state: TranslatorState = {};
  let out = "";
  for (const chunk of chunks) out += convertOpenAIChatCompletionsResponseToOpenAIResponses(emptyContext, "test", request, request, chunk, state).join("");
  return out;
}

const history = "context ".repeat(4096);
const tools = `[{"type":"namespace","name":"editor","tools":[{"type":"function","name":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}]}]`;
const echoRequests: [string, string][] = [
  ["nil", ""],
  ["empty-object", `{}`],
  ["malformed", `{`],
  [
    "full",
    `{"model":"gpt-5","instructions":"${history}","max_output_tokens":4096,"max_tool_calls":3,"parallel_tool_calls":false,"previous_response_id":"resp_prev","prompt_cache_key":"k1","reasoning":{"effort":"high","summary":"auto"},"safety_identifier":"user-1","service_tier":"priority","store":true,"temperature":1,"text":{"format":{"type":"json_schema","name":"x"}},"tool_choice":"auto","tools":${tools},"top_logprobs":5,"top_p":0.5,"truncation":"auto","user":"u1","metadata":{"b":2,"a":1},"input":[{"role":"user","content":"hi"}]}`,
  ],
  ["weird-types", `{"model":42,"instructions":null,"temperature":"hot","store":"yes","parallel_tool_calls":1,"max_output_tokens":"999","top_p":2,"tools":"none","metadata":[1,2],"user":{"id":7},"input":[]}`],
  ["escaped-key", `{"mod\\u0065l":"esc-model","input":[],"tools":${tools}}`],
  ["max-tokens-only", `{"model":"gpt-5","max_tokens":777,"input":[]}`],
];

// Golden hashes captured from the Go implementation.
const echoGoldenHashes: Record<string, [string, string]> = {
  nil: ["12e174a662e5387285c18447eacd8f21802f391689b43a855718bd3a7962a8d2", "1c76155d2c138f38f71aeb380c3bfc873486725a0a3da29d1484461831b729cc"],
  "empty-object": ["12e174a662e5387285c18447eacd8f21802f391689b43a855718bd3a7962a8d2", "1c76155d2c138f38f71aeb380c3bfc873486725a0a3da29d1484461831b729cc"],
  malformed: ["12e174a662e5387285c18447eacd8f21802f391689b43a855718bd3a7962a8d2", "1c76155d2c138f38f71aeb380c3bfc873486725a0a3da29d1484461831b729cc"],
  full: ["211b3a1fca607e01a1414e8cdefd2356369c5881284c09148ba2ac22df6b469f", "d9f230169b59ea6c2ab91910f9161656139cde3c44df55dee7c615798f5a687b"],
  "weird-types": ["b09dc247fa502d2dab743a6a8eb0f09e0c99bf4da1b231f1db2843d25a93deee", "42ec2fafcf76c77924dafdfabef14d7df28da2166f4a50c20f1be5217a5ca907"],
  "escaped-key": ["c1183fc24b5774533d05e66db7c43725ab4757de1df267b858afd401f6fe3004", "290d5be1207223112672ee6d9cfe7abc4d6b6d9f03a3b05c46ff83a2e63d9fd2"],
  "max-tokens-only": ["6326707a3383eb6227783564451eb7efa40f0c2fa10fec8dc99f3ac24390f3f3", "aed55068cbdb234de859841ffcdbd87098938f4c59d62d03b12d510f4fca109c"],
};

const echoResponse = `{"id":"chatcmpl-9","created":1700000000,"model":"resp-model","choices":[{"message":{"role":"assistant","content":"done","reasoning_content":"why","tool_calls":[{"id":"call_9","type":"function","function":{"name":"editor__read","arguments":"{\\"path\\":\\"/tmp/y\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}`;

describe("ResponsesEchoGoldenOutputs", () => {
  for (const [name, raw] of echoRequests) {
    test(name, () => {
      const want = echoGoldenHashes[name]!;
      expect(sha256Hex(runEchoStream(raw))).toBe(want[0]);
      const n1 = convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream(emptyContext, "test", raw, raw, echoResponse, {});
      expect(sha256Hex(n1)).toBe(want[1]);
    });
  }

  test("duplicate-keys echoes the JSON.parse (last) value", () => {
    const raw = `{"model":"first","input":[],"model":"second","temperature":0.1,"temperature":0.9}`;
    const n1 = JSON.parse(convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream(emptyContext, "test", raw, raw, echoResponse, {}));
    expect(n1.model).toBe("second");
    expect(n1.temperature).toBe(0.9);
  });
});

test("ResponsesEchoGoldenEdgeCases", () => {
  for (const req of [`[{"model":"x"}]`, `"hello"`, `42`]) {
    expect(sha256Hex(runEchoStream(req))).toBe("12e174a662e5387285c18447eacd8f21802f391689b43a855718bd3a7962a8d2");
    const resp = `{"id":"c1","created":1700000000,"model":"m","choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`;
    expect(sha256Hex(convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream(emptyContext, "test", req, req, resp, {}))).toBe(
      "b934f12c0c7cda0dc4d68ce8a849c70627249fd9f21f3a08754cad2d775b40c4",
    );
  }
  const respNoRC = `{"id":"c2","created":1700000000,"model":"m","choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`;
  const want: Record<string, [string, string]> = {
    "req-with-reasoning": [`{"model":"gpt-5","reasoning":{"effort":"low"},"input":[]}`, "f6685c62154ff44ea0f90a1b5f1ee216dc27ddd20cae0d978f321b427c9727e6"],
    "req-without-reasoning": [`{"model":"gpt-5","input":[]}`, "7465142d0300dcf9add250456693b76fbef1f1bb001aa57b7db47cc63ddc024d"],
    "req-reasoning-null": [`{"model":"gpt-5","reasoning":null,"input":[]}`, "1b4b449220acfdc810fa81e264e8559939f9b9ac79fa1097cd4ca09741665fde"],
  };
  for (const [name, [req, hash]] of Object.entries(want)) {
    expect(sha256Hex(convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream(emptyContext, "test", req, req, respNoRC, {})), name).toBe(hash);
  }
});

test("ResponsesCompatibilityDigest", () => {
  const requests = [
    responsesPerfRequest(0),
    responsesPerfRequest(10),
    responsesPerfRequest(100),
    `{"model":"test","tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"patch"},{"type":"function","name":"read"}]}],"input":[]}`,
    `{"model":"test","tools":[{"type":"function","name":"editor__patch"}],"input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"patch"}]}]}]}`,
    `{"model":"test","tools":[{"type":"namespace","name":"${"namespace".repeat(10)}","tools":[{"type":"function","name":"read"}]},{"type":"namespace","name":"other","tools":[{"type":"function","name":"read"}]}],"input":[]}`,
  ];
  const hash = new Bun.CryptoHasher("sha256");
  for (const request of requests) {
    hash.update(convertOpenAIResponsesRequestToOpenAIChatCompletions("test", request, true));
    for (const name of ["editor__read", "read", "editor__patch", "patch", "unknown"]) {
      const state: TranslatorState = {};
      const chunks = [
        `{"id":"r-test","created":1,"choices":[{"index":0,"delta":{"content":"hello"}}]}`,
        `{"id":"r-test","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-test","function":{"name":${JSON.stringify(name)},"arguments":""}}]}}]}`,
        `{"id":"r-test","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"input\\":\\"hello\\"}"}}]}}]}`,
        `{"id":"r-test","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}`,
        `[DONE]`,
      ];
      for (const chunk of chunks) {
        for (const event of convertOpenAIChatCompletionsResponseToOpenAIResponses(emptyContext, "test", request, request, "data: " + chunk, state)) hash.update(event);
      }
    }
  }
  expect(hash.digest("hex")).toBe("be3fc19eade4e6aff373fdfdd0192d586b5aa83e01a6b22884456396443f8411");
});

test("ResponsesRequestSelectionAndStreamIsolation", () => {
  const request = (namespace: string) => `{"tools":[{"type":"namespace","name":${JSON.stringify(namespace)},"tools":[{"type":"function","name":"run"}]}]}`;
  const cases: { original: string; translated: string; wantNamespace: string; state: TranslatorState }[] = [
    { original: request("original"), translated: request("translated"), wantNamespace: "original", state: {} },
    { original: `{"broken":`, translated: request("fallback"), wantNamespace: "fallback", state: {} },
    { original: "", translated: request("separate"), wantNamespace: "separate", state: {} },
    { original: `invalid`, translated: `invalid`, wantNamespace: "", state: {} },
  ];
  const start = `data: {"id":"r","created":1,"choices":[{"index":0,"delta":{"role":"assistant"}}]}`;
  const tool = `data: {"id":"r","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"run","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`;
  // Interleave independent requests to catch accidental global cache reuse.
  for (const c of cases) convertOpenAIChatCompletionsResponseToOpenAIResponses(emptyContext, "test", c.original, c.translated, start, c.state);
  cases.forEach((c, i) => {
    const events = [
      ...convertOpenAIChatCompletionsResponseToOpenAIResponses(emptyContext, "test", c.original, c.translated, tool, c.state),
      ...convertOpenAIChatCompletionsResponseToOpenAIResponses(emptyContext, "test", c.original, c.translated, "data: [DONE]", c.state),
    ];
    const all = events.join("");
    expect(all.includes(`"name":"run"`), `case ${i}`).toBe(true);
    if (c.wantNamespace === "") expect(all.includes(`"namespace":`)).toBe(false);
    else expect(all.includes(`"namespace":${JSON.stringify(c.wantNamespace)}`), `case ${i}`).toBe(true);
  });
});
