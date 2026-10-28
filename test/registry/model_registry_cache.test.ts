// Ported from: internal/registry/model_registry_cache_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { DefaultClaudeMaxInputTokens, DefaultClaudeMaxOutputTokens, ModelRegistry } from "../../src/registry/index.ts";
import type { JSONObject } from "../../src/util/json.ts";

test("GetAvailableModels returns cloned snapshots", () => {
  const r = new ModelRegistry();
  r.registerClient("client-1", "OpenAI", [{ id: "m1", type: "openai", ownedBy: "team-a", displayName: "Model One" }]);
  const first = r.getAvailableModels("openai");
  expect(first).toHaveLength(1);
  first[0]!.id = "mutated";
  first[0]!.display_name = "Mutated";
  const second = r.getAvailableModels("openai");
  expect(second[0]!.id).toBe("m1");
  expect(second[0]!.display_name).toBe("Model One");
});

test("GetAvailableModels claude includes token limits", () => {
  const r = new ModelRegistry();
  r.registerClient("client-1", "Claude", [
    { id: "claude-sonnet-4-6", ownedBy: "anthropic", type: "claude", created: 1771372800, contextLength: 200000, maxCompletionTokens: 64000 },
    { id: "claude-no-limits", ownedBy: "anthropic", type: "claude" },
  ]);
  const byID = new Map<string, JSONObject>(r.getAvailableModels("claude").map((m) => [m.id as string, m]));

  const withLimits = byID.get("claude-sonnet-4-6");
  expect(withLimits).toBeDefined();
  expect(withLimits!.max_input_tokens).toBe(200000);
  expect(withLimits!.max_tokens).toBe(64000);
  expect(withLimits!.created_at).toBe("2026-02-18T00:00:00Z");

  const withDefaults = byID.get("claude-no-limits");
  expect(withDefaults).toBeDefined();
  expect(withDefaults!.max_input_tokens).toBe(DefaultClaudeMaxInputTokens);
  expect(withDefaults!.max_tokens).toBe(DefaultClaudeMaxOutputTokens);
  expect(withDefaults!.display_name).toBe("claude-no-limits");
  expect(withDefaults!.type).toBe("model");
});

test("GetAvailableModels gemini includes token limits", () => {
  const r = new ModelRegistry();
  r.registerClient("client-1", "gemini", [
    { id: "gemini-3.8-flash", type: "gemini", name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", contextLength: 1048576, maxCompletionTokens: 65536 },
    { id: "gemini-2.5-pro", type: "gemini", name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1048576, outputTokenLimit: 65536 },
    { id: "gemini-no-limits", type: "gemini", name: "models/gemini-no-limits" },
  ]);
  const byName = new Map<string, JSONObject>(r.getAvailableModels("gemini").map((m) => [m.name as string, m]));

  const fromContext = byName.get("models/gemini-3.8-flash");
  expect(fromContext).toBeDefined();
  expect(fromContext!.inputTokenLimit).toBe(1048576);
  expect(fromContext!.outputTokenLimit).toBe(65536);

  const fromExplicit = byName.get("models/gemini-2.5-pro");
  expect(fromExplicit).toBeDefined();
  expect(fromExplicit!.inputTokenLimit).toBe(1048576);
  expect(fromExplicit!.outputTokenLimit).toBe(65536);

  const noLimits = byName.get("models/gemini-no-limits");
  expect(noLimits).toBeDefined();
  expect("inputTokenLimit" in noLimits!).toBe(false);
  expect("outputTokenLimit" in noLimits!).toBe(false);
});

test("GetAvailableModels invalidates cache on registry changes", () => {
  const r = new ModelRegistry();
  r.registerClient("client-1", "OpenAI", [{ id: "m1", type: "openai", ownedBy: "team-a", displayName: "Model One" }]);
  let models = r.getAvailableModels("openai");
  expect(models).toHaveLength(1);
  expect(models[0]!.display_name).toBe("Model One");

  r.registerClient("client-1", "OpenAI", [{ id: "m1", type: "openai", ownedBy: "team-a", displayName: "Model One Updated" }]);
  models = r.getAvailableModels("openai");
  expect(models[0]!.display_name).toBe("Model One Updated");

  r.suspendClientModel("client-1", "m1", "manual");
  expect(r.getAvailableModels("openai")).toHaveLength(0);

  r.resumeClientModel("client-1", "m1");
  expect(r.getAvailableModels("openai")).toHaveLength(1);
});
