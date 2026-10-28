// Claude token storage shapes. Port of internal/auth/claude/anthropic.go and
// token.go. Persistence is owned by the TokenStore; this module only builds the
// JSON object (`metadata`) that the store writes, with the same keys as the
// Go auth files.

export interface PKCECodesLike {
  codeVerifier: string;
  codeChallenge: string;
}

/** Token material returned by an exchange or refresh (ClaudeTokenData). */
export interface ClaudeTokenData {
  accessToken: string;
  refreshToken: string;
  email: string;
  accountUUID: string;
  organizationUUID: string;
  organizationName: string;
  /** RFC3339 expiry of the access token ("expired" in the auth file). */
  expire: string;
}

/** Result of a completed login (ClaudeAuthBundle). */
export interface ClaudeAuthBundle {
  apiKey: string;
  tokenData: ClaudeTokenData;
  deviceIDs: string[];
  /** RFC3339 timestamp of the exchange. */
  lastRefresh: string;
}

/** Persisted credential (ClaudeTokenStorage); field names mirror the JSON keys. */
export interface ClaudeTokenStorage {
  id_token: string;
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  email: string;
  account_uuid?: string;
  organization_uuid?: string;
  organization_name?: string;
  claude_device_ids?: string[];
  type: "claude";
  expired: string;
}

/** Port of ClaudeAuth.CreateTokenStorage. */
export function createTokenStorage(bundle: ClaudeAuthBundle): ClaudeTokenStorage {
  const storage: ClaudeTokenStorage = {
    id_token: "",
    access_token: bundle.tokenData.accessToken,
    refresh_token: bundle.tokenData.refreshToken,
    last_refresh: bundle.lastRefresh,
    email: bundle.tokenData.email,
    type: "claude",
    expired: bundle.tokenData.expire,
  };
  if (bundle.tokenData.accountUUID) storage.account_uuid = bundle.tokenData.accountUUID;
  if (bundle.tokenData.organizationUUID) storage.organization_uuid = bundle.tokenData.organizationUUID;
  if (bundle.tokenData.organizationName) storage.organization_name = bundle.tokenData.organizationName;
  if (bundle.deviceIDs.length > 0) storage.claude_device_ids = [...bundle.deviceIDs];
  return storage;
}

/**
 * Port of ClaudeAuth.UpdateTokenStorage: applies refreshed tokens, keeping the
 * previously resolved identity when the refresh response omitted it.
 */
export function updateTokenStorage(storage: ClaudeTokenStorage, tokenData: ClaudeTokenData, nowMs: number = Date.now()): void {
  storage.access_token = tokenData.accessToken;
  storage.refresh_token = tokenData.refreshToken;
  storage.last_refresh = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (tokenData.email !== "") storage.email = tokenData.email;
  if (tokenData.accountUUID !== "") storage.account_uuid = tokenData.accountUUID;
  if (tokenData.organizationUUID !== "") storage.organization_uuid = tokenData.organizationUUID;
  if (tokenData.organizationName !== "") storage.organization_name = tokenData.organizationName;
  storage.expired = tokenData.expire;
}

/**
 * Port of SaveTokenToFile's serialisation step (misc.MergeMetadata): the
 * storage fields with `type` forced to "claude", overlaid with any extra
 * metadata (prefix, proxy_url, disabled, ...). The result is what gets
 * persisted as Auth.metadata; `claude_device_ids` and the identity fields are
 * omitted when empty like the Go `omitempty` tags.
 */
export function claudeStorageToMetadata(storage: ClaudeTokenStorage, extra?: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id_token: storage.id_token ?? "",
    access_token: storage.access_token,
    refresh_token: storage.refresh_token,
    last_refresh: storage.last_refresh,
    email: storage.email,
  };
  if (storage.account_uuid) data.account_uuid = storage.account_uuid;
  if (storage.organization_uuid) data.organization_uuid = storage.organization_uuid;
  if (storage.organization_name) data.organization_name = storage.organization_name;
  if (storage.claude_device_ids && storage.claude_device_ids.length > 0) data.claude_device_ids = [...storage.claude_device_ids];
  data.type = "claude";
  data.expired = storage.expired;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) data[k] = v;
  }
  return data;
}
