// Ported from: sdk/auth/filestore_test.go
// Skipped cases: TestFileTokenStoreListExpandsPluginMultiAuths, TestFileTokenStoreListAppliesSourcePriorityToPluginAuths,
//   TestFileTokenStoreListAppliesSourceDisabledToPluginMultiAuths, TestFileTokenStoreListPluginHandledEmptySuppressesBuiltin
//   (plugin auth parsers are out of scope), TestFileTokenStoreSaveReadModifyWritePreservesSIWC (CodexRefreshPatch is not
//   part of the Auth contract). TestFileTokenStoreListSkipsInvalidPluginSourceWeight is ported without the plugin parser.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttributePath, AttributeSource, AttributeSourceBackend, AuthSourceFile, newAuth } from "../../src/auth/types.ts";
import { FileTokenStore } from "../../src/store/file.ts";
import { extractAccessToken, jsonEqual } from "../../src/store/record.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-filestore-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("extractAccessToken", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["antigravity top-level access_token", { access_token: "tok-abc" }, "tok-abc"],
    ["gemini nested token.access_token", { token: { access_token: "tok-nested" } }, "tok-nested"],
    ["top-level takes precedence over nested", { access_token: "tok-top", token: { access_token: "tok-nested" } }, "tok-top"],
    ["empty metadata", {}, ""],
    ["whitespace-only access_token", { access_token: "   " }, ""],
    ["wrong type access_token", { access_token: 12345 }, ""],
    ["token is not a map", { token: "not-a-map" }, ""],
    ["nested whitespace-only", { token: { access_token: "  " } }, ""],
    ["fallback to nested when top-level empty", { access_token: "", token: { access_token: "tok-fallback" } }, "tok-fallback"],
  ];
  for (const [name, metadata, expected] of cases) {
    test(name, () => {
      expect(extractAccessToken(metadata)).toBe(expected);
    });
  }
});

describe("FileTokenStore save existing metadata sets file attributes", () => {
  const cases = [
    { name: "unchanged content", existingToken: "token", savedToken: "token" },
    { name: "overwritten content", existingToken: "old-token", savedToken: "new-token" },
  ];
  for (const tt of cases) {
    test(tt.name, async () => {
      const baseDir = tempDir();
      const fileName = "antigravity-user.json";
      const path = join(baseDir, fileName);
      writeFileSync(path, `{"type":"antigravity","access_token":"${tt.existingToken}","disabled":false}`, { mode: 0o600 });

      const store = new FileTokenStore({ baseDir });
      const auth = newAuth({ id: fileName, provider: "antigravity", metadata: { type: "antigravity", access_token: tt.savedToken } });
      const savedPath = await store.save(auth);
      expect(savedPath).toBe(path);
      expect(auth.attributes[AttributePath]).toBe(path);
      expect(auth.attributes[AttributeSource]).toBe(path);
      expect(auth.attributes[AttributeSourceBackend]).toBe(AuthSourceFile);
      const persisted = JSON.parse(readFileSync(path, "utf8"));
      expect(jsonEqual(persisted, { type: "antigravity", access_token: tt.savedToken, disabled: false })).toBe(true);
    });
  }
});

describe("FileTokenStore normalizes legacy credential metadata", () => {
  test("save", async () => {
    const baseDir = tempDir();
    const store = new FileTokenStore({ baseDir });
    const auth = newAuth({
      id: "legacy-save.json",
      provider: "codex",
      metadata: { type: "codex", "request-retry": 2, request_retry: 0, "disable-cooling": true },
    });
    const path = await store.save(auth);
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted).toEqual({ type: "codex", request_retry: 0, disable_cooling: true, disabled: false });
  });

  test("list", async () => {
    const baseDir = tempDir();
    writeFileSync(join(baseDir, "legacy-list.json"), `{"type":"codex","request-retry":2,"disable-cooling":true}`, { mode: 0o600 });
    const store = new FileTokenStore({ baseDir });
    const auths = await store.list();
    expect(auths.length).toBe(1);
    expect(auths[0]!.metadata.request_retry).toBe(2);
    expect(auths[0]!.metadata.disable_cooling).toBe(true);
    expect("request-retry" in auths[0]!.metadata).toBe(false);
    expect("disable-cooling" in auths[0]!.metadata).toBe(false);
  });
});

test("FileTokenStore save rejects invalid weight", async () => {
  const baseDir = tempDir();
  const store = new FileTokenStore({ baseDir });
  const auth = newAuth({ id: "invalid.json", provider: "test", metadata: { type: "test", weight: 1.5 } });
  await expect(store.save(auth)).rejects.toThrow("weight");
  expect(existsSync(join(baseDir, "invalid.json"))).toBe(false);
});

test("FileTokenStore list skips a persisted source with an invalid weight", async () => {
  const baseDir = tempDir();
  writeFileSync(join(baseDir, "plugin.json"), `{"type":"plugin","weight":"invalid"}`, { mode: 0o600 });
  const store = new FileTokenStore({ baseDir });
  const auths = await store.list();
  expect(auths).toEqual([]);
});

test("FileTokenStore save allows deleting non-credential metadata", async () => {
  const baseDir = tempDir();
  const fileName = "codex-proxy.json";
  const path = join(baseDir, fileName);
  writeFileSync(
    path,
    `{"type":"codex","access_token":"outer-1","proxy_url":"http://old-proxy:8080","use_siwc":true,"siwc":{"access_token":"siwc-1","refresh_token":"siwc-ref-1","client_id":"oaiapp_1"}}`,
    { mode: 0o600 },
  );
  const store = new FileTokenStore({ baseDir });
  const auth = newAuth({
    id: fileName,
    provider: "codex",
    metadata: {
      type: "codex",
      access_token: "outer-1",
      use_siwc: true,
      siwc: { access_token: "siwc-1", refresh_token: "siwc-ref-1", client_id: "oaiapp_1" },
    },
  });
  await store.save(auth);
  expect("proxy_url" in auth.metadata).toBe(false);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  expect("proxy_url" in persisted).toBe(false);
});
