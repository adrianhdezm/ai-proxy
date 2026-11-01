// Ported from: sdk/api/handlers/claude/code_handlers_model_test.go
// Skipped cases: none.
import { expect, test } from "bun:test";
import { ModelRegistry } from "../../src/registry/index.ts";
import { ClaudeCodeAPIHandler, rewriteClaudeDDModelInBody } from "../../src/server/claude_handlers.ts";
import { fakeManager } from "./helpers.ts";

interface ModelsResponse {
  data: { id: string; display_name: string }[];
}

test("ClaudeModelsResponseUsesConfiguredDisplayName", async () => {
  const registry = new ModelRegistry();
  registry.registerClient("claude-display-name-catalog-test", "claude", [{ id: "claude-display-name-catalog-test", object: "model", ownedBy: "test", type: "claude", displayName: "Configured Claude Name" }]);
  const handler = new ClaudeCodeAPIHandler({ manager: fakeManager(), registry });
  const response = (await handler.claudeModels().json()) as ModelsResponse;
  const model = response.data.find((entry) => entry.id === "claude-display-name-catalog-test");
  expect(model).toBeDefined();
  expect(model?.display_name).toBe("Configured Claude Name");
});

test("ClaudeModelsResponseDisablesModelListCloaking", async () => {
  const registry = new ModelRegistry();
  registry.registerClient("claude-disable-model-list-cloaking-test", "claude", [{ id: "gpt-disable-model-list-cloaking-test", object: "model", ownedBy: "test", type: "openai" }]);
  // Cloaking is off by default in this port.
  const plain = (await new ClaudeCodeAPIHandler({ manager: fakeManager(), registry }).claudeModels().json()) as ModelsResponse;
  expect(plain.data.some((entry) => entry.id === "gpt-disable-model-list-cloaking-test")).toBe(true);
  // With cloaking on, the non-claude id is rewritten the way upstream does by default.
  const cloaked = (await new ClaudeCodeAPIHandler({ manager: fakeManager(), registry, cloakModelList: true }).claudeModels().json()) as ModelsResponse;
  expect(cloaked.data.some((entry) => entry.id === "claude-fable-5-dd-tset-gnikaolc-tsil-ledom-elbasid-tpg")).toBe(true);
});

test("RewriteClaudeDDModelInBody", () => {
  const cases: { body: string; wantModel: string }[] = [
    { body: `{"model":"claude-fable-5-dd-o4-tpg","messages":[]}`, wantModel: "gpt-4o" },
    { body: `{"model":"claude-sonnet-4-6","messages":[]}`, wantModel: "claude-sonnet-4-6" },
    { body: `{"model":"claude-fable-5-dd-o4-tpg(high)","stream":true}`, wantModel: "gpt-4o(high)" },
    { body: `{"messages":[]}`, wantModel: "" },
  ];
  for (const tc of cases) {
    const object = JSON.parse(tc.body) as Record<string, unknown>;
    const got = rewriteClaudeDDModelInBody(object, tc.body);
    const model = (JSON.parse(got.raw) as { model?: string }).model ?? "";
    expect(model).toBe(tc.wantModel);
    expect(got.object.model ?? "").toBe(tc.wantModel);
  }
});
