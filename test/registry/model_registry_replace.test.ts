// Ported from: internal/registry/model_registry_replace_test.go
// Skipped cases: none (provider labels "antigravity" renamed to "codex"; the provider string is opaque here)
import { describe, expect, test } from "bun:test";
import { ModelRegistry, type ModelInfo } from "../../src/registry/index.ts";

function newTestModelRegistry(): ModelRegistry {
  return new ModelRegistry({ now: () => 1_700_000_000_000 });
}

describe("ReplaceClientModels projection generation", () => {
  for (const mode of ["same-provider", "new-provider", "register"]) {
    test(mode, () => {
      const r = newTestModelRegistry();
      const models: ModelInfo[] = [{ id: "keep", type: "codex" }];
      r.registerClient("account", "codex", models);
      let epoch = r.clientRegistrationEpoch("account");
      expect(r.applyClientModelProjections("account", epoch, 11, [{ modelId: "keep", quotaExceeded: true, suspended: true, suspendReason: "rate_limit" }])).toBe(true);
      if (mode === "register") {
        r.registerClient("account", "codex", models);
      } else {
        const provider = mode === "new-provider" ? "gemini" : "codex";
        expect(r.replaceClientModels("account", provider, epoch, models).applied).toBe(true);
      }
      epoch = r.clientRegistrationEpoch("account");
      const accepted = r.applyClientModelProjections("account", epoch, 10, [{ modelId: "keep" }]);
      if (mode === "same-provider") {
        // An older generation must not overwrite retained scheduling state.
        expect(accepted).toBe(false);
        expect(r.isModelQuotaExceededForClient("account", "keep")).toBe(true);
        expect(r.modelSuspensionReason("account", "keep")).toBe("rate_limit");
        expect(r.applyClientModelProjections("account", epoch, 12, [{ modelId: "keep" }])).toBe(true);
      } else {
        expect(accepted).toBe(true);
      }
    });
  }
});

test("ReplaceClientModels epoch and availability", () => {
  const r = newTestModelRegistry();
  const models: ModelInfo[] = [
    { id: "keep", type: "codex" },
    { id: "remove", type: "codex" },
    { id: "keep", type: "codex" },
  ];
  expect(r.replaceClientModels("account", "codex", 0, models).applied).toBe(true);
  let epoch = r.clientRegistrationEpoch("account");
  r.suspendClientModel("account", "keep", "rate_limit");
  r.setModelQuotaExceeded("account", "keep");
  expect(r.replaceClientModels("account", "codex", epoch, [{ id: "keep", type: "codex" }, { id: "add", type: "codex" }]).applied).toBe(true);
  expect(r.modelSuspensionReason("account", "keep")).toBe("rate_limit");
  expect(r.isModelQuotaExceededForClient("account", "keep")).toBe(true);
  expect(r.clientSupportsModel("account", "remove")).toBe(false);
  expect(r.clientSupportsModel("account", "add")).toBe(true);
  expect(r.replaceClientModels("account", "codex", epoch, models).applied).toBe(false);

  r.registerClient("account", "codex", [{ id: "keep", type: "codex" }]);
  expect(r.modelSuspensionReason("account", "keep")).toBeUndefined();
  expect(r.isModelQuotaExceededForClient("account", "keep")).toBe(false);

  epoch = r.clientRegistrationEpoch("account");
  expect(r.replaceClientModels("account", "codex", epoch, []).applied).toBe(true);
  expect(r.getModelsForClient("account")).toHaveLength(0);
  const emptyEpoch = r.clientRegistrationEpoch("account");
  const recovered = r.replaceClientModels("account", "codex", emptyEpoch, models);
  expect(recovered.applied).toBe(true);
  expect(emptyEpoch).not.toBe(epoch);
  expect(recovered.epoch).toBe(emptyEpoch + 1);

  epoch = r.clientRegistrationEpoch("account");
  r.unregisterClient("account");
  expect(r.replaceClientModels("account", "codex", epoch, models).applied).toBe(false);
});
