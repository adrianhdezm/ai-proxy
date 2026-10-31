// New (no upstream test): HashiCorp Vault KV v2 token store.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AttributePath, AttributeSourceBackend, AuthSourceVault, StatusDisabled, newAuth } from "../../src/auth/types.ts";
import { VaultError, VaultTokenStore } from "../../src/store/vault.ts";
import { FakeVault } from "./fake_vault.ts";

let vault: FakeVault;

afterEach(() => vault?.stop());

describe("VaultTokenStore CRUD with a static token", () => {
  beforeEach(() => {
    vault = new FakeVault({ tokens: ["root-token"] });
  });

  test("save writes the record under <mount>/data/<prefix>/<id> and sets attributes", async () => {
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    const auth = newAuth({ id: "claude-user.json", provider: "claude", metadata: { type: "claude", access_token: "tok" } });
    const id = await store.save(auth);
    expect(id).toBe("claude-user.json");
    expect(vault.secrets.get("ai-proxy/auths/claude-user.json")?.data).toEqual({ type: "claude", access_token: "tok", disabled: false });
    expect(auth.attributes[AttributePath]).toBe("secret/data/ai-proxy/auths/claude-user.json");
    expect(auth.attributes[AttributeSourceBackend]).toBe(AuthSourceVault);
    const write = vault.requests.find((r) => r.method === "POST");
    expect(write?.path).toBe("/v1/secret/data/ai-proxy/auths/claude-user.json");
    expect(write?.token).toBe("root-token");
  });

  test("list reads every record and maps the document to an Auth", async () => {
    vault.put("ai-proxy/auths/claude.json", { type: "claude", access_token: "a", email: "me@example.com" });
    vault.put("ai-proxy/auths/gemini.json", { type: "gemini", token: { access_token: "g" }, project_id: "proj", prefix: "g", proxy_url: " http://p:1 ", disabled: true });
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    const auths = await store.list();
    expect(auths.map((a) => a.id)).toEqual(["claude.json", "gemini.json"]);
    expect(auths[0]!.provider).toBe("claude");
    expect(auths[0]!.label).toBe("me@example.com");
    expect(auths[0]!.attributes.email).toBe("me@example.com");
    expect(auths[1]!.provider).toBe("gemini-cli");
    expect(auths[1]!.disabled).toBe(true);
    expect(auths[1]!.status).toBe(StatusDisabled);
    expect(auths[1]!.prefix).toBe("g");
    expect(auths[1]!.proxyUrl).toBe("http://p:1");
    expect(auths[1]!.label).toBe("proj");
    expect(auths[1]!.attributes[AttributePath]).toBe("secret/data/ai-proxy/auths/gemini.json");
    expect(auths[1]!.createdAt).toBeGreaterThan(0);
    expect(auths[1]!.metadata).toEqual({ type: "gemini", token: { access_token: "g" }, project_id: "proj", prefix: "g", proxy_url: " http://p:1 ", disabled: true });
  });

  test("list recurses into nested folders and keeps the relative key as id", async () => {
    vault.put("ai-proxy/auths/top.json", { type: "codex" });
    vault.put("ai-proxy/auths/team-a/claude.json", { type: "claude" });
    vault.put("ai-proxy/auths/team-a/deep/codex.json", { type: "codex" });
    vault.put("other/ignored.json", { type: "claude" });
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    const auths = await store.list();
    expect(auths.map((a) => a.id)).toEqual(["team-a/claude.json", "team-a/deep/codex.json", "top.json"]);
    const lists = vault.requests.filter((r) => r.query === "list=true").map((r) => r.path);
    expect(lists).toEqual([
      "/v1/secret/metadata/ai-proxy/auths",
      "/v1/secret/metadata/ai-proxy/auths/team-a",
      "/v1/secret/metadata/ai-proxy/auths/team-a/deep",
    ]);
  });

  test("list on an empty prefix returns no records", async () => {
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    expect(await store.list()).toEqual([]);
  });

  test("delete destroys the metadata path and ignores missing ids", async () => {
    vault.put("ai-proxy/auths/claude.json", { type: "claude" });
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    await store.delete("claude.json");
    expect(vault.secrets.has("ai-proxy/auths/claude.json")).toBe(false);
    await store.delete("missing.json");
    const deletes = vault.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deletes).toEqual(["/v1/secret/metadata/ai-proxy/auths/claude.json", "/v1/secret/metadata/ai-proxy/auths/missing.json"]);
  });

  test("custom mount, prefix and namespace are honoured", async () => {
    vault.stop();
    vault = new FakeVault({ tokens: ["t"], mount: "kv" });
    const store = new VaultTokenStore({ address: `${vault.address}/`, token: "t", mount: "/kv/", pathPrefix: "/creds/proxy/", namespace: "team" });
    await store.save(newAuth({ id: "a.json", provider: "codex", metadata: { type: "codex" } }));
    expect(vault.secrets.has("creds/proxy/a.json")).toBe(true);
    expect(vault.requests[0]!.namespace).toBe("team");
    expect(vault.requests[0]!.path).toBe("/v1/kv/data/creds/proxy/a.json");
    expect(store.location).toEqual({ address: vault.address, mount: "kv", pathPrefix: "creds/proxy" });
  });

  test("ids with special characters are percent-encoded per segment", async () => {
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    await store.save(newAuth({ id: "team a/user+1.json", provider: "claude", metadata: {} }));
    expect(vault.secrets.has("team a/user+1.json".replace(/^/, "ai-proxy/auths/"))).toBe(true);
    const raw = vault.requests[0]!;
    expect(raw.path).toBe("/v1/secret/data/ai-proxy/auths/team a/user+1.json");
  });

  test("disabled auth whose record is missing is not created unless createDisabled is set", async () => {
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    const auth = newAuth({ id: "off.json", provider: "claude", disabled: true, metadata: { type: "claude" } });
    expect(await store.save(auth)).toBe("");
    expect(vault.secrets.has("ai-proxy/auths/off.json")).toBe(false);
    expect(await store.save(auth, { createDisabled: true })).toBe("off.json");
    expect(vault.secrets.get("ai-proxy/auths/off.json")?.data.disabled).toBe(true);
    // Existing disabled records are updated by plain saves.
    auth.metadata.note = "x";
    expect(await store.save(auth)).toBe("off.json");
    expect(vault.secrets.get("ai-proxy/auths/off.json")?.data.note).toBe("x");
  });

  test("round trip keeps the stored document identical to the file store shape", async () => {
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    const document = { type: "codex", access_token: "a", refresh_token: "r", email: "x@y", "request-retry": 2 };
    await store.save(newAuth({ id: "codex.json", provider: "codex", metadata: { ...document } }));
    expect(vault.secrets.get("ai-proxy/auths/codex.json")?.data).toEqual({
      type: "codex",
      access_token: "a",
      refresh_token: "r",
      email: "x@y",
      request_retry: 2,
      disabled: false,
    });
    const [listed] = await store.list();
    expect(listed!.id).toBe("codex.json");
    expect(listed!.provider).toBe("codex");
    expect(listed!.metadata.request_retry).toBe(2);
  });
});

describe("VaultTokenStore AppRole login", () => {
  beforeEach(() => {
    vault = new FakeVault({ approle: { roleId: "role", secretId: "secret", leaseDuration: 3600 } });
  });

  test("logs in once and reuses the client token", async () => {
    const store = new VaultTokenStore({ address: vault.address, approle: { roleId: "role", secretId: "secret" } });
    await store.save(newAuth({ id: "a.json", provider: "claude", metadata: {} }));
    await store.list();
    expect(vault.loginCount).toBe(1);
    const tokens = vault.requests.filter((r) => r.path !== "/v1/auth/approle/login").map((r) => r.token);
    expect(tokens.every((t) => t === "approle-token-1")).toBe(true);
  });

  test("re-logs in once after a 403 and retries the request", async () => {
    const store = new VaultTokenStore({ address: vault.address, approle: { roleId: "role", secretId: "secret" } });
    await store.save(newAuth({ id: "a.json", provider: "claude", metadata: {} }));
    vault.revokeToken("approle-token-1");
    const auths = await store.list();
    expect(auths.map((a) => a.id)).toEqual(["a.json"]);
    expect(vault.loginCount).toBe(2);
    const sequence = vault.requests.slice(2).map((r) => `${r.method} ${r.path}${r.query ? "?" + r.query : ""} ${r.token}`);
    expect(sequence[0]).toBe("GET /v1/secret/metadata/ai-proxy/auths?list=true approle-token-1");
    expect(sequence[1]).toBe("POST /v1/auth/approle/login ");
    expect(sequence[2]).toBe("GET /v1/secret/metadata/ai-proxy/auths?list=true approle-token-2");
  });

  test("a second 403 after re-login is surfaced as VaultError", async () => {
    const store = new VaultTokenStore({ address: vault.address, approle: { roleId: "role", secretId: "secret" } });
    await store.save(newAuth({ id: "a.json", provider: "claude", metadata: {} }));
    vault.revokeToken("approle-token-1");
    // Make every freshly issued token invalid too.
    const original = vault.validTokens.add.bind(vault.validTokens);
    vault.validTokens.add = (token: string) => {
      original(token);
      vault.validTokens.delete(token);
      return vault.validTokens;
    };
    const err = await store.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).status).toBe(403);
    expect((err as VaultError).errors).toEqual(["permission denied"]);
    expect(vault.loginCount).toBe(2);
  });

  test("renews the token when the lease elapsed according to the injected clock", async () => {
    let now = 1_000_000;
    vault.stop();
    vault = new FakeVault({ approle: { roleId: "role", secretId: "secret", leaseDuration: 100 } });
    const store = new VaultTokenStore({ address: vault.address, approle: { roleId: "role", secretId: "secret" }, now: () => now });
    await store.list();
    expect(vault.loginCount).toBe(1);
    now += 50_000;
    await store.list();
    expect(vault.loginCount).toBe(1);
    now += 50_000; // 100s > 90% of the 100s lease
    await store.list();
    expect(vault.loginCount).toBe(2);
  });

  test("invalid AppRole credentials fail with the Vault error text", async () => {
    const store = new VaultTokenStore({ address: vault.address, approle: { roleId: "role", secretId: "wrong" } });
    const err = await store.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).status).toBe(400);
    expect((err as Error).message).toBe("vault POST auth/approle/login: status 400: invalid role or secret ID");
  });
});

describe("VaultTokenStore error mapping", () => {
  beforeEach(() => {
    vault = new FakeVault({ tokens: ["root-token"] });
  });

  test("non-2xx responses throw VaultError with status and errors array", async () => {
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    vault.failNext = { status: 500, errors: ["1 error occurred:", "sealed"] };
    const err = await store.save(newAuth({ id: "a.json", provider: "claude", metadata: {} })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    const verr = err as VaultError;
    expect(verr.status).toBe(500);
    expect(verr.errors).toEqual(["1 error occurred:", "sealed"]);
    expect(verr.method).toBe("POST");
    expect(verr.path).toBe("secret/data/ai-proxy/auths/a.json");
    expect(verr.message).toBe("vault POST secret/data/ai-proxy/auths/a.json: status 500: 1 error occurred:; sealed");
  });

  test("a 403 with a static token is not retried and surfaces as VaultError", async () => {
    const store = new VaultTokenStore({ address: vault.address, token: "wrong" });
    const err = await store.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).status).toBe(403);
    expect(vault.requests.length).toBe(1);
  });

  test("list errors name the LIST operation", async () => {
    const store = new VaultTokenStore({ address: vault.address, token: "root-token" });
    vault.failNext = { status: 503, errors: ["standby"] };
    const err = await store.list().catch((e: unknown) => e);
    expect((err as Error).message).toBe("vault LIST secret/metadata/ai-proxy/auths: status 503: standby");
  });

  test("injected fetch is used instead of the global one", async () => {
    const calls: string[] = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push(`${init?.method} ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
      return new Response(JSON.stringify({ errors: [] }), { status: 404 });
    };
    const store = new VaultTokenStore({ address: "http://vault.invalid", token: "t", fetch: fakeFetch });
    expect(await store.list()).toEqual([]);
    expect(calls).toEqual(["GET http://vault.invalid/v1/secret/metadata/ai-proxy/auths?list=true"]);
  });

  test("constructor rejects missing credentials or address", () => {
    expect(() => new VaultTokenStore({ address: "" , token: "t" })).toThrow("address is required");
    expect(() => new VaultTokenStore({ address: "http://v" })).toThrow("either a token or approle");
  });
});
