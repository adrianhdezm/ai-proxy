// Port of internal/runtime/executor/helps/codex_quota.go.
//
// Converts one Codex quota event ("codex.rate_limits", or an "error" frame that
// carries upstream response headers) into the bounded X-Codex-* header
// representation used for usage observations. Number literals are kept verbatim
// (the raw JSON parser), like the gjson Raw values the Go code copies.
//
// The executor does not call this on the SSE path: upstream used it to merge
// quota headers into the request log of websocket sessions, which are not
// ported. It is kept as a pure helper for callers that observe quota frames.
import { RawNumber, isRawNumber, parseRawJSON } from "./rawjson.ts";

const codexQuotaAdditionalHeaderKey = "X-Codex-Additional-";
const maxCodexAdditionalRateLimits = 8;

const QuotaEventKind = { Other: 0, Error: 1, RateLimits: 2 } as const;
type QuotaEventKind = (typeof QuotaEventKind)[keyof typeof QuotaEventKind];

type JSONObject = Record<string, unknown>;

function isObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RawNumber);
}

/** Go: ParseCodexQuotaEventHeaders. Returns undefined when the event carries no quota data. */
export function parseCodexQuotaEventHeaders(payload: string): Headers | undefined {
  if (payload.length === 0) return undefined;
  const kind = codexQuotaEventKind(payload);
  if (kind === QuotaEventKind.Other) return undefined;
  let root: unknown;
  try {
    root = parseRawJSON(payload);
  } catch {
    return undefined;
  }
  if (kind === QuotaEventKind.Error) return parseCodexQuotaHeadersObject(getField(root, "headers"));

  const headers = new Headers();
  let hasQuotaData = false;

  const baseRateLimits = firstCodexQuotaResult(root, "rate_limits", "rateLimit");
  if (addCodexQuotaRateLimitHeaders(headers, "X-Codex-", baseRateLimits)) hasQuotaData = true;

  const additional = firstCodexQuotaResult(root, "additional_rate_limits", "additionalRateLimits");
  if (isObject(additional) || Array.isArray(additional)) {
    const entries: Array<[string, unknown]> = Array.isArray(additional) ? additional.map((v, i) => [String(i), v]) : Object.entries(additional);
    let additionalCount = 0;
    for (const [key, value] of entries) {
      if (additionalCount >= maxCodexAdditionalRateLimits) break;
      const limitName = Array.isArray(additional) ? firstCodexQuotaResultString(value, "limit_name", "limitName", "name") : key.trim();
      if (limitName === "") continue;
      const identifier = normalizeCodexQuotaHeaderIdentifier(limitName);
      if (identifier === "") continue;
      let rateInfo = firstCodexQuotaResult(value, "rate_limit", "rateLimit");
      if (rateInfo === undefined) rateInfo = value;
      const prefix = codexQuotaAdditionalHeaderKey + identifier + "-";
      if (addCodexQuotaRateLimitHeaders(headers, prefix, rateInfo)) {
        // The limit name is upstream-controlled; reject control characters.
        if (validCodexQuotaEventText(limitName)) safeSet(headers, prefix + "Limit-Name", limitName);
        hasQuotaData = true;
        additionalCount++;
      }
    }
  }

  const codeReview = firstCodexQuotaResult(root, "code_review_rate_limits", "codeReviewRateLimits");
  if (addCodexQuotaRateLimitHeaders(headers, "X-Codex-Code-Review-", codeReview)) hasQuotaData = true;

  const credits = firstCodexQuotaResult(root, "credits");
  if (isObject(credits)) {
    hasQuotaData = setCodexQuotaScalarHeader(headers, "X-Codex-Credits-Has-Credits", credits, "has_credits", "hasCredits") || hasQuotaData;
    hasQuotaData = setCodexQuotaScalarHeader(headers, "X-Codex-Credits-Unlimited", credits, "unlimited") || hasQuotaData;
    hasQuotaData = setCodexQuotaScalarHeader(headers, "X-Codex-Credits-Balance", credits, "balance") || hasQuotaData;
  }

  if (!hasQuotaData) return undefined;
  // A malformed active-limit name only invalidates that one header.
  const activeLimit = firstCodexQuotaResultString(root, "metered_limit_name", "meteredLimitName", "limit_name", "limitName");
  if (validCodexQuotaEventIdentifier(activeLimit)) safeSet(headers, "X-Codex-Active-Limit", activeLimit);
  const planType = firstCodexQuotaResultString(root, "plan_type", "planType");
  if (validCodexQuotaEventText(planType)) safeSet(headers, "X-Codex-Plan-Type", planType);
  return headers;
}

/**
 * Discriminates the event type by scanning a bounded prefix for the top-level
 * "type" field, so large non-quota frames are not parsed (Go: codexQuotaEventKind).
 */
function codexQuotaEventKind(payload: string): QuotaEventKind {
  const scanLimit = 256;
  const end = Math.min(payload.length, scanLimit);
  const isWS = (c: string | undefined) => c === " " || c === "\t" || c === "\r" || c === "\n";
  for (let i = 0; i + 6 < end; i++) {
    if (!payload.startsWith('"type"', i)) continue;
    let j = i + 6;
    while (j < end && isWS(payload[j])) j++;
    if (j >= end || payload[j] !== ":") continue;
    j++;
    while (j < end && isWS(payload[j])) j++;
    if (j + 7 <= end && payload.startsWith('"error"', j)) return QuotaEventKind.Error;
    const rateLimits = '"codex.rate_limits"';
    if (j + rateLimits.length <= end && payload.startsWith(rateLimits, j)) return QuotaEventKind.RateLimits;
  }
  return QuotaEventKind.Other;
}

function getField(obj: unknown, key: string): unknown {
  return isObject(obj) ? obj[key] : undefined;
}

function numberOf(v: unknown): number {
  if (isRawNumber(v)) return Number(v.raw);
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

function intOf(v: unknown): number {
  return Math.trunc(numberOf(v));
}

function addCodexQuotaRateLimitHeaders(headers: Headers, prefix: string, rateInfo: unknown): boolean {
  if (!isObject(rateInfo)) return false;
  let changed = false;
  if (setCodexQuotaScalarHeader(headers, prefix + "Allowed", rateInfo, "allowed")) changed = true;
  if (setCodexQuotaScalarHeader(headers, prefix + "Limit-Reached", rateInfo, "limit_reached", "limitReached")) changed = true;
  for (const windowName of ["primary", "secondary"]) {
    const window = firstCodexQuotaResult(rateInfo, windowName);
    if (!isObject(window)) continue;
    const used = firstCodexQuotaResult(window, "used_percent", "usedPercent");
    const minutes = firstCodexQuotaResult(window, "window_minutes", "windowMinutes");
    const resetAfter = firstCodexQuotaResult(window, "reset_after_seconds", "resetAfterSeconds");
    const resetAt = firstCodexQuotaResult(window, "reset_at", "resetAt");
    const hasResetAfter = resetAfter !== undefined && intOf(resetAfter) >= 0;
    const hasResetAt = resetAt !== undefined && intOf(resetAt) > 0;
    if (used === undefined || minutes === undefined || numberOf(used) < 0 || numberOf(used) > 100 || intOf(minutes) <= 0 || (!hasResetAfter && !hasResetAt)) continue;
    const windowPrefix = prefix + windowName[0]!.toUpperCase() + windowName.slice(1) + "-";
    setCodexQuotaScalarHeader(headers, windowPrefix + "Used-Percent", window, "used_percent", "usedPercent");
    setCodexQuotaScalarHeader(headers, windowPrefix + "Window-Minutes", window, "window_minutes", "windowMinutes");
    if (hasResetAfter) setCodexQuotaScalarHeader(headers, windowPrefix + "Reset-After-Seconds", window, "reset_after_seconds", "resetAfterSeconds");
    if (hasResetAt) setCodexQuotaScalarHeader(headers, windowPrefix + "Reset-At", window, "reset_at", "resetAt");
    changed = true;
  }
  return changed;
}

function parseCodexQuotaHeadersObject(node: unknown): Headers | undefined {
  if (!isObject(node)) return undefined;
  const headers = new Headers();
  let count = 0;
  for (const [key, value] of Object.entries(node)) {
    const name = key.trim();
    if (!isCodexQuotaHeaderName(name)) continue;
    const raw = codexQuotaScalarValue(value);
    if (raw !== "" && safeSet(headers, name, raw)) count++;
  }
  return count === 0 ? undefined : headers;
}

/** Only quota-related headers are observed (never cookies, auth or turn state) (Go: isCodexQuotaHeaderName). */
function isCodexQuotaHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === "retry-after" || lower.startsWith("x-ratelimit-")) return true;
  if (lower === "x-codex-active-limit" || lower === "x-codex-plan-type" || lower.startsWith("x-codex-credits-")) return true;
  if (!lower.startsWith("x-codex-")) return false;
  return ["-allowed", "-limit-reached", "-limit-name", "-used-percent", "-window-minutes", "-reset-after-seconds", "-reset-at", "-over-secondary-limit-percent"].some((marker) =>
    lower.includes(marker),
  );
}

/** Headers.set rejects names/values a Go http.Header would carry; such entries are dropped. */
function safeSet(headers: Headers, name: string, value: string): boolean {
  if (/[\r\n\0]/.test(value)) return false;
  try {
    headers.set(name, value);
    return true;
  } catch {
    return false;
  }
}

function setCodexQuotaScalarHeader(headers: Headers, name: string, object: unknown, ...paths: string[]): boolean {
  const value = firstCodexQuotaResult(object, ...paths);
  if (value === undefined) return false;
  const raw = codexQuotaScalarValue(value);
  if (raw === "") return false;
  return safeSet(headers, name, raw);
}

function codexQuotaScalarValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (isRawNumber(value)) return value.raw.trim();
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function firstCodexQuotaResult(object: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    const value = getField(object, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstCodexQuotaResultString(object: unknown, ...paths: string[]): string {
  for (const path of paths) {
    const raw = codexQuotaScalarValue(firstCodexQuotaResult(object, path));
    if (raw !== "") return raw;
  }
  return "";
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

function normalizeCodexQuotaHeaderIdentifier(value: string): string {
  value = value.trim();
  if (value === "" || utf8Len(value) > 128) return "";
  let out = "";
  let lastDash = false;
  for (const ch of value) {
    if (/^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  const identifier = out.replace(/^[-_.]+|[-_.]+$/g, "");
  if (identifier === "" || !validCodexQuotaEventIdentifier(identifier)) return "";
  return identifier;
}

function validCodexQuotaEventIdentifier(value: string): boolean {
  value = value.trim();
  if (value === "" || utf8Len(value) > 256) return false;
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function validCodexQuotaEventText(value: string): boolean {
  value = value.trim();
  return value !== "" && utf8Len(value) <= 256 && !/[\r\n]/.test(value);
}
