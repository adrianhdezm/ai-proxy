// Ported from: internal/config/clone_test.go
// Skipped cases: TestCloneForRuntimeNil (no nil receiver in TS), TestParseConfigBytes_AntigravitySensitiveWords,
//   TestParseConfigBytes_AntigravityConnectionPool (antigravity not carried), plugin/payload/openai-compat/vertex
//   fields of the sample config (not carried); TestCloneForRuntimeDoesNotShareReferenceFields is expressed by
//   mutating every reference-typed field and checking the other copy.
import { expect, test } from "bun:test";
import { cloneConfig, defaultConfig } from "../../src/config/load.ts";
import type { Config } from "../../src/config/types.ts";

function sampleCloneRuntimeConfig(): Config {
  const cfg = defaultConfig();
  cfg.access.apiKeys = ["client-key"];
  cfg.auth.vault.approle = { roleId: "r", secretId: "s" };
  cfg.geminiApiKeys = [
    { apiKey: "gemini-key", baseUrl: "", proxyUrl: "", prefix: "", label: "", priority: 0, models: [{ name: "gemini-upstream", alias: "gemini-upstream-alias", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }], headers: { "X-Gemini": "one" }, excludedModels: ["gemini-hidden"] },
  ];
  cfg.codexApiKeys = [
    { apiKey: "codex-key", baseUrl: "", proxyUrl: "", prefix: "", label: "", priority: 0, models: [{ name: "codex-upstream", alias: "codex-client", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false }], headers: { "X-Codex": "one" }, excludedModels: ["codex-hidden-key"] },
  ];
  cfg.claudeApiKeys = [
    {
      apiKey: "claude-key",
      baseUrl: "",
      proxyUrl: "",
      prefix: "",
      label: "",
      priority: 0,
      models: [{ name: "claude-upstream", alias: "claude-client", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false, thinking: { levels: ["low", "high"] } }],
      headers: { "X-Claude": "one" },
      excludedModels: ["claude-hidden"],
    },
  ];
  return cfg;
}

test("cloneConfig deep copies config", () => {
  const cfg = sampleCloneRuntimeConfig();
  const clone = cloneConfig(cfg);
  expect(clone).not.toBe(cfg);
  expect(clone).toEqual(cfg);

  // Mutate the original; the clone must not change.
  cfg.access.apiKeys[0] = "mutated-client-key";
  cfg.auth.vault.approle!.roleId = "mutated";
  cfg.claudeApiKeys[0]!.models[0]!.thinking!.levels![0] = "mutated-low";
  cfg.claudeApiKeys[0]!.headers["X-Claude"] = "mutated";
  cfg.geminiApiKeys[0]!.excludedModels[0] = "mutated-hidden";
  expect(clone.access.apiKeys[0]).toBe("client-key");
  expect(clone.auth.vault.approle!.roleId).toBe("r");
  expect(clone.claudeApiKeys[0]!.models[0]!.thinking!.levels![0]).toBe("low");
  expect(clone.claudeApiKeys[0]!.headers["X-Claude"]).toBe("one");
  expect(clone.geminiApiKeys[0]!.excludedModels[0]).toBe("gemini-hidden");

  // Mutate the clone; the original keeps its mutated values.
  clone.access.apiKeys[0] = "clone-client-key";
  clone.claudeApiKeys[0]!.models[0]!.thinking!.levels![0] = "clone-low";
  clone.codexApiKeys[0]!.models.push({ name: "extra", alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false });
  expect(cfg.access.apiKeys[0]).toBe("mutated-client-key");
  expect(cfg.claudeApiKeys[0]!.models[0]!.thinking!.levels![0]).toBe("mutated-low");
  expect(cfg.codexApiKeys[0]!.models.length).toBe(1);
});

test("cloneConfig does not share reference fields", () => {
  const cfg = sampleCloneRuntimeConfig();
  const clone = cloneConfig(cfg);
  const pairs: [unknown, unknown][] = [
    [cfg.server, clone.server],
    [cfg.access, clone.access],
    [cfg.access.apiKeys, clone.access.apiKeys],
    [cfg.auth, clone.auth],
    [cfg.auth.vault, clone.auth.vault],
    [cfg.auth.vault.approle, clone.auth.vault.approle],
    [cfg.routing, clone.routing],
    [cfg.routing.retry, clone.routing.retry],
    [cfg.routing.cooldown, clone.routing.cooldown],
    [cfg.requests, clone.requests],
    [cfg.quotaExceeded, clone.quotaExceeded],
    [cfg.claudeApiKeys, clone.claudeApiKeys],
    [cfg.claudeApiKeys[0], clone.claudeApiKeys[0]],
    [cfg.claudeApiKeys[0]!.models, clone.claudeApiKeys[0]!.models],
    [cfg.claudeApiKeys[0]!.models[0]!.thinking, clone.claudeApiKeys[0]!.models[0]!.thinking],
    [cfg.claudeApiKeys[0]!.headers, clone.claudeApiKeys[0]!.headers],
    [cfg.geminiApiKeys[0]!.excludedModels, clone.geminiApiKeys[0]!.excludedModels],
    [cfg.codexApiKeys[0], clone.codexApiKeys[0]],
  ];
  for (const [a, b] of pairs) expect(a).not.toBe(b);
});
