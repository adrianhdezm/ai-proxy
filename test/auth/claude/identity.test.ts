// Ported from: internal/auth/claude/identity_test.go
// Skipped cases: TestEnsureDeviceIDPoolConcurrentInitialization (goroutine race on a mutex; ported as repeated sequential calls)
import { describe, expect, test } from "bun:test";
import {
  ClaudeDeviceIDsMetadataKey,
  ClaudeDevicePoolSize,
  ensureDeviceIDPool,
  generateDeviceIDPool,
  hasCanonicalDeviceIDPool,
  normalizeDeviceIDPool,
  readDeviceIDPool,
  selectDeviceID,
  storeDeviceIDPool,
  validDeviceID,
} from "../../../src/auth/claude/identity.ts";

describe("device id pool", () => {
  test("generateDeviceIDPool yields unique lowercase 64-hex ids", () => {
    const ids = generateDeviceIDPool();
    expect(ids).toHaveLength(ClaudeDevicePoolSize);
    const seen = new Set<string>();
    for (const id of ids) {
      expect(validDeviceID(id)).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  test("readDeviceIDPool returns a defensive copy", () => {
    const metadata: Record<string, unknown> = {};
    const input = ["device-a", "device-b", "device-c"];
    storeDeviceIDPool(metadata, input);
    input[0] = "mutated-input";
    const stored = readDeviceIDPool(metadata) as string[];
    expect(stored[0]).toBe("device-a");
    stored[0] = "hijacked-device-id";
    expect((readDeviceIDPool(metadata) as string[])[0]).toBe("device-a");

    const jsonMetadata = { [ClaudeDeviceIDsMetadataKey]: ["json-a", "json-b"] as unknown[] };
    const jsonStored = readDeviceIDPool(jsonMetadata) as unknown[];
    jsonStored[0] = "hijacked";
    expect((readDeviceIDPool(jsonMetadata) as unknown[])[0]).toBe("json-a");
  });

  test("ensureDeviceIDPool repairs and stabilizes credential metadata", () => {
    const first = "a".repeat(64);
    const metadata: Record<string, unknown> = { [ClaudeDeviceIDsMetadataKey]: [first, first, "INVALID"] };
    const { deviceIDs, changed } = ensureDeviceIDPool(metadata);
    expect(changed).toBe(true);
    expect(deviceIDs).toEqual([first]);

    const second = ensureDeviceIDPool(metadata);
    expect(second.changed).toBe(false);
    expect(second.deviceIDs).toEqual(deviceIDs);

    second.deviceIDs[0] = "b".repeat(64);
    expect((metadata[ClaudeDeviceIDsMetadataKey] as string[])[0]).toBe(first);
  });

  test("ensureDeviceIDPool canonicalizes a single device", () => {
    const canonical = "a".repeat(64);
    const metadata: Record<string, unknown> = { [ClaudeDeviceIDsMetadataKey]: [`  ${"A".repeat(64)}  `] };
    const { deviceIDs, changed } = ensureDeviceIDPool(metadata);
    expect(changed).toBe(true);
    expect(deviceIDs).toEqual([canonical]);
    expect(hasCanonicalDeviceIDPool(metadata[ClaudeDeviceIDsMetadataKey])).toBe(true);
  });

  test("ensureDeviceIDPool migrates five slots to one", () => {
    const metadata: Record<string, unknown> = { [ClaudeDeviceIDsMetadataKey]: ["0", "1", "2", "3", "4"].map((c) => c.repeat(64)) };
    const { deviceIDs, changed } = ensureDeviceIDPool(metadata);
    expect(changed).toBe(true);
    expect(deviceIDs).toEqual(["0".repeat(64)]);
    expect(metadata[ClaudeDeviceIDsMetadataKey]).toEqual(["0".repeat(64)]);
  });

  test("ensureDeviceIDPool initialization is stable across repeated calls", () => {
    const metadata: Record<string, unknown> = {};
    const results: string[][] = [];
    for (let i = 0; i < 20; i++) results.push(ensureDeviceIDPool(metadata).deviceIDs);
    const stored = normalizeDeviceIDPool(metadata[ClaudeDeviceIDsMetadataKey]);
    expect(stored).toHaveLength(ClaudeDevicePoolSize);
    for (const r of results) expect(r).toEqual(stored);
  });

  test("selectDeviceID uses one device across sessions", () => {
    const deviceIDs = ["0".repeat(64)];
    const first = selectDeviceID(deviceIDs, "11111111-2222-4333-8444-555555555555");
    const second = selectDeviceID(deviceIDs, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(first).toBe(second);
    expect(first).toBe(deviceIDs[0]!);
    expect(() => selectDeviceID(deviceIDs, " ")).toThrow("session ID is empty");
    expect(() => selectDeviceID([], "s")).toThrow("device pool has 0 entries");
  });
});
