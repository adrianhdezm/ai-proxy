// Ported from: internal/config/claude_code_test.go, internal/config/claude_header_defaults_test.go,
//   internal/config/shared_upstream_test.go
// Skipped cases: TestParseConfigBytesClaudeCodeModelListCloaking (this port has no disable-cloaking-model-list
//   switch; model-list cloaking is off by default), the "legacy layout" rows of the model-level-cooling,
//   session-date-pin-days and tool-search tables (the legacy top-level claude: section is not read; only
//   upstream.claude), TestSaveConfigPreserveComments_* (config writing not carried),
//   TestClaudeSessionDatePinRetentionClampsOverflow (Go time.Duration overflow mechanic),
//   the StabilizeDeviceProfile assertion (device-profile learning not carried),
//   TestSharedUpstreamConfigSurvivesMigrationAndSnapshots legacy/historical rows and its migration/save half,
//   TestSharedUpstreamEmptyHistoricalContainers (v8 migration of oauth.providers.* not carried); codex
//   orphan-delegation-compatibility, response-steering and xai inject-x-search values (features not carried).
// Adapted cases: TestSharedUpstreamPresenceWinsOverHistoricalAliases uses the legacy claude-header-defaults
//   key as the historical spelling (oauth.providers.claude is not read by this port).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../../src/config/load.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function writeConfig(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-claude-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.yaml");
  writeFileSync(path, text);
  return path;
}

const opts = { env: {}, home: "/home/tester", warn: () => {} };

describe("TestParseConfigBytesClaudeModelLevelCooling", () => {
  for (const [name, yaml, want] of [
    ["defaults to false", "port: 8317\n", false],
    ["enables model-level cooling (v8 layout)", "upstream:\n  claude:\n    model-level-cooling: true\n", true],
  ] as const) {
    test(name, () => {
      expect(parseConfig(yaml, opts).upstream.claude.modelLevelCooling).toBe(want);
    });
  }
});

describe("TestParseConfigBytesClaudeSessionDatePinDays", () => {
  for (const [name, yaml, want] of [
    ["defaults to 7 days", "port: 8317\n", 7],
    ["v8 layout", "config-version: 8\nupstream:\n  claude:\n    session-date-pin-days: 7\n", 7],
    ["v8 explicit zero", "config-version: 8\nupstream:\n  claude:\n    session-date-pin-days: 0\n", 0],
  ] as const) {
    test(name, () => {
      expect(parseConfig(yaml, opts).upstream.claude.sessionDatePinDays).toBe(want);
    });
  }
});

describe("TestParseConfigBytesClaudeToolSearch", () => {
  for (const [name, yaml, want] of [
    ["defaults to false", "port: 8317\n", false],
    ["v8 layout", "config-version: 8\nupstream:\n  claude:\n    tool-search: true\n", true],
    ["v8 explicit false", "config-version: 8\nupstream:\n  claude:\n    tool-search: false\n", false],
  ] as const) {
    test(name, () => {
      expect(parseConfig(yaml, opts).upstream.claude.toolSearch).toBe(want);
    });
  }
});

test("TestLoadConfigOptional_ClaudeHeaderDefaults", async () => {
  const path = writeConfig(`
claude-header-defaults:
  user-agent: "  claude-cli/2.1.70 (external, cli)  "
  package-version: "  0.80.0  "
  runtime-version: "  v24.5.0  "
  os: "  MacOS  "
  arch: "  arm64  "
  timeout: "  900  "
  timezone: "  Pacific/Honolulu  "
  stabilize-device-profile: false
`);
  const cfg = await loadConfig(path, { ...opts, optional: false });
  const hd = cfg.upstream.claude.headerDefaults!;
  expect(hd.userAgent).toBe("claude-cli/2.1.70 (external, cli)");
  expect(hd.packageVersion).toBe("0.80.0");
  expect(hd.runtimeVersion).toBe("v24.5.0");
  expect(hd.os).toBe("MacOS");
  expect(hd.arch).toBe("arm64");
  expect(hd.timeout).toBe("900");
  expect(hd.timezone).toBe("Pacific/Honolulu");
});

test("TestParseConfigBytes_ClaudeHeaderDefaultsOperatorOverrides", () => {
  let cfg = parseConfig(
    `upstream:
  claude:
    header-defaults:
      anthropic-beta-strip: [" cache-diagnosis-2026-04-07 ", "", "cache-diagnosis-2026-04-07"]
      anthropic-beta-append: ["context-1m-2025-08-07", " context-1m-2025-08-07 ", "advisor-tool-2026-03-01"]
      inject-diagnostics: false
      client-request-id: " PassThrough "
`,
    opts,
  );
  const hd = cfg.upstream.claude.headerDefaults!;
  expect(hd.anthropicBetaStrip).toEqual(["cache-diagnosis-2026-04-07"]);
  expect(hd.anthropicBetaAppend).toEqual(["context-1m-2025-08-07", "advisor-tool-2026-03-01"]);
  expect(hd.injectDiagnostics).toBe(false);
  expect(hd.clientRequestId).toBe("passthrough");

  const warnings: string[] = [];
  cfg = parseConfig("claude-header-defaults: {client-request-id: sometimes}\n", { ...opts, warn: (m) => warnings.push(m) });
  expect(cfg.upstream.claude.headerDefaults?.clientRequestId ?? "").toBe("");
  expect(warnings.join("\n")).toContain("client-request-id");
});

test("TestSharedUpstreamConfigSurvivesMigrationAndSnapshots (upstream layout)", () => {
  const cfg = parseConfig(
    `upstream:
  codex: {disable-codex-cloaking: true, stream-bootstrap-buffering: true, stream-bootstrap-timeout: 10s, model-level-cooling: true}
  claude:
    model-level-cooling: true
    disable-claude-cloak-mode: true
    header-defaults: {user-agent: client-agent, package-version: 1.2.3, runtime-version: v22.1.0, os: Linux, arch: arm64, timeout: '123', timezone: Asia/Shanghai, stabilize-device-profile: true}
auth:
  auth-dir: client-auth
`,
    opts,
  );
  expect(cfg.auth.authDir).toBe("client-auth");
  expect(cfg.upstream.codex.disableCloaking).toBe(true);
  expect(cfg.upstream.codex.streamBootstrapBuffering).toBe(true);
  expect(cfg.upstream.codex.streamBootstrapTimeoutMs).toBe(10_000);
  expect(cfg.upstream.codex.modelLevelCooling).toBe(true);
  expect(cfg.upstream.claude.modelLevelCooling).toBe(true);
  expect(cfg.upstream.claude.disableCloakMode).toBe(true);
  expect(cfg.upstream.claude.headerDefaults).toEqual({
    userAgent: "client-agent",
    packageVersion: "1.2.3",
    runtimeVersion: "v22.1.0",
    os: "Linux",
    arch: "arm64",
    timeout: "123",
    timezone: "Asia/Shanghai",
  });
});

test("TestSharedUpstreamPresenceWinsOverHistoricalAliases", () => {
  for (const value of ["''", "null"]) {
    const cfg = parseConfig(
      `claude-header-defaults: {user-agent: historical-agent}\nupstream: {claude: {header-defaults: {user-agent: ${value}, stabilize-device-profile: false}}}\n`,
      opts,
    );
    expect(cfg.upstream.claude.headerDefaults?.userAgent ?? "").toBe("");
  }
});
