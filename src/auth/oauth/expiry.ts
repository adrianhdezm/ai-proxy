// Token expiry helpers for executors and the auto-refresh loop. Port of the
// relevant parts of sdk/cliproxy/auth/types.go (expirationFromMap, parseJWTExp,
// OuterExpirationTime) and conductor_refresh.go (authLastRefreshTimestamp,
// authOuterAccessToken, authRefreshToken).
import type { Auth } from "../types.ts";
import { parseTimeValue, normaliseUnix } from "./time.ts";

/** Metadata keys that may hold an absolute expiry, in lookup order. */
export const expireKeys = ["expired", "expire", "expires_at", "expiresAt", "expiry", "expires"] as const;

function metaString(meta: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!meta) return "";
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/** Base64url payload decode tolerant of missing padding. */
function decodeJWTSegment(segment: string): string | undefined {
  let s = segment.replace(/-/g, "+").replace(/_/g, "/");
  switch (s.length % 4) {
    case 2:
      s += "==";
      break;
    case 3:
      s += "=";
      break;
    case 1:
      return undefined;
  }
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** Reads the `exp` claim of a JWT without verifying it. Returns epoch ms. */
export function parseJWTExp(token: string): number | undefined {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return undefined;
  const payload = decodeJWTSegment(parts[1]!);
  if (payload === undefined) return undefined;
  let claims: { exp?: unknown };
  try {
    claims = JSON.parse(payload) as { exp?: unknown };
  } catch {
    return undefined;
  }
  const exp = claims.exp;
  if (typeof exp === "number" && exp > 0) return normaliseUnix(Math.trunc(exp));
  if (typeof exp === "string" && /^\d+$/.test(exp.trim())) return normaliseUnix(Number(exp.trim()));
  return undefined;
}

function parseRelativeExpiry(meta: Record<string, unknown>): number | undefined {
  const raw = meta["expires_in"] ?? meta["expiresIn"];
  let seconds: number | undefined;
  if (typeof raw === "number" && raw > 0) seconds = raw;
  else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) seconds = Number(raw.trim());
  if (seconds === undefined) return undefined;
  for (const key of ["timestamp", "issued_at", "issuedAt", "created_at", "createdAt", "last_refresh", "lastRefresh"]) {
    const ts = parseTimeValue(meta[key]);
    if (ts !== undefined) return ts + seconds * 1000;
  }
  return undefined;
}

/**
 * Finds the absolute expiry in a metadata map: explicit expiry keys, then
 * expires_in relative to a timestamp, then the nested `token` object (Gemini).
 */
export function expirationFromMetadata(meta: Record<string, unknown> | undefined): number | undefined {
  if (!meta) return undefined;
  for (const key of expireKeys) {
    if (key in meta) {
      const ts = parseTimeValue(meta[key]);
      if (ts !== undefined) return ts;
    }
  }
  const relative = parseRelativeExpiry(meta);
  if (relative !== undefined) return relative;
  for (const nestedKey of ["token", "Token"]) {
    const nested = meta[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const ts = expirationFromMetadata(nested as Record<string, unknown>);
      if (ts !== undefined) return ts;
    }
  }
  return undefined;
}

/** The access token of a credential (`access_token`, legacy `accessToken`, nested Gemini `token`). */
export function authAccessToken(auth: Pick<Auth, "metadata">): string {
  const direct = metaString(auth.metadata, "access_token", "accessToken");
  if (direct !== "") return direct;
  const nested = auth.metadata?.["token"];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return metaString(nested as Record<string, unknown>, "access_token");
  }
  return "";
}

/** The refresh token of a credential (`refresh_token`, legacy `refreshToken`, nested Gemini `token`). */
export function authRefreshToken(auth: Pick<Auth, "metadata">): string {
  const direct = metaString(auth.metadata, "refresh_token", "refreshToken");
  if (direct !== "") return direct;
  const nested = auth.metadata?.["token"];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return metaString(nested as Record<string, unknown>, "refresh_token");
  }
  return "";
}

/** Port of authLastRefreshTimestamp: metadata first, then attributes, then lastRefreshedAt. */
export function authLastRefreshTimestamp(auth: Pick<Auth, "metadata" | "attributes" | "lastRefreshedAt">): number | undefined {
  const keys = ["last_refresh", "lastRefresh", "last_refreshed_at", "lastRefreshedAt"];
  for (const key of keys) {
    const ts = parseTimeValue(auth.metadata?.[key]);
    if (ts !== undefined) return ts;
  }
  for (const key of keys) {
    const ts = parseTimeValue(auth.attributes?.[key]);
    if (ts !== undefined) return ts;
  }
  return auth.lastRefreshedAt > 0 ? auth.lastRefreshedAt : undefined;
}

/**
 * Port of Auth.OuterExpirationTime: the JWT `exp` of the access token wins,
 * otherwise the metadata expiry. Returns epoch ms or undefined when unknown.
 */
export function authExpirationTime(auth: Pick<Auth, "metadata">): number | undefined {
  const token = authAccessToken(auth);
  if (token !== "") {
    const jwtExp = parseJWTExp(token);
    if (jwtExp !== undefined) return jwtExp;
  }
  return expirationFromMetadata(auth.metadata);
}

/** True when the access token is missing or expires within `skewMs` of now. */
export function isAuthExpired(auth: Pick<Auth, "metadata">, now: number = Date.now(), skewMs = 0): boolean {
  if (authAccessToken(auth) === "") return true;
  const exp = authExpirationTime(auth);
  if (exp === undefined) return false;
  return exp - skewMs <= now;
}

export interface RefreshDue {
  /** When the next refresh should run (epoch ms); undefined when it cannot be scheduled. */
  dueAt?: number;
  /** The credential has a refresh token. */
  hasRefresh: boolean;
  /** A refresh is due now. */
  needsRefresh: boolean;
}

/**
 * Port of the generic branch of CodexOuterNeedsRefresh (also used for Claude):
 * refresh when the expiry minus the provider lead has passed; without an
 * expiry, when the last refresh is older than the lead; a lead of 0 or less
 * refreshes only at expiry; no lead means no proactive refresh.
 */
export function authNeedsRefresh(
  auth: Pick<Auth, "metadata" | "attributes" | "lastRefreshedAt">,
  leadMs: number | undefined,
  now: number = Date.now(),
): RefreshDue {
  if (authRefreshToken(auth) === "") return { hasRefresh: false, needsRefresh: false };
  if (authAccessToken(auth) === "") return { dueAt: now, hasRefresh: true, needsRefresh: true };
  const expiry = authExpirationTime(auth);
  if (leadMs === undefined) {
    return { hasRefresh: false, needsRefresh: false };
  }
  if (leadMs <= 0) {
    if (expiry !== undefined) {
      if (expiry <= now) return { dueAt: now, hasRefresh: true, needsRefresh: true };
      return { dueAt: expiry, hasRefresh: true, needsRefresh: false };
    }
    return { hasRefresh: false, needsRefresh: false };
  }
  if (expiry !== undefined) {
    const due = expiry - leadMs;
    if (due <= now) return { dueAt: now, hasRefresh: true, needsRefresh: true };
    return { dueAt: due, hasRefresh: true, needsRefresh: false };
  }
  const lastRefresh = authLastRefreshTimestamp(auth);
  if (lastRefresh !== undefined) {
    const due = lastRefresh + leadMs;
    if (due <= now) return { dueAt: now, hasRefresh: true, needsRefresh: true };
    return { dueAt: due, hasRefresh: true, needsRefresh: false };
  }
  return { dueAt: now, hasRefresh: true, needsRefresh: true };
}
