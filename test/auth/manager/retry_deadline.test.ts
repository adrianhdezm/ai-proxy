// Ported from: sdk/cliproxy/auth/retry_deadline_test.go
// Skipped cases: TestSchedulerPreservesTemporaryDeadlineWithoutChangingQuotaClassification (incremental scheduler shards
// not ported; the quota cooldown contract is covered by selector.test.ts).
import { expect, test } from "bun:test";
import { AuthManagerError, getAvailableAuths, safeResponseHeaders } from "../../../src/auth/manager/index.ts";
import { Minute, auth, baseNow } from "./helpers.ts";

test("TemporaryUnavailabilityPreservesRecoveryDeadline", () => {
  const now = baseNow;
  const temporary = auth({ id: "temporary", provider: "codex", unavailable: true, nextRetryAfter: now + Minute });
  const disabled = auth({ id: "disabled", provider: "codex", disabled: true, nextRetryAfter: now + 1000 });
  for (const auths of [[temporary], [temporary, disabled]]) {
    let err: unknown;
    try {
      getAvailableAuths(auths, "codex", "gpt-5.6-luna", now);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthManagerError);
    const authErr = err as AuthManagerError;
    expect(authErr.code).toBe("auth_unavailable");
    expect(authErr.retryable).toBe(true);
    expect(authErr.statusCode).toBe(503);
    expect(safeResponseHeaders(err)?.get("Retry-After")).toBe("60");
  }
  let disabledErr: unknown;
  try {
    getAvailableAuths([disabled], "codex", "gpt-5.6-luna", now);
  } catch (e) {
    disabledErr = e;
  }
  expect(safeResponseHeaders(disabledErr)?.get("Retry-After") ?? "").toBe("");
});
