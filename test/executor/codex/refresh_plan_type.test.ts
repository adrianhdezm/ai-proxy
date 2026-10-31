// Ported from: internal/runtime/executor/codex_executor_auth_test.go
// Skipped cases: TestCodexExecutorRefreshSelectiveAndDual, TestCodexExecutorUseSIWCExecuteAndStream,
//   TestCodexWebsocketsExecutorUseSIWCExecuteAndStream, TestCodexExecutorUseSIWCFailsClosedWhenMissingSIWCToken,
//   TestCodexExecutorUseSIWCImageRequestsRouteThroughResponsesSSE, TestCodexExecutorRefreshHomeModeRefreshesSIWCWhenOnlySIWCDue,
//   TestCodexExecutorCodexClientIgnoresUseSIWC (SIWC credentials and their nested token refresh are not ported),
//   TestCodexExecutorRefreshSerializesUnderFileLockAndSkipsAlreadyRotatedToken (the Home-mode refresh under a
//   credential file lock is not ported). Adaptations: the token endpoint is a fetch stub (Go tunnelled a TLS mock
//   through a CONNECT proxy); Go's CodexTokenStorage snapshot is the auth's metadata record, so "storage isolation"
//   checks that the caller's auth (attributes and metadata) is not mutated; persistence goes through the file store.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttributePath, newAuth } from "../../../src/auth/types.ts";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import { FileTokenStore } from "../../../src/store/file.ts";
import { stubFetch } from "./helpers.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Go: makeTestCodexRefreshJWT. */
function makeTestCodexRefreshJWT(planType: string, accountID: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const authInfo: Record<string, string> = { chatgpt_account_id: accountID };
  if (planType !== "") authInfo.chatgpt_plan_type = planType;
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "user@example.com", "https://api.openai.com/auth": authInfo })}.`;
}

/** Go: startCodexMockOAuthServers. */
function tokenEndpoint(idToken: string) {
  return stubFetch(() => Response.json({ access_token: "new-mock-access-token", refresh_token: "new-mock-refresh-token", id_token: idToken, token_type: "Bearer", expires_in: 3600 }));
}

async function savedPlanType(auth: ReturnType<typeof newAuth>, fileName: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "codex-refresh-"));
  tempDirs.push(dir);
  const store = new FileTokenStore({ baseDir: dir });
  auth.attributes[AttributePath] = join(dir, fileName);
  const path = await store.save(auth);
  return JSON.parse(readFileSync(path, "utf8")).plan_type;
}

for (const tc of [
  { name: "TestCodexExecutorRefresh_MissingPlanTypeDefaultsToFree", plan: "", account: "acc-codex-test", before: "unknown", want: "free", file: "codex-refreshed.json" },
  { name: "TestCodexExecutorRefresh_ExtractsPlanTypeWhenPresent", plan: "team", account: "acc-codex-test-team", before: "free", want: "team", file: "codex-team-refreshed.json" },
]) {
  test(tc.name, async () => {
    const stub = tokenEndpoint(makeTestCodexRefreshJWT(tc.plan, tc.account));
    const executor = new CodexExecutor({ fetch: stub.fetch });
    const auth = newAuth({
      id: "test-codex-refresh",
      provider: "codex",
      attributes: { plan_type: tc.before },
      metadata: { type: "codex", id_token: "old-id-token", access_token: "old-access-token", refresh_token: "valid-refresh-token", plan_type: tc.before },
    });

    const refreshed = await executor.refresh(auth);
    expect(stub.calls.length).toBe(1);
    expect(refreshed.attributes.plan_type).toBe(tc.want);
    expect(refreshed.metadata.plan_type).toBe(tc.want);
    expect(refreshed.metadata.access_token).toBe("new-mock-access-token");
    // Snapshot isolation: the caller's record is not mutated.
    expect(auth.metadata.plan_type).toBe(tc.before);
    expect(auth.attributes.plan_type).toBe(tc.before);
    expect(auth.metadata.access_token).toBe("old-access-token");
    // Persistence writes the refreshed plan_type into the credential file.
    expect(await savedPlanType(refreshed, tc.file)).toBe(tc.want);
  });
}

test("TestCodexExecutorRefresh_EmptyAttributesSnapshotIsolation", async () => {
  const stub = tokenEndpoint(makeTestCodexRefreshJWT("", "acc-codex-empty-attrs"));
  const executor = new CodexExecutor({ fetch: stub.fetch });
  const emptyAttrs: Record<string, string> = {};
  const auth = newAuth({ id: "test-codex-empty-attrs", provider: "codex", attributes: emptyAttrs, metadata: { refresh_token: "valid-refresh-token" } });
  const before = { ...auth.attributes };

  const refreshed = await executor.refresh(auth);
  expect(refreshed.attributes.plan_type).toBe("free");
  expect(emptyAttrs.plan_type).toBeUndefined();
  expect(Object.keys(emptyAttrs).length).toBe(0);
  expect(auth.attributes).toEqual(before);
});
