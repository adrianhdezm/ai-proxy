// Ported from: sdk/auth/manager_test.go, sdk/auth/refresh_registry_test.go
// Skipped cases: refresh_registry antigravity/kimi/kimi-ai/kimi.ai/xai/devin/meta (providers not kept; gemini-cli added as the nil-lead case);
//   manager_test uses an in-memory TokenStore instead of the file store (the file store is another slice)
import { describe, expect, test } from "bun:test";
import { credentialFileName } from "../../src/auth/claude/filename.ts";
import { ClaudeAuthenticator } from "../../src/auth/claude/authenticator.ts";
import { CodexAuthenticator } from "../../src/auth/codex/authenticator.ts";
import { GeminiAuthenticator } from "../../src/auth/gemini/authenticator.ts";
import { LoginManager, RefreshNotSupportedError, defaultAuthenticators, newLoginManager, providerRefreshLead, type Authenticator } from "../../src/auth/login.ts";
import { type Auth, cloneAuth, newAuth } from "../../src/auth/types.ts";
import type { TokenStore } from "../../src/store/types.ts";

class MemoryStore implements TokenStore {
  readonly kind = "memory";
  records = new Map<string, Auth>();
  saves: string[] = [];
  deletes: string[] = [];
  async save(auth: Auth): Promise<string> {
    this.records.set(auth.id, cloneAuth(auth));
    this.saves.push(auth.id);
    return `/auth/${auth.id}`;
  }
  async list(): Promise<Auth[]> {
    return [...this.records.values()].map(cloneAuth);
  }
  async delete(id: string): Promise<void> {
    this.records.delete(id);
    this.deletes.push(id);
  }
  seed(id: string, provider: string, metadata: Record<string, unknown>): void {
    this.records.set(id, newAuth({ id, provider, metadata }));
  }
}

class DummyAuthenticator implements Authenticator {
  constructor(readonly provider: string, private readonly record: Auth) {}
  async login(): Promise<Auth> {
    return this.record;
  }
  async refresh(auth: Auth): Promise<Auth> {
    return auth;
  }
  refreshLead(): number | undefined {
    return undefined;
  }
}

describe("LoginManager.login", () => {
  test("preserves existing auth file metadata", async () => {
    const store = new MemoryStore();
    store.seed("demo.json", "demo", { type: "demo", email: "user@example.com", access_token: "old-token", prefix: "my-prefix", websockets: false, note: "important note", weight: 10 });
    const record = newAuth({ id: "demo.json", provider: "demo", metadata: { type: "demo", email: "user@example.com", access_token: "new-token" } });
    const mgr = new LoginManager({ store, authenticators: [new DummyAuthenticator("demo", record)] });
    const { auth, savedId } = await mgr.login("demo");
    expect(savedId).toBe("/auth/demo.json");
    const saved = store.records.get("demo.json")!.metadata;
    expect(saved.access_token).toBe("new-token");
    expect(saved.prefix).toBe("my-prefix");
    expect(saved.websockets).toBe(false);
    expect(saved.note).toBe("important note");
    expect(saved.weight).toBe(10);
    expect(auth.metadata.prefix).toBe("my-prefix");
  });

  test("migrates a matching legacy Claude credential", async () => {
    const store = new MemoryStore();
    const legacyFileName = "claude-user@example.com.json";
    const targetFileName = credentialFileName("user@example.com", "organization-a", "account-a");
    store.seed(legacyFileName, "claude", { type: "claude", email: "user@example.com", organization_uuid: "organization-a", account_uuid: "account-a", access_token: "old-token", prefix: "team", proxy_url: "http://127.0.0.1:8080", disabled: true, weight: 5 });
    const record = newAuth({ id: targetFileName, provider: "claude", metadata: { type: "claude", email: "user@example.com", organization_uuid: "organization-a", account_uuid: "account-a", access_token: "new-token" } });
    const mgr = new LoginManager({ store, authenticators: [new DummyAuthenticator("claude", record)] });
    const { auth, savedId } = await mgr.login("claude");
    expect(savedId).toBe(`/auth/${targetFileName}`);
    expect(store.records.has(legacyFileName)).toBe(false);
    expect(store.deletes).toEqual([legacyFileName]);
    const saved = store.records.get(targetFileName)!.metadata;
    expect(saved).toMatchObject({ access_token: "new-token", prefix: "team", proxy_url: "http://127.0.0.1:8080", disabled: true, weight: 5 });
    expect(auth.disabled).toBe(true);
  });

  test("does not migrate a legacy Claude credential from a different organization", async () => {
    const store = new MemoryStore();
    const legacyFileName = "claude-user@example.com.json";
    const targetFileName = credentialFileName("user@example.com", "organization-b", "shared-account");
    store.seed(legacyFileName, "claude", { type: "claude", email: "user@example.com", organization_uuid: "organization-a", account_uuid: "shared-account", access_token: "old-token", prefix: "team" });
    const record = newAuth({ id: targetFileName, provider: "claude", metadata: { type: "claude", email: "user@example.com", organization_uuid: "organization-b", account_uuid: "shared-account", access_token: "new-token" } });
    const mgr = new LoginManager({ store, authenticators: [new DummyAuthenticator("claude", record)] });
    await mgr.login("claude");
    expect(store.records.has(legacyFileName)).toBe(true);
    expect("prefix" in store.records.get(targetFileName)!.metadata).toBe(false);
  });

  test("multiple organizations sharing an email coexist", async () => {
    const store = new MemoryStore();
    const file1 = credentialFileName("shared@example.com", "org-team-1", "account-1");
    const record1 = newAuth({ id: file1, provider: "claude", metadata: { type: "claude", email: "shared@example.com", organization_uuid: "org-team-1", access_token: "token-team" } });
    const r1 = await new LoginManager({ store, authenticators: [new DummyAuthenticator("claude", record1)] }).login("claude");
    const file2 = credentialFileName("shared@example.com", "org-enterprise-2", "account-1");
    const record2 = newAuth({ id: file2, provider: "claude", metadata: { type: "claude", email: "shared@example.com", organization_uuid: "org-enterprise-2", access_token: "token-enterprise" } });
    const r2 = await new LoginManager({ store, authenticators: [new DummyAuthenticator("claude", record2)] }).login("claude");
    expect(r1.savedId).not.toBe(r2.savedId);
    expect((await store.list()).length).toBe(2);
  });

  test("without a store the record is returned unsaved; unknown providers fail", async () => {
    const record = newAuth({ id: "x.json", provider: "demo", metadata: {} });
    const mgr = new LoginManager({ authenticators: [new DummyAuthenticator("demo", record)] });
    expect((await mgr.login("demo")).savedId).toBeUndefined();
    await expect(mgr.login("nope")).rejects.toThrow("authenticator nope not registered");
    await expect(mgr.refresh("nope", newAuth({ id: "y.json", provider: "other", metadata: {} }))).rejects.toBeInstanceOf(RefreshNotSupportedError);
    // Falls back to the record's own provider when the requested one is unknown.
    expect(await mgr.refresh("nope", record)).toBe(record);
    expect(await mgr.refresh("demo", record)).toBe(record);
  });
});

describe("provider refresh leads", () => {
  const cases: Array<{ name: string; authenticator: Authenticator; want?: number }> = [
    { name: "codex", authenticator: new CodexAuthenticator(), want: 96 * 60 * 60_000 },
    { name: "claude", authenticator: new ClaudeAuthenticator(), want: 4 * 60 * 60_000 },
    { name: "gemini-cli", authenticator: new GeminiAuthenticator() },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      expect(tt.authenticator.provider).toBe(tt.name);
      expect(tt.authenticator.refreshLead()).toBe(tt.want);
      expect(providerRefreshLead(tt.name)).toBe(tt.want);
    });
  }

  test("default manager registers the three providers", () => {
    const mgr = newLoginManager();
    expect(mgr.providers().sort()).toEqual(["claude", "codex", "gemini-cli"]);
    expect(defaultAuthenticators().map((a) => a.provider).sort()).toEqual(["claude", "codex", "gemini-cli"]);
    expect(mgr.refreshLead("codex")).toBe(96 * 60 * 60_000);
    expect(mgr.refreshLead("unknown")).toBeUndefined();
  });
});
