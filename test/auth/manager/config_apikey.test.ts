// Ported from: sdk/cliproxy/auth/config_apikey_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { isConfigAPIKeyAuth } from "../../../src/auth/manager/index.ts";
import { auth } from "./helpers.ts";

test("IsConfigAPIKeyAuth", () => {
  expect(isConfigAPIKeyAuth(undefined)).toBe(false);
  expect(isConfigAPIKeyAuth(auth({ id: "x", attributes: { source: "config:codex[x]" } }))).toBe(false);
  expect(isConfigAPIKeyAuth(auth({ id: "codex:oauth:abc", provider: "codex", attributes: { auth_kind: "oauth", api_key: "k", source: "config:codex[abc]" } }))).toBe(false);
  expect(isConfigAPIKeyAuth(auth({ id: "codex:apikey:abc", provider: "codex", attributes: { auth_kind: "apikey", source: "config:codex[abc]" } }))).toBe(true);
  expect(isConfigAPIKeyAuth(auth({ id: "codex:apikey:abc", provider: "codex", attributes: { api_key: "k", source: "config:codex[abc]" } }))).toBe(true);
});
