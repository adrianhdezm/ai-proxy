// Ported from: internal/client/claude/models/models_test.go
// Skipped cases: none.
import { expect, test } from "bun:test";
import { buildClaudeModelsResponse, ensureClaudeModelIDPrefix, resolveClaudeModelIDPrefix } from "../../src/server/models.ts";
import type { JSONObject } from "../../src/util/json.ts";

test("BuildResponse", () => {
  const availableModels: JSONObject[] = [
    { id: "claude-z", display_name: "Zebra", max_tokens: 64000 },
    { id: "gpt-4o", display_name: "Alpha" },
    { id: "claude-c", display_name: "Alpha" },
    { id: "claude-b", display_name: "Beta" },
  ];
  const response = buildClaudeModelsResponse(availableModels, false);
  const models = response.data as JSONObject[];
  const wantIDs = ["claude-c", "claude-fable-5-dd-o4-tpg", "claude-b", "claude-z"];
  expect(models.map((m) => m.id)).toEqual(wantIDs);
  expect(models[3]!.max_tokens).toBe(64000);
  expect(response.has_more).toBe(false);
  expect(response.first_id).toBe(wantIDs[0]);
  expect(response.last_id).toBe(wantIDs[wantIDs.length - 1]);
  // Input is neither mutated nor reordered.
  expect(availableModels[1]!.id).toBe("gpt-4o");
  expect(availableModels[0]!.id).toBe("claude-z");
});

test("BuildResponseWithCloakingDisabled", () => {
  const response = buildClaudeModelsResponse([{ id: "gpt-4o", display_name: "GPT-4o" }], true);
  const models = response.data as JSONObject[];
  expect(models).toHaveLength(1);
  expect(models[0]!.id).toBe("gpt-4o");
  expect(response.first_id).toBe("gpt-4o");
  expect(response.last_id).toBe("gpt-4o");
});

test("BuildResponseEmpty", () => {
  const response = buildClaudeModelsResponse(null, false);
  expect(response.data).toEqual([]);
  expect(response.first_id).toBe("");
  expect(response.last_id).toBe("");
});

test("EnsureClaudeModelIDPrefix", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["my-claude-custom", "claude-fable-5-dd-motsuc-edualc-ym"],
    ["Claude-Opus-4", "claude-fable-5-dd-4-supO-edualC"],
    ["gpt-4o", "claude-fable-5-dd-o4-tpg"],
    ["gemini-2.5-pro", "claude-fable-5-dd-orp-5.2-inimeg"],
  ];
  for (const [id, want] of cases) expect(ensureClaudeModelIDPrefix(id)).toBe(want);
});

test("ResolveClaudeModelIDPrefix", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["gpt-4o", "gpt-4o"],
    ["claude-fable-5-dd-o4-tpg", "gpt-4o"],
    ["claude-fable-5-dd-orp-5.2-inimeg", "gemini-2.5-pro"],
    ["claude-fable-5-dd-", "claude-fable-5-dd-"],
    ["claude-fable-5-dd-o4-tpg(high)", "gpt-4o(high)"],
    [ensureClaudeModelIDPrefix("custom-model-x"), "custom-model-x"],
  ];
  for (const [id, want] of cases) expect(resolveClaudeModelIDPrefix(id)).toBe(want);
});
