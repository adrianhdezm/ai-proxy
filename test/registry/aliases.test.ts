// Ported from: sdk/cliproxy/service_oauth_model_alias_test.go
// Skipped cases: TestApplyOAuthModelAlias_Meta (meta dropped), TestApplyOAuthModelAlias_PluginProvider,
//   TestApplyOAuthModelAlias_PluginProviderSkipsAPIKey, TestApplyOAuthModelAlias_PerAuthAlias
//   (config/auth-channel resolution lives in the config slice; only the alias entry application is ported).
import { expect, test } from "bun:test";
import { applyExcludedModels, applyModelAliases, matchWildcard, type ModelInfo } from "../../src/registry/index.ts";

test("alias rename", () => {
  const out = applyModelAliases([{ id: "gpt-5", type: "openai", name: "models/gpt-5", displayName: "Upstream GPT Five" }], [{ name: "gpt-5", alias: "g5", displayName: "Configured GPT Five" }]);
  expect(out).toHaveLength(1);
  expect(out[0]!.id).toBe("g5");
  expect(out[0]!.name).toBe("models/g5");
  expect(out[0]!.displayName).toBe("Configured GPT Five");
  expect(out[0]!.metadataModelId).toBe("gpt-5");
});

test("fork adds alias", () => {
  const out = applyModelAliases([{ id: "gpt-5", type: "openai", name: "models/gpt-5", displayName: "Upstream GPT Five" }], [{ name: "gpt-5", alias: "g5", fork: true, displayName: "Configured GPT Five" }]);
  expect(out.map((m) => m.id)).toEqual(["gpt-5", "g5"]);
  expect(out[1]!.name).toBe("models/g5");
  expect(out[0]!.displayName).toBe("Upstream GPT Five");
  expect(out[1]!.displayName).toBe("Configured GPT Five");
});

test("preserves upstream display name by default", () => {
  const out = applyModelAliases([{ id: "gpt-5", type: "openai", displayName: "Upstream GPT Five" }], [{ name: "gpt-5", alias: "g5" }]);
  expect(out).toHaveLength(1);
  expect(out[0]!.displayName).toBe("Upstream GPT Five");
});

test("fork adds multiple aliases", () => {
  const out = applyModelAliases(
    [{ id: "gpt-5", type: "openai", name: "models/gpt-5" }],
    [
      { name: "gpt-5", alias: "g5", fork: true },
      { name: "gpt-5", alias: "g5-2", fork: true },
    ],
  );
  expect(out.map((m) => m.id)).toEqual(["gpt-5", "g5", "g5-2"]);
  expect(out[1]!.name).toBe("models/g5");
  expect(out[2]!.name).toBe("models/g5-2");
});

test("preserves metadata model id", () => {
  const models: ModelInfo[] = [
    { id: "gpt-6-astra", type: "openai", name: "models/gpt-6-astra" },
    { id: "gpt-5.6-luna", type: "openai", name: "models/gpt-5.6-luna" },
  ];
  const out = applyModelAliases(models, [
    { name: "gpt-6-astra", alias: "codex-main", fork: true },
    { name: "gpt-5.6-luna", alias: "codex-luna", fork: false },
  ]);
  expect(out).toHaveLength(3);
  const byId = new Map(out.map((m) => [m.id, m]));
  expect(byId.get("gpt-6-astra")).toBeDefined();
  expect(byId.get("codex-main")?.metadataModelId).toBe("gpt-6-astra");
  expect(byId.get("codex-luna")?.metadataModelId).toBe("gpt-5.6-luna");
  expect(byId.has("gpt-5.6-luna")).toBe(false);
});

test("excluded models support wildcards", () => {
  const models: ModelInfo[] = [
    { id: "gpt-6-astra", type: "openai" },
    { id: "gpt-6-sol", type: "openai" },
    { id: "codex-auto-review", type: "openai" },
  ];
  expect(applyExcludedModels(models, ["gpt-6-*"]).map((m) => m.id)).toEqual(["codex-auto-review"]);
  expect(applyExcludedModels(models, ["CODEX-AUTO-REVIEW"]).map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol"]);
  expect(applyExcludedModels(models, [" ", ""]).map((m) => m.id)).toHaveLength(3);
  expect(matchWildcard("*-sol", "gpt-6-sol")).toBe(true);
  expect(matchWildcard("gpt-*-astra", "gpt-6-astra")).toBe(true);
  expect(matchWildcard("gpt-*-luna", "gpt-6-astra")).toBe(false);
  expect(matchWildcard("", "x")).toBe(false);
});
