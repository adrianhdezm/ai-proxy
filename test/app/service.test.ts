// Ported from: sdk/cliproxy/builder_weight_validation_test.go, sdk/cliproxy/service_config_weight_test.go,
//   sdk/cliproxy/service_executor_registration_test.go, sdk/cliproxy/service_stale_state_test.go,
//   sdk/cliproxy/service_stop_test.go
// Skipped cases: TestServiceRejectsInvalidCredentialWeightConfigCommit (hot config reload not carried),
//   TestApplyManagerConfigStopsReplacedServiceAffinitySelector (session-affinity selectors and live selector
//   replacement not carried), TestSyncPluginModelRuntimePreservesSDKExecutorUnlessForced (plugins not carried),
//   TestRegisterExecutorForAuth_OpenAICompatUsesNamespacedProviderKey (kimi and openai-compatibility executors
//   not carried), the plugin-host and dropped-provider (gemini-interactions, vertex, antigravity, kimi, xai,
//   openai-compatibility) rows of TestRegisterAvailableExecutors, TestForceHomeRuntimeConfigEnablesUsageStatistics,
//   TestLifetimeRegistryObservesBarrierFromAppliedHomeConfig, TestApplyHomeOverlayDoesNotApplyWithoutReadyClient
//   (Home mode not carried), TestServiceRun_ShutdownContextFreshAtExit (Go context-driven Service.Run lifecycle;
//   App.stop is the only shutdown path here).
// Adapted: TestWeightedRoundRobinRoutingSelector checks the strategy normalisation and the selector createApp
//   installs for it.
import { afterAll, afterEach, expect, test } from "bun:test";
import { createApp, newRoutingSelector, type App } from "../../src/app.ts";
import { FillFirstSelector, RoundRobinSelector, WeightedRoundRobinSelector } from "../../src/auth/manager/index.ts";
import { newAuth, StatusActive, type Auth } from "../../src/auth/types.ts";
import { MaxCredentialWeight, defaultConfig, parseConfig } from "../../src/config/load.ts";
import type { ApiKeyCredential, Config } from "../../src/config/types.ts";
import { createExecutors } from "../../src/executor/index.ts";
import { ModelRegistry } from "../../src/registry/index.ts";
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

function credential(partial: Partial<ApiKeyCredential> & { apiKey: string }): ApiKeyCredential {
  return { baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

function config(): Config {
  const cfg = defaultConfig();
  cfg.loggingLevel = "error";
  return cfg;
}

async function app(cfg: Config, executors = createExecutors(cfg)): Promise<App> {
  const created = await createApp(cfg, { store: new MemoryStore(), registry: new ModelRegistry(), executors, autoRefresh: false });
  apps.push(created);
  return created;
}

test("TestBuilderBuildRejectsInvalidWithConfigCredentialWeight", async () => {
  const cfg = config();
  cfg.claudeApiKeys = [credential({ apiKey: "claude-key", weight: MaxCredentialWeight + 1 })];
  await expect(createApp(cfg, { store: new MemoryStore(), registry: new ModelRegistry(), executors: [], autoRefresh: false })).rejects.toThrow(
    "validate credential weights: claude-api-key[0].weight",
  );
});

test("TestWeightedRoundRobinRoutingSelector (strategy normalisation and selector choice)", () => {
  const opts = { env: {}, home: "/home/tester", warn: () => {} };
  expect(parseConfig("routing:\n  strategy: wrr\n", opts).routing.strategy).toBe("weighted-round-robin");
  expect(parseConfig("routing:\n  strategy: WeightedRoundRobin\n", opts).routing.strategy).toBe("weighted-round-robin");
  expect(parseConfig("routing:\n  strategy: ff\n", opts).routing.strategy).toBe("fill-first");
  expect(parseConfig("routing:\n  strategy: fillfirst\n", opts).routing.strategy).toBe("fill-first");
  expect(newRoutingSelector("fill-first")).toBeInstanceOf(FillFirstSelector);
  expect(newRoutingSelector("round-robin")).toBeInstanceOf(RoundRobinSelector);
});

test("TestWeightedRoundRobinRoutingSelector: wrr installs the weighted round-robin selector", () => {
  expect(newRoutingSelector("weighted-round-robin")).toBeInstanceOf(WeightedRoundRobinSelector);
});

test("TestRegisterAvailableExecutors (kept providers)", async () => {
  const created = await app(config());
  for (const provider of ["codex", "claude", "gemini-cli", "aistudio", "openai"]) {
    expect(created.manager.executor(provider), provider).toBeDefined();
  }
});

test("TestServiceApplyCoreAuthAddOrUpdate_DeleteReAddDoesNotInheritStaleRuntimeState", async () => {
  const created = await app(config(), []);
  const authID = "service-stale-state-auth";
  const modelID = "stale-model";
  const lastRefreshedAt = Date.UTC(2026, 2, 1, 8);
  const nextRefreshAfter = lastRefreshedAt + 30 * 60_000;
  created.registerAuth(
    newAuth({
      id: authID,
      provider: "claude",
      status: StatusActive,
      lastRefreshedAt,
      nextRefreshAfter,
      modelStates: { [modelID]: { status: StatusActive, unavailable: false, nextRetryAfter: 0, quota: { exceeded: false, nextRecoverAt: 0, backoffLevel: 7 }, updatedAt: lastRefreshedAt } },
    }),
  );

  created.removeAuth(authID);
  expect(created.manager.getById(authID)).toBeUndefined();
  expect(created.registry.getModelsForClient(authID)).toHaveLength(0);

  created.registerAuth(newAuth({ id: authID, provider: "claude", status: StatusActive }));
  const updated = created.manager.getById(authID)!;
  expect(updated).toBeDefined();
  expect(updated.disabled).toBe(false);
  expect(updated.lastRefreshedAt ?? 0).toBe(0);
  expect(updated.nextRefreshAfter ?? 0).toBe(0);
  expect(Object.keys(updated.modelStates ?? {})).toHaveLength(0);
  expect(created.registry.getModelsForClient(authID).length).toBeGreaterThan(0);
});

test("TestServiceShutdown_ViolentShutdownImmediatelyClosesServer", async () => {
  const cfg = config();
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0;
  const created = await app(cfg, []);
  const server = created.start();
  const port = server.port!;
  const conn = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
  try {
    const started = performance.now();
    await created.stop();
    expect(performance.now() - started).toBeLessThan(1000);
    await expect(Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })).rejects.toThrow();
  } finally {
    conn.end();
  }
});
