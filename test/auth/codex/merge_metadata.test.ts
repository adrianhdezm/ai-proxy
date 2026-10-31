// Ported from: internal/misc/credentials_test.go
// Skipped cases: none. MergeMetadata's job (token storage fields overlaid with the auth's extra metadata) is
//   done by codexStorageToMetadata in this port.
import { expect, test } from "bun:test";
import { codexStorageToMetadata } from "../../../src/auth/codex/token.ts";

test("TestMergeMetadata", () => {
  const result = codexStorageToMetadata(
    { id_token: "", access_token: "token-123", refresh_token: "", account_id: "", last_refresh: "", email: "", type: "codex", expired: "" },
    { disabled: false, email: "test@example.com", prefix: "custom-prefix", websockets: false, note: "custom note" },
  );
  expect(result.type).toBe("codex");
  expect(result.access_token).toBe("token-123");
  expect(result.disabled).toBe(false);
  expect(result.email).toBe("test@example.com");
  expect(result.prefix).toBe("custom-prefix");
  expect(result.websockets).toBe(false);
  expect(result.note).toBe("custom note");
});
