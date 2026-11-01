// Credential and upstream-origin helpers for the Claude executor. Port of
// internal/runtime/executor/helps/claude_upstream.go plus claudeCreds,
// isClaudeOAuthToken, claudeCredentialUsesOAuth and the case-insensitive
// header helpers of claude_code_session.go.
import { type Auth, AttributeAPIKey, AttributeAuthKind, AttributeBaseURL } from "../../auth/types.ts";

export const DefaultClaudeBaseURL = "https://api.anthropic.com";

/**
 * Reports whether a resolved request targets Anthropic's first-party API origin
 * (Go: IsAnthropicUpstreamURL). Every Claude-specific body, header and wire rule
 * keys on this so it cannot drift onto custom ports or userinfo URLs.
 */
export function isAnthropicUpstreamURL(target: URL | string | undefined): boolean {
  if (target === undefined) return false;
  let u: URL;
  try {
    u = typeof target === "string" ? new URL(target) : target;
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if (u.protocol.toLowerCase() !== "https:") return false;
  if (u.hostname.toLowerCase() !== "api.anthropic.com") return false;
  return u.port === "" || u.port === "443";
}

/** Reports whether a configured base URL targets Anthropic's first-party API (Go: isAnthropicUpstreamBase). */
export function isAnthropicUpstreamBase(baseURL: string): boolean {
  const trimmed = baseURL.trim();
  if (trimmed === "") return false;
  return isAnthropicUpstreamURL(trimmed);
}

/** Credential material of an auth: attributes.api_key (or metadata.access_token) and attributes.base_url (Go: claudeCreds). */
export function claudeCreds(auth: Auth | undefined): { apiKey: string; baseURL: string } {
  if (!auth) return { apiKey: "", baseURL: "" };
  let apiKey = auth.attributes?.[AttributeAPIKey] ?? "";
  const baseURL = auth.attributes?.[AttributeBaseURL] ?? "";
  if (apiKey === "") {
    const token = auth.metadata?.access_token;
    if (typeof token === "string") apiKey = token;
  }
  return { apiKey, baseURL };
}

/** Claude Code OAuth access tokens carry the sk-ant-oat prefix (Go: isClaudeOAuthToken). */
export function isClaudeOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

function authKindIsAPIKey(auth: Auth | undefined): boolean {
  const kind = (auth?.attributes?.[AttributeAuthKind] ?? "").trim().toLowerCase();
  return kind === "apikey" || kind === "api_key" || kind === "api-key";
}

/**
 * Classifies the selected upstream credential as Bearer (OAuth-style) or
 * x-api-key (Go: claudeCredentialUsesOAuth). It is the single authority for
 * every decision that has to agree with the OAuth beta profile.
 */
export function claudeCredentialUsesOAuth(auth: Auth | undefined, apiKey: string): boolean {
  if (isClaudeOAuthToken(apiKey)) return true;
  if (authKindIsAPIKey(auth)) return false;
  const hasAPIKeyAttr = (auth?.attributes?.[AttributeAPIKey] ?? "").trim() !== "";
  return !hasAPIKeyAttr;
}

/** Whether the auth is an API-key credential for the x-api-key decision (Go: PrepareRequest useAPIKey). */
export function claudeAuthUsesAPIKey(auth: Auth | undefined): boolean {
  if (!auth) return false;
  return authKindIsAPIKey(auth) || (auth.attributes?.[AttributeAPIKey] ?? "").trim() !== "";
}

/** First non-empty header value (Go: HeaderValueCaseInsensitive); Headers is already case-insensitive. */
export function headerValueCaseInsensitive(headers: Headers | undefined, name: string): string {
  if (!headers) return "";
  return headers.get(name) ?? "";
}

/**
 * All non-empty comma-separated values of a header (Go: HeaderValuesCaseInsensitive).
 * The Fetch Headers API already joins repeated entries with ", ".
 */
export function headerValuesCaseInsensitive(headers: Headers | undefined, name: string): string[] {
  if (!headers) return [];
  const raw = headers.get(name);
  if (raw === null) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * Sets `key` on target from the incoming request when the caller sent a non-empty
 * value, otherwise keeps an existing target value, otherwise sets the default
 * (Go: misc.EnsureHeader).
 */
export function ensureHeader(target: Headers, source: Headers | undefined, key: string, defaultValue: string): void {
  const incoming = (source?.get(key) ?? "").trim();
  if (incoming !== "") {
    target.set(key, incoming);
    return;
  }
  if ((target.get(key) ?? "").trim() !== "") return;
  target.set(key, defaultValue);
}
