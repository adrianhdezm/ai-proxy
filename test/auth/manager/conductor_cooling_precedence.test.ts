// Ported from: sdk/cliproxy/auth/conductor_cooling_precedence_test.go
// Skipped cases: the openai-compatibility provider override rows and the Home mode row (neither ported).
import { expect, test } from "bun:test";
import { auth, newManager } from "./helpers.ts";

test("ManagerMarkResultUsesCredentialCoolingPrecedence", () => {
  const cases: Array<{ name: string; globalDisable?: boolean; credential?: boolean; wantCooldown: boolean }> = [
    { name: "credential true overrides global false", credential: true, wantCooldown: false },
    { name: "credential false overrides global true", globalDisable: true, credential: false, wantCooldown: true },
    { name: "unset inherits global true", globalDisable: true, wantCooldown: false },
    { name: "unset inherits global false", wantCooldown: true },
  ];
  for (const tc of cases) {
    const tm = newManager({ cooldownDisabled: tc.globalDisable ?? false });
    const a = auth({ id: tc.name, provider: "claude", metadata: tc.credential === undefined ? {} : { disable_cooling: tc.credential } });
    tm.manager.register(a);
    const model = "test-model";
    tm.manager.markResult({ authId: a.id, provider: a.provider, model, success: false, error: { httpStatus: 500, message: "upstream failed", retryable: false } });
    const state = tm.manager.getById(a.id)!.modelStates![model]!;
    expect(state.nextRetryAfter !== 0, tc.name).toBe(tc.wantCooldown);
  }
});
