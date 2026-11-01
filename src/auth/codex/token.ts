// Codex token storage shapes and the disk-merge rules. Port of
// internal/auth/codex/openai.go and token.go (minus the file locking and the
// atomic file write, which belong to the TokenStore in this port).
import { DefaultPlanType } from "./jwt_parser.ts";

/** Token material returned by an exchange or refresh (CodexTokenData). */
export interface CodexTokenData {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountID: string;
  email: string;
  /** RFC3339 access token expiry ("expired" in the auth file). */
  expire: string;
  planType: string;
}

/** Result of a completed login (CodexAuthBundle). */
export interface CodexAuthBundle {
  apiKey: string;
  tokenData: CodexTokenData;
  lastRefresh: string;
}

/** Persisted credential (CodexTokenStorage); field names mirror the JSON keys. */
export interface CodexTokenStorage {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  last_refresh: string;
  email: string;
  type: "codex";
  expired: string;
  plan_type?: string;
  use_siwc?: boolean;
  siwc?: Record<string, unknown>;
}

/** Outer (non-SIWC) credential keys protected by the disk merge rules. */
export const codexOuterCredentialKeys = ["id_token", "access_token", "refresh_token", "account_id", "last_refresh", "email", "expired", "plan_type"] as const;

export function cloneStringAnyMap<T extends Record<string, unknown> | undefined>(src: T): T {
  if (src === undefined || src === null) return src;
  const dst: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v)) dst[k] = cloneStringAnyMap(v as Record<string, unknown>);
    else if (Array.isArray(v)) dst[k] = [...v];
    else dst[k] = v;
  }
  return dst as T;
}

/** Port of CodexAuth.CreateTokenStorage. */
export function createTokenStorage(bundle: CodexAuthBundle): CodexTokenStorage {
  const planType = bundle.tokenData.planType.trim() !== "" ? bundle.tokenData.planType.trim() : DefaultPlanType;
  return {
    id_token: bundle.tokenData.idToken,
    access_token: bundle.tokenData.accessToken,
    refresh_token: bundle.tokenData.refreshToken,
    account_id: bundle.tokenData.accountID,
    last_refresh: bundle.lastRefresh,
    email: bundle.tokenData.email,
    type: "codex",
    expired: bundle.tokenData.expire,
    plan_type: planType,
  };
}

/** Port of CodexAuth.UpdateTokenStorage. */
export function updateTokenStorage(storage: CodexTokenStorage, tokenData: CodexTokenData, nowMs: number = Date.now()): void {
  storage.id_token = tokenData.idToken;
  storage.access_token = tokenData.accessToken;
  storage.refresh_token = tokenData.refreshToken;
  storage.account_id = tokenData.accountID;
  storage.last_refresh = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  storage.email = tokenData.email;
  storage.expired = tokenData.expire;
  storage.plan_type = tokenData.planType.trim() !== "" ? tokenData.planType.trim() : DefaultPlanType;
}

/**
 * Port of SaveTokenToFile's serialisation step (misc.MergeMetadata): the
 * storage fields with `type` forced to "codex", overlaid with extra metadata.
 */
export function codexStorageToMetadata(storage: CodexTokenStorage, extra?: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id_token: storage.id_token,
    access_token: storage.access_token,
    refresh_token: storage.refresh_token,
    account_id: storage.account_id,
    last_refresh: storage.last_refresh,
    email: storage.email,
    type: "codex",
    expired: storage.expired,
  };
  if (storage.plan_type) data.plan_type = storage.plan_type;
  if (storage.use_siwc !== undefined) data.use_siwc = storage.use_siwc;
  if (storage.siwc && Object.keys(storage.siwc).length > 0) data.siwc = cloneStringAnyMap(storage.siwc);
  if (extra) for (const [k, v] of Object.entries(extra)) data[k] = v;
  return data;
}

/**
 * Port of MergeWithDiskMap: preserves disk credentials when saving a
 * non-refresh snapshot (settings edits). Outer credential keys always come
 * from disk when a disk record exists.
 */
export function mergeWithDiskMap(diskMap: Record<string, unknown>, incomingMap: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = cloneStringAnyMap(diskMap) ?? {};
  const hasDisk = Object.keys(diskMap).length > 0;
  for (const [key, value] of Object.entries(incomingMap)) {
    if (value === null || value === undefined) continue;
    if ((key === "siwc" || key === "use_siwc") && key in diskMap) continue;
    if (typeof value === "string" && value.trim() === "" && key in diskMap) continue;
    merged[key] = value;
  }
  for (const key of codexOuterCredentialKeys) {
    if (key in diskMap) merged[key] = diskMap[key];
    else if (hasDisk) delete merged[key];
  }
  if (!("siwc" in diskMap) && hasDisk) delete merged["siwc"];
  return merged;
}

function hasDiskOAuthOuter(diskMap: Record<string, unknown>): boolean {
  if (Object.keys(diskMap).length === 0) return false;
  const rt = diskMap["refresh_token"];
  if (typeof rt === "string" && rt.trim() !== "") return true;
  const lr = diskMap["last_refresh"];
  return typeof lr === "string" && lr.trim() !== "";
}

/**
 * Port of MergeCodexCredentialsFromDisk: protects disk credentials during
 * configuration saves while allowing intentional changes to other settings.
 */
export function mergeCodexCredentialsFromDisk(diskMap: Record<string, unknown>, incomingMetadata: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = cloneStringAnyMap(incomingMetadata) ?? {};
  if (hasDiskOAuthOuter(diskMap)) {
    for (const key of codexOuterCredentialKeys) {
      if (key in diskMap) merged[key] = diskMap[key];
      else delete merged[key];
    }
  } else {
    for (const key of codexOuterCredentialKeys) {
      if (!(key in diskMap)) continue;
      const inVal = merged[key];
      if (!(key in merged) || inVal === null || inVal === undefined || (typeof inVal === "string" && inVal.trim() === "")) {
        merged[key] = diskMap[key];
      }
    }
  }
  if ("siwc" in diskMap) {
    const value = diskMap["siwc"];
    merged["siwc"] = value && typeof value === "object" && !Array.isArray(value) ? cloneStringAnyMap(value as Record<string, unknown>) : value;
  }
  if ("use_siwc" in diskMap && !("use_siwc" in incomingMetadata)) merged["use_siwc"] = diskMap["use_siwc"];
  return merged;
}
