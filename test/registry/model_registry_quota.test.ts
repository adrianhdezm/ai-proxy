// Ported from: internal/registry/model_registry_credential_quota_regression_test.go,
//   internal/registry/model_registry_quota_refresh_regression_test.go,
//   internal/registry/model_registry_sole_credential_quota_test.go
// Skipped cases: none. The Go tests poke registration timestamps and the availability cache expiry
//   directly; here an injected clock advances instead, and modelRegistrationAvailability is observed
//   through the public listings.
import { expect, test } from "bun:test";
import { ModelRegistry, modelQuotaExceededWindowMs, type ModelInfo } from "../../src/registry/index.ts";

function clock(start: number) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const minute = 60_000;

test("TestAvailableModelsKeepsHealthyProviderDuringCredentialQuota", () => {
  const r = new ModelRegistry();
  const model: ModelInfo = { id: "gpt-5.6-luna", ownedBy: "openai", type: "openai" };
  r.registerClient("healthy-api-provider", "codex", [model]);
  r.registerClient("exhausted-oauth-account", "codex", [model]);
  let { epoch } = r.getModelsAndEpochForClient("exhausted-oauth-account");
  expect(
    r.applyClientModelProjections("exhausted-oauth-account", epoch, 1, [{ modelId: model.id, suspended: true, suspendReason: "credential_quota", quotaExceeded: true }]),
  ).toBe(true);
  expect(r.getAvailableModels("openai")).toHaveLength(1);
  expect(r.getAvailableModelsByProvider("codex")).toHaveLength(1);
  expect(r.getAvailableModelInfos()).toHaveLength(1);
  expect(r.getModelCount(model.id)).toBe(1);

  ({ epoch } = r.getModelsAndEpochForClient("healthy-api-provider"));
  expect(r.applyClientModelProjections("healthy-api-provider", epoch, 1, [{ modelId: model.id, suspended: true, suspendReason: "manual" }])).toBe(true);
  expect(r.getAvailableModels("openai")).toHaveLength(0);
  expect(r.getAvailableModelsByProvider("codex")).toHaveLength(0);
  expect(r.getModelCount(model.id)).toBe(0);
});

test("TestCredentialQuotaKeepsHealthyCatalogAcrossRefresh", () => {
  const c = clock(Date.UTC(2026, 8, 22, 8, 53, 19));
  const r = new ModelRegistry({ now: c.now });
  const models: ModelInfo[] = [{ id: "audit-luna", ownedBy: "openai", type: "openai" }];
  r.registerClient("healthy", "codex", models);
  r.registerClient("oauth", "codex", models);
  let { epoch } = r.getModelsAndEpochForClient("oauth");
  const projection = [{ modelId: "audit-luna", suspended: true, suspendReason: "credential_quota", quotaExceeded: true }];
  expect(r.applyClientModelProjections("oauth", epoch, 1, projection)).toBe(true);

  // Listed at 0, just before, at and after the five-minute window (the OAuth suspension is unchanged).
  for (const offset of [0, modelQuotaExceededWindowMs - 1, 1, minute]) {
    c.advance(offset);
    expect(r.getAvailableModels("openai")).toHaveLength(1);
  }

  // A registry refresh clears the old quota timestamp; reapplying the cooldown starts a new window.
  r.registerClient("oauth", "codex", models);
  ({ epoch } = r.getModelsAndEpochForClient("oauth"));
  expect(r.applyClientModelProjections("oauth", epoch, 2, projection)).toBe(true);
  expect(r.getAvailableModels("openai")).toHaveLength(1);
});

test("TestCredentialQuotaKeepsSoleCredentialModelsListed", () => {
  const c = clock(Date.UTC(2026, 9, 1));
  const r = new ModelRegistry({ now: c.now });
  const models: ModelInfo[] = [
    { id: "claude-sonnet-5", ownedBy: "anthropic", type: "claude" },
    { id: "claude-opus-5-5", ownedBy: "anthropic", type: "claude" },
    { id: "claude-haiku-4-5", ownedBy: "anthropic", type: "claude" },
  ];
  r.registerClient("claude-oauth", "claude", models);
  let { epoch } = r.getModelsAndEpochForClient("claude-oauth");
  expect(
    r.applyClientModelProjections("claude-oauth", epoch, 1, [
      { modelId: "claude-sonnet-5", suspended: true, suspendReason: "quota", quotaExceeded: true },
      { modelId: "claude-opus-5-5", suspended: true, suspendReason: "credential_quota", quotaExceeded: true },
      // A sibling without a recorded state of its own inherits the credential's suspension.
      { modelId: "claude-haiku-4-5", suspended: true, suspendReason: "credential_quota" },
    ]),
  ).toBe(true);
  expect(r.getAvailableModels("claude")).toHaveLength(models.length);
  expect(r.getAvailableModelsByProvider("claude")).toHaveLength(models.length);
  expect(r.getAvailableModelInfos()).toHaveLength(models.length);

  // After the quota window, the suspension alone still keeps each model listed.
  c.advance(2 * modelQuotaExceededWindowMs);
  expect(r.getAvailableModelInfos().some((m) => m.id === "claude-opus-5-5")).toBe(true);
  expect(r.getAvailableModelsByProvider("claude")).toHaveLength(models.length);

  // A suspension that is not a quota cooldown still hides the model.
  ({ epoch } = r.getModelsAndEpochForClient("claude-oauth"));
  expect(r.applyClientModelProjections("claude-oauth", epoch, 2, [{ modelId: "claude-opus-5-5", suspended: true, suspendReason: "unauthorized" }])).toBe(true);
  expect(r.getAvailableModelsByProvider("claude").some((m) => m.id === "claude-opus-5-5")).toBe(false);

  // A second credential suspended for a non-quota reason hides a sibling that only has credential_quota.
  r.registerClient("claude-api-backup", "claude", [{ id: "claude-haiku-4-5", ownedBy: "anthropic", type: "claude" }]);
  const backup = r.getModelsAndEpochForClient("claude-api-backup");
  expect(r.applyClientModelProjections("claude-api-backup", backup.epoch, 1, [{ modelId: "claude-haiku-4-5", suspended: true, suspendReason: "manual" }])).toBe(true);
  expect(r.getAvailableModelsByProvider("claude").some((m) => m.id === "claude-haiku-4-5")).toBe(false);
  expect(r.getAvailableModels("claude").some((m) => m.id === "claude-haiku-4-5")).toBe(false);
});
