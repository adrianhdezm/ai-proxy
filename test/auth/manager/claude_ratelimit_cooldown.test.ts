// Ported from: sdk/cliproxy/auth/claude_ratelimit_cooldown_test.go
// Skipped cases: TestAuthManager_CooldownPersistenceAcrossRestore (cooldown state store not ported; cooldowns persist
// with the auth record through the token store instead).
import { afterEach, expect, test } from "bun:test";
import { isAuthBlockedForModel, setQuotaCooldownDisabled } from "../../../src/auth/manager/index.ts";
import { Hour, Minute, auth, newManager, registerModels } from "./helpers.ts";

afterEach(() => setQuotaCooldownDisabled(false));

const sevenDays = 7 * 24 * Hour;

test("AuthManager_ConcurrentSuccessDoesNotClearActiveCredentialCooldown", () => {
  const { manager, registry, clock } = newManager();
  const now = clock.now();
  const a = auth({ id: "claude-concurrent", provider: "claude", attributes: { api_key: "test-key" } });
  registerModels(registry, a.id, "claude", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229");
  manager.register(a);

  // 1. Request A fails with a 7d credential-scoped cooldown.
  manager.markResult({ authId: a.id, provider: "claude", model: "claude-3-5-sonnet-20241022", success: false, retryAfterMs: sevenDays, credentialScope: true, error: { httpStatus: 429, message: "7d limit rejected", retryable: false } });
  // 2. An earlier in-flight request on opus returns 200 OK after the 429.
  manager.markResult({ authId: a.id, provider: "claude", model: "claude-3-opus-20240229", success: true });
  // 3. The credential MUST still be blocked for all models.
  const updated = manager.getById(a.id)!;
  expect(updated.quota.exceeded).toBe(true);
  expect(updated.quota.nextRecoverAt).toBeGreaterThan(now + 6 * 24 * Hour);
  for (const m of ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-7-sonnet-20250219"]) {
    const block = isAuthBlockedForModel(updated, m, now);
    expect(block.blocked, m).toBe(true);
    expect(block.reason, m).toBe("cooldown");
    expect(block.next, m).toBeGreaterThanOrEqual(now + sevenDays - Minute);
  }
});

test("AuthManager_UpdatePreservesActiveCredentialCooldown", () => {
  const { manager, registry, clock } = newManager();
  const now = clock.now();
  const a = auth({ id: "claude-update", provider: "claude", attributes: { api_key: "test-key" } });
  registerModels(registry, a.id, "claude", "claude-3-5-sonnet-20241022");
  manager.register(a);
  manager.markResult({ authId: a.id, provider: "claude", model: "claude-3-5-sonnet-20241022", success: false, retryAfterMs: sevenDays, credentialScope: true, error: { httpStatus: 429, message: "7d limit rejected", retryable: false } });

  // Reload/update auth (config reload or token refresh).
  manager.update(auth({ id: a.id, provider: "claude", attributes: { api_key: "test-key-updated" } }));
  const persisted = manager.getById(a.id)!;
  expect(persisted.quota.exceeded).toBe(true);
  expect(persisted.quota.reason).toBe("credential_quota");
  expect(persisted.quota.nextRecoverAt).toBeGreaterThan(now + 6 * 24 * Hour);
  const block = isAuthBlockedForModel(persisted, "claude-3-5-sonnet-20241022", now);
  expect(block.blocked).toBe(true);
  expect(block.reason).toBe("cooldown");
});

test("AuthManager_DisableCoolingDoesNotPermanentlyBlock", () => {
  setQuotaCooldownDisabled(true);
  const { manager, registry, clock } = newManager();
  const a = auth({ id: "claude-disable-cooling", provider: "claude", attributes: { api_key: "test-key" } });
  registerModels(registry, a.id, "claude", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229");
  manager.register(a);
  manager.markResult({ authId: a.id, provider: "claude", model: "claude-3-5-sonnet-20241022", success: false, retryAfterMs: sevenDays, credentialScope: true, error: { httpStatus: 429, message: "7d limit rejected", retryable: false } });
  for (const m of ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229"]) {
    expect(isAuthBlockedForModel(manager.getById(a.id), m, clock.now()).blocked, m).toBe(false);
  }
});

test("AuthManager_NonClaudeProvider_Model429DoesNotBlockSiblingModels", () => {
  const { manager, registry, clock } = newManager();
  const a = auth({ id: "openai-auth", provider: "openai", attributes: { api_key: "test-key" } });
  registerModels(registry, a.id, "openai", "gpt-4o", "gpt-4o-mini");
  manager.register(a);
  manager.markResult({ authId: a.id, provider: "openai", model: "gpt-4o", success: false, credentialScope: false, error: { httpStatus: 429, message: "rate limit", retryable: false } });
  const updated = manager.getById(a.id)!;
  expect(isAuthBlockedForModel(updated, "gpt-4o", clock.now()).blocked).toBe(true);
  expect(isAuthBlockedForModel(updated, "gpt-4o-mini", clock.now()).blocked).toBe(false);
});
