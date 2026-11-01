// Ported from: sdk/cliproxy/auth/oauth_model_alias_test.go, sdk/cliproxy/auth/api_key_model_alias_test.go
// Ported from: sdk/cliproxy/auth/api_key_model_compat_test.go, sdk/cliproxy/auth/api_key_model_capabilities_test.go
// Ported from: sdk/cliproxy/auth/conductor_oauth_alias_suspension_test.go, sdk/cliproxy/auth/conductor_alias_cooldown_test.go
// Skipped cases: oauth_model_alias rows for the kimi / meta / devin / plugin channels and the antigravity provider are run
// on the kept codex / claude channels (dropped providers); TestOAuthModelAliasChannel_APIKeyOnlyProviderUnsupported is
// inverted here: provider "gemini" is the Gemini CLI OAuth credential in this port and uses the "gemini-cli" channel the
// app registers its aliases under. api_key_model_alias: TestLookupAPIKeyUpstreamModel_InteractionsKey (Interactions API),
// the xai row of TestAPIKeyModelAlias_MultipleProviders (xAI), TestLookupAPIKeyUpstreamModel_MetaKey (Meta).
// api_key_model_capabilities: TestAPIKeyModelRoutingClonesPublishedConfig / ...KeepsOneExecutionSnapshotAcrossReload (Go
// routing snapshot publication; the TS manager reads the config it holds), ...SupportsKeylessOpenAICompatibility
// (openai-compatibility providers not ported), ...BindsUnknownConfiguredCapability and TestSelectedCodexConfigurationUpdate*
// / TestCodexAPIKeyModelIsCompat (Codex configuration-update capability and Home execution overrides not ported).
// conductor_oauth_alias_suspension: the requested-model-alias usage context assertion (Go usage context; the requested
// model rides on ExecOptions.metadata here). conductor_alias_cooldown: the weighted / fill-first rows run with all three
// selectors as upstream; the "select" path checks the selected id only.
// The RequestedModelAlias usage context and SetOAuthModelAlias become config.oauthModelAlias via setConfig.
import { expect, test } from "bun:test";
import {
  FillFirstSelector,
  ModelCooldownError,
  ResolvedAPIKeyModelInfoMetadataKey,
  RoundRobinSelector,
  WeightedRoundRobinSelector,
  applyOAuthModelAlias,
  oauthModelAliasChannel,
  resolveOAuthModelAliasWithResult,
  resolvedAPIKeyModelInfo,
  updateAggregatedAvailability,
  type Selector,
} from "../../../src/auth/manager/index.ts";
import { defaultConfig } from "../../../src/config/load.ts";
import type { ApiKeyCredential, Config, ModelOverride, OAuthModelAlias } from "../../../src/config/types.ts";
import { AttributeWeight, type Auth, type ModelState } from "../../../src/auth/types.ts";
import { Hour, auth, drain, fakeExecutor, newManager, opts, registerModels, rejection, req, statusError, streamOf } from "./helpers.ts";

function aliasConfig(aliases: Record<string, Array<Partial<OAuthModelAlias> & { name: string; alias: string }>>): Config {
  const cfg = defaultConfig();
  cfg.oauthModelAlias = Object.fromEntries(
    Object.entries(aliases).map(([channel, list]) => [channel, list.map((a) => ({ fork: false, displayName: "", forceMapping: false, ...a }))]),
  );
  return cfg;
}

function model(partial: Partial<ModelOverride> & { name: string; alias: string }): ModelOverride {
  return { displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false, ...partial };
}

function key(partial: Partial<ApiKeyCredential> & { apiKey: string }): ApiKeyCredential {
  return { baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

const oauth = (provider: string, extra: Partial<Auth> = {}) => auth({ id: `${provider}-oauth`, provider, attributes: { auth_kind: "oauth" }, ...extra });

// --- oauth_model_alias_test.go ---

test("ResolveOAuthUpstreamModel_SuffixPreservation", () => {
  const cases: Array<{ name: string; aliases: Record<string, Array<{ name: string; alias: string }>>; channel: string; input: string; want: string }> = [
    { name: "numeric suffix preserved", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro" }] }, channel: "codex", input: "gemini-2.5-pro(8192)", want: "gemini-2.5-pro-exp-03-25(8192)" },
    { name: "level suffix preserved", aliases: { claude: [{ name: "claude-sonnet-4-5-20250514", alias: "claude-sonnet-4-5" }] }, channel: "claude", input: "claude-sonnet-4-5(high)", want: "claude-sonnet-4-5-20250514(high)" },
    { name: "no suffix unchanged", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro" }] }, channel: "codex", input: "gemini-2.5-pro", want: "gemini-2.5-pro-exp-03-25" },
    { name: "config suffix takes priority", aliases: { claude: [{ name: "claude-sonnet-4-5-20250514(low)", alias: "claude-sonnet-4-5" }] }, channel: "claude", input: "claude-sonnet-4-5(high)", want: "claude-sonnet-4-5-20250514(low)" },
    { name: "auto suffix preserved", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro" }] }, channel: "codex", input: "gemini-2.5-pro(auto)", want: "gemini-2.5-pro-exp-03-25(auto)" },
    { name: "none suffix preserved", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro" }] }, channel: "codex", input: "gemini-2.5-pro(none)", want: "gemini-2.5-pro-exp-03-25(none)" },
    { name: "case insensitive alias lookup with suffix", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "Gemini-2.5-Pro" }] }, channel: "codex", input: "gemini-2.5-pro(high)", want: "gemini-2.5-pro-exp-03-25(high)" },
    { name: "no alias returns empty", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro" }] }, channel: "codex", input: "unknown-model(high)", want: "" },
    { name: "wrong channel returns empty", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro" }] }, channel: "claude", input: "gemini-2.5-pro(high)", want: "" },
    { name: "empty suffix filtered out", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro" }] }, channel: "codex", input: "gemini-2.5-pro()", want: "gemini-2.5-pro-exp-03-25" },
    { name: "incomplete suffix treated as no suffix", aliases: { codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro(high" }] }, channel: "codex", input: "gemini-2.5-pro(high", want: "gemini-2.5-pro-exp-03-25" },
  ];
  for (const tc of cases) {
    const got = resolveOAuthModelAliasWithResult(aliasConfig(tc.aliases), oauth(tc.channel), tc.input).upstreamModel;
    expect({ name: tc.name, got }).toEqual({ name: tc.name, got: tc.want });
  }
});

test("OAuthModelAliasChannel", () => {
  expect(oauthModelAliasChannel(oauth("codex"))).toBe("codex");
  expect(oauthModelAliasChannel(auth({ id: "a", provider: " Sample-Provider ", attributes: { auth_kind: "oauth" } }))).toBe("sample-provider");
  expect(oauthModelAliasChannel(auth({ id: "a", provider: "sample-provider", attributes: { auth_kind: "api_key" } }))).toBe("");
  expect(oauthModelAliasChannel(oauth("gemini"))).toBe("gemini-cli");
});

test("ApplyOAuthModelAlias_SuffixPreservation", () => {
  const cfg = aliasConfig({ codex: [{ name: "gemini-2.5-pro-exp-03-25", alias: "gemini-2.5-pro" }] });
  expect(applyOAuthModelAlias(cfg, auth({ id: "test-auth-id", provider: "codex" }), "gemini-2.5-pro(8192)")).toBe("gemini-2.5-pro-exp-03-25(8192)");
});

test("ApplyOAuthModelAlias_ForceMappingSameBasePreservesSuffix", () => {
  const cfg = aliasConfig({ codex: [{ name: "gemini-2.5-pro", alias: "gemini-2.5-pro(8192)", forceMapping: true }] });
  expect(applyOAuthModelAlias(cfg, auth({ id: "test-auth-id", provider: "codex" }), "gemini-2.5-pro(8192)")).toBe("gemini-2.5-pro(8192)");
});

test("ApplyOAuthModelAlias_PerAuthForceMappingSameBasePreservesSuffix", () => {
  const target = auth({ id: "test-auth-id", provider: "codex", attributes: { model_aliases: `[{"name":"gemini-2.5-pro","alias":"gemini-2.5-pro(8192)","force-mapping":true}]` } });
  expect(applyOAuthModelAlias(defaultConfig(), target, "gemini-2.5-pro(8192)")).toBe("gemini-2.5-pro(8192)");
});

test("ApplyOAuthModelAlias_PerAuthOverridesGlobalAlias", () => {
  const cfg = aliasConfig({ codex: [{ name: "gpt-5-global", alias: "gpt-5.5" }] });
  const target = auth({ id: "codex-auth-id", provider: "codex", attributes: { auth_kind: "oauth", model_aliases: `[{"name":"gpt-5.3-codex-spark","alias":"gpt-5.5"}]` } });
  expect(applyOAuthModelAlias(cfg, target, "gpt-5.5(high)")).toBe("gpt-5.3-codex-spark(high)");
});

test("ApplyOAuthModelAlias_PerAuthAliasSkipsAPIKey", () => {
  const target = auth({ id: "codex-api-key-auth", provider: "codex", attributes: { auth_kind: "api_key", model_aliases: `[{"name":"gpt-5.3-codex-spark","alias":"gpt-5.5"}]` } });
  expect(applyOAuthModelAlias(defaultConfig(), target, "gpt-5.5")).toBe("gpt-5.5");
});

test("ApplyOAuthModelAlias_PluginProvider (fork + force mapping result on a kept channel)", () => {
  const cfg = aliasConfig({ claude: [{ name: "claude-fable-5-1", alias: "fable-5-1", fork: true, forceMapping: true }] });
  const target = oauth("claude");
  expect(applyOAuthModelAlias(cfg, target, "fable-5-1")).toBe("claude-fable-5-1");
  expect(applyOAuthModelAlias(cfg, target, "fable-5-1(max)")).toBe("claude-fable-5-1(max)");
  expect(resolveOAuthModelAliasWithResult(cfg, target, "fable-5-1(max)")).toEqual({ upstreamModel: "claude-fable-5-1(max)", forceMapping: true, originalAlias: "fable-5-1" });
  const apiKey = auth({ id: "k", provider: "claude", attributes: { auth_kind: "api_key" } });
  expect(applyOAuthModelAlias(cfg, apiKey, "fable-5-1")).toBe("fable-5-1");
});

test("ApplyOAuthModelAliasWithResult_ForceMappingUsesConfigAliasNotRequestSuffix", () => {
  const cfg = aliasConfig({ codex: [{ name: "gpt-5.4", alias: "gpt-5.4-fast", fork: true, forceMapping: true }] });
  const res = resolveOAuthModelAliasWithResult(cfg, auth({ id: "t", provider: "codex" }), "gpt-5.4-fast(high)");
  expect(res.upstreamModel).toBe("gpt-5.4(high)");
  expect(res.originalAlias).toBe("gpt-5.4-fast");
});

test("ApplyOAuthModelAliasWithResultPrefersExactSuffixedAlias", () => {
  const cfg = aliasConfig({ codex: [{ name: "base-upstream", alias: "public", fork: true }, { name: "low-upstream", alias: "public(low)", fork: true, forceMapping: true }] });
  const res = resolveOAuthModelAliasWithResult(cfg, auth({ id: "exact-suffix", provider: "codex" }), "public(low)");
  expect(res.upstreamModel).toBe("low-upstream(low)");
  expect(res.forceMapping).toBe(true);
});

test("ApplyOAuthModelAliasWithResult_NoForceMappingPreservesRequestedModelInOriginalAlias", () => {
  const cfg = aliasConfig({ codex: [{ name: "gpt-5.4", alias: "gpt-5.4-fast", fork: true }] });
  const res = resolveOAuthModelAliasWithResult(cfg, auth({ id: "t", provider: "codex" }), "gpt-5.4-fast(high)");
  expect(res.forceMapping).toBe(false);
  expect(res.originalAlias).toBe("gpt-5.4-fast(high)");
});

// --- api_key_model_alias_test.go ---

function geminiKeyConfig(models: ModelOverride[], extra: Partial<ApiKeyCredential> = {}): Config {
  const cfg = defaultConfig();
  cfg.geminiApiKeys = [key({ apiKey: "k", baseUrl: "https://example.com", models, ...extra })];
  return cfg;
}

test("LookupAPIKeyUpstreamModel", () => {
  const cfg = geminiKeyConfig([model({ name: "gemini-2.5-pro-exp-03-25", alias: "g25p" }), model({ name: "gemini-2.5-flash(low)", alias: "g25f" })]);
  const { manager } = newManager({ config: cfg });
  manager.register(auth({ id: "a1", provider: "gemini", attributes: { api_key: "k", base_url: "https://example.com" } }));
  const cases: Array<[string, string, string, string]> = [
    ["alias with suffix", "a1", "g25p(8192)", "gemini-2.5-pro-exp-03-25(8192)"],
    ["alias without suffix", "a1", "g25p", "gemini-2.5-pro-exp-03-25"],
    ["config suffix priority", "a1", "g25f(high)", "gemini-2.5-flash(low)"],
    ["config suffix no user suffix", "a1", "g25f", "gemini-2.5-flash(low)"],
    ["uppercase alias", "a1", "G25P", "gemini-2.5-pro-exp-03-25"],
    ["mixed case with suffix", "a1", "G25p(4096)", "gemini-2.5-pro-exp-03-25(4096)"],
    ["upstream name direct", "a1", "gemini-2.5-pro-exp-03-25", "gemini-2.5-pro-exp-03-25"],
    ["upstream name with suffix", "a1", "gemini-2.5-pro-exp-03-25(8192)", "gemini-2.5-pro-exp-03-25(8192)"],
    ["non-existent auth", "non-existent", "g25p", ""],
    ["unknown alias", "a1", "unknown-alias", ""],
    ["empty auth ID", "", "g25p", ""],
    ["empty model", "a1", "", ""],
  ];
  for (const [name, id, input, want] of cases) expect({ name, got: manager.lookupAPIKeyUpstreamModel(id, input) }).toEqual({ name, got: want });
});

test("APIKeyModelAlias_ConfigHotReload", () => {
  const { manager } = newManager({ config: geminiKeyConfig([model({ name: "gemini-2.5-pro-exp-03-25", alias: "g25p" })], { baseUrl: "" }) });
  manager.register(auth({ id: "a1", provider: "gemini", attributes: { api_key: "k" } }));
  expect(manager.lookupAPIKeyUpstreamModel("a1", "g25p")).toBe("gemini-2.5-pro-exp-03-25");
  manager.setConfig(geminiKeyConfig([model({ name: "gemini-2.5-flash", alias: "g25p" })], { baseUrl: "" }));
  expect(manager.lookupAPIKeyUpstreamModel("a1", "g25p")).toBe("gemini-2.5-flash");
});

test("APIKeyModelAlias_MultipleProviders", () => {
  const cfg = defaultConfig();
  cfg.geminiApiKeys = [key({ apiKey: "gemini-key", models: [model({ name: "gemini-2.5-pro", alias: "gp" })] })];
  cfg.claudeApiKeys = [key({ apiKey: "claude-key", models: [model({ name: "claude-sonnet-4", alias: "cs4" })] })];
  cfg.codexApiKeys = [key({ apiKey: "codex-key", models: [model({ name: "o3", alias: "o" })] })];
  const { manager } = newManager({ config: cfg });
  manager.register(auth({ id: "gemini-auth", provider: "gemini", attributes: { api_key: "gemini-key" } }));
  manager.register(auth({ id: "claude-auth", provider: "claude", attributes: { api_key: "claude-key" } }));
  manager.register(auth({ id: "codex-auth", provider: "codex", attributes: { api_key: "codex-key" } }));
  expect(manager.lookupAPIKeyUpstreamModel("gemini-auth", "gp")).toBe("gemini-2.5-pro");
  expect(manager.lookupAPIKeyUpstreamModel("claude-auth", "cs4")).toBe("claude-sonnet-4");
  expect(manager.lookupAPIKeyUpstreamModel("codex-auth", "o")).toBe("o3");
});

test("ApplyAPIKeyModelAlias", () => {
  const { manager } = newManager({ config: geminiKeyConfig([model({ name: "gemini-2.5-pro-exp-03-25", alias: "g25p" })], { baseUrl: "" }) });
  const apiKeyAuth = manager.register(auth({ id: "a1", provider: "gemini", attributes: { api_key: "k" } }));
  expect(manager.resolveExecutionModel(apiKeyAuth, "g25p(8192)")).toBe("gemini-2.5-pro-exp-03-25(8192)");
  expect(manager.resolveExecutionModel(auth({ id: "oauth-auth", provider: "claude", attributes: { auth_kind: "oauth" } }), "some-model")).toBe("some-model");
});

test("ResolveAPIKeyModelAliasWithResult_ForceMapping", () => {
  const cfg = defaultConfig();
  cfg.claudeApiKeys = [key({ apiKey: "claude-key", models: [model({ name: "glm-5.2", alias: "claude-sonnet-latest", forceMapping: true })] })];
  const { manager } = newManager({ config: cfg });
  const target = manager.register(auth({ id: "claude-auth", provider: "claude", attributes: { api_key: "claude-key" } }));
  expect(manager.resolveAPIKeyModelAliasWithResult(target, "claude-sonnet-latest")).toEqual({ upstreamModel: "glm-5.2", forceMapping: true, originalAlias: "claude-sonnet-latest" });
  expect(manager.resolveAPIKeyModelAliasWithResult(target, "glm-5.2")).toEqual({ upstreamModel: "glm-5.2", forceMapping: false, originalAlias: "" });
});

test("ResolveAPIKeyModelAliasWithResult_SameBasePreservesSuffix", () => {
  const { manager } = newManager({ config: geminiKeyConfig([model({ name: "gemini-2.5-pro", alias: "gemini-2.5-pro(8192)", forceMapping: true })], { baseUrl: "" }) });
  const target = manager.register(auth({ id: "gemini-auth", provider: "gemini", attributes: { api_key: "k" } }));
  expect(manager.resolveAPIKeyModelAliasWithResult(target, "gemini-2.5-pro(8192)")).toEqual({ upstreamModel: "gemini-2.5-pro(8192)", forceMapping: true, originalAlias: "gemini-2.5-pro(8192)" });
});

test("ResolveAPIKeyModelAliasWithResult_ForceMappingUsesConfigAliasNotRequestSuffix", () => {
  const cfg = defaultConfig();
  cfg.codexApiKeys = [key({ apiKey: "codex-key", models: [model({ name: "gpt-5.5", alias: "claude-sonnet-4-5", forceMapping: true })] })];
  const { manager } = newManager({ config: cfg });
  const target = manager.register(auth({ id: "codex-auth", provider: "codex", attributes: { api_key: "codex-key" } }));
  const result = manager.resolveAPIKeyModelAliasWithResult(target, "claude-sonnet-4-5(high)");
  expect(result.upstreamModel).toBe("gpt-5.5(high)");
  expect(result.originalAlias).toBe("claude-sonnet-4-5");
});

// --- api_key_model_compat_test.go / api_key_model_capabilities_test.go ---

const capabilityAuth = (id: string, apiKey: string) => auth({ id, provider: "claude", prefix: "tenant", attributes: { auth_kind: "api_key", api_key: apiKey, source: "config:claude[0]" } });

test("ResolvedAPIKeyModelInfoPropagatesIsCompat", () => {
  const cfg = defaultConfig();
  cfg.claudeApiKeys = [key({ apiKey: "compat-key", prefix: "tenant", models: [model({ name: "deepseek-upstream", alias: "deepseek-alias", isCompat: true })] })];
  const { manager } = newManager({ config: cfg });
  const target = manager.register(capabilityAuth("compat-auth", "compat-key"));
  const info = resolvedAPIKeyModelInfo(manager.attachResolvedAPIKeyModelInfo(req(""), target, "tenant/deepseek-alias", "deepseek-upstream"));
  expect(info?.isCompat).toBe(true);
});

test("AttachResolvedAPIKeyModelInfoUsesSelectedCredential", () => {
  const cfg = defaultConfig();
  cfg.claudeApiKeys = [
    key({ apiKey: "key-high", prefix: "tenant", models: [model({ name: "shared-upstream", alias: "public-model", thinking: { levels: ["high"] } })] }),
    key({ apiKey: "key-max", prefix: "tenant", models: [model({ name: "shared-upstream", alias: "public-model", thinking: { levels: ["max"] } })] }),
  ];
  const { manager } = newManager({ config: cfg });
  const high = manager.register(capabilityAuth("auth-high", "key-high"));
  const max = manager.register(capabilityAuth("auth-max", "key-max"));
  expect(resolvedAPIKeyModelInfo(manager.attachResolvedAPIKeyModelInfo(req(""), high, "tenant/public-model", "shared-upstream"))?.thinking?.levels).toEqual(["high"]);
  expect(resolvedAPIKeyModelInfo(manager.attachResolvedAPIKeyModelInfo(req(""), max, "tenant/public-model", "shared-upstream"))?.thinking?.levels).toEqual(["max"]);
});

test("AttachResolvedAPIKeyModelInfoUsesExactDuplicateCredentialConfig", () => {
  const cfg = defaultConfig();
  cfg.claudeApiKeys = [
    key({ apiKey: "shared-key", prefix: "tenant", models: [model({ name: "shared-upstream", alias: "public-model", thinking: { levels: ["high"] } })] }),
    key({ apiKey: "shared-key", prefix: "tenant", models: [model({ name: "shared-upstream", alias: "public-model", thinking: { levels: ["max"] } })] }),
  ];
  const { manager } = newManager({ config: cfg });
  const high = capabilityAuth("auth-duplicate-high", "shared-key");
  high.attributes.config_index = "0";
  const max = capabilityAuth("auth-duplicate-max", "shared-key");
  max.attributes.config_index = "1";
  manager.register(high);
  manager.register(max);
  expect(resolvedAPIKeyModelInfo(manager.attachResolvedAPIKeyModelInfo(req(""), high, "tenant/public-model", "shared-upstream"))?.thinking?.levels).toEqual(["high"]);
  expect(resolvedAPIKeyModelInfo(manager.attachResolvedAPIKeyModelInfo(req(""), max, "tenant/public-model", "shared-upstream"))?.thinking?.levels).toEqual(["max"]);
});

test("AttachResolvedAPIKeyModelInfoPrefersExactConfiguredSuffix", () => {
  const cfg = defaultConfig();
  cfg.claudeApiKeys = [
    key({
      apiKey: "key-suffix",
      prefix: "tenant",
      models: [model({ name: "shared-upstream(high)", alias: "public-high", thinking: { levels: ["high"] } }), model({ name: "shared-upstream(low)", alias: "public-low", thinking: { levels: ["low"] } })],
    }),
  ];
  const { manager } = newManager({ config: cfg });
  const target = manager.register(capabilityAuth("auth-suffix", "key-suffix"));
  expect(resolvedAPIKeyModelInfo(manager.attachResolvedAPIKeyModelInfo(req(""), target, "tenant/public-low", "shared-upstream(low)"))?.thinking?.levels).toEqual(["low"]);
  expect(resolvedAPIKeyModelInfo(manager.attachResolvedAPIKeyModelInfo(req(""), target, "tenant/public-high", "shared-upstream(high)"))?.thinking?.levels).toEqual(["high"]);
});

test("Execute sends the resolved upstream model with the bound model info (prefix + API-key alias)", async () => {
  const cfg = defaultConfig();
  cfg.claudeApiKeys = [key({ apiKey: "compat-key", prefix: "tenant", models: [model({ name: "deepseek-upstream", alias: "deepseek-alias", isCompat: true })] })];
  const tm = newManager({ config: cfg });
  const seen: Array<{ model: string; compat: unknown }> = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "claude",
      execute: (_a, r) => {
        seen.push({ model: r.model, compat: (r.metadata?.[ResolvedAPIKeyModelInfoMetadataKey] as { isCompat?: boolean } | undefined)?.isCompat });
        return { payload: r.model };
      },
    }),
  );
  registerModels(tm.registry, "compat-auth", "claude", "tenant/deepseek-alias");
  tm.manager.register(capabilityAuth("compat-auth", "compat-key"));
  await tm.manager.execute(["claude"], req("tenant/deepseek-alias"), opts());
  expect(seen).toEqual([{ model: "deepseek-upstream", compat: true }]);
});

// --- conductor_oauth_alias_suspension_test.go ---

function modelState(partial: Partial<ModelState>): ModelState {
  return { status: "active", unavailable: false, nextRetryAfter: 0, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: 0, ...partial };
}

test("ManagerExecute_OAuthAliasBypassesBlockedRouteModel", async () => {
  const routeModel = "claude-opus-4-6";
  const targetModel = "claude-opus-4-6-thinking";
  const tm = newManager({ config: aliasConfig({ claude: [{ name: targetModel, alias: routeModel, fork: true }] }) });
  const models: string[] = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      identifier: "claude",
      execute: (_a, r) => {
        models.push(r.model);
        return { payload: r.model };
      },
    }),
  );
  registerModels(tm.registry, "oauth-alias-auth", "claude", routeModel, targetModel);
  tm.manager.register(auth({ id: "oauth-alias-auth", provider: "claude", status: "active", modelStates: { [routeModel]: modelState({ unavailable: true, status: "error", nextRetryAfter: tm.clock.now() + Hour }) } }));
  const resp = await tm.manager.execute(["claude"], req(routeModel), opts());
  expect(resp.payload).toBe(targetModel);
  expect(models).toEqual([targetModel]);
});

// --- conductor_alias_cooldown_test.go ---

test("ManagerAliasQuotaFailoverWithUnobservedTargetModel", async () => {
  const selectors: Record<string, () => Selector> = { "round-robin": () => new RoundRobinSelector(), "weighted-round-robin": () => new WeightedRoundRobinSelector(), "fill-first": () => new FillFirstSelector() };
  for (const [name, newSelector] of Object.entries(selectors)) {
    for (const path of ["select", "execute", "stream"] as const) {
      const routeModel = "quota-route";
      const targetModel = "quota-target";
      const otherModel = "quota-other";
      const tm = newManager({ selector: newSelector(), config: aliasConfig({ codex: [{ name: targetModel, alias: routeModel, fork: true }] }) });
      tm.manager.setRetryConfig(3, 30_000, 0);
      const highID = `alias-quota-high-${name}-${path}`;
      const lowID = `alias-quota-low-${name}-${path}`;
      for (const [id, priority] of [[highID, "4"], [lowID, "3"]] as const) {
        registerModels(tm.registry, id, "codex", routeModel, targetModel, otherModel);
        tm.manager.register(auth({ id, provider: "codex", status: "active", attributes: { priority, [AttributeWeight]: "1" } }));
      }
      tm.manager.markResult({ authId: highID, provider: "codex", model: otherModel, success: false, retryAfterMs: Hour, error: { httpStatus: 429, message: "other model rate limit", retryable: false } });
      const high = tm.manager.getById(highID)!;
      expect(high.unavailable).toBe(true);
      expect(high.modelStates?.[targetModel]).toBeUndefined();
      const attempts: string[] = [];
      const upstreamModels: string[] = [];
      const run = (a: Auth, model: string) => {
        attempts.push(a.id);
        upstreamModels.push(model);
        if (a.id === highID) throw statusError(429, "account quota exhausted", { retryAfterMs: Hour, credentialScoped: true });
        return lowID;
      };
      tm.manager.registerExecutor(
        fakeExecutor({
          identifier: "codex",
          execute: (a, r) => ({ payload: run(a, r.model) }),
          stream: (a, r) => streamOf([run(a, r.model)]),
        }),
      );
      if (path === "select") {
        expect(tm.manager.selectAuth(["codex"], routeModel, opts()).auth.id).toBe(highID);
        continue;
      }
      if (path === "execute") {
        expect((await tm.manager.execute(["codex"], req(routeModel), opts())).payload).toBe(lowID);
      } else {
        expect((await drain(await tm.manager.executeStream(["codex"], req(routeModel), opts({ stream: true })))).payload).toBe(lowID);
      }
      expect({ name, path, attempts }).toEqual({ name, path, attempts: [highID, lowID] });
      expect(upstreamModels.every((m) => m === targetModel)).toBe(true);
    }
  }
});

function aliasCooldownManager(id: string, states: Record<string, ModelState>, models: string[]) {
  const requestModel = "gemini-3.6-flash";
  const targetModel = "gemini-3.6-flash-high";
  const tm = newManager({ selector: new RoundRobinSelector(), config: aliasConfig({ codex: [{ name: targetModel, alias: requestModel, fork: true }] }) });
  tm.manager.registerExecutor(fakeExecutor({ identifier: "codex", execute: (_a, r) => ({ payload: r.model }) }));
  const target = auth({ id, provider: "codex", status: "active", modelStates: states });
  updateAggregatedAvailability(target, tm.clock.now());
  tm.manager.register(target);
  registerModels(tm.registry, id, "codex", ...models);
  return { tm, requestModel, targetModel };
}

test("ManagerExecute_ModelAliasRequestNotBlockedByOtherModelQuotaCooldown", async () => {
  const next = Date.parse("2026-10-28T12:00:00Z") + Hour;
  const { tm, requestModel, targetModel } = aliasCooldownManager(
    "alias-auth-1",
    { "gemini-3.6-flash-high": modelState({}), "gemini-3.1-flash-image": modelState({ status: "error", unavailable: true, nextRetryAfter: next, quota: { exceeded: true, reason: "quota", nextRecoverAt: next } }) },
    ["gemini-3.6-flash", "gemini-3.6-flash-high", "gemini-3.1-flash-image"],
  );
  expect((await tm.manager.execute(["codex"], req(requestModel), opts())).payload).toBe(targetModel);
});

test("ManagerSelectAuth_ModelAliasRequestNotBlockedByOtherModelQuotaCooldown", () => {
  const next = Date.parse("2026-10-28T12:00:00Z") + Hour;
  const { tm, requestModel } = aliasCooldownManager(
    "alias-auth-2",
    { "gemini-3.6-flash-high": modelState({}), "gemini-3.1-flash-image": modelState({ status: "error", unavailable: true, nextRetryAfter: next, quota: { exceeded: true, reason: "quota", nextRecoverAt: next } }) },
    ["gemini-3.6-flash", "gemini-3.6-flash-high", "gemini-3.1-flash-image"],
  );
  expect(tm.manager.selectAuth(["codex"], requestModel, opts()).auth.id).toBe("alias-auth-2");
});

test("ManagerExecute_ModelAliasRequestBlockedWhenTargetModelInQuotaCooldown", async () => {
  const next = Date.parse("2026-10-28T12:00:00Z") + Hour;
  const { tm, requestModel } = aliasCooldownManager(
    "alias-auth-3",
    { "gemini-3.6-flash-high": modelState({ status: "error", unavailable: true, nextRetryAfter: next, quota: { exceeded: true, reason: "quota", nextRecoverAt: next } }) },
    ["gemini-3.6-flash", "gemini-3.6-flash-high"],
  );
  const err = await rejection(tm.manager.execute(["codex"], req(requestModel), opts()));
  expect(err).toBeInstanceOf(ModelCooldownError);
  expect((err as ModelCooldownError).model).toBe(requestModel);
});
