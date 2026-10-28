// Partition-aware refresh patch for Codex credential files. Port of
// internal/auth/codex/refresh_patch.go. A patch records the credential
// versions before/after a refresh so it can be overlaid on a disk snapshot
// that another process may have rotated in the meantime.
import { cloneStringAnyMap, codexOuterCredentialKeys } from "./token.ts";

type AnyMap = Record<string, unknown>;

const codexSIWCCredentialKeys = ["access_token", "refresh_token", "id_token", "client_id", "device_id", "expired", "expires_at", "last_refresh", "scope", "scopes"] as const;

function credentialFields(metadata: AnyMap | undefined, keys: readonly string[]): AnyMap {
  const fields: AnyMap = {};
  if (metadata) {
    for (const key of keys) if (key in metadata) fields[key] = metadata[key];
  }
  return cloneStringAnyMap(fields);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ak = Object.keys(a as AnyMap);
    const bk = Object.keys(b as AnyMap);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual((a as AnyMap)[k], (b as AnyMap)[k]));
  }
  return false;
}

function sameCredentialVersion(a: AnyMap | undefined, b: AnyMap | undefined): boolean {
  for (const key of ["access_token", "refresh_token", "id_token", "account_id", "client_id", "device_id"]) {
    if (!deepEqual(a?.[key], b?.[key])) return false;
  }
  return true;
}

function matchesBaselineOrAfter(target: AnyMap | undefined, memBefore: AnyMap | undefined, diskBefore: AnyMap | undefined, after: AnyMap | undefined): AnyMap | undefined {
  if (diskBefore && Object.keys(diskBefore).length > 0 && sameCredentialVersion(target, diskBefore)) return diskBefore;
  if (sameCredentialVersion(target, memBefore)) return memBefore ?? {};
  if (after && Object.keys(after).length > 0 && sameCredentialVersion(target, after)) return after;
  return undefined;
}

function applyCredentialFields(disk: AnyMap, before: AnyMap, after: AnyMap): void {
  for (const [key, value] of Object.entries(after)) {
    // Preserve fields changed on disk that the refresh did not modify.
    if (!(key in before) || !deepEqual(before[key], value)) disk[key] = value;
  }
  if ("expires_at" in before && !("expires_at" in after)) delete disk["expires_at"];
}

/** Reports whether key belongs to a Codex credential partition managed by the patch. */
export function isCodexCredentialKey(key: string): boolean {
  if (key === "siwc" || key === "use_siwc") return true;
  return (codexOuterCredentialKeys as readonly string[]).includes(key);
}

/** Immutable, partition-specific refresh result. */
export class CredentialRefreshPatch {
  private outerBefore?: AnyMap;
  private outerDiskBefore?: AnyMap;
  private outerAfter?: AnyMap;
  private siwcBefore?: AnyMap;
  private siwcDiskBefore?: AnyMap;
  private siwcAfter?: AnyMap;

  private constructor() {}

  /** Records only the credential partitions actually refreshed. */
  static create(before: AnyMap, after: AnyMap, outer: boolean, siwc: boolean): CredentialRefreshPatch {
    return CredentialRefreshPatch.createWithDiskBaseline(before, undefined, after, outer, siwc);
  }

  /** Records both the in-memory baseline and the on-disk baseline observed before refreshing. */
  static createWithDiskBaseline(before: AnyMap, diskBefore: AnyMap | undefined, after: AnyMap, outer: boolean, siwc: boolean): CredentialRefreshPatch {
    const patch = new CredentialRefreshPatch();
    if (outer) {
      patch.outerBefore = credentialFields(before, codexOuterCredentialKeys);
      if (diskBefore && Object.keys(diskBefore).length > 0) patch.outerDiskBefore = credentialFields(diskBefore, codexOuterCredentialKeys);
      patch.outerAfter = credentialFields(after, codexOuterCredentialKeys);
    }
    if (siwc) {
      const beforeSIWC = asMap(before["siwc"]);
      const diskBeforeSIWC = asMap(diskBefore?.["siwc"]);
      const afterSIWC = asMap(after["siwc"]);
      patch.siwcBefore = credentialFields(beforeSIWC, codexSIWCCredentialKeys);
      if (diskBeforeSIWC && Object.keys(diskBeforeSIWC).length > 0) patch.siwcDiskBefore = credentialFields(diskBeforeSIWC, codexSIWCCredentialKeys);
      patch.siwcAfter = credentialFields(afterSIWC, codexSIWCCredentialKeys);
    }
    return patch;
  }

  get refreshedOuter(): boolean {
    return this.outerAfter !== undefined;
  }

  get refreshedSIWC(): boolean {
    return this.siwcAfter !== undefined;
  }

  /** True when at least one refreshed partition still matches disk's version. */
  canApplyTo(disk: AnyMap): boolean {
    if (this.outerAfter && matchesBaselineOrAfter(disk, this.outerBefore, this.outerDiskBefore, this.outerAfter)) return true;
    if (this.siwcAfter && matchesBaselineOrAfter(asMap(disk["siwc"]), this.siwcBefore, this.siwcDiskBefore, this.siwcAfter)) return true;
    return false;
  }

  /** Overlays the refreshed partitions on the disk snapshot; rotated partitions are left alone. */
  apply(disk: AnyMap): AnyMap {
    const merged: AnyMap = cloneStringAnyMap(disk) ?? {};
    if (this.outerAfter) {
      const base = matchesBaselineOrAfter(disk, this.outerBefore, this.outerDiskBefore, this.outerAfter);
      if (base) applyCredentialFields(merged, base, this.outerAfter);
    }
    const diskSIWC = asMap(disk["siwc"]);
    if (this.siwcAfter) {
      const base = matchesBaselineOrAfter(diskSIWC, this.siwcBefore, this.siwcDiskBefore, this.siwcAfter);
      if (base) {
        const mergedSIWC: AnyMap = cloneStringAnyMap(diskSIWC) ?? {};
        applyCredentialFields(mergedSIWC, base, this.siwcAfter);
        merged["siwc"] = mergedSIWC;
      }
    }
    return merged;
  }
}

function asMap(v: unknown): AnyMap | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AnyMap) : undefined;
}
