// Ported from: internal/registry/model_registry_safety_test.go
// Skipped cases: TestGetAvailableModelsIncludesMaxContextLengthOverride (MaxContextLength is Codex
//   client-catalog metadata, dropped), TestApplyClientModelCapabilities_UpdatesAllViews,
//   TestMultiClientRegistration_PreservesProbedCapabilities,
//   TestReRegisterClient_ClearsStaleProbedCapabilitiesWhenNoOtherClientSupports (Antigravity
//   web-search capability probing, dropped).
import { expect, test } from "bun:test";
import { ModelRegistry, lookupModelInfo } from "../../src/registry/index.ts";

test("GetModelInfo returns clone", () => {
  const r = new ModelRegistry();
  r.registerClient("client-1", "gemini", [{ id: "m1", type: "gemini", displayName: "Model One", thinking: { min: 1, max: 2, levels: ["low", "high"] } }]);
  const first = r.getModelInfo("m1", "gemini");
  expect(first).toBeDefined();
  first!.displayName = "mutated";
  first!.thinking!.levels![0] = "mutated";
  const second = r.getModelInfo("m1", "gemini");
  expect(second!.displayName).toBe("Model One");
  expect(second!.thinking!.levels![0]).toBe("low");
});

test("GetModelsForClient returns clones", () => {
  const r = new ModelRegistry();
  r.registerClient("client-1", "gemini", [{ id: "m1", type: "gemini", displayName: "Model One", thinking: { levels: ["low", "high"] } }]);
  const first = r.getModelsForClient("client-1");
  expect(first).toHaveLength(1);
  first[0]!.displayName = "mutated";
  first[0]!.thinking!.levels![0] = "mutated";
  const second = r.getModelsForClient("client-1");
  expect(second).toHaveLength(1);
  expect(second[0]!.displayName).toBe("Model One");
  expect(second[0]!.thinking!.levels![0]).toBe("low");
});

test("GetAvailableModelsByProvider returns clones", () => {
  const r = new ModelRegistry();
  r.registerClient("client-1", "gemini", [{ id: "m1", type: "gemini", displayName: "Model One", thinking: { levels: ["low", "high"] } }]);
  const first = r.getAvailableModelsByProvider("gemini");
  expect(first).toHaveLength(1);
  first[0]!.displayName = "mutated";
  first[0]!.thinking!.levels![0] = "mutated";
  const second = r.getAvailableModelsByProvider("gemini");
  expect(second).toHaveLength(1);
  expect(second[0]!.displayName).toBe("Model One");
  expect(second[0]!.thinking!.levels![0]).toBe("low");
});

test("CleanupExpiredQuotas invalidates the available-models cache", () => {
  const clock = { now: 1_700_000_000_000 };
  const r = new ModelRegistry({ now: () => clock.now });
  r.registerClient("client-1", "openai", [{ id: "m1", type: "openai", created: 1 }]);
  r.setModelQuotaExceeded("client-1", "m1");
  expect(r.getAvailableModels("openai")).toHaveLength(1); // cooldown model stays listed

  clock.now += 6 * 60 * 1000;
  r.cleanupExpiredQuotas();

  expect(r.getModelCount("m1")).toBe(1);
  const models = r.getAvailableModels("openai");
  expect(models).toHaveLength(1);
  expect(models[0]!.id).toBe("m1");
});

test("GetAvailableModels returns cloned supported_parameters", () => {
  const r = new ModelRegistry();
  r.registerClient("client-1", "openai", [{ id: "m1", type: "openai", displayName: "Model One", supportedParameters: ["temperature", "top_p"] }]);
  const first = r.getAvailableModels("openai");
  expect(first).toHaveLength(1);
  const params = first[0]!.supported_parameters as string[];
  expect(params).toHaveLength(2);
  params[0] = "mutated";
  const second = r.getAvailableModels("openai");
  expect(second[0]!.supported_parameters).toEqual(["temperature", "top_p"]);
});

test("LookupModelInfo returns clone for static definitions", () => {
  const first = lookupModelInfo("claude-sonnet-4-6");
  expect(first?.thinking?.levels?.length).toBeGreaterThan(0);
  first!.thinking!.levels![0] = "mutated";
  const second = lookupModelInfo("claude-sonnet-4-6");
  expect(second!.thinking!.levels![0]).not.toBe("mutated");
});

test("LookupModelInfo includes Claude Sonnet 5", () => {
  const model = lookupModelInfo("claude-sonnet-5");
  expect(model).toBeDefined();
  expect(model!.type).toBe("claude");
  expect(model!.contextLength).toBe(1000000);
  expect(model!.maxCompletionTokens).toBe(128000);
  expect(model!.thinking).toBeDefined();
  expect(model!.thinking!.zeroAllowed).toBe(true);
  expect(model!.thinking!.dynamicAllowed).toBe(true);
  expect(model!.thinking!.min ?? 0).toBe(0);
  expect(model!.thinking!.max ?? 0).toBe(0);
  expect(model!.thinking!.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
});
