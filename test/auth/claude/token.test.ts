// Ported from: internal/auth/claude/token_test.go
// Skipped cases: file I/O of SaveTokenToFile (persistence is the TokenStore's job; the merged JSON object is checked instead)
import { describe, expect, test } from "bun:test";
import { claudeStorageToMetadata, createTokenStorage, type ClaudeTokenStorage } from "../../../src/auth/claude/token.ts";

describe("claudeStorageToMetadata", () => {
  test("preserves custom metadata", () => {
    const storage: ClaudeTokenStorage = {
      id_token: "",
      type: "claude",
      email: "user@example.com",
      access_token: "new-claude-access",
      refresh_token: "new-claude-refresh",
      expired: "2026-12-31T23:59:59Z",
      last_refresh: "2026-04-14T12:00:00Z",
    };
    const saved = claudeStorageToMetadata(storage, {
      disabled: false,
      prefix: "claude-prefix",
      note: "claude custom note",
      proxy_url: "http://proxy:8080",
      weight: 5,
    });
    expect(saved.access_token).toBe("new-claude-access");
    expect(saved.prefix).toBe("claude-prefix");
    expect(saved.note).toBe("claude custom note");
    expect(saved.proxy_url).toBe("http://proxy:8080");
    expect(saved.weight).toBe(5);
    expect(saved.type).toBe("claude");
    expect(saved.expired).toBe("2026-12-31T23:59:59Z");
    expect("account_uuid" in saved).toBe(false);
    expect("claude_device_ids" in saved).toBe(false);
  });

  test("createTokenStorage carries identity and device pool", () => {
    const storage = createTokenStorage({
      apiKey: "",
      tokenData: { accessToken: "a", refreshToken: "r", email: "e@x", accountUUID: "acc", organizationUUID: "org", organizationName: "Org", expire: "2026-01-01T00:00:00Z" },
      deviceIDs: ["d".repeat(64)],
      lastRefresh: "2025-12-31T00:00:00Z",
    });
    expect(storage).toEqual({
      id_token: "",
      access_token: "a",
      refresh_token: "r",
      last_refresh: "2025-12-31T00:00:00Z",
      email: "e@x",
      type: "claude",
      expired: "2026-01-01T00:00:00Z",
      account_uuid: "acc",
      organization_uuid: "org",
      organization_name: "Org",
      claude_device_ids: ["d".repeat(64)],
    });
    expect(Object.keys(claudeStorageToMetadata(storage)).sort()).toEqual(
      ["access_token", "account_uuid", "claude_device_ids", "email", "expired", "id_token", "last_refresh", "organization_name", "organization_uuid", "refresh_token", "type"],
    );
  });
});
