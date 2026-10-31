// Anthropic unified rate-limit header parsing. Port of
// internal/runtime/executor/helps/claude_ratelimit.go onto the Fetch Headers API.
// Durations are milliseconds; `now` is epoch milliseconds so tests stay deterministic.
import { log } from "../../log.ts";
import { tryParse } from "../../util/json.ts";

const defaultClaudeRateLimitFuzzMinSeconds = 1;
const defaultClaudeRateLimitFuzzMaxSeconds = 30;
/** The longest Anthropic rate-limit window (7 days) plus a small clock-skew allowance. */
export const maxClaudeRateLimitWindowMs = 7 * 24 * 60 * 60_000 + 60 * 60_000;

function header(h: Headers | undefined, name: string): string {
  return h?.get(name) ?? "";
}

function lowerTrim(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * A window status header. Fetch joins repeated (or differently cased) entries
 * with ", "; any "rejected" value wins, otherwise the first non-empty one.
 */
function statusHeader(h: Headers, name: string): string {
  const values = header(h, name)
    .split(",")
    .map(lowerTrim)
    .filter((v) => v !== "");
  if (values.includes("rejected")) return "rejected";
  return values[0] ?? "";
}

/**
 * Whether response headers explicitly declare an Anthropic shared 5h or 7d
 * rate-limit rejection (Go: ClaudeHeadersIndicateUnifiedRateLimitRejection). An
 * overage-only or Fable-only rejection remains model-scoped when the shared
 * subscription windows are not rejected.
 */
export function claudeHeadersIndicateUnifiedRateLimitRejection(headers: Headers | undefined): boolean {
  if (!headers) return false;
  const unifiedStatus = statusHeader(headers, "Anthropic-Ratelimit-Unified-Status");
  const status5h = statusHeader(headers, "Anthropic-Ratelimit-Unified-5h-Status");
  if (status5h === "rejected") return true;
  const status7d = statusHeader(headers, "Anthropic-Ratelimit-Unified-7d-Status");
  if (status7d === "rejected") return true;
  if (unifiedStatus !== "rejected") return false;
  const status7dOI = statusHeader(headers, "Anthropic-Ratelimit-Unified-7d_oi-Status");
  return !isOverageOrFableOnlyRejection(headers, unifiedStatus, status5h, status7d, status7dOI);
}

function isClaudeWindowAllowed(status: string): boolean {
  return status === "allowed" || status === "allowed_warning";
}

function isOverageOrFableOnlyRejection(headers: Headers, unifiedStatus: string, status5h: string, status7d: string, status7dOI: string): boolean {
  if (status5h === "rejected" || status7d === "rejected") return false;

  const overageStatus = statusHeader(headers, "Anthropic-Ratelimit-Unified-Overage-Status");
  const overageDisabledReason = header(headers, "Anthropic-Ratelimit-Unified-Overage-Disabled-Reason").trim();
  const representativeClaim = lowerTrim(header(headers, "Anthropic-Ratelimit-Unified-Representative-Claim"));

  const isOverageRejected = status7dOI === "rejected" || overageStatus === "rejected" || overageDisabledReason !== "" || representativeClaim.includes("overage");
  if (!isOverageRejected) return false;

  const shared5hAllowed = isClaudeWindowAllowed(status5h);
  const shared7dAllowed = isClaudeWindowAllowed(status7d);
  if (shared5hAllowed && shared7dAllowed) return true;

  // Anthropic often omits the 5h status while 5h utilization is 0.00 (or vice versa).
  if (shared7dAllowed && status5h === "" && isClaudeUtilizationHealthy(header(headers, "Anthropic-Ratelimit-Unified-5h-Utilization"))) return true;
  if (shared5hAllowed && status7d === "" && isClaudeUtilizationHealthy(header(headers, "Anthropic-Ratelimit-Unified-7d-Utilization"))) return true;

  // Both shared-window headers omitted: only a rejected overage claim uses that absence.
  if (unifiedStatus === "rejected" && status5h === "" && status7d === "" && representativeClaim.includes("overage")) {
    const util5h = header(headers, "Anthropic-Ratelimit-Unified-5h-Utilization");
    const util7d = header(headers, "Anthropic-Ratelimit-Unified-7d-Utilization");
    const util5hOK = util5h.trim() === "" || isClaudeUtilizationHealthy(util5h);
    const util7dOK = util7d.trim() === "" || isClaudeUtilizationHealthy(util7d);
    if (util5hOK && util7dOK) return true;
  }
  return false;
}

function isClaudeUtilizationHealthy(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return false;
  const u = Number(trimmed);
  if (!Number.isFinite(u)) return false;
  return u >= 0 && u < 1.0;
}

/** Headers whose non-empty value declares a quota window. */
const claudeQuotaStatusHeaders = [
  "Anthropic-Ratelimit-Unified-Status",
  "Anthropic-Ratelimit-Unified-5h-Status",
  "Anthropic-Ratelimit-Unified-7d-Status",
  "Anthropic-Ratelimit-Unified-7d_oi-Status",
  "Anthropic-Ratelimit-Unified-Overage-Status",
];

/**
 * ParseClaudeRateLimitReset with one narrow, body-aware exception: an explicit
 * per-minute rate-limit error carries no quota window, so an unclassified unified
 * reset must not stretch its short Retry-After into an hours-long cooldown
 * (Go: ParseClaudeRateLimitResetForError).
 */
export function parseClaudeRateLimitResetForError(headers: Headers | undefined, body: string, nowMs: number): number | undefined {
  if (!headers || !claudeBodyIsExplicitPerMinuteRateLimit(body) || claudeHeadersHaveQuotaStatus(headers)) {
    return parseClaudeRateLimitReset(headers, nowMs);
  }
  const rawRetryAfter = singleHeaderValue(headers, "Retry-After");
  if (rawRetryAfter === undefined) return parseClaudeRateLimitReset(headers, nowMs);
  const retryAt = parseRetryAfterHeader(rawRetryAfter, nowMs);
  if (retryAt === undefined || retryAt <= nowMs || retryAt - nowMs > maxClaudeRateLimitWindowMs) {
    return parseClaudeRateLimitReset(headers, nowMs);
  }
  const rateHeaders = new Headers(headers);
  rateHeaders.delete("Anthropic-Ratelimit-Unified-Reset");
  return parseClaudeRateLimitReset(rateHeaders, nowMs);
}

function claudeBodyIsExplicitPerMinuteRateLimit(body: string): boolean {
  const envelope = tryParse<{ error?: { type?: unknown; message?: unknown } }>(body);
  if (!envelope || typeof envelope !== "object" || envelope.error?.type !== "rate_limit_error") return false;
  const message = typeof envelope.error.message === "string" ? envelope.error.message.trim().toLowerCase() : "";
  switch (message) {
    case "this request would exceed the requests per minute rate limit. please try again later.":
    case "this request would exceed the input tokens per minute rate limit. please try again later.":
    case "this request would exceed the output tokens per minute rate limit. please try again later.":
      return true;
    default:
      return false;
  }
}

function claudeHeadersHaveQuotaStatus(headers: Headers): boolean {
  for (const name of claudeQuotaStatusHeaders) {
    if (header(headers, name).trim() !== "") return true;
  }
  return false;
}

/** An IMF-fixdate (RFC 9110), the one HTTP-date form that itself contains a comma. */
const httpDatePattern = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The sole value of a header; a repeated header (joined with ", " by Headers) is
 * ambiguous. A single HTTP-date keeps its own comma.
 */
function singleHeaderValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  if (value === null) return undefined;
  if (value.includes(",") && !httpDatePattern.test(value.trim())) return undefined;
  return value;
}

/** Conservative cooldown (ms) derived from the Anthropic rate-limit headers, with a bounded random grace period (Go: ParseClaudeRateLimitReset). */
export function parseClaudeRateLimitReset(headers: Headers | undefined, nowMs: number): number | undefined {
  return parseClaudeRateLimitResetWithFuzz(headers, nowMs, defaultClaudeRateLimitFuzzMinSeconds, defaultClaudeRateLimitFuzzMaxSeconds);
}

export function parseClaudeRateLimitResetWithFuzz(headers: Headers | undefined, nowMs: number, minFuzzSec: number, maxFuzzSec: number): number | undefined {
  if (!headers) return undefined;

  const unifiedStatus = statusHeader(headers, "Anthropic-Ratelimit-Unified-Status");
  const status5h = statusHeader(headers, "Anthropic-Ratelimit-Unified-5h-Status");
  const status7d = statusHeader(headers, "Anthropic-Ratelimit-Unified-7d-Status");
  const status7dOI = statusHeader(headers, "Anthropic-Ratelimit-Unified-7d_oi-Status");
  const overageOnlyRejection = isOverageOrFableOnlyRejection(headers, unifiedStatus, status5h, status7d, status7dOI);

  const candidates: number[] = [];
  const rejectedWindows: string[] = [];
  if (unifiedStatus === "rejected") rejectedWindows.push("unified");
  if (status5h === "rejected") rejectedWindows.push("5h");
  if (status7d === "rejected") rejectedWindows.push("7d");
  if (status7dOI === "rejected") rejectedWindows.push("7d_oi");

  // 1. Retry-After (skipped for an overage/Fable-only rejection, which does not describe the credential)
  if (!overageOnlyRejection) {
    const rawRetryAfter = header(headers, "Retry-After");
    if (rawRetryAfter !== "") {
      if (!rejectedWindows.includes("retry-after")) rejectedWindows.push("retry-after");
      const t = parseRetryAfterHeader(rawRetryAfter, nowMs);
      if (t !== undefined && t > nowMs) candidates.push(t);
    }
  }
  // 2. 5-hour window reset (only when rejected)
  if (status5h === "rejected") {
    const t = parseUnixOrTimestamp(header(headers, "Anthropic-Ratelimit-Unified-5h-Reset"));
    if (t !== undefined && t > nowMs) candidates.push(t);
  }
  // 3. 7-day window reset (only when rejected)
  if (status7d === "rejected") {
    const t = parseUnixOrTimestamp(header(headers, "Anthropic-Ratelimit-Unified-7d-Reset"));
    if (t !== undefined && t > nowMs) candidates.push(t);
  }
  // 4. Fable-specific 7-day window reset
  if (status7dOI === "rejected" && !overageOnlyRejection) {
    const t = parseUnixOrTimestamp(header(headers, "Anthropic-Ratelimit-Unified-7d_oi-Reset"));
    if (t !== undefined && t > nowMs) candidates.push(t);
  }
  // 5. Unified reset header
  const unifiedRejected =
    !overageOnlyRejection &&
    (unifiedStatus === "rejected" ||
      status5h === "rejected" ||
      status7d === "rejected" ||
      status7dOI === "rejected" ||
      (unifiedStatus === "" && !isClaudeWindowAllowed(status5h) && !isClaudeWindowAllowed(status7d)));
  if (unifiedRejected) {
    const raw = header(headers, "Anthropic-Ratelimit-Unified-Reset");
    if (raw !== "") {
      if (!rejectedWindows.includes("unified")) rejectedWindows.push("unified");
      if (!claudeUnifiedResetIsOverageBillingBoundary(headers, raw)) {
        const t = parseUnixOrTimestamp(raw);
        if (t !== undefined && t > nowMs) candidates.push(t);
      }
    }
  }

  const kept = candidates.filter((d) => d > nowMs && d - nowMs <= maxClaudeRateLimitWindowMs);
  if (kept.length === 0) {
    if (rejectedWindows.length > 0) {
      log.info("Anthropic rate limit window rejected; falling back to generic exponential backoff", { rejected_windows: rejectedWindows.join(",") });
    }
    return undefined;
  }
  const latest = Math.max(...kept);
  const base = latest - nowMs;
  const fuzz = randomClaudeFuzzMs(minFuzzSec, maxFuzzSec);
  const effective = base + fuzz;
  log.info("parsed Anthropic rate limit reset headers", {
    rejected_windows: rejectedWindows.join(","),
    effective_cooldown_ms: effective,
    base_cooldown_ms: base,
    fuzz_ms: fuzz,
    deadline: new Date(latest).toISOString(),
  });
  return effective;
}

function claudeUnifiedResetIsOverageBillingBoundary(headers: Headers, unifiedReset: string): boolean {
  const claim = lowerTrim(header(headers, "Anthropic-Ratelimit-Unified-Representative-Claim"));
  if (!claim.includes("overage")) return false;
  const unifiedAt = parseUnixOrTimestamp(unifiedReset);
  const overageAt = parseUnixOrTimestamp(header(headers, "Anthropic-Ratelimit-Unified-Overage-Reset"));
  if (unifiedAt === undefined || overageAt === undefined) return false;
  return unifiedAt === overageAt;
}

const numericPattern = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Unix seconds (fractional allowed), RFC3339 or HTTP-date to epoch ms (Go: parseUnixOrTimestamp). */
export function parseUnixOrTimestamp(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (numericPattern.test(trimmed)) {
    const sec = Number(trimmed);
    if (Number.isFinite(sec) && sec > 0) return Math.floor(sec * 1000);
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Retry-After seconds or HTTP-date/RFC3339 to an absolute epoch ms (Go: parseRetryAfterHeader). */
export function parseRetryAfterHeader(raw: string, nowMs: number): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (numericPattern.test(trimmed)) {
    const sec = Number(trimmed);
    if (Number.isFinite(sec) && sec > 0) return nowMs + Math.floor(sec * 1000);
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function randomClaudeFuzzMs(minSec: number, maxSec: number): number {
  if (maxSec <= minSec) return minSec < 0 ? 0 : minSec * 1000;
  const span = maxSec - minSec + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (minSec + (buf[0]! % span)) * 1000;
}
