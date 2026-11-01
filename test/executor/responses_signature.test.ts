// Ported from: internal/runtime/executor/openai_responses_signature_test.go
// Skipped cases: TestSanitizeOpenAIResponsesReasoningEncryptedContentKeepForeign_Issue6450, the ForMeta /
//   ForMetaBaseURL halves of ..._ForMeta_PreservesRecognizedMuse, ..._ForMeta_StripsRouterSuffixed and
//   ..._WithCompatModel_RoutedMetaTarget (the keepForeign and native-Meta variants serve only the Meta executor; Meta
//   is a dropped provider). The other variants are expressed through the Codex executor's single entry point
//   sanitizeResponsesReasoningEncryptedContent(provider, body, isCompat, targetModel, baseURL): plain = (false, "", ""),
//   WithCompat = (isCompat, "", ""), WithCompatModel = (isCompat, model, "").
//   In TestSanitizeOpenAIResponsesReasoningEncryptedContent_StripsRouterSuffixOnNonOpenRouterUpstreams, the
//   parseSignatureBytes sub-check (Go-internal Devin sealed-signature parser; Devin dropped) and the reasoning replay cache
//   backfill sub-check (the channel switch is re-expressed directly on the cached item shape). The "same backing slice"
//   assertion of NoopReturnsOriginalBody is the identical string here.
// New case: the Codex executor sanitises the outbound /responses body.
import { describe, expect, test } from "bun:test";
import { sanitizeResponsesReasoningEncryptedContent } from "../../src/executor/codex/reasoning_sanitize.ts";

const sanitizeOpenAIResponsesReasoningEncryptedContent = (provider: string, body: string) => sanitizeResponsesReasoningEncryptedContent(provider, body, false, "", "");
const sanitizeOpenAIResponsesReasoningEncryptedContentWithCompat = (provider: string, body: string, isCompat: boolean) => sanitizeResponsesReasoningEncryptedContent(provider, body, isCompat, "", "");
const sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModel = (provider: string, body: string, isCompat: boolean, model: string) => sanitizeResponsesReasoningEncryptedContent(provider, body, isCompat, model, "");
const sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL = sanitizeResponsesReasoningEncryptedContent;
import { CodexExecutor } from "../../src/executor/codex/index.ts";
import { newAuth } from "../../src/auth/types.ts";
import { getAt } from "../../src/util/gpath.ts";

const testClaudeCAISSample =
  "CAISqwIKiAEIEBgCKkBHRlRBsNiptQUWfPoOhuQKwi5LnncZVO9bB5jqOs76D7uBtgktML0zqJtNmLHXHHcgD6lk4MQu4QBXzFd1lbC3Mg5jbGF1ZGUtZmFibGUtNTgBQgh0aGlua2luZ1okZDk3NDM5NzUtNGJiMC00OTM2LTllMjgtZDViMGQyMWJkYzQ4EgxCGh+XVFFFeySAjtAaDL/A1LltGu6MMJ+eXSIwsN0oBpDrqLv22UBfkMnTotnIbkvkOyb9xZHgigG6OZVHaI3gThm+maLKmgO5PrFLKlDFYp+YZksy/wKwszJlnLTPzAK+NUlfzagOE1ymtZTXhAYK260XyFYmg/te/C231+Fr/hoX+EJoUBnrn0gD7hqMISOT+TaFEuOXYsN517GfaxgB";

function validOpenAIResponsesReasoningEncryptedContentForTest(): string {
  const payload = new Uint8Array(1 + 8 + 16 + 16 + 32);
  payload[0] = 0x80;
  for (let i = 9; i < payload.length; i++) payload[i] = i;
  return Buffer.from(payload).toString("base64url");
}

const validMeta = () => "Q-PaDgE" + "A".repeat(1419);
const routedMeta = () => validMeta() + "." + "Ab3".repeat(23).slice(0, 67);

const get = (body: string, path: string): unknown => getAt(JSON.parse(body), path);
const has = (body: string, path: string): boolean => get(body, path) !== undefined;

function expectEmptyReasoningContent(body: string, path: string): void {
  expect(get(body, path)).toEqual([]);
}

test("StripsOrphanIDsWhenStoreDisabled", () => {
  const valid = validOpenAIResponsesReasoningEncryptedContentForTest();
  const body = `{"store":false,"input":[{"id":"rs_bad","type":"reasoning","encrypted_content":"bad","summary":[]},{"id":"rs_orphan","type":"reasoning","summary":[]},{"id":"rs_good","type":"reasoning","encrypted_content":"${valid}","summary":[]},{"id":"msg_1","type":"message","role":"user","content":"hi"}]}`;
  const got = sanitizeOpenAIResponsesReasoningEncryptedContent("test", body);
  expect(has(got, "input.0.encrypted_content")).toBe(false);
  expect(has(got, "input.0.id")).toBe(false);
  expect(has(got, "input.1.id")).toBe(false);
  expect(get(got, "input.2.id")).toBe("rs_good");
  expect(get(got, "input.2.encrypted_content")).toBe(valid);
  expect(get(got, "input.3.id")).toBe("msg_1");
});

test("KeepsIDsWhenStoreEnabled", () => {
  const body = `{"store":true,"input":[{"id":"rs_bad","type":"reasoning","encrypted_content":"bad","summary":[]},{"id":"rs_orphan","type":"reasoning","summary":[]}]}`;
  const got = sanitizeOpenAIResponsesReasoningEncryptedContent("test", body);
  expect(has(got, "input.0.encrypted_content")).toBe(false);
  expect(get(got, "input.0.id")).toBe("rs_bad");
  expect(get(got, "input.1.id")).toBe("rs_orphan");
});

test("MovesCleartextContentToSummary", () => {
  const body = `{"store":false,"input":[{"type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"The model thinking process from a previous turn with a third-party provider..."}],"encrypted_content":null},{"id":"msg_1","type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`;
  const got = sanitizeOpenAIResponsesReasoningEncryptedContent("test", body);
  expectEmptyReasoningContent(got, "input.0.content");
  expect(get(got, "input.0.summary.0.type")).toBe("summary_text");
  expect(get(got, "input.0.summary.0.text")).toBe("The model thinking process from a previous turn with a third-party provider...");
  expect(has(got, "input.0.encrypted_content")).toBe(false);
  expect(get(got, "input.1.content.0.type")).toBe("input_text");
});

test("DoesNotDuplicateExistingSummary", () => {
  const body = `{"store":false,"input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"already summarized"}],"content":[{"type":"reasoning_text","text":"duplicate thinking"}]}]}`;
  const got = sanitizeOpenAIResponsesReasoningEncryptedContent("test", body);
  expectEmptyReasoningContent(got, "input.0.content");
  expect((get(got, "input.0.summary") as unknown[]).length).toBe(1);
  expect(get(got, "input.0.summary.0.text")).toBe("already summarized");
});

test("PromotesMultipleReasoningTextParts", () => {
  const body = `{"store":false,"input":[{"type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"step one"},{"type":"reasoning_text","text":"step two"}]}]}`;
  const got = sanitizeOpenAIResponsesReasoningEncryptedContent("test", body);
  expectEmptyReasoningContent(got, "input.0.content");
  expect((get(got, "input.0.summary") as unknown[]).length).toBe(2);
  expect(get(got, "input.0.summary.0.text")).toBe("step one");
  expect(get(got, "input.0.summary.1.text")).toBe("step two");
});

test("KeepsValidEncryptedContentWhenStrippingContent", () => {
  const valid = validOpenAIResponsesReasoningEncryptedContentForTest();
  const body = `{"store":false,"input":[{"id":"rs_good","type":"reasoning","encrypted_content":"${valid}","summary":[],"content":[{"type":"reasoning_text","text":"cleartext thinking"}]}]}`;
  const got = sanitizeOpenAIResponsesReasoningEncryptedContent("test", body);
  expectEmptyReasoningContent(got, "input.0.content");
  expect(get(got, "input.0.id")).toBe("rs_good");
  expect(get(got, "input.0.encrypted_content")).toBe(valid);
  expect(get(got, "input.0.summary.0.text")).toBe("cleartext thinking");
});

test("NoopReturnsOriginalBody", () => {
  const valid = validOpenAIResponsesReasoningEncryptedContentForTest();
  const body = `{"store":false,"input":[{"id":"rs_good","type":"reasoning","encrypted_content":"${valid}","summary":[]},{"role":"user","content":"hi"}]}`;
  expect(sanitizeOpenAIResponsesReasoningEncryptedContent("test", body)).toBe(body);
});

test("WithCompat preserves reasoning content and id", () => {
  const body = `{"store":false,"input":[{"id":"rs_compat","type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"keep cleartext thinking"}],"encrypted_content":null},{"id":"msg_1","type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`;
  const got = sanitizeOpenAIResponsesReasoningEncryptedContentWithCompat("test", body, true);
  expect(get(got, "input.0.id")).toBe("rs_compat");
  expect(get(got, "input.0.content")).toEqual([{ type: "reasoning_text", text: "keep cleartext thinking" }]);
  expect(get(got, "input.0.summary")).toEqual([]);
  expect(has(got, "input.0.encrypted_content")).toBe(false);
});

test("WithCompat preserves unknown-format encrypted_content", () => {
  const unknownSig = "opaque-encrypted-reasoning-token-xyz";
  const body = `{"store":false,"input":[{"type":"reasoning","summary":[],"content":null,"encrypted_content":"${unknownSig}"},{"type":"reasoning","summary":[],"content":null,"encrypted_content":""},{"type":"reasoning","summary":[],"content":null,"encrypted_content":"${testClaudeCAISSample}"}]}`;
  let got = sanitizeOpenAIResponsesReasoningEncryptedContentWithCompat("test", body, true);
  expect(get(got, "input.0.encrypted_content")).toBe(unknownSig);
  expect(has(got, "input.1.encrypted_content")).toBe(false);
  expect(has(got, "input.2.encrypted_content")).toBe(false);
  got = sanitizeOpenAIResponsesReasoningEncryptedContent("test", body);
  expect(has(got, "input.0.encrypted_content")).toBe(false);
});

test("compat Meta-model target preserves a recognized Muse envelope (Go: ..._ForMeta_PreservesRecognizedMuse, compat half)", () => {
  const metaSig = validMeta();
  const unknownSig = "Q-PaDg-mock-muse-spark-encrypted-reasoning-payload";
  const body = `{"store":false,"input":[{"id":"rs_meta","type":"reasoning","summary":[],"content":null,"encrypted_content":"${metaSig}"},{"id":"rs_unknown","type":"reasoning","summary":[],"content":null,"encrypted_content":"${unknownSig}"},{"id":"rs_claude","type":"reasoning","summary":[],"content":null,"encrypted_content":"${testClaudeCAISSample}"} ]}`;
  const compatMeta = sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModel("test", body, true, "muse-spark-1.3");
  expect(get(compatMeta, "input.0.encrypted_content")).toBe(metaSig);
  expect(has(compatMeta, "input.1.encrypted_content")).toBe(false);
  const compatOther = sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModel("test", body, true, "deepseek-v4");
  expect(has(compatOther, "input.0.encrypted_content")).toBe(false);
});

test("WithCompatModel routed Meta target", () => {
  const native = validMeta();
  const routed = routedMeta();
  const gptSig = validOpenAIResponsesReasoningEncryptedContentForTest();
  const unknownSig = "opaque-encrypted-reasoning-token-xyz";
  const body = `{"store":false,"input":[{"type":"reasoning","summary":[],"encrypted_content":"${native}"},{"type":"reasoning","summary":[],"encrypted_content":"${routed}"},{"type":"reasoning","summary":[],"encrypted_content":"${gptSig}"},{"type":"reasoning","summary":[],"encrypted_content":"${unknownSig}"},{"type":"reasoning","summary":[],"encrypted_content":"${testClaudeCAISSample}"}]}`;
  const assertRouted = (got: string) => {
    expect(get(got, "input.0.encrypted_content")).toBe(native);
    expect(get(got, "input.1.encrypted_content")).toBe(routed);
    for (let i = 2; i < 5; i++) expect(has(got, `input.${i}.encrypted_content`)).toBe(false);
  };
  for (const isCompat of [false, true]) assertRouted(sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", body, isCompat, "meta/muse-wonder", "https://openrouter.ai/api/v1"));
  assertRouted(sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", body, false, "openrouter/meta/muse-wonder", "https://openrouter.ai/api/v1"));
  const other = sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", body, false, "meta/muse-wonder", "https://example-proxy.internal/v1");
  expect(get(other, "input.1.encrypted_content")).toBe(native);
});

test("WithCompatModel strips Meta for non-Meta targets", () => {
  const body = `{"store":false,"input":[{"type":"reasoning","summary":[],"encrypted_content":"${validMeta()}"},{"type":"reasoning","summary":[],"encrypted_content":"${routedMeta()}"}]}`;
  for (const [model, isCompat] of [["gpt-5.4", false], ["deepseek-v4", true]] as const) {
    const got = sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModel("test", body, isCompat, model);
    expect(has(got, "input.0.encrypted_content")).toBe(false);
    expect(has(got, "input.1.encrypted_content")).toBe(false);
  }
});

describe("strips the router suffix on non-OpenRouter upstreams", () => {
  const gptNative = validOpenAIResponsesReasoningEncryptedContentForTest();
  const gptRouted = gptNative + "." + "Ab3".repeat(27).slice(0, 79);
  const body = `{"store":false,"input":[{"type":"reasoning","summary":[],"encrypted_content":"${gptRouted}"}]}`;

  test("official Codex strips, OpenRouter keeps", () => {
    expect(get(sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", body, false, "gpt-5.4", "https://chatgpt.com/backend-api/codex"), "input.0.encrypted_content")).toBe(gptNative);
    expect(get(sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", body, false, "openrouter/openai/o4-mini", "https://openrouter.ai/api/v1"), "input.0.encrypted_content")).toBe(gptRouted);
    // The channel-switch half of the replay-cache sub-check: the same cached item per upstream.
    expect(get(sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", body, false, "o4-mini", "https://openrouter.ai/api/v1"), "input.0.encrypted_content")).toBe(gptRouted);
    expect(get(sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", body, false, "o4-mini", "https://chatgpt.com/backend-api/codex"), "input.0.encrypted_content")).toBe(gptNative);
  });

  test("foreign GPT content is stripped for non-GPT targets", () => {
    for (const model of ["openrouter/x-ai/grok-4.7", "openrouter/google/gemini-3.8-flash"]) {
      expect(has(sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", body, true, model, "https://openrouter.ai/api/v1"), "input.0.encrypted_content")).toBe(false);
    }
  });

  test("cache-prefixed compatible signatures are normalised", () => {
    const prefixed = `{"store":false,"input":[{"type":"reasoning","summary":[],"encrypted_content":"swe#sealed.v1.token"}]}`;
    expect(get(sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL("test", prefixed, true, "devin/swe-2", "https://openrouter.ai/api/v1"), "input.0.encrypted_content")).toBe("sealed.v1.token");
  });
});

test("the Codex executor sanitises reasoning items before sending", async () => {
  const bodies: string[] = [];
  const completed = `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","model":"gpt-5","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(completed, { headers: { "Content-Type": "text/event-stream" } });
  };
  const exec = new CodexExecutor({ fetch: fetchImpl as never });
  const auth = newAuth({ id: "x", provider: "codex", attributes: { api_key: "k", base_url: "http://upstream.invalid" } });
  const payload = `{"model":"gpt-5","store":false,"input":[{"id":"rs_bad","type":"reasoning","encrypted_content":"bad","summary":[],"content":[{"type":"reasoning_text","text":"cleartext"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`;
  await exec.execute(auth, { model: "gpt-5", payload, format: "openai-response" }, { stream: false, sourceFormat: "openai-response" });
  expect(bodies.length).toBe(1);
  const sent = JSON.parse(bodies[0]!);
  const reasoning = sent.input.find((item: { type?: string }) => item.type === "reasoning");
  expect(reasoning.encrypted_content).toBeUndefined();
  expect(reasoning.id).toBeUndefined();
  expect(reasoning.content).toEqual([]);
  expect(reasoning.summary).toEqual([{ type: "summary_text", text: "cleartext" }]);
});
