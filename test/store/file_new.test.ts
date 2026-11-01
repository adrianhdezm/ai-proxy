// New (no upstream test): file store behaviour specific to this port
// (gemini files kept, nested ids, atomic writes, record shape helpers).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttributePath, AttributeSourceBackend, AttributeWeight, AuthSourceFile, StatusActive, StatusDisabled, newAuth } from "../../src/auth/types.ts";
import { FileTokenStore, idFor } from "../../src/store/file.ts";
import { providerFromRecordType, recordFromAuth, recordTypeFromProvider } from "../../src/store/record.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-filestore-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("provider mapping", () => {
  test("type -> provider", () => {
    expect(providerFromRecordType("claude")).toBe("claude");
    expect(providerFromRecordType("codex")).toBe("codex");
    expect(providerFromRecordType("gemini")).toBe("gemini-cli");
    expect(providerFromRecordType("gemini-cli")).toBe("gemini-cli");
    expect(providerFromRecordType(" Claude ")).toBe("claude");
    expect(providerFromRecordType("")).toBe("unknown");
    expect(providerFromRecordType("antigravity")).toBe("antigravity");
  });

  test("provider -> type", () => {
    expect(recordTypeFromProvider("gemini-cli")).toBe("gemini");
    expect(recordTypeFromProvider("claude")).toBe("claude");
    expect(recordTypeFromProvider("codex")).toBe("codex");
  });
});

describe("FileTokenStore.list", () => {
  test("keeps gemini files (v7.0.12 behaviour) and maps them to gemini-cli", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "gemini.json"), JSON.stringify({ type: "gemini", token: { access_token: "a" }, project_id: "p", email: "e@x" }));
    writeFileSync(join(dir, "claude.json"), JSON.stringify({ type: "claude", access_token: "a" }));
    writeFileSync(join(dir, "codex.json"), JSON.stringify({ type: "codex", access_token: "a", disabled: true }));
    const store = new FileTokenStore({ baseDir: dir });
    const auths = await store.list();
    expect(auths.map((a) => [a.id, a.provider, a.status])).toEqual([
      ["claude.json", "claude", StatusActive],
      ["codex.json", "codex", StatusDisabled],
      ["gemini.json", "gemini-cli", StatusActive],
    ]);
    const gemini = auths[2]!;
    expect(gemini.label).toBe("e@x");
    expect(gemini.attributes.email).toBe("e@x");
    expect(gemini.attributes[AttributePath]).toBe(join(dir, "gemini.json"));
    expect(gemini.attributes[AttributeSourceBackend]).toBe(AuthSourceFile);
    expect(gemini.createdAt).toBe(Math.trunc(statSync(join(dir, "gemini.json")).mtimeMs));
    expect(gemini.metadata).toEqual({ type: "gemini", token: { access_token: "a" }, project_id: "p", email: "e@x" });
  });

  test("scans nested directories, uses the relative path as id and ignores non-JSON", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "team-a", "deep"), { recursive: true });
    writeFileSync(join(dir, "team-a", "deep", "codex.JSON"), JSON.stringify({ type: "codex" }));
    writeFileSync(join(dir, "team-a", "claude.json"), JSON.stringify({ type: "claude" }));
    writeFileSync(join(dir, "notes.txt"), "{}");
    writeFileSync(join(dir, "empty.json"), "");
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeFileSync(join(dir, "array.json"), "[1,2]");
    const store = new FileTokenStore({ baseDir: dir });
    const auths = await store.list();
    expect(auths.map((a) => a.id)).toEqual(["team-a/claude.json", "team-a/deep/codex.JSON"]);
    expect(idFor(join(dir, "x", "y.json"), dir)).toBe("x/y.json");
  });

  test("label precedence, prefix sanitising, headers and weight attributes", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.json"), JSON.stringify({ type: "claude", label: "named", email: "e", prefix: "/team/", headers: { "X-A": " 1 ", "": "x", "X-B": 2 }, weight: 3, priority: " 2 " }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ type: "claude", prefix: "a/b", project_id: "proj" }));
    const store = new FileTokenStore({ baseDir: dir });
    const [a, b] = await store.list();
    expect(a!.label).toBe("named");
    expect(a!.prefix).toBe("team");
    expect(a!.attributes["header:X-A"]).toBe("1");
    expect("header:X-B" in a!.attributes).toBe(false);
    expect(a!.attributes[AttributeWeight]).toBe("3");
    expect(a!.attributes.priority).toBe("2");
    expect(b!.label).toBe("proj");
    expect(b!.prefix).toBe("");
  });

  test("missing directory lists nothing; unconfigured directory throws", async () => {
    const dir = join(tempDir(), "does-not-exist");
    expect(await new FileTokenStore({ baseDir: dir }).list()).toEqual([]);
    await expect(new FileTokenStore({ baseDir: "" }).list()).rejects.toThrow("directory not configured");
  });
});

describe("FileTokenStore.save", () => {
  test("creates the directory, writes atomically with mode 0600 and leaves no temp files", async () => {
    const dir = join(tempDir(), "nested", "auths");
    const store = new FileTokenStore({ baseDir: dir });
    const auth = newAuth({ id: "team/claude.json", provider: "claude", metadata: { access_token: "a" } });
    const path = await store.save(auth);
    expect(path).toBe(join(dir, "team", "claude.json"));
    expect(readdirSync(join(dir, "team"))).toEqual(["claude.json"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ access_token: "a", type: "claude", disabled: false });
  });

  test("fills type from provider and routing fields from the Auth when metadata lacks them", () => {
    const auth = newAuth({ id: "g.json", provider: "gemini-cli", prefix: "team", proxyUrl: "http://p", label: "lbl", metadata: { token: { access_token: "x" } } });
    expect(recordFromAuth(auth)).toEqual({ token: { access_token: "x" }, type: "gemini", disabled: false, proxy_url: "http://p", prefix: "team", label: "lbl" });
    const explicit = newAuth({ id: "c.json", provider: "claude", label: "lbl", metadata: { type: "anthropic", email: "me" } });
    expect(recordFromAuth(explicit)).toEqual({ type: "anthropic", email: "me", disabled: false });
  });

  test("honours an explicit path attribute and absolute ids", async () => {
    const dir = tempDir();
    const store = new FileTokenStore({ baseDir: join(dir, "unused") });
    const explicit = newAuth({ id: "ignored.json", provider: "claude", metadata: {}, attributes: { path: join(dir, "explicit.json") } });
    expect(await store.save(explicit)).toBe(join(dir, "explicit.json"));
    const absolute = newAuth({ id: join(dir, "absolute.json"), provider: "claude", metadata: {} });
    expect(await store.save(absolute)).toBe(join(dir, "absolute.json"));
    expect(existsSync(join(dir, "unused"))).toBe(false);
  });

  test("round trip through list preserves the document and id", async () => {
    const dir = tempDir();
    const store = new FileTokenStore({ baseDir: dir });
    const auth = newAuth({ id: "codex.json", provider: "codex", metadata: { type: "codex", access_token: "a", refresh_token: "r", expired: "2026-01-01T00:00:00Z" } });
    await store.save(auth);
    const [listed] = await store.list();
    expect(listed!.id).toBe("codex.json");
    expect(listed!.provider).toBe("codex");
    expect(listed!.metadata).toEqual({ type: "codex", access_token: "a", refresh_token: "r", expired: "2026-01-01T00:00:00Z", disabled: false });
    expect(listed!.attributes[AttributePath]).toBe(join(dir, "codex.json"));
  });

  test("concurrent saves to the same file never corrupt it", async () => {
    const dir = tempDir();
    const store = new FileTokenStore({ baseDir: dir });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.save(newAuth({ id: "same.json", provider: "claude", metadata: { type: "claude", n: i, pad: "x".repeat(2000) } }))),
    );
    const doc = JSON.parse(readFileSync(join(dir, "same.json"), "utf8"));
    expect(doc.type).toBe("claude");
    expect(readdirSync(dir)).toEqual(["same.json"]);
  });
});

describe("FileTokenStore.delete", () => {
  test("removes by id, by nested id and by absolute path; missing ids are fine", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "team"));
    writeFileSync(join(dir, "a.json"), "{}");
    writeFileSync(join(dir, "team", "b.json"), "{}");
    writeFileSync(join(dir, "c.json"), "{}");
    const store = new FileTokenStore({ baseDir: dir });
    await store.delete("a.json");
    await store.delete("team/b.json");
    await store.delete(join(dir, "c.json"));
    await store.delete("missing.json");
    expect(existsSync(join(dir, "a.json"))).toBe(false);
    expect(existsSync(join(dir, "team", "b.json"))).toBe(false);
    expect(existsSync(join(dir, "c.json"))).toBe(false);
    await expect(store.delete("  ")).rejects.toThrow("id is empty");
  });
});
