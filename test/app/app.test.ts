// New (no upstream test): createApp wiring — stored OAuth auths and config API keys are loaded into
// the manager, their models registered per provider, and /v1/messages routes end to end through
// fake executors (streaming and non-streaming).
import { expect, test } from "bun:test";
import { applyModelPrefixes, buildConfigModels, createApp, modelsForAuth } from "../../src/app.ts";
import { AttributeAPIKey, type Auth } from "../../src/auth/types.ts";
import { defaultConfig } from "../../src/config/load.ts";
import type { ApiKeyCredential, Config } from "../../src/config/types.ts";
import { StatusError } from "../../src/executor/types.ts";
import { ModelRegistry, getClaudeModels, getCodexModelsForPlan, getGeminiCLIModels } from "../../src/registry/index.ts";
import type { PersistingTokenStore } from "../../src/store/index.ts";
import { chunkStream, fakeExecutor, messagesBody, messagesRequest, testAuth } from "../server/helpers.ts";

class MemoryStore implements PersistingTokenStore {
  readonly kind = "memory";
  readonly saved: Auth[] = [];
  constructor(public items: Auth[] = []) {}
  async save(auth: Auth): Promise<string> {
    this.saved.push(structuredClone(auth));
    return auth.id;
  }
  async list(): Promise<Auth[]> {
    return this.items.map((a) => structuredClone(a));
  }
  async delete(): Promise<void> {}
}

function credential(partial: Partial<ApiKeyCredential> & { apiKey: string }): ApiKeyCredential {
  return { baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

function testConfig(): Config {
  const config = defaultConfig();
  config.loggingLevel = "error";
  config.access.apiKeys = ["sk-proxy"];
  config.claudeApiKeys = [credential({ apiKey: "sk-ant-1", excludedModels: ["claude-3*", "claude-haiku*"] })];
  config.codexApiKeys = [
    credential({
      apiKey: "sk-codex-1",
      prefix: "team",
      models: [{ name: "gpt-5.4", alias: "codex-fast", displayName: "Codex Fast", maxContextLength: 128000, isCompat: false, forceMapping: false }],
    }),
  ];
  return config;
}

const claudeModel = getClaudeModels().find((m) => !m.id.startsWith("claude-haiku") && !m.id.startsWith("claude-3"))!.id;

async function buildApp(executors = [fakeExecutor({ identifier: "claude" }), fakeExecutor({ identifier: "codex" })]) {
  const store = new MemoryStore([
    testAuth({ id: "codex-user.json", provider: "codex", metadata: { plan_type: "free", access_token: "oauth-secret", email: "user@example.com" } }),
    testAuth({ id: "gemini-user.json", provider: "gemini-cli", metadata: { access_token: "oauth-secret-2" } }),
    testAuth({ id: "disabled.json", provider: "claude", disabled: true, status: "disabled", metadata: { access_token: "x" } }),
  ]);
  const registry = new ModelRegistry();
  const app = await createApp(testConfig(), { store, registry, executors, autoRefresh: false });
  return { app, store, registry };
}

test("createApp loads stored auths and config API keys and registers their models per provider", async () => {
  const { app, registry } = await buildApp();
  try {
    const auths = app.manager.list();
    const ids = auths.map((a) => a.id).sort();
    expect(ids).toContain("codex-user.json");
    expect(ids).toContain("gemini-user.json");
    const claudeKey = auths.find((a) => a.provider === "claude" && a.attributes[AttributeAPIKey] === "sk-ant-1");
    const codexKey = auths.find((a) => a.provider === "codex" && a.attributes[AttributeAPIKey] === "sk-codex-1");
    expect(claudeKey).toBeDefined();
    expect(codexKey).toBeDefined();

    // codex OAuth -> plan catalog
    const codexOAuthModels = registry.getModelsForClient("codex-user.json").map((m) => m.id);
    expect(codexOAuthModels).toEqual(getCodexModelsForPlan("free").map((m) => m.id));
    // gemini-cli -> static catalog
    expect(registry.getModelsForClient("gemini-user.json").map((m) => m.id)).toEqual(getGeminiCLIModels().map((m) => m.id));
    // disabled auths publish nothing
    expect(registry.getModelsForClient("disabled.json")).toHaveLength(0);
    // claude API key -> catalog minus excluded patterns
    const claudeKeyModels = registry.getModelsForClient(claudeKey!.id).map((m) => m.id);
    expect(claudeKeyModels.length).toBeGreaterThan(0);
    expect(claudeKeyModels.some((id) => id.startsWith("claude-haiku") || id.startsWith("claude-3"))).toBe(false);
    expect(claudeKeyModels).toContain(claudeModel);
    // codex API key -> configured alias, user defined, with and without the routing prefix
    const codexKeyModels = registry.getModelsForClient(codexKey!.id);
    expect(codexKeyModels.map((m) => m.id).sort()).toEqual(["codex-fast", "team/codex-fast"]);
    const alias = codexKeyModels.find((m) => m.id === "codex-fast")!;
    expect(alias.metadataModelId).toBe("gpt-5.4");
    expect(alias.userDefined).toBe(true);
    expect(alias.displayName).toBe("Codex Fast");
    expect(alias.contextLength).toBe(128000);

    // Provider resolution through the registry.
    expect(registry.getModelProviders(claudeModel)).toEqual(["claude"]);
    expect(registry.getModelProviders("codex-fast")).toEqual(["codex"]);
    expect(registry.getModelProviders("team/codex-fast")).toEqual(["codex"]);

    // The advertised list is what /v1/models returns.
    const advertised = app.models().map((m) => m.id);
    expect(advertised).toContain(claudeModel);
    expect(advertised).toContain("codex-fast");
    expect(app.manager.retrySettings()).toEqual({ requestRetry: 3, maxRetryIntervalMs: 30_000, maxRetryCredentials: 0 });
  } finally {
    await app.stop();
  }
});

test("createApp routes /v1/messages through the executors end to end", async () => {
  const claude = fakeExecutor({
    identifier: "claude",
    execute: async (auth, req) => ({ payload: JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: `via ${auth.id}` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) }),
    stream: async () => chunkStream([`event: message_start\ndata: {"type":"message_start"}\n\n`, `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`, `event: message_stop\ndata: {"type":"message_stop"}\n\n`]),
    count: async () => ({ payload: `{"input_tokens":3}` }),
  });
  const codex = fakeExecutor({
    identifier: "codex",
    execute: async (auth, req) => ({ payload: JSON.stringify({ id: "msg_2", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: `codex ${auth.id}` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) }),
    stream: async () => chunkStream([`event: message_start\ndata: {"type":"message_start"}\n\n`], new StatusError(408, "stream disconnected before completion", { streamTruncated: true })),
  });
  const { app } = await buildApp([claude, codex]);
  try {
    // Missing key -> 401.
    expect((await app.fetch(messagesRequest(claudeModel, false))).status).toBe(401);

    // Non-streaming through the Claude executor (API key auth).
    const response = await app.fetch(messagesRequest(claudeModel, false, { headers: { "x-api-key": "sk-proxy", "anthropic-beta": "beta-1" } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { content: { text: string }[] };
    expect(body.content[0]!.text).toContain("via ");
    expect(claude.executeCalls).toHaveLength(1);
    expect(claude.executeCalls[0]!.model).toBe(claudeModel);
    expect(claude.lastOptions?.headers?.get("anthropic-beta")).toBe("beta-1");
    expect(claude.lastOptions?.headers?.get("x-api-key")).toBeNull();

    // Streaming through the Claude executor.
    const stream = await app.fetch(messagesRequest(claudeModel, true, { headers: { Authorization: "Bearer sk-proxy" } }));
    expect(stream.status).toBe(200);
    expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await stream.text();
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("event: error");

    // count_tokens.
    const count = await app.fetch(messagesRequest(claudeModel, false, { headers: { "x-api-key": "sk-proxy" }, path: "/v1/messages/count_tokens" }));
    expect(count.status).toBe(200);
    expect(((await count.json()) as { input_tokens: number }).input_tokens).toBe(3);

    // The codex alias routes to the codex executor (prefixed and plain), and a truncated stream
    // ends with an api_error frame.
    const aliased = await app.fetch(messagesRequest("team/codex-fast", false, { headers: { "x-api-key": "sk-proxy" } }));
    expect(aliased.status).toBe(200);
    expect(codex.executeCalls[0]!.model).toBe("team/codex-fast");
    const truncated = await app.fetch(messagesRequest("codex-fast", true, { headers: { "x-api-key": "sk-proxy" } }));
    expect(truncated.status).toBe(200);
    const truncatedText = await truncated.text();
    expect(truncatedText).toContain(`event: error\ndata: {"type":"error","error":{"type":"api_error"`);

    // Unknown model -> 404 before any executor runs.
    const unknown = await app.fetch(messagesRequest("gemini-nope", false, { headers: { "x-api-key": "sk-proxy" } }));
    expect(unknown.status).toBe(404);

    // A provider without an executor (gemini-cli) fails with the manager's no-auth error, not a crash.
    const geminiModel = getGeminiCLIModels()[0]!.id;
    const noExecutor = await app.fetch(messagesRequest(geminiModel, false, { headers: { "x-api-key": "sk-proxy" } }));
    expect(noExecutor.status).toBeGreaterThanOrEqual(500);
    const noExecutorBody = (await noExecutor.json()) as { error: { type: string; message: string } };
    expect(noExecutorBody.error.message).toContain(geminiModel);
  } finally {
    await app.stop();
  }
});

test("registerAuth publishes models for a credential added at runtime", async () => {
  const { app, registry } = await buildApp();
  try {
    app.registerAuth(testAuth({ id: "claude-user.json", provider: "claude", metadata: { access_token: "t" } }));
    expect(registry.getModelsForClient("claude-user.json").map((m) => m.id)).toEqual(getClaudeModels().map((m) => m.id));
    expect(app.manager.getById("claude-user.json")).toBeDefined();
  } finally {
    await app.stop();
  }
});

test("modelsForAuth / buildConfigModels / applyModelPrefixes", () => {
  const config = defaultConfig();
  config.openaiApiKeys = [credential({ apiKey: "sk-openai", models: [{ name: "gpt-4.1", alias: "", displayName: "", maxContextLength: 0, isCompat: true, forceMapping: false }] })];
  const openaiAuth = testAuth({ id: "openai:apikey:1", provider: "openai", attributes: { api_key: "sk-openai", source_backend: "config", config_index: "0", auth_kind: "apikey" } });
  const openai = modelsForAuth(config, openaiAuth);
  expect(openai.map((m) => m.id)).toEqual(["gpt-4.1"]);
  expect(openai[0]!.isCompat).toBe(true);
  expect(openai[0]!.displayName).toBe("gpt-4.1");
  // Without configured models an OpenAI key advertises nothing (no static OpenAI channel).
  expect(modelsForAuth(config, testAuth({ id: "openai:apikey:2", provider: "openai", attributes: { api_key: "k", auth_kind: "apikey" } }))).toEqual([]);
  // A codex API key without configured models falls back to the Pro catalog.
  const codexKey = modelsForAuth(config, testAuth({ id: "codex:apikey:1", provider: "codex", attributes: { api_key: "k", auth_kind: "apikey" } }));
  expect(codexKey.length).toBeGreaterThan(0);
  expect(codexKey.every((m) => m.supportConfigurationUpdate === false)).toBe(true);
  // Codex OAuth plan from attributes.
  expect(modelsForAuth(config, testAuth({ id: "c", provider: "codex", attributes: { plan_type: "plus" } })).map((m) => m.id)).toEqual(getCodexModelsForPlan("plus").map((m) => m.id));

  const built = buildConfigModels([{ name: "a", alias: "b", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }, { name: "a", alias: "B", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }, { name: "", alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }], "anthropic", "claude", 1);
  expect(built.map((m) => m.id)).toEqual(["b"]);
  expect(built[0]!.metadataModelId).toBe("a");
  expect(built[0]!.created).toBe(1);

  const prefixed = applyModelPrefixes([{ id: "m1", type: "claude" }, { id: "m1", type: "claude" }], " p ");
  expect(prefixed.map((m) => m.id)).toEqual(["m1", "p/m1"]);
  expect(prefixed[1]!.metadataModelId).toBe("m1");
  expect(applyModelPrefixes([{ id: "m1", type: "claude" }], "").map((m) => m.id)).toEqual(["m1"]);
});
