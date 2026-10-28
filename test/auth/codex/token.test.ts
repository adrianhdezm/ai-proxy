// Ported from: internal/auth/codex/token_test.go
// Skipped cases: file I/O and locking of SaveTokenToFile (persistence is the TokenStore's job; the merged JSON object and the disk-merge rules are checked instead)
import { describe, expect, test } from "bun:test";
import { codexStorageToMetadata, mergeCodexCredentialsFromDisk, mergeWithDiskMap, type CodexTokenStorage } from "../../../src/auth/codex/token.ts";

describe("codexStorageToMetadata", () => {
  test("preserves custom metadata", () => {
    const storage: CodexTokenStorage = {
      type: "codex",
      email: "user@example.com",
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      id_token: "new-id-token",
      account_id: "new-account",
      expired: "2026-12-31T23:59:59Z",
      last_refresh: "2026-04-14T12:00:00Z",
    };
    const saved = codexStorageToMetadata(storage, {
      disabled: false,
      prefix: "my-prefix",
      websockets: false,
      note: "my important note",
      proxy_url: "http://proxy:8080",
      weight: 42,
    });
    expect(saved.access_token).toBe("new-access-token");
    expect(saved.refresh_token).toBe("new-refresh-token");
    expect(saved.id_token).toBe("new-id-token");
    expect(saved.account_id).toBe("new-account");
    expect(saved.prefix).toBe("my-prefix");
    expect(saved.websockets).toBe(false);
    expect(saved.note).toBe("my important note");
    expect(saved.proxy_url).toBe("http://proxy:8080");
    expect(saved.weight).toBe(42);
    expect(saved.type).toBe("codex");
  });
});

describe("mergeWithDiskMap", () => {
  test("disk credentials win over a settings snapshot", () => {
    const disk = { access_token: "disk-at", refresh_token: "disk-rt", last_refresh: "x", prefix: "old", siwc: { access_token: "s" } };
    const incoming = { access_token: "mem-at", prefix: "new", note: "", siwc: { access_token: "mem" }, use_siwc: true };
    const merged = mergeWithDiskMap(disk, incoming);
    expect(merged.access_token).toBe("disk-at");
    expect(merged.refresh_token).toBe("disk-rt");
    expect(merged.prefix).toBe("new");
    expect(merged.siwc).toEqual({ access_token: "s" });
    expect(merged.use_siwc).toBe(true);
    // A blank incoming value only yields to disk when disk has the key; otherwise it is written as is.
    expect(merged.note).toBe("");
    expect(mergeWithDiskMap({ note: "kept" }, { note: "  " }).note).toBe("kept");
  });

  test("an empty disk map takes the incoming snapshot as is", () => {
    expect(mergeWithDiskMap({}, { access_token: "a", prefix: "p" })).toEqual({ access_token: "a", prefix: "p" });
  });
});

describe("mergeCodexCredentialsFromDisk", () => {
  test("disk OAuth credentials are protected during config saves", () => {
    const disk = { refresh_token: "disk-rt", access_token: "disk-at", email: "e", siwc: { client_id: "c" }, use_siwc: false };
    const merged = mergeCodexCredentialsFromDisk(disk, { access_token: "mem", prefix: "p", plan_type: "pro" });
    expect(merged.access_token).toBe("disk-at");
    expect(merged.refresh_token).toBe("disk-rt");
    expect(merged.email).toBe("e");
    expect("plan_type" in merged).toBe(false);
    expect(merged.prefix).toBe("p");
    expect(merged.siwc).toEqual({ client_id: "c" });
    expect(merged.use_siwc).toBe(false);
  });

  test("without disk OAuth credentials only blanks are filled from disk", () => {
    const merged = mergeCodexCredentialsFromDisk({ email: "disk@example.com", plan_type: "free" }, { email: "", plan_type: "team" });
    expect(merged.email).toBe("disk@example.com");
    expect(merged.plan_type).toBe("team");
  });
});
