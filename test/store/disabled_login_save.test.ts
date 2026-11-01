// Ported from: internal/store/disabled_login_save_test.go
// Skipped cases: TestRemoteStoresSaveDoesNotShortCircuitWhenLocalFileMatches (postgres/object stores keep a
//   local mirror that this port's Vault store does not have), TestGitTokenStoreSaveHonorsContextCancellationDuringPullAndPush
//   (git store not carried). The postgres/object rows of TestRemoteStoresDisabledLoginReachesTokenStorage run
//   against the Vault store, the remote store of this port; the creation intent is SaveOptions.createDisabled.
import { afterEach, expect, test } from "bun:test";
import { newAuth } from "../../src/auth/types.ts";
import { VaultTokenStore } from "../../src/store/vault.ts";
import { FakeVault } from "./fake_vault.ts";

let vault: FakeVault | undefined;
afterEach(() => vault?.stop());

test("TestRemoteStoresDisabledLoginReachesTokenStorage (vault)", async () => {
  vault = new FakeVault({ tokens: ["root-token"] });
  const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
  const auth = newAuth({ id: "canonical-disabled.json", provider: "claude", disabled: true, metadata: { type: "claude" } });

  // A runtime save of a missing disabled credential does not reach storage.
  expect(await store.save(auth)).toBe("");
  expect(vault.requests.some((r) => r.method === "POST")).toBe(false);
  expect(vault.secrets.has("ai-proxy/auths/canonical-disabled.json")).toBe(false);

  // A login (creation intent) does.
  expect(await store.save(auth, { createDisabled: true })).toBe("canonical-disabled.json");
  expect(vault.requests.some((r) => r.method === "POST")).toBe(true);
  expect(vault.secrets.get("ai-proxy/auths/canonical-disabled.json")?.data.disabled).toBe(true);
});
