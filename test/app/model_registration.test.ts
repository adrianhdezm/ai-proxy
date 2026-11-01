// Ported from: sdk/cliproxy/config_model_display_name_test.go, sdk/cliproxy/config_model_max_context_length_test.go,
//   sdk/cliproxy/service_models_config_index_test.go, sdk/cliproxy/service_codex_models_test.go,
//   sdk/cliproxy/service_excluded_models_test.go, sdk/cliproxy/service_excluded_models_priority_test.go,
//   sdk/cliproxy/service_oauth_settings_test.go, sdk/cliproxy/openai_compat_config_models_test.go
// Skipped cases: the vertex and xai rows of TestBuildConfigModelsDisplayName and the interactions and xai rows of
//   TestBuildConfigModelsPropagatesMaxContextLength (families not carried; openai-api-key stands in for
//   openai-compatibility), the MaxContextLength field assertions (ModelInfo keeps contextLength only),
//   TestOpenAICompatibilityRegistrationCacheUsesConfigIndex (openai-compatibility registration cache not carried),
//   TestRegisterModelsForAuth_OpenAICompatibilityImageModelType and the image-model half of
//   TestBuildOpenAICompatibilityConfigModels_InputModalities (image-only compat models not carried),
//   TestRegisterModelsForAuth_OpenAICompatibilityInputModalities (openai-compatibility thinking/output modality
//   defaults not carried; input modalities are covered through openai-api-key),
//   TestRegisterModelsForAuth_AntigravityFetchesWebSearchCapability (antigravity not carried),
//   TestRegisterModelsForAuth_DevinSWE16SlowIncluded (devin not carried),
//   TestApplyOAuthSettings_CodexCatalogPipeline (Codex client model catalog not carried).
// Adapted: TestRegisterModelsForAuth_MetaOAuthAliasAndExcludedModels runs on the codex channel (meta not carried);
//   TestCodexExcludedModelsCredentialPriorityAfterPatchAndReload changes the credential's excluded_models
//   metadata and re-registers through App.registerAuth instead of the management PATCH + auth-file synthesis
//   (Management API and file watcher not carried); Gemini OAuth uses provider "gemini-cli".
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  applyOAuthSettings,
  buildCodexConfigModels,
  buildConfigModels,
  createApp,
  modelsForAuth,
  oauthModelAliasChannel,
  registerAuthModels,
  type App,
} from "../../src/app.ts";
import { resolveConfigEntry } from "../../src/config/auths.ts";
import { defaultConfig } from "../../src/config/load.ts";
import type { ApiKeyCredential, Config, ModelOverride } from "../../src/config/types.ts";
import { newAuth, StatusActive, type Auth } from "../../src/auth/types.ts";
import { ModelRegistry, getCodexProModels, type ModelInfo } from "../../src/registry/index.ts";
import type { PersistingTokenStore } from "../../src/store/index.ts";
import { logLevel, setLogLevel } from "../../src/log.ts";

// createApp sets the process-wide log level from the config; restore it for later test files.
const initialLogLevel = logLevel();
afterAll(() => setLogLevel(initialLogLevel));

class MemoryStore implements PersistingTokenStore {
  readonly kind = "memory";
  async save(auth: Auth): Promise<string> {
    return auth.id;
  }
  async list(): Promise<Auth[]> {
    return [];
  }
  async delete(): Promise<void> {}
}

const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.stop();
});

function model(partial: Partial<ModelOverride> & { name: string }): ModelOverride {
  return { alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false, ...partial };
}

function credential(partial: Partial<ApiKeyCredential> & { apiKey: string }): ApiKeyCredential {
  return { baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

function config(partial: Partial<Config> = {}): Config {
  const cfg = defaultConfig();
  cfg.loggingLevel = "error";
  return Object.assign(cfg, partial);
}

function auth(id: string, provider: string, attributes: Record<string, string> = {}, metadata: Record<string, unknown> = {}): Auth {
  return newAuth({ id, provider, status: StatusActive, attributes, metadata });
}

function idSet(models: ReadonlyArray<ModelInfo>): Set<string> {
  return new Set(models.map((m) => m.id));
}

const imageModels = ["gpt-image-1.5", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5"];

describe("TestBuildConfigModelsDisplayName", () => {
  test("claude", () => {
    expect(buildConfigModels([model({ name: "claude-upstream", alias: "claude-catalog", displayName: "Claude Catalog Name" })], "anthropic", "claude")[0]!.displayName).toBe("Claude Catalog Name");
  });
  test("gemini", () => {
    expect(buildConfigModels([model({ name: "gemini-upstream", alias: "gemini-catalog", displayName: "Gemini Catalog Name" })], "google", "gemini")[0]!.displayName).toBe("Gemini Catalog Name");
  });
  test("codex", () => {
    expect(buildCodexConfigModels([model({ name: "gpt-5.5", alias: "gpt-5.5", displayName: "Codex Catalog Name" })])[0]!.displayName).toBe("Codex Catalog Name");
  });
});

test("TestBuildCodexConfigModelsSelectsDefaultsOrConfiguredModels", () => {
  const configured = buildCodexConfigModels([model({ name: "upstream-codex", alias: "configured-codex" })]);
  expect(configured.map((m) => m.id)).toEqual(["configured-codex"]);
  const defaults = buildCodexConfigModels([]);
  expect(defaults).toHaveLength(getCodexProModels().length);
  const ids = idSet(defaults);
  for (const id of imageModels) expect(ids.has(id), id).toBe(true);
});

test("TestBuildConfigModelsDisplayNameFallback", () => {
  expect(buildConfigModels([model({ name: "claude-upstream", alias: "claude-catalog" })], "anthropic", "claude")[0]!.displayName).toBe("claude-upstream");
});

describe("TestBuildConfigModelsPropagatesMaxContextLength", () => {
  const want = 1048576;
  for (const [name, build] of [
    ["codex", () => buildCodexConfigModels([model({ name: "codex-upstream", alias: "codex-alias", maxContextLength: want })])[0]!],
    ["claude", () => buildConfigModels([model({ name: "claude-upstream", alias: "claude-alias", maxContextLength: want })], "anthropic", "claude")[0]!],
    ["gemini", () => buildConfigModels([model({ name: "gemini-upstream", alias: "gemini-alias", maxContextLength: want })], "google", "gemini")[0]!],
    ["openai compatibility", () => buildConfigModels([model({ name: "compat-upstream", alias: "compat-alias", maxContextLength: want })], "openai", "openai")[0]!],
  ] as const) {
    test(name, () => {
      expect(build().contextLength).toBe(want);
    });
  }
});

test("TestBuildOpenAICompatibilityConfigModels_InputModalities (openai-api-key)", () => {
  const cfg = config({
    openaiApiKeys: [credential({ apiKey: "sk-mimo", models: [model({ name: "upstream-vision", alias: "mimo-v2.5-pro", displayName: "Mimo Vision", inputModalities: ["text", "image"] })] })],
  });
  const models = modelsForAuth(cfg, auth("openai:apikey:mimo", "openai", { api_key: "sk-mimo", auth_kind: "apikey", source: "config:openai[x]", config_index: "0" }));
  expect(models).toHaveLength(1);
  expect(models[0]!.displayName).toBe("Mimo Vision");
  expect(models[0]!.supportedInputModalities?.join(",")).toBe("text,image");
  // The loader lower-cases and de-duplicates the configured modalities.
  expect(buildConfigModels([model({ name: "x", inputModalities: ["text", "image"] })], "openai", "openai")[0]!.supportedInputModalities).toEqual(["text", "image"]);
});

test("TestResolveConfigClaudeKeyUsesConfigIndex", () => {
  const cfg = config({
    claudeApiKeys: [credential({ apiKey: "shared-key", models: [model({ name: "first" })] }), credential({ apiKey: "shared-key", models: [model({ name: "second" })] })],
  });
  const entry = resolveConfigEntry(cfg, auth("claude-shared", "claude", { api_key: "shared-key", source: "config:claude[token-1]", config_index: "1" }));
  expect(entry?.models.map((m) => m.name)).toEqual(["second"]);
});

describe("service_codex_models_test.go", () => {
  const capableID = getCodexProModels().find((m) => m.supportConfigurationUpdate)?.id ?? "";

  test("an OAuth Codex model supports configuration_update", () => {
    expect(capableID).not.toBe("");
  });

  for (const [index, testCase] of [
    { name: "defaults do not inherit OAuth capability", models: [] as ModelOverride[], wantModels: { [capableID]: false } as Record<string, boolean> },
    {
      name: "explicit per-model capability overrides OAuth",
      models: [model({ name: capableID, alias: capableID }), model({ name: capableID, alias: "configured-enabled", supportConfigurationUpdate: true })],
      wantModels: { [capableID]: false, "configured-enabled": true } as Record<string, boolean>,
    },
  ].entries()) {
    test(`TestRegisterModelsForAuthCodexConfigurationUpdate: ${testCase.name}`, () => {
      const registry = new ModelRegistry();
      const apiKey = `config-update-key-${index}`;
      const cfg = config({ codexApiKeys: [credential({ apiKey, models: testCase.models })] });
      registerAuthModels(registry, cfg, auth(`oauth-${index}`, "codex", { plan_type: "pro" }));
      registerAuthModels(registry, cfg, auth(`apikey-${index}`, "codex", { api_key: apiKey, config_index: "0", source: "config:codex:test" }));

      const oauthModel = registry.getModelsForClient(`oauth-${index}`).find((m) => m.id === capableID);
      expect(oauthModel?.supportConfigurationUpdate).toBe(true);

      const seen = new Set<string>();
      for (const m of registry.getModelsForClient(`apikey-${index}`)) {
        if (!(m.id in testCase.wantModels)) continue;
        seen.add(m.id);
        expect(m.supportConfigurationUpdate === true, m.id).toBe(testCase.wantModels[m.id]!);
      }
      for (const id of Object.keys(testCase.wantModels)) expect(seen.has(id), id).toBe(true);
      for (const listed of registry.getAvailableModels("openai")) expect("support_configuration_update" in listed).toBe(false);
    });
  }

  describe("TestRegisterModelsForAuthCodexAPIKeyModels", () => {
    const defaults = getCodexProModels();
    const excludedModelID = defaults[0]!.id;
    for (const [index, tc] of [
      { name: "defaults without explicit models", entry: credential({ apiKey: "default-key" }), want: idSet(defaults), present: imageModels, absent: [] as string[] },
      {
        name: "only explicitly configured models",
        entry: credential({ apiKey: "configured-key", models: [model({ name: "upstream-codex", alias: "configured-codex" })] }),
        want: new Set(["configured-codex"]),
        present: [] as string[],
        absent: imageModels,
      },
      { name: "exclusions apply to defaults", entry: credential({ apiKey: "excluded-key", excludedModels: [excludedModelID] }), want: idSet(defaults.slice(1)), present: [] as string[], absent: [] as string[] },
    ].entries()) {
      test(tc.name, () => {
        const registry = new ModelRegistry();
        const id = `codex-api-key-models-${index}`;
        registerAuthModels(registry, config({ codexApiKeys: [tc.entry] }), auth(id, "codex", { api_key: tc.entry.apiKey, config_index: "0", source: "config:codex:test" }));
        const got = idSet(registry.getModelsForClient(id));
        expect(got).toEqual(tc.want);
        for (const m of tc.present) expect(got.has(m), m).toBe(true);
        for (const m of tc.absent) expect(got.has(m), m).toBe(false);
      });
    }
  });

  describe("TestRegisterModelsForAuthCodexAPIKeyDefaultRequiresConfigMatch", () => {
    const defaultIDs = idSet(getCodexProModels());
    for (const [index, tc] of [
      {
        name: "valid index with unmatched API key",
        cfg: config({ codexApiKeys: [credential({ apiKey: "configured-key" })] }),
        attributes: { api_key: "stale-key", config_index: "0", source: "config:codex:stale" },
        want: new Set<string>(),
      },
      {
        name: "valid index with unmatched base URL",
        cfg: config({ codexApiKeys: [credential({ apiKey: "configured-key", baseUrl: "https://new.example.com" })] }),
        attributes: { api_key: "configured-key", config_index: "0", source: "config:codex:stale", base_url: "https://old.example.com" },
        want: new Set<string>(),
      },
      {
        name: "stale index falls back to matching credentials",
        cfg: config({ codexApiKeys: [credential({ apiKey: "wrong-key", models: [model({ name: "wrong-model" })] }), credential({ apiKey: "configured-key" })] }),
        attributes: { api_key: "configured-key", config_index: "0", source: "config:codex:stale" },
        want: defaultIDs,
      },
      {
        name: "API key ignores OAuth plan type",
        cfg: config({ codexApiKeys: [credential({ apiKey: "configured-key" })] }),
        attributes: { api_key: "configured-key", config_index: "0", source: "config:codex:test", plan_type: "free" },
        want: defaultIDs,
      },
    ].entries()) {
      test(tc.name, () => {
        const registry = new ModelRegistry();
        const id = `codex-api-key-config-match-${index}`;
        registry.registerClient(id, "codex", [{ id: "stale-model", type: "openai" }]);
        registerAuthModels(registry, tc.cfg, auth(id, "codex", tc.attributes as unknown as Record<string, string>));
        expect(idSet(registry.getModelsForClient(id))).toEqual(tc.want);
      });
    }
  });

  describe("TestRegisterConfigAPIKeyAuthsCodexModelModes", () => {
    const defaultIDs = idSet(getCodexProModels());
    for (const [index, tc] of [
      { name: "empty models uses defaults with images", models: [] as ModelOverride[], want: defaultIDs, wantImages: true },
      { name: "configured models replace defaults", models: [model({ name: "runtime-upstream", alias: "runtime-configured" })], want: new Set(["runtime-configured"]), wantImages: false },
    ].entries()) {
      test(tc.name, async () => {
        const registry = new ModelRegistry();
        const cfg = config({ codexApiKeys: [credential({ apiKey: `runtime-key-${index}`, models: tc.models })] });
        const app = await createApp(cfg, { store: new MemoryStore(), registry, executors: [], autoRefresh: false });
        apps.push(app);
        const auths = app.manager.list();
        expect(auths).toHaveLength(1);
        const registered = idSet(registry.getModelsForClient(auths[0]!.id));
        expect(registered).toEqual(tc.want);
        const available = new Set(registry.getAvailableModels("openai").map((m) => m.id as string));
        for (const id of imageModels) {
          expect(registered.has(id), id).toBe(tc.wantImages);
          if (tc.wantImages) expect(available.has(id), id).toBe(true);
        }
      });
    }
  });
});

test("TestRegisterModelsForAuth_CredentialExcludedModelsOverrideGlobal", () => {
  const registry = new ModelRegistry();
  const cfg = config({ oauthExcludedModels: { "gemini-cli": ["gemini-2.5-pro"] } });
  registerAuthModels(registry, cfg, auth("auth-gemini", "gemini-cli", { auth_kind: "oauth", excluded_models: "gemini-2.5-flash" }));
  const models = registry.getAvailableModelsByProvider("gemini-cli");
  expect(models.length).toBeGreaterThan(0);
  const ids = idSet(models);
  expect(ids.has("gemini-2.5-flash")).toBe(false);
  expect(ids.has("gemini-2.5-pro")).toBe(true);
});

test("TestRegisterModelsForAuth_MetaOAuthAliasAndExcludedModels (codex channel)", () => {
  const registry = new ModelRegistry();
  const cfg = config({
    oauthExcludedModels: { codex: ["gpt-5.6-luna"] },
    oauthModelAlias: { codex: [{ name: "gpt-6-sol", alias: "sol-latest", fork: false, displayName: "", forceMapping: false }] },
  });
  registerAuthModels(registry, cfg, auth("auth-codex-oauth", "codex", { auth_kind: "oauth" }, { type: "codex", access_token: "t" }));
  const models = registry.getModelsForClient("auth-codex-oauth");
  expect(models.length).toBeGreaterThan(0);
  const ids = idSet(models);
  expect(ids.has("gpt-5.6-luna")).toBe(false);
  expect(ids.has("gpt-6-sol")).toBe(false);
  expect(ids.has("sol-latest")).toBe(true);
  expect(models.find((m) => m.id === "sol-latest")!.metadataModelId).toBe("gpt-6-sol");
});

test("TestCodexExcludedModelsCredentialPriorityAfterPatchAndReload", async () => {
  const globalModel = "gpt-6-luna";
  const credentialModel = "gpt-6.1-sol";
  const registry = new ModelRegistry();
  const cfg = config({ oauthExcludedModels: { codex: [globalModel] } });
  const app = await createApp(cfg, { store: new MemoryStore(), registry, executors: [], autoRefresh: false });
  apps.push(app);
  const load = (metadata: Record<string, unknown>) => auth("exclusion-priority.json", "codex", {}, { type: "codex", access_token: "t", ...metadata });
  const check = (stage: string, wantGlobal: boolean, wantCredential: boolean) => {
    const present = idSet(registry.getModelsForClient("exclusion-priority.json"));
    expect([present.has(globalModel), present.has(credentialModel)], stage).toEqual([wantGlobal, wantCredential]);
  };
  app.registerAuth(load({}));
  check("global fallback", false, true);
  app.registerAuth(load({ excluded_models: [credentialModel] }));
  check("credential override", true, false);
  app.registerAuth(load({ excluded_models: [] }));
  check("empty fallback", false, true);
  // A later global config change applies to the same credential on the next registration.
  cfg.oauthExcludedModels = { codex: [credentialModel] };
  app.registerAuth(load({ excluded_models: [] }));
  check("updated global fallback", true, false);
});

describe("service_oauth_settings_test.go", () => {
  const settingsConfig = (settings: Config["oauthSettings"]) => config({ oauthSettings: settings });

  test("TestApplyOAuthSettings_MaxContextLength", () => {
    const cfg = settingsConfig({
      codex: [
        { name: "gpt-6-sol", alias: "", maxContextLength: 524288 },
        { name: "deepseek-v4-flash", alias: "", maxContextLength: 1048576 },
      ],
    });
    const out = applyOAuthSettings(cfg, "codex", [
      { id: "gpt-6-sol", type: "openai", contextLength: 272000 },
      { id: "deepseek-v4-flash", type: "openai", contextLength: 272000 },
      { id: "gpt-5-codex", type: "openai", contextLength: 272000 },
    ]);
    expect(out.map((m) => m.contextLength)).toEqual([524288, 1048576, 272000]);
  });

  test("TestApplyOAuthSettings_AliasedModel", () => {
    const cfg = settingsConfig({ codex: [{ name: "gpt-6-sol", alias: "", maxContextLength: 524288 }] });
    const out = applyOAuthSettings(cfg, "codex", [{ id: "custom-sol", metadataModelId: "gpt-6-sol", type: "openai", contextLength: 272000 }]);
    expect(out[0]!.contextLength).toBe(524288);
  });

  test("TestApplyOAuthSettings_MatchedByAlias", () => {
    const cfg = settingsConfig({ codex: [{ name: "gpt-6-sol", alias: "sol-preview", maxContextLength: 524288 }] });
    const out = applyOAuthSettings(cfg, "codex", [
      { id: "sol-preview", type: "openai", contextLength: 272000 },
      { id: "other-model", type: "openai", contextLength: 272000 },
    ]);
    expect(out.map((m) => m.contextLength)).toEqual([524288, 272000]);
  });

  test("TestApplyOAuthSettings_SkipsAPIKey", () => {
    const cfg = settingsConfig({ codex: [{ name: "gpt-6-sol", alias: "", maxContextLength: 524288 }] });
    expect(oauthModelAliasChannel("codex", true)).toBe("");
    const out = applyOAuthSettings(cfg, oauthModelAliasChannel("codex", true), [{ id: "gpt-6-sol", type: "openai", contextLength: 1048576 }]);
    expect(out[0]!.contextLength).toBe(1048576);
    // Through registration: an OAuth credential gets the override, a codex API key keeps its own value.
    cfg.codexApiKeys = [credential({ apiKey: "k", models: [model({ name: "gpt-6-sol", maxContextLength: 1048576 })] })];
    const oauthModels = modelsForAuth(cfg, auth("codex-oauth", "codex", { plan_type: "pro" }));
    expect(oauthModels.find((m) => m.id === "gpt-6-sol")!.contextLength).toBe(524288);
    const keyModels = modelsForAuth(cfg, auth("codex-key", "codex", { api_key: "k", source: "config:codex[k]", config_index: "0" }));
    expect(keyModels.find((m) => m.id === "gpt-6-sol")!.contextLength).toBe(1048576);
  });
});
