// Ported from: sdk/auth/filestore_proxy_test.go
// Skipped cases: none (the DefaultTransport interception is expressed by
//   counting globalThis.fetch calls during list()).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("List loads proxy URL and prefix from metadata", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "antigravity.json"),
    `{
      "type": "antigravity",
      "proxy_url": "http://127.0.0.1:7890",
      "prefix": "custom-prefix",
      "project_id": "test-project",
      "access_token": "ya29.test-token"
    }`,
    { mode: 0o600 },
  );
  const store = new FileTokenStore({ baseDir: dir });
  const auths = await store.list();
  expect(auths.length).toBe(1);
  expect(auths[0]!.proxyUrl).toBe("http://127.0.0.1:7890");
  expect(auths[0]!.prefix).toBe("custom-prefix");
});

test("List does not perform network requests on cold start", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });

  const dir = tempDir();
  // Gemini-type file without project_id: v7.0.12 fetched the project id here; this port must not.
  writeFileSync(
    join(dir, "gemini.json"),
    `{"type":"gemini","proxy_url":"http://127.0.0.1:9999","token":{"access_token":"ya29.test-token","refresh_token":"r"}}`,
    { mode: 0o600 },
  );
  const store = new FileTokenStore({ baseDir: dir });
  const auths = await store.list();
  expect(auths.length).toBe(1);
  expect(auths[0]!.provider).toBe("gemini-cli");
  expect(auths[0]!.proxyUrl).toBe("http://127.0.0.1:9999");
  expect(fetchCalls).toBe(0);
});
