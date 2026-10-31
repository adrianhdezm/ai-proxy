// Claude device identity pool. Port of internal/auth/claude/identity.go.
// The Go version guards Auth.Metadata with a mutex because a credential is
// shared by concurrent goroutines; JS is single threaded so the lock is gone,
// but the defensive copying of the pool is kept.

export const ClaudeDeviceIDsMetadataKey = "claude_device_ids";
export const ClaudeDevicePoolSize = 1;
const claudeDeviceIDByteSize = 32;

function generateDeviceID(): string {
  const bytes = new Uint8Array(claudeDeviceIDByteSize);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Creates the fixed-size device pool stored with a Claude credential. */
export function generateDeviceIDPool(): string[] {
  const deviceIDs: string[] = [];
  const seen = new Set<string>();
  while (deviceIDs.length < ClaudeDevicePoolSize) {
    const id = generateDeviceID();
    if (seen.has(id)) continue;
    seen.add(id);
    deviceIDs.push(id);
  }
  return deviceIDs;
}

/** Reports whether a value matches Claude Code's lowercase 64-hex device format. */
export function validDeviceID(value: string): boolean {
  return value.length === claudeDeviceIDByteSize * 2 && /^[0-9a-f]+$/.test(value);
}

function stringValues(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/** Returns the first valid device ID in canonical (trimmed, lowercase) form. */
export function normalizeDeviceIDPool(raw: unknown): string[] {
  const values = stringValues(raw);
  if (!values) return [];
  const deviceIDs: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = value.trim().toLowerCase();
    if (!validDeviceID(id) || seen.has(id)) continue;
    seen.add(id);
    deviceIDs.push(id);
    if (deviceIDs.length === ClaudeDevicePoolSize) break;
  }
  return deviceIDs;
}

/** Reports whether raw stores exactly one valid device ID, already canonical. */
export function hasCanonicalDeviceIDPool(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  for (const v of raw) if (typeof v !== "string") return false;
  const values = raw as string[];
  const normalized = normalizeDeviceIDPool(values);
  return values.length === ClaudeDevicePoolSize && normalized.length === ClaudeDevicePoolSize && values[0] === normalized[0];
}

/**
 * Repairs or creates the single-device pool in credential metadata. Returns a
 * copy of the pool and whether the metadata was changed.
 */
export function ensureDeviceIDPool(metadata: Record<string, unknown>): { deviceIDs: string[]; changed: boolean } {
  const raw = metadata[ClaudeDeviceIDsMetadataKey];
  const deviceIDs = normalizeDeviceIDPool(raw);
  const changed = !hasCanonicalDeviceIDPool(raw);
  const seen = new Set(deviceIDs);
  while (deviceIDs.length < ClaudeDevicePoolSize) {
    const id = generateDeviceID();
    if (seen.has(id)) continue;
    seen.add(id);
    deviceIDs.push(id);
  }
  if (changed) metadata[ClaudeDeviceIDsMetadataKey] = [...deviceIDs];
  return { deviceIDs: [...deviceIDs], changed };
}

/** Returns a copy of the stored pool value (arrays are copied, other values returned as is). */
export function readDeviceIDPool(metadata: Record<string, unknown> | undefined): unknown {
  if (!metadata) return undefined;
  const stored = metadata[ClaudeDeviceIDsMetadataKey];
  return Array.isArray(stored) ? [...stored] : stored;
}

/** Stores a defensive copy of deviceIDs. */
export function storeDeviceIDPool(metadata: Record<string, unknown>, deviceIDs: string[]): void {
  metadata[ClaudeDeviceIDsMetadataKey] = [...deviceIDs];
}

/** Returns the credential's sole device ID after validating the conversation session. */
export function selectDeviceID(deviceIDs: string[], sessionID: string): string {
  const normalized = normalizeDeviceIDPool(deviceIDs);
  if (normalized.length !== ClaudeDevicePoolSize) {
    throw new Error(`select Claude device ID: device pool has ${normalized.length} entries, want ${ClaudeDevicePoolSize}`);
  }
  if (sessionID.trim() === "") throw new Error("select Claude device ID: session ID is empty");
  return normalized[0]!;
}
