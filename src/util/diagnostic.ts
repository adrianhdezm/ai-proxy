// Log-safe diagnostics. Port of internal/logging/diagnostic.go: SafeDiagnosticForLog keeps
// a bounded single-line excerpt with credential values and URL userinfo redacted (the
// "access token expired" signal survives truncation); SafeErrorDiagnostic extracts only
// allowlisted failure signals and never the free-form error text.

export const DiagnosticLogRuneLimit = 300;
const diagnosticLogScanRuneLimit = 600;

const accessTokenExpiredPattern = /access token expired/i;
const sensitiveAssignmentPattern =
  /(["']?(?:access[\s_-]*token|refresh[\s_-]*token|id[\s_-]*token|api[\s_-]*key|client[\s_-]*secret|private[\s_-]*key|proxy[\s_-]*authorization|authorization|password|credential|token|secret)["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+[^\s,;]+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;&}\]]+)/gi;
const authorizationPattern = /\b(bearer|basic)\s+[^\s,;]+/gi;
const urlUserinfoPattern = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const statusPattern = /\bstatus(?:\s+code)?\s*[:=]?\s*([1-5][0-9]{2})\b/i;

/** A bounded, single-line, redacted diagnostic for ordinary logs (Go: SafeDiagnosticForLog). */
export function safeDiagnosticForLog(message: string): string {
  const runes = Array.from(message);
  const sourceTruncated = runes.length > diagnosticLogScanRuneLimit;
  let excerpt = sourceTruncated ? runes.slice(0, diagnosticLogScanRuneLimit).join("") : message;
  if (sourceTruncated && !accessTokenExpiredPattern.test(excerpt)) {
    const marker = accessTokenExpiredPattern.exec(message);
    if (marker) excerpt += " ... " + marker[0];
  }
  excerpt = excerpt.split(/\s+/).filter((field) => field !== "").join(" ");
  if (excerpt === "") return "";
  excerpt = excerpt.replace(urlUserinfoPattern, "$1[REDACTED]@");
  excerpt = excerpt.replace(sensitiveAssignmentPattern, '$1"[REDACTED]"');
  excerpt = excerpt.replace(authorizationPattern, "$1 [REDACTED]");
  return truncateExcerpt(excerpt, sourceTruncated);
}

function truncateExcerpt(message: string, sourceTruncated: boolean): string {
  const runes = Array.from(message);
  if (runes.length <= DiagnosticLogRuneLimit) return sourceTruncated ? message + "..." : message;
  let output = runes.slice(0, DiagnosticLogRuneLimit).join("");
  const match = accessTokenExpiredPattern.exec(message);
  if (match) {
    const markerStart = Array.from(message.slice(0, match.index)).length;
    const markerEnd = markerStart + Array.from(match[0]).length;
    if (markerEnd > DiagnosticLogRuneLimit) {
      const separator = " ... ";
      const prefixLimit = Math.max(0, DiagnosticLogRuneLimit - separator.length - (markerEnd - markerStart));
      output = runes.slice(0, prefixLimit).join("") + separator + runes.slice(markerStart, markerEnd).join("");
    }
  }
  return output + "...";
}

const signals: [needle: string, label: string][] = [
  ["socks", "proxy=socks"],
  ["proxyconnect", "proxy_connect_failed"],
  ["proxy connect", "proxy_connect_failed"],
  ["dial ", "dial_failed"],
  ["dial failed", "dial_failed"],
  ["connection refused", "connection_refused"],
  ["connection reset", "connection_reset"],
  ["connection aborted", "connection_aborted"],
  ["stream reset", "stream_reset"],
  ["network is unreachable", "network_unreachable"],
  ["no route to host", "network_unreachable"],
  ["no such host", "dns_not_found"],
  ["server misbehaving", "dns_failure"],
  ["tls handshake timeout", "tls_handshake_timeout"],
  ["i/o timeout", "timeout"],
  ["deadline exceeded", "timeout"],
  ["unexpected eof", "unexpected_EOF"],
  ["certificate", "tls_certificate_error"],
  ["invalid character", "invalid_response_json"],
  ["cannot unmarshal", "invalid_response_json"],
  ["invalid_grant", "oauth_error=invalid_grant"],
  ["refresh_token_expired", "oauth_error=refresh_token_expired"],
  ["refresh_token_revoked", "oauth_error=refresh_token_revoked"],
  ["refresh_token_reused", "oauth_error=refresh_token_reused"],
];

/** Only allowlisted failure signals of an error, never its free-form text (Go: SafeErrorDiagnostic). */
export function safeErrorDiagnostic(err: unknown): string {
  if (err === undefined || err === null) return "";
  const parts: string[] = [];
  const add = (part: string) => {
    if (part !== "" && !parts.includes(part)) parts.push(part);
  };
  let rawOriginal = "";
  const seen = new Set<unknown>();
  for (let current: unknown = err; current !== undefined && current !== null && !seen.has(current); current = current instanceof Error ? current.cause : undefined) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.name === "TimeoutError") add("timeout");
      if (current.name === "AbortError") add("canceled");
    }
    if (rawOriginal === "") rawOriginal = current instanceof Error ? current.message : String(current);
  }
  const raw = rawOriginal.toLowerCase();
  if (rawOriginal.trim().toUpperCase() === "EOF") add("EOF");
  if (raw.includes("socks") && (raw.includes("authentication failed") || raw.includes("authentication required"))) add("proxy_authentication_failed");
  for (const [needle, label] of signals) if (raw.includes(needle)) add(label);
  const status = statusPattern.exec(rawOriginal);
  if (status) add(`status=${status[1]}`);
  if (parts.length === 0) add(`error_type=${err instanceof Error ? err.name : typeof err}`);
  return parts.join(" ");
}
