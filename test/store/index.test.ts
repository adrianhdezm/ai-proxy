// New (no upstream test): createTokenStore factory and migrate helper.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttributeSourceBackend, AuthSourceFile, AuthSourceVault, newAuth } from "../../src/auth/types.ts";
import { defaultConfig } from "../../src/config/load.ts";
import { FileTokenStore, VaultTokenStore, createTokenStore, migrate, vaultOptionsFromConfig } from "../../src/store/index.ts";
import { FakeVault } from "./fake_vault.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-store-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("createTokenStore", () => {
  test("file store from auth config", () => {
    const cfg = defaultConfig();
    cfg.auth.authDir = tempDir();
    const store = createTokenStore(cfg.auth);
    expect(store).toBeInstanceOf(FileTokenStore);
    expect(store.kind).toBe("file");
  });

  test("vault store from auth config with env-style options", () => {
    const cfg = defaultConfig();
    cfg.auth.store = "vault";
    cfg.auth.vault.address = "http://vault.invalid:8200";
    cfg.auth.vault.namespace = "ns";
    cfg.auth.vault.approle = { roleId: "r", secretId: "s" };
    const fakeFetch = async (): Promise<Response> => new Response("{}", { status: 200 });
    const store = createTokenStore(cfg.auth, { fetch: fakeFetch, now: () => 1 });
    expect(store).toBeInstanceOf(VaultTokenStore);
    expect(store.kind).toBe("vault");
    const options = vaultOptionsFromConfig(cfg.auth);
    expect(options.namespace).toBe("ns");
    expect(options.approle).toEqual({ roleId: "r", secretId: "s" });
    expect(options.token).toBeUndefined();
  });

  test("vault store without an address is rejected", () => {
    const cfg = defaultConfig();
    cfg.auth.store = "vault";
    expect(() => createTokenStore(cfg.auth)).toThrow("auth.vault.address");
  });

  test("unknown store kind is rejected", () => {
    const cfg = defaultConfig();
    (cfg.auth as { store: string }).store = "redis";
    expect(() => createTokenStore(cfg.auth)).toThrow('unknown auth store "redis"');
  });
});

describe("migrate", () => {
  test("copies every record from the file store into Vault keeping ids", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "claude.json"), JSON.stringify({ type: "claude", access_token: "a", email: "me@example.com" }));
    writeFileSync(join(dir, "disabled.json"), JSON.stringify({ type: "codex", disabled: true }));
    const nested = join(dir, "team");
    writeFileSync(join(dir, "ignore.txt"), "not json");
    require("node:fs").mkdirSync(nested);
    writeFileSync(join(nested, "gemini.json"), JSON.stringify({ type: "gemini", token: { access_token: "g" } }));

    const vault = new FakeVault({ tokens: ["t"] });
    cleanups.push(() => vault.stop());
    const from = new FileTokenStore({ baseDir: dir });
    const to = new VaultTokenStore({ address: vault.address, token: "t" });

    const seen: string[] = [];
    const result = await migrate(from, to, { onRecord: (_auth, targetId) => seen.push(targetId) });
    expect(result.copied).toEqual(["claude.json", "disabled.json", "team/gemini.json"]);
    expect(result.failed).toEqual([]);
    expect(seen).toEqual(["claude.json", "disabled.json", "team/gemini.json"]);
    expect(vault.secrets.get("ai-proxy/auths/claude.json")?.data).toEqual({ type: "claude", access_token: "a", email: "me@example.com", disabled: false });
    // Disabled records are created on migration (creation intent).
    expect(vault.secrets.get("ai-proxy/auths/disabled.json")?.data).toEqual({ type: "codex", disabled: true });
    expect(vault.secrets.get("ai-proxy/auths/team/gemini.json")?.data).toEqual({ type: "gemini", token: { access_token: "g" }, disabled: false });

    const listed = await to.list();
    expect(listed.map((a) => [a.id, a.provider, a.attributes[AttributeSourceBackend]])).toEqual([
      ["claude.json", "claude", AuthSourceVault],
      ["disabled.json", "codex", AuthSourceVault],
      ["team/gemini.json", "gemini-cli", AuthSourceVault],
    ]);
    // Source records are untouched.
    const source = await from.list();
    expect(source.every((a) => a.attributes[AttributeSourceBackend] === AuthSourceFile)).toBe(true);
  });

  test("copies from Vault back to files, honours filter and dry-run", async () => {
    const vault = new FakeVault({ tokens: ["t"] });
    cleanups.push(() => vault.stop());
    vault.put("ai-proxy/auths/a.json", { type: "claude", access_token: "a" });
    vault.put("ai-proxy/auths/sub/b.json", { type: "codex", access_token: "b" });
    const from = new VaultTokenStore({ address: vault.address, token: "t" });
    const dir = tempDir();
    const to = new FileTokenStore({ baseDir: dir });

    const dry = await migrate(from, to, { dryRun: true });
    expect(dry.copied).toEqual(["a.json", "sub/b.json"]);
    expect(await to.list()).toEqual([]);

    const result = await migrate(from, to, { filter: (auth) => auth.id.startsWith("sub/") });
    expect(result.copied).toEqual(["sub/b.json"]);
    expect(result.skipped).toEqual(["a.json"]);
    const listed = await to.list();
    expect(listed.map((a) => a.id)).toEqual(["sub/b.json"]);
    expect(listed[0]!.attributes.path).toBe(join(dir, "sub", "b.json"));
    expect(listed[0]!.metadata).toEqual({ type: "codex", access_token: "b", disabled: false });
  });

  test("records that fail to save are reported without aborting the run", async () => {
    const dir = tempDir();
    const from = new FileTokenStore({ baseDir: dir });
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ type: "claude" }));
    writeFileSync(join(dir, "zz.json"), JSON.stringify({ type: "claude" }));
    const target = {
      kind: "memory",
      saved: [] as string[],
      async save(auth: ReturnType<typeof newAuth>) {
        if (auth.id === "ok.json") throw new Error("boom");
        this.saved.push(auth.id);
        return auth.id;
      },
      async list() {
        return [];
      },
      async delete() {},
    };
    const result = await migrate(from, target);
    expect(result.copied).toEqual(["zz.json"]);
    expect(result.failed).toEqual([{ id: "ok.json", error: "boom" }]);
    expect(target.saved).toEqual(["zz.json"]);
  });
});
