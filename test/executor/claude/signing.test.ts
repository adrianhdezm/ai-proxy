// Ported from: internal/runtime/executor/claude_signing_test.go
// Skipped cases: none (the Kimi rows of TestClaudeCCHSigningEnabled are kept: they only exercise the origin gate).
import { describe, expect, test } from "bun:test";
import {
  ClaudeCCHUpstreamKind,
  claudeBillingCCHDigitsOffset,
  claudeCCHLength,
  claudeCCHSigningEnabled,
  finalizeAnthropicMessagesBodyCCH,
  normalizeClaudeCCHInput,
  signAnthropicMessagesBody,
} from "../../../src/executor/claude/signing.ts";

const base = `{"model":"model-a","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"},{"type":"text","text":"system-x"}],"tools":[],"metadata":{"user_id":"meta-x"},"max_tokens":1,"thinking":{"type":"adaptive","display":"omitted"},"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"output_config":{"effort":"high"},"stream":true}`;

function cchOf(body: string): string {
  const offset = claudeBillingCCHDigitsOffset(body);
  if (offset === undefined) throw new Error(`billing CCH not found in body: ${body}`);
  return body.slice(offset, offset + claudeCCHLength);
}

const r = (from: string, to: string) => base.replace(from, to);

describe("signAnthropicMessagesBody known vectors (Claude Code 2.1.220)", () => {
  const cases: Array<[string, string, string]> = [
    ["base", base, "7ee87"],
    ["model value ignored", r(`"model":"model-a"`, `"model":"model-b"`), "7ee87"],
    ["max tokens ignored", r(`"max_tokens":1`, `"max_tokens":2`), "7ee87"],
    ["message changes hash", r(`"text":"x"`, `"text":"y"`), "b9cc8"],
    ["system changes hash", r(`"system-x"`, `"system-y"`), "a30d3"],
    ["metadata changes hash", r(`"user_id":"meta-x"`, `"user_id":"meta-y"`), "7a89d"],
    ["thinking changes hash", r(`"thinking":{"type":"adaptive","display":"omitted"}`, `"thinking":{"type":"disabled"}`), "7205c"],
    ["context changes hash", r(`"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`, `"context_management":{"edits":[]}`), "05073"],
    ["effort changes hash", r(`"effort":"high"`, `"effort":"low"`), "12366"],
    ["stream changes hash", r(`"stream":true`, `"stream":false`), "60400"],
    ["tool changes hash", r(`"tools":[]`, `"tools":[{"name":"t","description":"d","input_schema":{"type":"object"}}]`), "3d78d"],
    ["extra field changes hash", r(`"stream":true}`, `"stream":true,"extra_top":"extra"}`), "2d622"],
    [
      "field order remains significant",
      `{"stream":true,"output_config":{"effort":"high"},"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"thinking":{"type":"adaptive","display":"omitted"},"max_tokens":1,"metadata":{"user_id":"meta-x"},"tools":[],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"},{"type":"text","text":"system-x"}],"messages":[{"role":"user","content":[{"type":"text","text":"x"}]}],"model":"model-a"}`,
      "e5b6c",
    ],
    ["nested model value ignored", r(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","model":"a"}`), "0601b"],
    ["nested max tokens member omitted", r(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","max_tokens":2}`), "7ee87"],
    ["top level fallbacks member omitted", r(`"stream":true}`, `"stream":true,"fallbacks":[{"model":"fallback-a"}]}`), "7ee87"],
    ["nested fallbacks member omitted", r(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","fallbacks":[{"model":"nested-a"}]}`), "7ee87"],
    ["top level fallback credit token omitted", r(`"stream":true}`, `"stream":true,"fallback_credit_token":"a"}`), "7ee87"],
    ["nested fallback credit token omitted", r(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","fallback_credit_token":"a"}`), "7ee87"],
    ["trailing dispatch run keeps native comma", r(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","max_tokens":999,"fallbacks":[{"model":"fallback-model"}]}`), "4589b"],
    [
      "model before trailing dispatch run",
      r(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","model":"nested-model","max_tokens":999,"fallbacks":[{"model":"fallback-model"}],"fallback_credit_token":"not-a-real-token"}`),
      "2d312",
    ],
    ["model splits dispatch runs", r(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","max_tokens":999,"model":"nested-model","fallbacks":[{"model":"fallback-model"}]}`), "0601b"],
    ["ordinary nested member remains", r(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","plain":"a"}`), "8d74c"],
    ["billing block only", `{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"}]}`, "f2edb"],
  ];
  for (const [name, body, want] of cases) {
    test(name, () => {
      expect(cchOf(signAnthropicMessagesBody(body))).toBe(want);
    });
  }
});

test("signAnthropicMessagesBody preserves final serialized bytes", () => {
  const literal = "keep literal cch=00000; in the message";
  const body = base.replace(`"text":"x"`, `"text":"${literal}"`);
  const signed = signAnthropicMessagesBody(body);
  expect(JSON.parse(signed).messages[0].content[0].text).toBe(literal);
  const offset = claudeBillingCCHDigitsOffset(signed)!;
  expect(offset).toBeDefined();
  const unsigned = signed.slice(0, offset) + "00000" + signed.slice(offset + claudeCCHLength);
  expect(unsigned).toBe(body);
});

test("finalizeAnthropicMessagesBodyCCH inserts a missing placeholder", () => {
  const body = base.replace(" cch=00000;", "");
  const signed = finalizeAnthropicMessagesBodyCCH(body, "");
  expect(cchOf(signed)).toBe("7ee87");
  expect(JSON.parse(signed).system[0].text).toContain("cc_entrypoint=sdk-cli; cch=7ee87;");
});

test("finalizeAnthropicMessagesBodyCCH adds a missing billing block", () => {
  const body = `{"model":"claude-opus-4-6","system":"keep this system text","messages":[{"role":"user","content":"hello"}],"max_tokens":128}`;
  const fallback = "x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;";
  const signed = finalizeAnthropicMessagesBodyCCH(body, fallback);
  const root = JSON.parse(signed);
  expect(root.system[0].text.startsWith("x-anthropic-billing-header:")).toBe(true);
  expect(root.system[1].text).toBe("keep this system text");
  expect(claudeBillingCCHDigitsOffset(signed)).toBeDefined();
});

describe("claudeCCHSigningEnabled", () => {
  const anthropicOrigin = "https://api.anthropic.com/v1/messages?beta=true";
  const gatewayOrigin = "https://gateway.example/v1/messages?beta=true";
  const A = ClaudeCCHUpstreamKind.Anthropic;
  const cases: Array<[string, string, ClaudeCCHUpstreamKind, boolean, string, boolean]> = [
    ["official API key default", "key-123", A, false, anthropicOrigin, false],
    ["official API key opt-in", "key-123", A, true, anthropicOrigin, true],
    ["Kimi API key default", "key-123", A, false, "https://api.kimi.com/v1/messages", false],
    ["Kimi API key opt-in", "key-123", A, true, "https://api.kimi.com/v1/messages", false],
    ["gateway API key opt-in", "key-123", A, true, gatewayOrigin, false],
    ["anthropic host over http opt-in", "key-123", A, true, "http://api.anthropic.com/v1/messages", false],
    ["anthropic host explicit 443 opt-in", "key-123", A, true, "https://api.anthropic.com:443/v1/messages", true],
    ["anthropic lookalike host opt-in", "key-123", A, true, "https://api.anthropic.com.evil.example/v1/messages", false],
    ["Claude OAuth", "sk-ant-oat-custom", A, false, anthropicOrigin, true],
    ["Claude OAuth custom gateway", "sk-ant-oat-custom", A, false, gatewayOrigin, true],
    ["other provider Claude OAuth", "sk-ant-oat-other", ClaudeCCHUpstreamKind.Other, false, gatewayOrigin, true],
    ["Vertex provider API key", "key-123", ClaudeCCHUpstreamKind.Vertex, false, "https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/anthropic/models/m:streamRawPredict", true],
    ["other provider API key", "key-123", ClaudeCCHUpstreamKind.Other, false, gatewayOrigin, false],
    ["other provider API key opt-in", "key-123", ClaudeCCHUpstreamKind.Other, true, gatewayOrigin, false],
  ];
  for (const [name, apiKey, kind, cli, origin, want] of cases) {
    test(name, () => expect(claudeCCHSigningEnabled(apiKey, kind, cli, origin)).toBe(want));
  }
});

describe("normalizeClaudeCCHInput preserves raw JSON", () => {
  const cases: Array<[string, string, string]> = [
    ["model string becomes empty", `{"model":"claude","keep":1}`, `{"model":"","keep":1}`],
    ["excluded first member", `{"max_tokens":1,"keep":2}`, `{"keep":2}`],
    ["excluded middle member", `{"keep":1,"fallbacks":[{"model":"x"}],"tail":2}`, `{"keep":1,"tail":2}`],
    ["excluded last member", `{"keep":1,"fallback_credit_token":"secret"}`, `{"keep":1}`],
    ["all members excluded", `{"max_tokens":1,"fallbacks":[],"fallback_credit_token":"secret"}`, `{}`],
    ["adjacent excluded members", `{"keep":1,"max_tokens":1,"fallbacks":[],"tail":2}`, `{"keep":1,"tail":2}`],
    ["native trailing dispatch run", `{"keep":1,"max_tokens":1,"fallbacks":[]}`, `{"keep":1,}`],
    ["nested fields", `{"outer":{"model":"x","max_tokens":1,"keep":"y"}}`, `{"outer":{"model":"","keep":"y"}}`],
    ["escaped key text stays inside string", `{"text":"literal \\"model\\":\\"x\\" and \\"max_tokens\\":1"}`, `{"text":"literal \\"model\\":\\"x\\" and \\"max_tokens\\":1"}`],
  ];
  for (const [name, body, want] of cases) {
    test(name, () => expect(normalizeClaudeCCHInput(body)).toBe(want));
  }
});
