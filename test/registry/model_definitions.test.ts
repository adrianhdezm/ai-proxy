// Ported from: internal/registry/model_definitions_test.go
// Skipped cases: TestGetStaticModelDefinitionsByChannelSupportsGeminiInteractions (gemini-interactions
//   channel dropped), TestGetStaticModelDefinitionsByChannelSupportsKimiAndKimiAI (kimi dropped),
//   TestGeminiVertexModelsUseFlashLiteReleaseID (vertex dropped), TestWithXAIBuiltins* (xai dropped),
//   TestAntigravityWebSearchModelForRequiresRequestedModelCapability (antigravity dropped),
//   TestGetDevinModelsFallback (devin dropped).
// Adapted cases: TestValidateModelsCatalog_Meta runs against the claude section instead of meta;
//   the gemini-interactions/kimi channel tests are replaced by a kept-channels check.
import { describe, expect, test } from "bun:test";
import {
  type ModelInfo,
  cloneModelInfo,
  getCodexFreeModels,
  getCodexPlusModels,
  getCodexProModels,
  getCodexTeamModels,
  getModels,
  getStaticModelDefinitionsByChannel,
  modelInfoFromJSON,
  modelInfoToJSON,
  modelOverrideHeaders,
  validateModelsCatalog,
  withCodexBuiltins,
} from "../../src/registry/index.ts";

describe("Codex configuration_update capability", () => {
  // Counterexample: present in every tier without support_configuration_update.
  const incapableModelID = "gpt-5.6-luna";
  const tiers: Array<{ name: string; models: () => ModelInfo[]; capable: string[] }> = [
    { name: "free", models: getCodexFreeModels, capable: ["gpt-6-luna"] },
    { name: "team", models: getCodexTeamModels, capable: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] },
    { name: "plus", models: getCodexPlusModels, capable: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] },
    { name: "pro", models: getCodexProModels, capable: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] },
  ];
  for (const tier of tiers) {
    test(tier.name, () => {
      const byID = new Map(tier.models().map((info) => [info.id, info]));
      for (const id of [incapableModelID, ...tier.capable]) {
        const info = byID.get(id);
        expect(info, `${id} is missing`).toBeDefined();
        const want = id !== incapableModelID;
        expect(info!.supportConfigurationUpdate === true).toBe(want);
        expect(cloneModelInfo(info!).supportConfigurationUpdate === true).toBe(want);
        const raw = JSON.stringify(modelInfoToJSON(info!));
        expect(raw).not.toContain("support_configuration_update");
        expect(raw).not.toContain("supportConfigurationUpdate");
      }
    });
  }

  const parseCases = [
    { name: "true", raw: `{"id":"test","support_configuration_update":true}`, want: true },
    { name: "false", raw: `{"id":"test","support_configuration_update":false}`, want: false },
    { name: "absent", raw: `{"id":"test"}`, want: false },
  ];
  for (const tt of parseCases) {
    test(`unmarshal ${tt.name}`, () => {
      const info = modelInfoFromJSON(JSON.parse(tt.raw));
      expect(info.supportConfigurationUpdate === true).toBe(tt.want);
    });
  }
});

test("GetStaticModelDefinitionsByChannel supports the kept channels", () => {
  for (const channel of ["claude", "gemini", "gemini-cli", "aistudio", "codex", "Claude", " codex "]) {
    const models = getStaticModelDefinitionsByChannel(channel);
    expect(models, channel).toBeDefined();
    expect(models!.length, channel).toBeGreaterThan(0);
  }
  for (const channel of ["kimi", "antigravity", "vertex", "xai", "devin", "meta", "unknown"]) {
    expect(getStaticModelDefinitionsByChannel(channel)).toBeUndefined();
  }
});

test("ModelOverrideHeaders from embedded models", () => {
  const wantUA = "codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)";
  const got = modelOverrideHeaders("gpt-5.6-luna");
  expect(got).toBeDefined();
  expect(got!["user-agent"]).toBe(wantUA);
  expect(modelOverrideHeaders("gpt-5.4")).toBeUndefined();
});

test("validateModelsCatalog rejects null, empty and duplicate ids", () => {
  const base = getModels();
  const withSection = (claude: Array<ModelInfo | null>) => ({ ...base, claude: claude as ModelInfo[] });
  expect(() => validateModelsCatalog(withSection([{ id: "claude-test", type: "claude" }]))).not.toThrow();
  expect(() => validateModelsCatalog(withSection([null]))).toThrow();
  expect(() => validateModelsCatalog(withSection([{ id: " ", type: "claude" }]))).toThrow();
  expect(() =>
    validateModelsCatalog(
      withSection([
        { id: "claude-test", type: "claude" },
        { id: "claude-test", type: "claude" },
      ]),
    ),
  ).toThrow();
});

test("WithCodexBuiltins includes the GPT Image 2.5 models", () => {
  const models = withCodexBuiltins([]);
  const expected: Record<string, string> = {
    "gpt-image-2.5-flare": "GPT Image 2.5 Flare",
    "gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
    "gpt-image-2.5": "GPT Image 2.5",
  };
  const found = new Map(models.filter((m) => m.id in expected).map((m) => [m.id, m]));
  for (const [id, wantDisplayName] of Object.entries(expected)) {
    const model = found.get(id);
    expect(model, id).toBeDefined();
    expect(model!.displayName).toBe(wantDisplayName);
    expect(model!.object).toBe("model");
    expect(model!.ownedBy).toBe("openai");
    expect(model!.type).toBe("openai");
    expect(model!.version).toBe(id);
    expect(model!.created).toBe(1704067200);
  }
});
