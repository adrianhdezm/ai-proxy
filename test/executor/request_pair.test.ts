// Ported from: internal/runtime/executor/helps/request_pair_compat_test.go
// Ported from: internal/runtime/executor/helps/request_pair_error_test.go
// Ported from: internal/runtime/executor/helps/request_unsupported_user_turn_test.go
// Ported from: internal/runtime/executor/helps/unsupported_part_test.go
// Ported from: internal/runtime/executor/unsupported_part_executor_test.go
// Skipped cases: TestCompatibilityRequestPairInvokesPluginOncePerInput (translator plugin hooks not ported);
//   TestTranslateRequestPairWithAPIKeyModelCompatibilityCountsTranslations "equal content with a different backing
//   array" half (JS strings have no identity: content-equal payloads are translated once); every Interactions,
//   Antigravity and OpenAI-chat-inbound route (TestEnvelopePairKeepsTheWorkingPayloadWhenTheBaselineIsRefused,
//   TestAntigravityTargetsReportUnsupportedParts, the "openai chat to codex/interactions" and "responses to
//   antigravity/interactions" routes, the "with update intent" variants: Codex multi-agent v2 update intent not
//   ported); TestByteWrappersKeepAJSONBodyForAnUnsendableFile (Go wrappers that swallow the error; the TS translators
//   always throw); the openai/gemini/interactions inbound rows of TestExecutorsRefuseAFileOnlyTurnBeforeCallingUpstream
//   (only Claude and Responses inbound are served).
// The Go "working buffer aliases the baseline" checks are moot for immutable strings.
import { afterAll, describe, expect, test } from "bun:test";
import "../../src/translator/openai/openai/responses/index.ts";
import "../../src/translator/gemini/openai/responses/index.ts";
import { translateRequestPairWithAPIKeyModelCompatibility, translateRequestWithAPIKeyModelCompatibility } from "../../src/executor/request_pair.ts";
import { register, unregister, hasRequestTransformer } from "../../src/translator/registry.ts";
import { UnsupportedPartError } from "../../src/translator/common/parts.ts";
import { FormatClaude, FormatCodex, FormatGemini, FormatOpenAI, FormatOpenAIResponse, type Format } from "../../src/translator/types.ts";
import { OpenAICompatExecutor } from "../../src/executor/openai/index.ts";
import { CodexExecutor } from "../../src/executor/codex/index.ts";
import { newAuth } from "../../src/auth/types.ts";
import { tryParse } from "../../src/util/json.ts";
import { getAt, gstr } from "../../src/util/gpath.ts";

function rejection(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Go: requireUnsupportedPart. */
function expectUnsupportedPart(err: unknown, wantType: string): void {
  expect(err).toBeInstanceOf(UnsupportedPartError);
  const part = err as UnsupportedPartError;
  expect(part.type).toBe(wantType);
  expect(part.statusCode).toBe(400);
  expect(part.message).toBe("unsupported content part: " + wantType);
}

const pairFileOnlyClaude = `{"model":"m","max_tokens":8,"messages":[{"role":"user","content":[{"type":"container_upload","file_id":"file-1"}]}]}`;
const pairTextOnlyClaude = `{"model":"m","max_tokens":8,"messages":[{"role":"user","content":[{"type":"text","text":"keep me"}]}]}`;

describe("TestCompatibilityRequestPair", () => {
  for (const compat of [false, true]) {
    for (const stream of [false, true]) {
      for (const distinct of [false, true]) {
        test(`compat=${compat} stream=${stream} distinct=${distinct}`, () => {
          const original = `{"model":"test","input":"hello"}`;
          const request = distinct ? `{"model":"test","input":"changed"}` : original;
          const wantOriginal = translateRequestWithAPIKeyModelCompatibility(FormatOpenAIResponse, FormatOpenAI, "test", original, stream, compat);
          const wantWorking = translateRequestWithAPIKeyModelCompatibility(FormatOpenAIResponse, FormatOpenAI, "test", request, stream, compat);
          const pair = translateRequestPairWithAPIKeyModelCompatibility(FormatOpenAIResponse, FormatOpenAI, "test", original, request, stream, compat);
          expect(pair.original).toBe(wantOriginal);
          expect(pair.working).toBe(wantWorking);
        });
      }
    }
  }
});

test("TestTranslateRequestPairWithAPIKeyModelCompatibilityCountsTranslations (same payload)", () => {
  const from = "api-key-compat-count-from" as Format;
  const to = "api-key-compat-count-to" as Format;
  expect(hasRequestTransformer(from, to)).toBe(false);
  const model = "compat-count-model";
  let calls = 0;
  let wantStream = false;
  register(from, to, (gotModel: string, raw: string, stream: boolean) => {
    expect(gotModel).toBe(model);
    expect(stream).toBe(wantStream);
    calls++;
    return raw;
  });
  try {
    const payload = `{"model":"compat-count-model","input":"hello"}`;
    for (const stream of [false, true]) {
      for (const compat of [false, true]) {
        wantStream = stream;
        calls = 0;
        const pair = translateRequestPairWithAPIKeyModelCompatibility(from, to, model, payload, payload, stream, compat);
        expect(calls).toBe(1);
        expect(pair.original).toBe(payload);
        expect(pair.working).toBe(payload);
        calls = 0;
        translateRequestPairWithAPIKeyModelCompatibility(from, to, model, payload, `{"model":"compat-count-model","input":"other"}`, stream, compat);
        expect(calls).toBe(2);
      }
    }
  } finally {
    unregister(from, to);
  }
});

describe("TestPairTranslationReportsOnlyTheWorkingError", () => {
  for (const to of [FormatOpenAI, FormatGemini, FormatCodex] as Format[]) {
    for (const compat of [false, true]) {
      test(`api-key pair to ${to}${compat ? " compat" : ""}`, () => {
        const pair = (original: string, working: string) => translateRequestPairWithAPIKeyModelCompatibility(FormatClaude, to, "m", original, working, false, compat);
        const ok = pair(pairFileOnlyClaude, pairTextOnlyClaude);
        expect(tryParse(ok.working)).toBeDefined();
        expectUnsupportedPart(rejection(() => pair(pairTextOnlyClaude, pairFileOnlyClaude)), "container_upload");
        expectUnsupportedPart(rejection(() => pair(pairFileOnlyClaude, pairFileOnlyClaude)), "container_upload");
        expect(rejection(() => pair(pairTextOnlyClaude, pairTextOnlyClaude))).toBeUndefined();
      });
    }
  }
});

describe("TestClaudeContainerUploadReturns400", () => {
  const payload = `{"messages":[{"role":"user","content":[{"type":"container_upload","file_id":"file-example"}]}]}`;
  for (const to of [FormatGemini, FormatOpenAI, FormatCodex] as Format[]) {
    for (const compat of [false, true]) {
      test(`to=${to} compat=${compat}`, () => {
        expectUnsupportedPart(rejection(() => translateRequestWithAPIKeyModelCompatibility(FormatClaude, to, "m", payload, false, compat)), "container_upload");
        expectUnsupportedPart(rejection(() => translateRequestPairWithAPIKeyModelCompatibility(FormatClaude, to, "m", payload, payload, false, compat)), "container_upload");
      });
    }
  }
});

describe("TestResponsesFileIDOnlyReturns400OnEveryPath", () => {
  const payload = `{"model":"claude-sonnet-4","input":[{"type":"message","role":"user","content":[{"type":"input_file","file_id":"file-1"}]}]}`;
  for (const compat of [false, true]) {
    test(`compat=${compat}`, () => {
      expectUnsupportedPart(rejection(() => translateRequestWithAPIKeyModelCompatibility(FormatOpenAIResponse, FormatClaude, "claude-sonnet-4", payload, false, compat)), "input_file");
      expectUnsupportedPart(rejection(() => translateRequestPairWithAPIKeyModelCompatibility(FormatOpenAIResponse, FormatClaude, "claude-sonnet-4", payload, payload, false, compat)), "input_file");
    });
  }
});

test("TestResponsesAudioAndTextBesideFileIDOnCompatPath", () => {
  const audio = `{"model":"claude-sonnet-4","input":[{"type":"message","role":"user","content":[{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}]}]}`;
  expectUnsupportedPart(rejection(() => translateRequestWithAPIKeyModelCompatibility(FormatOpenAIResponse, FormatClaude, "claude-sonnet-4", audio, false, true)), "input_audio");
  const mixed = `{"model":"claude-sonnet-4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"keep me"},{"type":"input_file","file_id":"file-1"}]}]}`;
  const body = translateRequestWithAPIKeyModelCompatibility(FormatOpenAIResponse, FormatClaude, "claude-sonnet-4", mixed, false, true);
  const content = getAt(tryParse(body), "messages.0.content");
  const text = typeof content === "string" ? content : gstr(getAt(content, "0.text"));
  expect(text).toBe("keep me");
});

describe("TestTranslateRequestReturningErrorRefusesEmptiedAttachmentTurns", () => {
  const responsesHistory = `{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}`;
  const routes: Array<{ name: string; to: Format; refused: string; accepted: string; wantType: string }> = [
    {
      name: "responses to openai chat",
      to: FormatOpenAI,
      refused: `{"model":"m","input":[${responsesHistory},{"type":"message","role":"user","content":[{"type":"input_file","file_url":"https://example.test/a.pdf"}]}]}`,
      accepted: `{"model":"m","input":[${responsesHistory},{"type":"message","role":"user","content":[{"type":"input_file","file_id":"file-1"}]}]}`,
      wantType: "input_file",
    },
    {
      name: "responses to gemini",
      to: FormatGemini,
      refused: `{"model":"m","input":[${responsesHistory},{"type":"message","role":"user","content":[{"type":"input_file","file_id":"file-1"}]}]}`,
      accepted: `{"model":"m","input":[${responsesHistory},{"type":"message","role":"user","content":[{"type":"input_file","file_data":"data:application/pdf;base64,JVBERi0xLjQK"}]}]}`,
      wantType: "input_file",
    },
  ];
  for (const route of routes) {
    for (const compat of [false, true]) {
      test(`${route.name}${compat ? " compat" : ""}`, () => {
        expectUnsupportedPart(rejection(() => translateRequestWithAPIKeyModelCompatibility(FormatOpenAIResponse, route.to, "m", route.refused, false, compat)), route.wantType);
        expectUnsupportedPart(rejection(() => translateRequestPairWithAPIKeyModelCompatibility(FormatOpenAIResponse, route.to, "m", route.refused, route.refused, false, compat)), route.wantType);
        expect(rejection(() => translateRequestWithAPIKeyModelCompatibility(FormatOpenAIResponse, route.to, "m", route.accepted, false, compat))).toBeUndefined();
      });
    }
  }
});

describe("TestExecutorsRefuseAFileOnlyTurnBeforeCallingUpstream", () => {
  let upstreamCalls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      upstreamCalls++;
      return new Response("", { status: 200 });
    },
  });
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const claudeFile = `{"model":"m","max_tokens":8,"messages":[{"role":"user","content":[{"type":"container_upload","file_id":"file_not_stored"}]}]}`;
  const targets = [
    { name: "claude to openai-compat", exec: new OpenAICompatExecutor(), auth: newAuth({ id: "o", provider: "openai", attributes: { api_key: "k", base_url: base + "/v1" } }) },
    { name: "claude to codex", exec: new CodexExecutor(), auth: newAuth({ id: "c", provider: "codex", attributes: { api_key: "k", base_url: base, plan_type: "pro" } }) },
  ];
  for (const target of targets) {
    for (const method of ["execute", "executeStream", "countTokens"] as const) {
      test(`${target.name} ${method}`, async () => {
        const req = { model: "m", payload: claudeFile, format: FormatClaude };
        const opts = { stream: method === "executeStream", sourceFormat: FormatClaude };
        let err: unknown;
        try {
          await target.exec[method](target.auth, req, opts);
        } catch (e) {
          err = e;
        }
        expect(err).toBeDefined();
        const e = err as { statusCode?: number; message?: string };
        expect(e.statusCode).toBe(400);
        expect(e.message).toBe("unsupported content part: container_upload");
        expect(upstreamCalls).toBe(0);
      });
    }
  }
});

// The OpenAI executor translates the baseline (opts.originalRequest) and working payloads as a pair; a baseline
// the target cannot represent must not reject a working payload that translates (Go: TestPairTranslationReportsOnlyTheWorkingError
// at the executor boundary).
test("OpenAI executor sends the working payload when only the baseline is refused", async () => {
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      bodies.push(await req.text());
      return Response.json({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    },
  });
  try {
    const auth = newAuth({ id: "o", provider: "openai", attributes: { api_key: "k", base_url: `http://127.0.0.1:${server.port}/v1` } });
    await new OpenAICompatExecutor().execute(auth, { model: "m", payload: pairTextOnlyClaude, format: FormatClaude }, { stream: false, sourceFormat: FormatClaude, originalRequest: pairFileOnlyClaude });
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("keep me");
  } finally {
    server.stop(true);
  }
});
