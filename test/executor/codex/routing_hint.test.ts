// Ported from: internal/runtime/executor/codex_executor_routing_hint_test.go
// Skipped cases: none.
import { afterAll, describe, expect, test } from "bun:test";
import { type Auth, newAuth } from "../../../src/auth/types.ts";
import { CodexExecutor, applyCodexRoutingHint, codexRoutingHintHeader } from "../../../src/executor/codex/index.ts";
import { drain, getValue, options, startUpstream, sseResponse } from "./helpers.ts";

const upstream = startUpstream((req) => {
  if (req.path === "/responses/compact") {
    return new Response(`{"id":"cmp_1","object":"response.compaction","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`, { headers: { "Content-Type": "application/json" } });
  }
  return sseResponse(
    `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.5","service_tier":"default","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`,
  );
});
afterAll(() => upstream.close());

function captured() {
  const req = upstream.requests[upstream.requests.length - 1]!;
  return { path: req.path, model: getValue(req.body, "model"), serviceTier: getValue(req.body, "service_tier"), hint: req.headers.get(codexRoutingHintHeader) };
}

/** Go: codexOAuthTestAuth. */
function codexOAuthTestAuth(baseURL: string, attributes: Record<string, string> = {}): Auth {
  const attrs: Record<string, string> = { ...attributes };
  if (baseURL !== "") attrs.base_url = baseURL;
  return newAuth({ id: "codex-oauth", provider: "codex", attributes: attrs, metadata: { type: "codex", access_token: "oauth-token", account_id: "acct" } });
}

/** Go: codexAPIKeyTestAuth. */
function codexAPIKeyTestAuth(baseURL: string): Auth {
  const attrs: Record<string, string> = { api_key: "sk-test" };
  if (baseURL !== "") attrs.base_url = baseURL;
  return newAuth({ id: "codex-key", provider: "codex", attributes: attrs });
}

describe("TestCodexExecutorRoutingHintCarriesRequestedTier", () => {
  const fastClaude = `{"model":"gpt-5.5","max_tokens":64,"speed":"fast","messages":[{"role":"user","content":"hi"}]}`;
  const plainClaude = `{"model":"gpt-5.5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`;
  const aliasedClaude = `{"model":"client-alias","max_tokens":64,"speed":"fast","messages":[{"role":"user","content":"hi"}]}`;
  const cases: Array<{ name: string; apiKey?: boolean; stream?: boolean; model?: string; payload: string; wantHint?: string; wantTier?: string }> = [
    { name: "oauth stream fast", stream: true, payload: fastClaude, wantHint: "model=gpt-5.5;tier=priority", wantTier: "priority" },
    { name: "oauth non-stream fast", stream: false, payload: fastClaude, wantHint: "model=gpt-5.5;tier=priority", wantTier: "priority" },
    { name: "oauth stream alias and thinking suffix", stream: true, model: "gpt-5.5(low)", payload: aliasedClaude, wantHint: "model=gpt-5.5;tier=priority", wantTier: "priority" },
    { name: "oauth non-stream alias and thinking suffix", model: "gpt-5.5(low)", payload: aliasedClaude, wantHint: "model=gpt-5.5;tier=priority", wantTier: "priority" },
    { name: "oauth stream standard", stream: true, payload: plainClaude, wantHint: "model=gpt-5.5" },
    { name: "api key keeps body tier without hint", apiKey: true, stream: true, payload: fastClaude, wantTier: "priority" },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const auth = tc.apiKey ? codexAPIKeyTestAuth(upstream.url) : codexOAuthTestAuth(upstream.url);
      const executor = new CodexExecutor();
      const req = { model: tc.model ?? "gpt-5.5", payload: tc.payload, format: "claude" };
      if (tc.stream) {
        const { error } = await drain(await executor.executeStream(auth, req, options("claude", true)));
        expect(error).toBeUndefined();
      } else {
        await executor.execute(auth, req, options("claude", false));
      }
      const got = captured();
      expect(got.model).toBe("gpt-5.5");
      if (tc.wantHint === undefined) expect(got.hint).toBeNull();
      else expect(got.hint).toBe(tc.wantHint);
      if (tc.wantTier === undefined) expect(got.serviceTier).toBeUndefined();
      else expect(got.serviceTier).toBe(tc.wantTier);
    });
  }
});

test("TestCodexExecutorCompactRoutingHintCarriesRequestedTier", async () => {
  await new CodexExecutor().execute(
    codexOAuthTestAuth(upstream.url),
    { model: "gpt-5.5(low)", payload: `{"model":"client-alias","service_tier":"priority","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`, format: "openai-response" },
    options("openai-response", false, { alt: "responses/compact" }),
  );
  const got = captured();
  expect(got.path).toBe("/responses/compact");
  expect(got.model).toBe("gpt-5.5");
  expect(got.serviceTier).toBe("priority");
  expect(got.hint).toBe(`model=${got.model};tier=${got.serviceTier}`);
});

test("TestCodexExecutorOperatorRoutingHintRuleWins", async () => {
  const auth = codexOAuthTestAuth(upstream.url, { "header:X-Codex-Routing-Hint": "model=operator-pinned" });
  const clientHeaders = new Headers({ [codexRoutingHintHeader]: "model=gpt-5.4-client" });
  const result = await new CodexExecutor().executeStream(
    auth,
    { model: "gpt-5.5", payload: `{"model":"gpt-5.5","max_tokens":64,"speed":"fast","messages":[{"role":"user","content":"hi"}]}`, format: "claude" },
    options("claude", true, { headers: clientHeaders }),
  );
  const { error } = await drain(result);
  expect(error).toBeUndefined();
  expect(captured().hint).toBe("model=operator-pinned");
});

describe("TestApplyCodexRoutingHint", () => {
  const oauth = codexOAuthTestAuth("");
  const body = `{"model":"gpt-5.5","service_tier":"priority"}`;

  test("replaces a hint that did not come from an operator rule", () => {
    const headers = new Headers({ [codexRoutingHintHeader]: "model=gpt-5.4-client" });
    applyCodexRoutingHint(headers, oauth, "gpt-5.5", body, undefined);
    expect(headers.get(codexRoutingHintHeader)).toBe("model=gpt-5.5;tier=priority");
  });

  test("keeps the value from an operator auth header rule", () => {
    const operator = codexOAuthTestAuth("", { "header:x-codex-routing-hint": "model=operator" });
    const headers = new Headers({ [codexRoutingHintHeader]: "model=operator" });
    applyCodexRoutingHint(headers, operator, "gpt-5.5", body, undefined);
    expect(headers.get(codexRoutingHintHeader)).toBe("model=operator");
  });

  test("derives the hint when a dynamic operator rule resolves to nothing", () => {
    const operator = codexOAuthTestAuth("", { "header:X-Codex-Routing-Hint": "$X-Operator-Hint" });
    const headers = new Headers({ [codexRoutingHintHeader]: "model=gpt-5.4-client" });
    applyCodexRoutingHint(headers, operator, "gpt-5.5", body, undefined);
    expect(headers.get(codexRoutingHintHeader)).toBe("model=gpt-5.5;tier=priority");
  });

  test("leaves API-key requests untouched", () => {
    const headers = new Headers({ [codexRoutingHintHeader]: "model=client" });
    applyCodexRoutingHint(headers, codexAPIKeyTestAuth(""), "gpt-5.5", body, undefined);
    expect(headers.get(codexRoutingHintHeader)).toBe("model=client");
  });

  test("drops a forwarded hint when the resolved model is empty", () => {
    const headers = new Headers({ [codexRoutingHintHeader]: "model=gpt-5.4-client" });
    applyCodexRoutingHint(headers, oauth, "", body, undefined);
    expect(headers.has(codexRoutingHintHeader)).toBe(false);
  });

  test("ignores a non-string tier", () => {
    const headers = new Headers();
    applyCodexRoutingHint(headers, oauth, "gpt-5.5", `{"model":"gpt-5.5","service_tier":null}`, undefined);
    expect(headers.get(codexRoutingHintHeader)).toBe("model=gpt-5.5");
  });
});
