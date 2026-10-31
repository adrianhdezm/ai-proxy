// Ported from: sdk/api/handlers/handlers_request_details_test.go
// Skipped cases: the xai/grok-imagine-* rows run only through the pure model check (xAI is not
// ported, so no image route serves them); TestExecuteImageWithAuthManager_AllowsImageOnlyModels is
// adapted: the image path is the /v1/images/generations handler and the non-image path the
// /v1/messages and /v1/responses handlers.
import { describe, expect, test } from "bun:test";
import { ModelRegistry } from "../../src/registry/index.ts";
import { getRequestDetails, isOpenAIImageOnlyModel, validateImageOnlyModel } from "../../src/server/routing.ts";
import { createServer } from "../../src/server/server.ts";
import { fakeManager, messagesRequest } from "./helpers.ts";

const now = Math.floor(Date.parse("2026-10-28T12:00:00Z") / 1000);

function detailsRegistry(): ModelRegistry {
  const registry = new ModelRegistry();
  registry.registerClient("test-request-details-gemini", "gemini", [
    { id: "gemini-2.5-pro", type: "gemini", created: now + 30 },
    { id: "gemini-2.5-flash", type: "gemini", created: now + 25 },
  ]);
  registry.registerClient("test-request-details-openai", "openai", [{ id: "gpt-5.2", type: "openai", created: now + 20 }]);
  registry.registerClient("test-request-details-claude", "claude", [{ id: "claude-sonnet-4-5", type: "claude", created: now + 5 }]);
  return registry;
}

describe("TestGetRequestDetails_PreservesSuffix", () => {
  const registry = detailsRegistry();
  const cases: { name: string; input: string; providers?: string[]; model?: string; wantErr?: boolean }[] = [
    { name: "numeric suffix preserved", input: "gemini-2.5-pro(8192)", providers: ["gemini"], model: "gemini-2.5-pro(8192)" },
    { name: "level suffix preserved", input: "gpt-5.2(high)", providers: ["openai"], model: "gpt-5.2(high)" },
    { name: "no suffix unchanged", input: "claude-sonnet-4-5", providers: ["claude"], model: "claude-sonnet-4-5" },
    { name: "unknown model with suffix", input: "unknown-model(8192)", wantErr: true },
    { name: "auto suffix resolved", input: "auto(high)", providers: ["gemini"], model: "gemini-2.5-pro(high)" },
    { name: "special suffix none preserved", input: "gemini-2.5-flash(none)", providers: ["gemini"], model: "gemini-2.5-flash(none)" },
    { name: "special suffix auto preserved", input: "claude-sonnet-4-5(auto)", providers: ["claude"], model: "claude-sonnet-4-5(auto)" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const details = getRequestDetails(registry, tc.input);
      if (tc.wantErr) {
        expect("error" in details).toBe(true);
        return;
      }
      if ("error" in details) throw new Error(`unexpected error: ${details.error.error.message}`);
      expect(details.providers).toEqual(tc.providers!);
      expect(details.model).toBe(tc.model!);
    });
  }
});

describe("TestGetRequestDetails_UnknownModelErrorResistsJSONInjection", () => {
  const registry = new ModelRegistry();
  for (const model of ["unroutable-model", `foo"bar`, `x","code":"insufficient_quota","x":"`, `x"}}`, `foo\\bar`, "foo\nbar"]) {
    test(JSON.stringify(model), () => {
      const details = getRequestDetails(registry, model);
      if (!("error" in details)) throw new Error("expected an error for an unroutable model");
      expect(details.error.statusCode).toBe(400);
      const body = JSON.parse(details.error.error.message) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("model_not_found");
      expect(body.error.message).toBe(`unknown provider for model ${model}`);
    });
  }
});

const imageOnlyModels = [
  "gpt-image-1.5",
  "gpt-image-2",
  "codex/gpt-image-2",
  "gpt-image-2.5-flare",
  "codex/gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "codex/gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "codex/gpt-image-2.5",
  "grok-imagine-image",
  "xai/grok-imagine-image",
  "grok-imagine-image-quality",
  "xai/grok-imagine-image-quality",
  "grok-imagine-image-2.0",
  "xai/grok-imagine-image-2.0",
];

test("TestGetRequestDetails_ImageModelReturns503", () => {
  const registry = new ModelRegistry();
  for (const model of imageOnlyModels) {
    const details = getRequestDetails(registry, model);
    if (!("error" in details)) throw new Error(`expected error for ${model}`);
    expect(details.error.statusCode).toBe(503);
    expect(details.error.error.message).toContain("/v1/images/generations");
    expect(details.error.error.message).toContain("/v1/images/edits");
  }
});

test("TestValidateImageOnlyModel_AllowsImageEndpoints", () => {
  for (const model of imageOnlyModels) {
    expect(validateImageOnlyModel(model, true)).toBeUndefined();
    const rejected = validateImageOnlyModel(model, false);
    expect(rejected?.statusCode).toBe(503);
  }
});

test("TestIsOpenAIImageOnlyModel", () => {
  const cases: [string, boolean][] = [
    ["gpt-image-1.5", true],
    ["gpt-image-2", true],
    ["codex/gpt-image-1.5", true],
    ["gpt-image-2.5-flare", true],
    ["codex/gpt-image-2.5-flare", true],
    ["gpt-image-2.5-sunburst", true],
    ["codex/gpt-image-2.5-sunburst", true],
    ["gpt-image-2.5", true],
    ["codex/gpt-image-2.5", true],
    ["grok-imagine-image", true],
    ["xai/grok-imagine-image", true],
    ["XAI/Grok-Imagine-Image-Quality", true],
    ["grok-imagine-image-quality", true],
    ["grok-imagine-image-2.0", true],
    ["xai/grok-imagine-image-2.0", true],
    ["grok-3", false],
    ["gpt-5.2", false],
    ["grok-imagine-video", false],
  ];
  for (const [model, want] of cases) expect([model, isOpenAIImageOnlyModel(model)]).toEqual([model, want]);
});

test("TestExecuteImageWithAuthManager_AllowsImageOnlyModels (adapted to the HTTP handlers)", async () => {
  const registry = new ModelRegistry();
  const manager = fakeManager();
  const server = createServer({ manager, registry });
  for (const model of ["gpt-image-1.5", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5"]) {
    const image = await server.fetch(
      new Request("http://proxy.test/v1/images/generations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt: "draw" }) }),
    );
    expect(await image.text()).not.toContain("only supported on /v1/images/generations");

    const claude = await server.fetch(messagesRequest(model, false));
    expect(claude.status).toBe(503);
    const claudeBody = (await claude.json()) as { error: { type: string; message: string } };
    expect(claudeBody.error.message).toContain("only supported on /v1/images/generations");

    const responses = await server.fetch(
      new Request("http://proxy.test/v1/responses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, input: "draw" }) }),
    );
    expect(responses.status).toBe(503);
    expect(await responses.text()).toContain("only supported on /v1/images/generations");
  }
  expect(manager.calls).toHaveLength(0);
});
