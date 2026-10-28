// Ported from: sdk/auth/filestore_disabled_test.go
// Skipped cases: none (the TokenStorage-backed variants are expressed through
//   Auth.metadata, the only persistence path kept in this port).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newAuth } from "../../src/auth/types.ts";
import { FileTokenStore } from "../../src/store/file.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-filestore-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Save disabled persists flag for existing file", async () => {
  const baseDir = tempDir();
  const path = join(baseDir, "disabled.json");
  writeFileSync(path, `{"type":"test","disabled":true}`, { mode: 0o600 });
  const store = new FileTokenStore({ baseDir });
  const auth = newAuth({ id: "disabled.json", provider: "test", disabled: true, metadata: { type: "test" } });
  await store.save(auth);
  const meta = JSON.parse(readFileSync(path, "utf8"));
  expect(meta.disabled).toBe(true);
});

test("Save disabled login creates canonical file", async () => {
  const baseDir = tempDir();
  const path = join(baseDir, "canonical-disabled.json");
  const store = new FileTokenStore({ baseDir });
  const auth = newAuth({ id: "canonical-disabled.json", provider: "test", disabled: true, metadata: { type: "test" } });
  const savedPath = await store.save(auth, { createDisabled: true });
  expect(savedPath).toBe(path);
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  expect(metadata.disabled).toBe(true);
});

test("Save disabled runtime update does not recreate missing file", async () => {
  const baseDir = tempDir();
  const path = join(baseDir, "removed-disabled.json");
  const store = new FileTokenStore({ baseDir });
  const auth = newAuth({ id: "removed-disabled.json", provider: "test", disabled: true, metadata: { type: "test" } });
  const savedPath = await store.save(auth);
  expect(savedPath).toBe("");
  expect(existsSync(path)).toBe(false);
});
