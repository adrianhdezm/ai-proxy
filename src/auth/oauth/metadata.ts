// Metadata merge used when a login replaces an existing auth file. Port of
// sdk/cliproxy/auth/metadata_merge.go (IsAuthTokenPayloadKey, MergeExistingAuthMetadata).
import type { Auth } from "../types.ts";

/** Keys that belong to the token payload and must never be inherited from an older file. */
export function isAuthTokenPayloadKey(key: string): boolean {
  switch (key.trim().toLowerCase()) {
    case "access_token":
    case "refresh_token":
    case "id_token":
    case "session_id":
    case "expired":
    case "last_refresh":
    case "expires_in":
    case "timestamp":
    case "token_type":
    case "user_code":
    case "verification_uri":
    case "verification_uri_complete":
      return true;
    default:
      return false;
  }
}

/**
 * Copies user-configured fields (prefix, proxy_url, weight, note, ...) from an
 * existing auth file into the freshly logged-in record when the record does
 * not define them. Token payload keys are never inherited. `disabled` is
 * mirrored onto the record flag when the record did not set it explicitly.
 */
export function mergeExistingAuthMetadata(target: Auth, existing: Record<string, unknown> | undefined): void {
  if (!existing || Object.keys(existing).length === 0) return;
  if (!target.metadata) target.metadata = {};
  if (!("disabled" in target.metadata) && typeof existing["disabled"] === "boolean") {
    target.disabled = existing["disabled"];
  }
  for (const [k, v] of Object.entries(existing)) {
    if (isAuthTokenPayloadKey(k)) continue;
    if (!(k in target.metadata)) target.metadata[k] = v;
  }
}

/** Reads a trimmed string metadata value ("" when absent or not a string). */
export function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const v = metadata?.[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Writes a string metadata value, skipping empty values so prior identity is kept. */
export function storeMetadataString(metadata: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value === undefined || value.trim() === "") return;
  metadata[key] = value;
}
