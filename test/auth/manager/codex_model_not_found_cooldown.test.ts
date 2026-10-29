// Ported from: sdk/cliproxy/auth/codex_model_not_found_cooldown_test.go
// Skipped cases: TestCodexStructuredModelNotFound_SessionAffinityReleased / TestCodexTerminalEvent_EndToEndCooldownAndAffinity
// (session affinity not ported; the cooldown half of the end-to-end case is covered by the classification test).
import { expect, test } from "bun:test";
import { ErrorCodeRequestScoped, isRequestInvalidError, resultErrorFromError, shouldSkipCredentialCooldown } from "../../../src/auth/manager/index.ts";
import { Hour, auth, newManager, statusError } from "./helpers.ts";

const modelNotFoundBody = `{"error":{"type":"invalid_request_error","code":"model_not_found","message":"The model gpt-5.5 does not exist or you do not have access to it."}}`;

test("CodexStructuredModelNotFound_ClassificationAndCooldown", () => {
  for (const status of [400, 404]) {
    const rawErr = statusError(status, modelNotFoundBody);
    expect(isRequestInvalidError(rawErr), String(status)).toBe(false);
    const resultErr = resultErrorFromError(rawErr)!;
    expect(resultErr.code).toBe("model_not_found");
    expect(shouldSkipCredentialCooldown(resultErr)).toBe(false);

    const { manager, clock } = newManager();
    manager.register(auth({ id: "auth-codex-1", provider: "codex" }));
    manager.markResult({ authId: "auth-codex-1", provider: "codex", model: "gpt-5.5", success: false, error: resultErr });
    const state = manager.getById("auth-codex-1")!.modelStates!["gpt-5.5"]!;
    expect(state.unavailable).toBe(true);
    expect(state.lastError?.code).toBe("model_not_found");
    const remaining = state.nextRetryAfter - clock.now();
    expect(remaining).toBeGreaterThanOrEqual(11 * Hour);
    expect(remaining).toBeLessThanOrEqual(13 * Hour);
  }
});

test("CodexModelNotFound_CallerInputErrorNotModelCooldown", () => {
  const rawErr = statusError(400, `{"error":{"type":"invalid_request_error","message":"The model not found in request body"}}`);
  expect(isRequestInvalidError(rawErr)).toBe(true);
  const resultErr = resultErrorFromError(rawErr)!;
  expect(resultErr.code).toBe(ErrorCodeRequestScoped);
  expect(shouldSkipCredentialCooldown(resultErr)).toBe(true);
});

test("CodexModelNotFound_Generic404NotModelNotFound", () => {
  const rawErr = statusError(404, `{"error":{"message":"Not Found"}}`);
  const resultErr = resultErrorFromError(rawErr)!;
  expect(resultErr.code).not.toBe("model_not_found");
  const { manager } = newManager();
  manager.register(auth({ id: "auth-codex-generic-404", provider: "codex" }));
  manager.markResult({ authId: "auth-codex-generic-404", provider: "codex", model: "gpt-5.5", success: false, error: resultErr });
  const state = manager.getById("auth-codex-generic-404")!.modelStates!["gpt-5.5"];
  expect(state?.lastError?.code).not.toBe("model_not_found");
});

test("CodexStructuredModelNotFound_DisableCooling", () => {
  const { manager } = newManager();
  manager.register(auth({ id: "auth-codex-disable-cooling", provider: "codex", metadata: { disable_cooling: true } }));
  const resultErr = resultErrorFromError(statusError(400, modelNotFoundBody));
  manager.markResult({ authId: "auth-codex-disable-cooling", provider: "codex", model: "gpt-5.5", success: false, error: resultErr });
  const state = manager.getById("auth-codex-disable-cooling")!.modelStates!["gpt-5.5"]!;
  expect(state.nextRetryAfter).toBe(0);
});
