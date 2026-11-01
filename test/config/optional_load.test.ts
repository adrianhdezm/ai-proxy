// Ported from: internal/config/credential_in_flight_test.go
// Skipped cases: the CredentialInFlight / CredentialConcurrency assertions inside assertOptionalConfigFallback,
//   TestCredentialInFlightConfigContractFixture, TestCredentialInFlightConfigFixtureRejectsInvalidJSON,
//   TestCredentialInFlightConfigDurationBounds, TestCredentialInFlightConfigRejectsUnsafeBounds (Home in-flight
//   credential observation is not carried). The ported part is the LoadConfigOptional fallback itself.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../../src/config/load.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-optional-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const opts = { env: {}, home: "/home/tester", warn: () => {}, optional: true };

function assertOptionalConfigFallback(cfg: Awaited<ReturnType<typeof loadConfig>>, path: string): void {
  const want = defaultConfig();
  want.auth.authDir = "/home/tester/.ai-proxy";
  want.sourcePath = path;
  expect(cfg).toEqual(want);
}

test("TestLoadConfigOptionalMissingFallbackAppliesCredentialInFlightDefaults", async () => {
  const path = join(tempDir(), "missing.yaml");
  assertOptionalConfigFallback(await loadConfig(path, opts), path);
});

test("TestLoadConfigOptionalEmptyFallbackAppliesCredentialInFlightDefaults", async () => {
  const path = join(tempDir(), "config.yaml");
  writeFileSync(path, "");
  assertOptionalConfigFallback(await loadConfig(path, opts), path);
});

test("TestLoadConfigOptionalWhitespaceFallbackAppliesCredentialInFlightDefaults", async () => {
  const path = join(tempDir(), "config.yaml");
  writeFileSync(path, " \t\n\r ");
  assertOptionalConfigFallback(await loadConfig(path, opts), path);
});

test("TestLoadConfigOptionalInvalidFallbackAppliesCredentialInFlightDefaults", async () => {
  const path = join(tempDir(), "config.yaml");
  writeFileSync(path, ":");
  assertOptionalConfigFallback(await loadConfig(path, opts), path);
  // Bun's YAML parser reads ":" as a null key, so also check a document it cannot parse.
  writeFileSync(path, "port: [8317\n");
  assertOptionalConfigFallback(await loadConfig(path, opts), path);
  // Without optional the same file is an error.
  await expect(loadConfig(path, { ...opts, optional: false })).rejects.toThrow("failed to parse config file");
});
