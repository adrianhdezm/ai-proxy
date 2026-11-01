// GET /v0/usage body. Port of the management GetUsageStatistics handler
// (v6 internal/api/handlers/management/usage.go: {"usage": snapshot,
// "failed_requests": n}) with an optional `?since=` lower bound.
import type { UsageStatistics } from "./statistics.ts";

/**
 * Parses `since`: an RFC 3339 / ISO date, or epoch seconds / milliseconds
 * (values below 1e12 are seconds). Returns undefined for an absent value and
 * NaN for an invalid one.
 */
export function parseSince(raw: string | null): number | undefined {
  const value = (raw ?? "").trim();
  if (value === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** The JSON response for an enabled statistics store; 400 for an invalid `since`. */
export function usageStatisticsResponse(statistics: UsageStatistics, url: URL): Response {
  const since = parseSince(url.searchParams.get("since"));
  if (since !== undefined && Number.isNaN(since)) {
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "invalid since: expected an RFC 3339 timestamp or epoch seconds/milliseconds" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(statistics.snapshot({ since })), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
