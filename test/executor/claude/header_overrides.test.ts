// Ported from: internal/runtime/executor/claude_header_overrides_issue5093_test.go
// Ported from: internal/runtime/executor/claude_issue_6193_test.go
// Ported from: internal/runtime/executor/claude_executor_wire_casing_test.go
// Ported from: internal/runtime/executor/claude_executor_native_helper_test.go
// Skipped cases: the YAML parsing of upstream.claude.header-defaults (the Go tests parse config text; here the same
// values are passed as ClaudeExecutorConfig.headerDefaults, whose YAML wiring belongs to the config slice) and the final
// resolveClaudeFingerprintPolicy(...).InjectDiagnostics assertion of TestClaudeExecutor_InjectDiagnosticsDisabledOmits
// DiagnosticsAndCacheDiagnosis (the switch is read from headerDefaults.injectDiagnostics, not a policy field).
// claude_executor_wire_casing_test.go: TestApplyClaudeHeaders_UserAgentStillHoistedByGo (documents Go's net/http
// serializer hoisting User-Agent) and TestClaudeExecutorHasSingleUpstreamSendBoundary (greps the Go sources); the
// serialized-order check of TestApplyClaudeHeaders_WireCasingMatchesRealClient runs on the bytewise-sorted
// applyClaudeWireHeaderCasing tuples, because Bun's fetch lower-cases names on the wire.
// claude_executor_native_helper_test.go: TestClaudeExecutorMinimalNativeHelperPreservesMarkerlessWire,
// TestClaudeExecutorStructuredNativeHelperPreservesStreamProfile, TestClaudeExecutor_Native280HaikuTitleHelperPreserves
// ServerSideFallbackBeta and the "custom base keeps caller id" row of TestApplyClaudeHeadersHelperRequestIDFollowsUpstreamBase
// (the measured Haiku helper native profile - helperProfile - is not ported); the other two rows run on the confirmed
// native path without the helper flag.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import {
  claudeAdvisorToolBeta,
  claudeCacheDiagnosisBeta,
  claudeCodeBeta,
  claudeCodeCLIBetas,
  claudeContext1MBeta,
  claudeExtendedCacheTTLBeta,
  withoutClaudeBeta,
} from "../../../src/executor/claude/betas.ts";
import { claudeBodyNeedsBillingFallback } from "../../../src/executor/claude/signing.ts";
import type { ClaudeHeaderDefaults } from "../../../src/executor/claude/device_profile.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { applyClaudeWireHeaderCasing, claudeWireHeaderCasing } from "../../../src/executor/claude/headers.ts";
import { isClaudeSonnet55Model, isClaudeSonnet5Model, claudeModelUsesProgressDisplay } from "../../../src/executor/claude/model.ts";
import { anthropicMessagesURL, claudeOpts, fakeFetch, headersFor } from "./helpers.ts";

const claudeRaceProbeOAuthKey = "sk-ant-oat-beta-policy";
const oauthAuthForBetaPolicy = () => newAuth({ id: "claude-beta-policy", provider: "claude", metadata: { access_token: claudeRaceProbeOAuthKey } });
const body = `{"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}]}`;
const isUUID = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function oauthHeaders(headerDefaults: ClaudeHeaderDefaults | undefined, stream = false, incoming?: Headers): Headers {
  return headersFor({
    url: anthropicMessagesURL,
    auth: oauthAuthForBetaPolicy(),
    apiKey: claudeRaceProbeOAuthKey,
    stream,
    body,
    cfg: headerDefaults ? { headerDefaults } : undefined,
    incomingHeaders: incoming,
    confirmedClaudeCode: false,
  });
}

describe("claude_header_overrides_issue5093_test.go", () => {
  test("ApplyClaudeHeaders_OperatorBetaStripAndAppend", () => {
    const hd: ClaudeHeaderDefaults = {
      anthropicBetaStrip: [" extended-cache-ttl-2025-04-11 ", "not-emitted-2099-01-01"],
      anthropicBetaAppend: ["context-1m-2025-08-07", "advisor-tool-2026-03-01", "claude-code-20250219", "context-1m-2025-08-07"],
    };
    for (const stream of [false, true]) {
      const derived = oauthHeaders(undefined, stream).get("Anthropic-Beta") ?? "";
      expect(derived).toContain(claudeExtendedCacheTTLBeta);
      expect(derived).not.toContain(claudeContext1MBeta);
      expect(derived).not.toContain(claudeAdvisorToolBeta);
      const want = withoutClaudeBeta(derived, claudeExtendedCacheTTLBeta) + "," + claudeContext1MBeta + "," + claudeAdvisorToolBeta;
      expect(oauthHeaders(hd, stream).get("Anthropic-Beta")).toBe(want);
    }
  });

  test("ApplyClaudeHeaders_OperatorBetaOverridesStableAcrossReapplication", () => {
    const hd: ClaudeHeaderDefaults = { anthropicBetaStrip: ["operator-a-2099-01-01"], anthropicBetaAppend: ["operator-a-2099-01-01", "operator-b-2099-01-01"] };
    const wantSuffix = ",operator-a-2099-01-01,operator-b-2099-01-01";
    expect((oauthHeaders(hd).get("Anthropic-Beta") ?? "").endsWith(wantSuffix)).toBe(true);
    const incoming = new Headers({ "Anthropic-Beta": claudeCodeBeta });
    const caller = headersFor({
      url: anthropicMessagesURL,
      auth: newAuth({ id: "caller", provider: "claude", attributes: { api_key: "key-caller-owned" } }),
      apiKey: "key-caller-owned",
      stream: false,
      body: `{"model":"claude-opus-5"}`,
      cfg: { headerDefaults: hd },
      incomingHeaders: incoming,
      confirmedClaudeCode: false,
    });
    expect(caller.get("Anthropic-Beta")).toBe(claudeCodeBeta + wantSuffix);
  });

  for (const [name, url, wantBetas] of [
    ["custom gateway", "https://gateway.example.com/v1/messages", "credential-beta-2099-01-01"],
    ["anthropic", "https://api.anthropic.com/v1/messages", "operator-beta-2099-01-01"],
  ] as const) {
    test(`ApplyClaudeHeaders_CredentialHeadersKeepPrecedenceOverOperatorDefaults/${name}`, () => {
      const auth = newAuth({
        id: "cred",
        provider: "claude",
        attributes: { api_key: "key-credential-headers", "header:Anthropic-Beta": "credential-beta-2099-01-01", "header:X-Client-Request-Id": "credential-request-id" },
      });
      const h = headersFor({
        url,
        auth,
        apiKey: "key-credential-headers",
        stream: false,
        body: `{"model":"claude-opus-5"}`,
        cfg: { headerDefaults: { anthropicBetaStrip: ["credential-beta-2099-01-01"], anthropicBetaAppend: ["operator-beta-2099-01-01"], clientRequestId: "off" } },
        incomingHeaders: new Headers(),
        confirmedClaudeCode: false,
      });
      expect(h.get("Anthropic-Beta")).toBe(wantBetas);
      expect(h.get("X-Client-Request-Id")).toBe("credential-request-id");
    });
  }

  test("ApplyClaudeHeaders_OperatorBetaStripAppliesToCallerOwnedBetas", () => {
    const incoming = new Headers({ "Anthropic-Beta": claudeCodeBeta + ",fine-grained-tool-streaming-2025-05-14" });
    const h = headersFor({
      url: anthropicMessagesURL,
      auth: newAuth({ id: "caller", provider: "claude", attributes: { api_key: "key-caller-owned" } }),
      apiKey: "key-caller-owned",
      stream: false,
      body: `{"model":"claude-opus-5"}`,
      cfg: { headerDefaults: { anthropicBetaStrip: ["fine-grained-tool-streaming-2025-05-14"] } },
      incomingHeaders: incoming,
      confirmedClaudeCode: false,
    });
    expect(h.get("Anthropic-Beta")).toBe(claudeCodeBeta);
  });

  test("ApplyClaudeHeaders_OperatorBetaStripAllRemovesHeader", () => {
    const stripAll = (oauthHeaders(undefined).get("Anthropic-Beta") ?? "").split(",");
    expect(oauthHeaders({ anthropicBetaStrip: stripAll }).has("Anthropic-Beta")).toBe(false);
  });

  for (const tc of [
    { name: "default execute", hd: undefined, stream: false, inject: true },
    { name: "default stream", hd: undefined, stream: true, inject: true },
    { name: "disabled execute", hd: { injectDiagnostics: false }, stream: false, inject: false },
    { name: "disabled stream", hd: { injectDiagnostics: false }, stream: true, inject: false },
  ]) {
    test(`ClaudeExecutor_InjectDiagnosticsDisabledOmitsDiagnosticsAndCacheDiagnosis/${tc.name}`, async () => {
      const { fetch, requests } = fakeFetch(() => {
        if (tc.stream) {
          return new Response(
            `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_5093","type":"message","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(`{"id":"msg_5093","type":"message","model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`, {
          headers: { "Content-Type": "application/json" },
        });
      });
      const testID = crypto.randomUUID();
      const auth = newAuth({
        id: "diagnostics-disabled-" + testID,
        provider: "claude",
        attributes: { api_key: "sk-ant-oat-diagnostics-disabled", cloak_mode: "always" },
        metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)] },
      });
      const exec = createClaudeExecutor({ fetch, headerDefaults: tc.hd });
      const req = { model: "claude-opus-5", payload: `{"model":"claude-opus-5","messages":[{"role":"user","content":"x"}],"max_tokens":16}`, format: "claude" as const };
      const opts = claudeOpts({ stream: tc.stream, metadata: { execution_session_id: "diagnostics-disabled-" + testID } });
      if (tc.stream) {
        const result = await exec.executeStream(auth, req, opts);
        for await (const _ of result.chunks) {
          // drain
        }
      } else {
        await exec.execute(auth, req, opts);
      }
      expect(requests.length).toBe(1);
      expect(JSON.parse(requests[0]!.body).diagnostics !== undefined).toBe(tc.inject);
      expect((requests[0]!.headers.get("Anthropic-Beta") ?? "").includes(claudeCacheDiagnosisBeta)).toBe(tc.inject);
    });
  }

  describe("ApplyClaudeHeaders_ClientRequestIDModes", () => {
    const callerRequestID = "caller-request-id-5093";
    const withCallerID = () => new Headers({ "X-Client-Request-Id": callerRequestID });
    const cases: Array<{ name: string; mode?: "passthrough" | "off"; apiKey?: boolean; incoming?: Headers; check: (got: string | null) => void }> = [
      { name: "default synthesizes", incoming: withCallerID(), check: (got) => expect(isUUID(got ?? "")).toBe(true) },
      { name: "off omits header", mode: "off", incoming: withCallerID(), check: (got) => expect(got).toBeNull() },
      { name: "passthrough forwards caller value", mode: "passthrough", incoming: withCallerID(), check: (got) => expect(got).toBe(callerRequestID) },
      { name: "passthrough never synthesizes", mode: "passthrough", check: (got) => expect(got).toBeNull() },
      { name: "off removes caller-owned value", mode: "off", apiKey: true, incoming: withCallerID(), check: (got) => expect(got).toBeNull() },
    ];
    for (const tc of cases) {
      test(tc.name, () => {
        const auth = tc.apiKey ? newAuth({ id: "caller", provider: "claude", attributes: { api_key: "key-caller-owned" } }) : oauthAuthForBetaPolicy();
        const h = headersFor({
          url: anthropicMessagesURL,
          auth,
          apiKey: tc.apiKey ? "key-caller-owned" : claudeRaceProbeOAuthKey,
          stream: false,
          body: `{"model":"claude-opus-5"}`,
          cfg: tc.mode ? { headerDefaults: { clientRequestId: tc.mode } } : undefined,
          incomingHeaders: tc.incoming,
          confirmedClaudeCode: false,
        });
        tc.check(h.get("X-Client-Request-Id"));
      });
    }
  });
});

describe("claude_issue_6193_test.go", () => {
  test("Issue6193_Sonnet55ToolChangeBeta", () => {
    for (const model of ["claude-sonnet-5-5", "claude-sonnet-5-5-20261001", "claude-sonnet-5-5[1m]"]) {
      expect(claudeCodeCLIBetas(`{"model":"${model}"}`, undefined, false)).toContain("mid-conversation-tool-changes-2026-07-01");
      expect(isClaudeSonnet5Model(model)).toBe(false);
      expect(isClaudeSonnet55Model(model)).toBe(true);
      expect(claudeModelUsesProgressDisplay(model)).toBe(true);
    }
    for (const model of ["claude-sonnet-5", "claude-sonnet-5-20260401", "claude-sonnet-5[1m]"]) {
      expect(claudeCodeCLIBetas(`{"model":"${model}"}`, undefined, false)).not.toContain("mid-conversation-tool-changes-2026-07-01");
      expect(isClaudeSonnet5Model(model)).toBe(true);
      expect(isClaudeSonnet55Model(model)).toBe(false);
      expect(claudeModelUsesProgressDisplay(model)).toBe(true);
    }
    const reqBody = `{"model":"claude-sonnet-5-5","max_tokens":64,"tools":[{"name":"lookup_notes","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"hello"},{"role":"system","content":[{"type":"tool_removal","tool":{"type":"tool_reference","name":"lookup_notes"}}]}]}`;
    const auth = newAuth({ id: "test-oauth", provider: "claude", metadata: { access_token: "sk-ant-oat-issue-6193" } });
    for (const clientBetas of ["mid-conversation-tool-changes-2026-07-01", ""]) {
      const incoming = new Headers();
      if (clientBetas !== "") incoming.set("Anthropic-Beta", clientBetas);
      const h = headersFor({ url: "https://api.anthropic.com/v1/messages", auth, apiKey: "sk-ant-oat-issue-6193", stream: false, body: reqBody, incomingHeaders: incoming, confirmedClaudeCode: false });
      expect(h.get("Anthropic-Beta") ?? "").toContain("mid-conversation-tool-changes-2026-07-01");
    }
  });
});

describe("claude_executor_wire_casing_test.go", () => {
  const claudeCode2_1_220WireHeaderOrder = [
    "Accept",
    "Authorization",
    "Content-Type",
    "X-Claude-Code-Session-Id",
    "X-Stainless-Arch",
    "X-Stainless-Lang",
    "X-Stainless-OS",
    "X-Stainless-Package-Version",
    "X-Stainless-Retry-Count",
    "X-Stainless-Runtime",
    "X-Stainless-Runtime-Version",
    "X-Stainless-Timeout",
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "anthropic-version",
    "x-app",
    "x-client-request-id",
  ];
  const wireAuth = () => newAuth({ id: "wire", provider: "claude", metadata: { access_token: "sk-ant-oat01-wire" } });
  const probe = (url: string) => {
    const headers = headersFor({ url, auth: wireAuth(), apiKey: "sk-ant-oat01-wire", stream: false, body, confirmedClaudeCode: false });
    return { headers, tuples: applyClaudeWireHeaderCasing(headers, url) };
  };
  const bytewise = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  test("ApplyClaudeHeaders_LeavesHeadersCanonicalForThePipeline", () => {
    const { headers } = probe(anthropicMessagesURL);
    for (const name of Object.keys(claudeWireHeaderCasing)) expect(headers.get(name) ?? "").not.toBe("");
  });

  test("ApplyClaudeHeaders_WireCasingMatchesRealClient", () => {
    const transportOwned = new Set(["Host", "Content-Length", "Connection", "Accept-Encoding", "User-Agent"]);
    const names = probe(anthropicMessagesURL)
      .tuples.map(([name]) => name)
      .filter((name) => !transportOwned.has(name))
      .sort(bytewise);
    expect(names).toEqual(claudeCode2_1_220WireHeaderOrder);
  });

  test("ClaudeWireHeaderOrderIsBytewiseSorted", () => {
    expect([...claudeCode2_1_220WireHeaderOrder].sort(bytewise)).toEqual(claudeCode2_1_220WireHeaderOrder);
  });

  test("ApplyClaudeHeaders_WireCasingIsAnthropicOnly", () => {
    const { headers, tuples } = probe("https://api.moonshot.cn/v1/messages");
    for (const [name] of tuples) expect(["anthropic-beta", "x-app", "X-Stainless-OS"]).not.toContain(name);
    expect(headers.get("Anthropic-Version") ?? "").not.toBe("");
  });

  test("ApplyClaudeHeaders_WireCasingPreservesValues", () => {
    const { headers, tuples } = probe(anthropicMessagesURL);
    const byName = new Map(tuples);
    for (const [canonical, wire] of Object.entries(claudeWireHeaderCasing)) {
      expect(byName.get(wire) ?? "").not.toBe("");
      expect(byName.get(wire)).toBe(headers.get(canonical)!);
    }
  });
});

describe("claude_executor_native_helper_test.go", () => {
  const sessionID = "11111111-2222-4333-8444-555555555555";

  for (const tc of [
    { name: "confirmed native", confirmed: true, wantAsync: "async" },
    { name: "unconfirmed caller default", confirmed: false, wantAsync: "async" },
    { name: "unconfirmed caller profile", confirmed: false, profile: true, wantAsync: null },
  ]) {
    test(`ApplyClaudeHeadersPreservesCallerAsyncWithoutFingerprintOptIn/${tc.name}`, () => {
      const attributes: Record<string, string> = { api_key: "test-api-key" };
      if (tc.profile) attributes.fingerprint_profile = "claude-code-cli";
      const h = headersFor({
        url: anthropicMessagesURL,
        auth: newAuth({ id: "", provider: "claude", attributes }),
        apiKey: "test-api-key",
        stream: true,
        body: `{"model":"claude-haiku-4-5-20251001"}`,
        incomingHeaders: new Headers({ "X-Stainless-Async": "async" }),
        confirmedClaudeCode: tc.confirmed,
        sessionID,
      });
      expect(h.get("X-Stainless-Async")).toBe(tc.wantAsync);
    });
  }

  test("ClaudeBodyNeedsBillingFallbackTracksSystemPresence", () => {
    expect(claudeBodyNeedsBillingFallback(`{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"probe"}]}`)).toBe(false);
    expect(claudeBodyNeedsBillingFallback(`{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=cli; cch=00000;"}]}`)).toBe(true);
    expect(claudeBodyNeedsBillingFallback(`{"system":[{"type":"text","text":"injected by a payload rule"}]}`)).toBe(true);
    expect(claudeBodyNeedsBillingFallback(`{"system":"injected by a payload rule"}`)).toBe(true);
  });

  for (const tc of [
    { name: "first party base without caller id", url: "https://api.anthropic.com/v1/messages?beta=true", generated: true },
    { name: "custom base without caller id", url: "https://gateway.example.com/v1/messages", generated: false },
  ]) {
    test(`ApplyClaudeHeadersHelperRequestIDFollowsUpstreamBase/${tc.name}`, () => {
      const h = headersFor({
        url: tc.url,
        auth: newAuth({ id: "", provider: "claude", attributes: { api_key: "test-api-key" } }),
        apiKey: "test-api-key",
        stream: false,
        body: `{"model":"claude-haiku-4-5-20251001"}`,
        incomingHeaders: new Headers(),
        confirmedClaudeCode: true,
        sessionID,
      });
      const got = h.get("X-Client-Request-Id");
      if (tc.generated) expect(isUUID(got ?? "")).toBe(true);
      else expect(got).toBeNull();
    });
  }
});
