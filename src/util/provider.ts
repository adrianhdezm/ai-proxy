// Port of the secret-masking helpers from internal/util/provider.go
// (HideAPIKey, MaskAuthorizationHeader, MaskSensitiveHeaderValue, MaskSensitiveQuery, InArray).

export function inArray(haystack: string[], needle: string): boolean {
  return haystack.includes(needle);
}

/** Obscures an API key for logging, showing only the first and last few characters. */
export function hideAPIKey(apiKey: string): string {
  if (apiKey.length > 8) return apiKey.slice(0, 4) + "..." + apiKey.slice(-4);
  if (apiKey.length > 4) return apiKey.slice(0, 2) + "..." + apiKey.slice(-2);
  if (apiKey.length > 2) return apiKey.slice(0, 1) + "..." + apiKey.slice(-1);
  return apiKey;
}

/** Masks an Authorization header value while preserving the auth type prefix ("Bearer "). */
export function maskAuthorizationHeader(value: string): string {
  const trimmed = value.trim();
  const idx = trimmed.indexOf(" ");
  if (idx < 0) return hideAPIKey(value);
  return trimmed.slice(0, idx) + " " + hideAPIKey(trimmed.slice(idx + 1));
}

/** Masks sensitive header values by header name (case-insensitive). */
export function maskSensitiveHeaderValue(key: string, value: string): string {
  const lowerKey = key.trim().toLowerCase();
  if (lowerKey.includes("authorization")) return maskAuthorizationHeader(value);
  if (lowerKey.includes("api-key") || lowerKey.includes("apikey") || lowerKey.includes("token") || lowerKey.includes("secret")) {
    return hideAPIKey(value);
  }
  return value;
}

/** Masks sensitive query parameters (key, value, *token*, *secret*, api keys) in a raw query string. */
export function maskSensitiveQuery(raw: string): string {
  if (raw === "") return "";
  const parts = raw.split("&");
  let changed = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "") continue;
    let keyPart = part;
    let valuePart = "";
    const idx = part.indexOf("=");
    if (idx >= 0) {
      keyPart = part.slice(0, idx);
      valuePart = part.slice(idx + 1);
    }
    const decodedKey = queryUnescape(keyPart) ?? keyPart;
    if (!shouldMaskQueryParam(decodedKey)) continue;
    const decodedValue = queryUnescape(valuePart) ?? valuePart;
    const masked = hideAPIKey(decodedValue.trim());
    parts[i] = keyPart + "=" + queryEscape(masked);
    changed = true;
  }
  return changed ? parts.join("&") : raw;
}

function shouldMaskQueryParam(key: string): boolean {
  key = key.trim().toLowerCase();
  if (key === "") return false;
  if (key.endsWith("[]")) key = key.slice(0, -2);
  if (key === "key" || key === "value" || key.includes("api-key") || key.includes("apikey") || key.includes("api_key")) return true;
  return key.includes("token") || key.includes("secret");
}

function queryUnescape(s: string): string | undefined {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

function queryEscape(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
