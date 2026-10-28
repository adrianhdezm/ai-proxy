// Ported from: internal/watcher/synthesizer/config_test.go
// Skipped cases: TestNewConfigSynthesizer (no struct), TestConfigSynthesizer_InteractionsKeys, _XAIKeys,
//   _XAIKeys_AllowsEmptyAPIKeyWithBaseURL, _MetaKeys, _OpenAICompat*, _VertexCompat* (families not carried);
//   claude rebuild-mid-system-message / native-tool-search / fingerprint-profile and codex websockets /
//   alpha-search / disable-codex-cloaking attribute assertions (features not carried).
import { describe, expect, test } from "bun:test";
import { AttributeAuthKind, AttributeConfigIndex, AttributeRuntimeOnly, AttributeSourceBackend, AuthSourceConfig, StatusActive, type Auth } from "../../src/auth/types.ts";
import { StableIDGenerator, modelOverridesFor, synthesizeApiKeyAuths } from "../../src/config/auths.ts";
import { defaultConfig } from "../../src/config/load.ts";
import type { ApiKeyCredential, Config } from "../../src/config/types.ts";

function key(partial: Partial<ApiKeyCredential>): ApiKeyCredential {
  return { apiKey: "", baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

function configWith(partial: Partial<Config>): Config {
  return { ...defaultConfig(), ...partial };
}

const fixedNow = () => Date.UTC(2025, 0, 1);

test("Synthesize nil config", () => {
  expect(synthesizeApiKeyAuths(undefined)).toEqual([]);
  expect(synthesizeApiKeyAuths(null)).toEqual([]);
});

describe("GeminiKeys", () => {
  const cases: { name: string; geminiKeys: ApiKeyCredential[]; wantLen: number; validate?: (auths: Auth[]) => void }[] = [
    {
      name: "single gemini key",
      geminiKeys: [key({ apiKey: "test-key-123", prefix: "team-a" })],
      wantLen: 1,
      validate: (auths) => {
        expect(auths[0]!.provider).toBe("aistudio");
        expect(auths[0]!.prefix).toBe("team-a");
        expect(auths[0]!.label).toBe("gemini-apikey");
        expect(auths[0]!.attributes.api_key).toBe("test-key-123");
        expect(auths[0]!.metadata).toEqual({});
        expect(auths[0]!.status).toBe(StatusActive);
      },
    },
    {
      name: "gemini key disable cooling",
      geminiKeys: [key({ apiKey: "test-key-123", prefix: "team-a", disableCooling: true })],
      wantLen: 1,
      validate: (auths) => expect(auths[0]!.metadata.disable_cooling).toBe(true),
    },
    {
      name: "gemini key with base url and proxy",
      geminiKeys: [key({ apiKey: "api-key", baseUrl: "https://custom.api.com", proxyUrl: "http://proxy.local:8080", prefix: "custom" })],
      wantLen: 1,
      validate: (auths) => {
        expect(auths[0]!.attributes.base_url).toBe("https://custom.api.com");
        expect(auths[0]!.proxyUrl).toBe("http://proxy.local:8080");
      },
    },
    {
      name: "gemini key with headers",
      geminiKeys: [key({ apiKey: "api-key", headers: { "X-Custom": "value" } })],
      wantLen: 1,
      validate: (auths) => expect(auths[0]!.attributes["header:X-Custom"]).toBe("value"),
    },
    { name: "empty api key skipped", geminiKeys: [key({ apiKey: "" }), key({ apiKey: "  " }), key({ apiKey: "valid-key" })], wantLen: 1 },
    { name: "multiple gemini keys", geminiKeys: [key({ apiKey: "key-1", prefix: "a" }), key({ apiKey: "key-2", prefix: "b" }), key({ apiKey: "key-3", prefix: "c" })], wantLen: 3 },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const auths = synthesizeApiKeyAuths(configWith({ geminiApiKeys: tt.geminiKeys }), { now: fixedNow, idGenerator: new StableIDGenerator() });
      expect(auths.length).toBe(tt.wantLen);
      if (tt.validate && auths.length > 0) tt.validate(auths);
      for (const auth of auths) {
        expect(auth.createdAt).toBe(fixedNow());
        expect(auth.updatedAt).toBe(fixedNow());
      }
    });
  }
});

test("ClaudeKeys", () => {
  const auths = synthesizeApiKeyAuths(
    configWith({
      claudeApiKeys: [
        key({
          apiKey: "sk-ant-api-xxx",
          prefix: "main",
          baseUrl: "https://api.anthropic.com",
          disableCooling: true,
          models: [
            { name: "claude-3-opus", alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false },
            { name: "claude-3-sonnet", alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false },
          ],
        }),
      ],
    }),
  );
  expect(auths.length).toBe(1);
  expect(auths[0]!.provider).toBe("claude");
  expect(auths[0]!.label).toBe("claude-apikey");
  expect(auths[0]!.prefix).toBe("main");
  expect(auths[0]!.attributes.api_key).toBe("sk-ant-api-xxx");
  expect(auths[0]!.attributes[AttributeConfigIndex]).toBe("0");
  expect("models_hash" in auths[0]!.attributes).toBe(true);
  expect(auths[0]!.metadata.disable_cooling).toBe(true);
});

test("ClaudeKeys skips empty and headers", () => {
  const auths = synthesizeApiKeyAuths(
    configWith({ claudeApiKeys: [key({ apiKey: "" }), key({ apiKey: "   " }), key({ apiKey: "valid-key", headers: { "X-Custom": "value" } })] }),
  );
  expect(auths.length).toBe(1);
  expect(auths[0]!.attributes["header:X-Custom"]).toBe("value");
});

test("ClaudeKeys allows empty API key with base URL", () => {
  const auths = synthesizeApiKeyAuths(configWith({ claudeApiKeys: [key({ apiKey: "", baseUrl: "https://gateway.example.com", headers: { "Custom-Auth": "secret" } })] }));
  expect(auths.length).toBe(1);
  expect(auths[0]!.attributes.base_url).toBe("https://gateway.example.com");
  expect(auths[0]!.attributes["header:Custom-Auth"]).toBe("secret");
  expect(auths[0]!.attributes[AttributeAuthKind]).toBe("apikey");
  expect("api_key" in auths[0]!.attributes).toBe(false);
});

test("CodexKeys", () => {
  const auths = synthesizeApiKeyAuths(
    configWith({ codexApiKeys: [key({ apiKey: "codex-key-123", prefix: "dev", baseUrl: "https://api.openai.com", proxyUrl: "http://proxy.local", disableCooling: true })] }),
  );
  expect(auths.length).toBe(1);
  expect(auths[0]!.provider).toBe("codex");
  expect(auths[0]!.label).toBe("codex-apikey");
  expect(auths[0]!.proxyUrl).toBe("http://proxy.local");
  expect(auths[0]!.metadata.disable_cooling).toBe(true);
});

test("CodexKeys skips empty and headers", () => {
  const auths = synthesizeApiKeyAuths(
    configWith({ codexApiKeys: [key({ apiKey: "" }), key({ apiKey: "  " }), key({ apiKey: "valid-key", headers: { Authorization: "Bearer xyz" } })] }),
  );
  expect(auths.length).toBe(1);
  expect(auths[0]!.attributes["header:Authorization"]).toBe("Bearer xyz");
});

test("CodexKeys allows empty API key with base URL", () => {
  const auths = synthesizeApiKeyAuths(
    configWith({
      codexApiKeys: [
        key({ apiKey: "", baseUrl: "https://custom-codex.example.com", headers: { "Custom-Auth": "secret" } }),
        key({ apiKey: "   ", baseUrl: "https://custom-codex-2.example.com" }),
      ],
    }),
  );
  expect(auths.length).toBe(2);
  expect(auths[0]!.attributes.base_url).toBe("https://custom-codex.example.com");
  expect(auths[0]!.attributes["header:Custom-Auth"]).toBe("secret");
  expect(auths[0]!.attributes[AttributeAuthKind]).toBe("apikey");
  expect("api_key" in auths[0]!.attributes).toBe(false);
});

test("GeminiKeys allows empty API key with base URL", () => {
  const auths = synthesizeApiKeyAuths(configWith({ geminiApiKeys: [key({ apiKey: "", baseUrl: "https://custom-gemini.example.com" })] }));
  expect(auths.length).toBe(1);
  expect(auths[0]!.attributes.base_url).toBe("https://custom-gemini.example.com");
  expect("api_key" in auths[0]!.attributes).toBe(false);
});

// New (no upstream test): openai family, deterministic ids, ordering, weight/priority/excluded models.
describe("port specifics", () => {
  test("openai keys, ordering and deterministic ids across runs", () => {
    const cfg = configWith({
      openaiApiKeys: [key({ apiKey: "sk-openai", baseUrl: "https://api.openai.com/v1", label: "primary" })],
      claudeApiKeys: [key({ apiKey: "sk-ant" })],
      codexApiKeys: [key({ apiKey: "sk-codex", baseUrl: "https://chatgpt.com/backend-api/codex" })],
      geminiApiKeys: [key({ apiKey: "AIza" })],
    });
    const first = synthesizeApiKeyAuths(cfg, { now: fixedNow });
    const second = synthesizeApiKeyAuths(cfg, { now: fixedNow });
    expect(first.map((a) => a.provider)).toEqual(["aistudio", "claude", "codex", "openai"]);
    expect(first.map((a) => a.id)).toEqual(second.map((a) => a.id));
    expect(first[0]!.id).toMatch(/^gemini:apikey:[0-9a-f]{12}$/);
    expect(first[3]!.id).toMatch(/^openai:apikey:[0-9a-f]{12}$/);
    expect(first[3]!.label).toBe("primary");
    expect(first[3]!.attributes.source).toBe(`config:openai[${first[3]!.id.split(":")[2]}]`);
    expect(first[3]!.attributes[AttributeSourceBackend]).toBe(AuthSourceConfig);
    expect(first[3]!.attributes[AttributeRuntimeOnly]).toBe("true");
    // Changing the key changes the id; identical duplicates get a -1 suffix.
    cfg.openaiApiKeys.push(key({ apiKey: "sk-openai", baseUrl: "https://api.openai.com/v1" }), key({ apiKey: "sk-other" }));
    const third = synthesizeApiKeyAuths(cfg, { now: fixedNow });
    expect(third[4]!.id).toBe(`${first[3]!.id}-1`);
    expect(third[5]!.id).not.toBe(first[3]!.id);
  });

  test("weight, priority, request-retry and excluded models", () => {
    const auths = synthesizeApiKeyAuths(
      configWith({
        claudeApiKeys: [
          key({ apiKey: "a", weight: -5, priority: 3, requestRetry: 0, excludedModels: ["Claude-3-*", "*haiku*", "claude-3-*"] }),
          key({ apiKey: "b", weight: 7, requestRetry: -1 }),
        ],
      }),
    );
    expect(auths[0]!.attributes.weight).toBe("0");
    expect(auths[0]!.attributes.priority).toBe("3");
    expect(auths[0]!.metadata).toEqual({ request_retry: 0 });
    expect(auths[0]!.attributes.excluded_models).toBe("*haiku*,claude-3-*");
    expect(auths[0]!.attributes.excluded_models_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(auths[1]!.attributes.weight).toBe("7");
    expect("priority" in auths[1]!.attributes).toBe(false);
    expect(auths[1]!.metadata).toEqual({});
    expect("excluded_models" in auths[1]!.attributes).toBe(false);
  });

  test("invalid weights are rejected before synthesis", () => {
    expect(() => synthesizeApiKeyAuths(configWith({ geminiApiKeys: [key({ apiKey: "a", weight: 1.5 })] }))).toThrow("gemini-api-key[0].weight");
  });

  test("modelOverridesFor resolves overrides by provider and config index", () => {
    const models = [{ name: "gpt-5", alias: "latest", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }];
    const cfg = configWith({ openaiApiKeys: [key({ apiKey: "a" }), key({ apiKey: "b", models })] });
    const auths = synthesizeApiKeyAuths(cfg);
    expect(modelOverridesFor(cfg, auths[0]!)).toEqual([]);
    expect(modelOverridesFor(cfg, auths[1]!)).toEqual(models);
    const oauth = { ...auths[1]!, attributes: { ...auths[1]!.attributes, source_backend: "file" } };
    expect(modelOverridesFor(cfg, oauth)).toEqual([]);
  });
});
