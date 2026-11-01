// Ported from: internal/config/oauth_settings_test.go
// Skipped cases: TestSaveConfigPreserveComments_OAuthSettings (config writing not carried). Decoding goes
//   through parseConfig (YAML -> sanitised config) instead of
//   yaml.Unmarshal + SanitizeOAuthSettings.
import { expect, test } from "bun:test";
import { parseConfig, resolveOAuthModelSetting, sanitizeOAuthSettings } from "../../src/config/load.ts";

const opts = { env: {}, home: "/home/tester", warn: () => {} };

test("TestOAuthSettingsConfigDecoding_V8", () => {
  const cfg = parseConfig(
    `
config-version: 8
oauth:
  settings:
    codex:
      - name: "gpt-6-sol"
        max-context-length: 524288
      - name: "deepseek-v4-flash"
        max-context-length: 1048576
`,
    opts,
  );
  const codex = cfg.oauthSettings!.codex!;
  expect(codex).toHaveLength(2);
  expect(codex[0]).toMatchObject({ name: "gpt-6-sol", maxContextLength: 524288 });
  expect(codex[1]).toMatchObject({ name: "deepseek-v4-flash", maxContextLength: 1048576 });
});

test("TestOAuthSettingsConfigDecoding_Legacy", () => {
  const cfg = parseConfig(
    `
oauth-settings:
  codex:
    - name: "gpt-6-sol"
      max-context-length: 524288
`,
    opts,
  );
  const codex = cfg.oauthSettings!.codex!;
  expect(codex).toHaveLength(1);
  expect(codex[0]).toMatchObject({ name: "gpt-6-sol", maxContextLength: 524288 });
});

test("TestSanitizeOAuthSettings", () => {
  const out = sanitizeOAuthSettings({
    " CODEX ": [
      { name: "  gpt-6-sol  ", maxContextLength: 524288 },
      { name: "gpt-6-sol", maxContextLength: 999999 }, // duplicate name, same alias -> later entry wins
      { name: "   ", maxContextLength: 12345 }, // empty name
      { name: "deepseek-v4-flash", maxContextLength: 1048576 },
    ],
    "  ": [{ name: "ignored", maxContextLength: 100 }],
  });
  expect("  " in out).toBe(false);
  const codex = out.codex!;
  expect(codex).toHaveLength(2);
  expect(codex[0]).toMatchObject({ name: "gpt-6-sol", maxContextLength: 999999 });
  expect(codex[1]).toMatchObject({ name: "deepseek-v4-flash", maxContextLength: 1048576 });
});

test("TestParseConfigBytes_DuplicateOAuthSettingsLaterWins", () => {
  const cfg = parseConfig(
    `
config-version: 8
oauth:
  settings:
    codex:
      - name: "gpt-6-sol"
        max-context-length: 524288
      - name: "gpt-6-sol"
        max-context-length: 1048576
`,
    opts,
  );
  const codex = cfg.oauthSettings!.codex!;
  expect(codex).toHaveLength(1);
  expect(codex[0]!.maxContextLength).toBe(1048576);
});

test("TestSanitizeOAuthSettings_PreservesLastOccurrenceOrderWithInterleavedRules", () => {
  const raw = [
    { name: "upstream", alias: "", maxContextLength: 524288 },
    { name: "public", alias: "", maxContextLength: 600000 },
    { name: "upstream", alias: "", maxContextLength: 1048576 },
  ];
  expect(resolveOAuthModelSetting(raw, "public", "upstream", "")?.maxContextLength).toBe(1048576);
  const codex = sanitizeOAuthSettings({ codex: raw }).codex!;
  expect(codex).toHaveLength(2);
  expect(codex[0]).toMatchObject({ name: "public", maxContextLength: 600000 });
  expect(codex[1]).toMatchObject({ name: "upstream", maxContextLength: 1048576 });
  expect(resolveOAuthModelSetting(codex, "public", "upstream", "")?.maxContextLength).toBe(1048576);
});

test("TestResolveOAuthModelSetting_Priority", () => {
  const settings = [
    { name: "upstream", alias: "", maxContextLength: 524288 },
    { name: "upstream", alias: "public", maxContextLength: 1048576 },
  ];
  expect(resolveOAuthModelSetting(settings, "upstream", "upstream", "")?.maxContextLength).toBe(524288);
  expect(resolveOAuthModelSetting(settings, "public", "upstream", "")?.maxContextLength).toBe(1048576);
  expect(resolveOAuthModelSetting(settings, "unknown", "", "")).toBeUndefined();
});
