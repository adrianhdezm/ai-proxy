// Header filtering for the HTTP layer. Port of sdk/api/handlers/header_filter.go
// (FilterUpstreamHeaders, IsCPAReservedResponseHeader, WriteUpstreamHeaders) plus
// the inbound allow-list the handlers hand to executors through ExecOptions.headers
// (upstream forwards the whole gin request header; this port forwards only the
// client identity / Anthropic protocol headers and never the inbound credentials).

/** Header name prefixes injected by known AI gateways; stripped so Claude Code's telemetry does not detect a gateway. */
const gatewayHeaderPrefixes = ["x-litellm-", "helicone-", "x-portkey-", "cf-aig-", "x-kong-", "x-bt-"];

/** RFC 7230 hop-by-hop headers, security-sensitive headers and headers the proxy manages itself. */
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "content-length",
  "content-encoding",
]);

const cpaReservedResponseHeaders = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "x-cpa-trace-id",
]);

/** Whether a downstream response header is managed by the proxy (Go: IsCPAReservedResponseHeader). */
export function isCPAReservedResponseHeader(name: string): boolean {
  return cpaReservedResponseHeaders.has(name.trim().toLowerCase());
}

function connectionScopedHeaders(src: Headers): Set<string> {
  const scoped = new Set<string>();
  const raw = src.get("connection");
  if (!raw) return scoped;
  for (const token of raw.split(",")) {
    const name = token.trim().toLowerCase();
    if (name !== "") scoped.add(name);
  }
  return scoped;
}

/**
 * Copies `src` without hop-by-hop, connection-scoped, security-sensitive,
 * proxy-reserved and gateway-injected headers. Returns undefined when nothing
 * survives (Go: FilterUpstreamHeaders returns nil).
 */
export function filterUpstreamHeaders(src: Headers | undefined | null): Headers | undefined {
  if (!src) return undefined;
  const scoped = connectionScopedHeaders(src);
  const dst = new Headers();
  let count = 0;
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) return;
    if (cpaReservedResponseHeaders.has(lower)) return;
    if (scoped.has(lower)) return;
    for (const prefix of gatewayHeaderPrefixes) {
      if (lower.startsWith(prefix)) return;
    }
    dst.append(key, value);
    count++;
  });
  return count === 0 ? undefined : dst;
}

/** Adds `src` headers to `dst` without overwriting headers already set by the proxy (Go: WriteUpstreamHeaders). */
export function writeUpstreamHeaders(dst: Headers, src: Headers | undefined | null): void {
  if (!src) return;
  src.forEach((value, key) => {
    if (dst.has(key)) return;
    dst.append(key, value);
  });
}

/** Inbound header names handed to executors verbatim. */
const forwardedInboundHeaders = new Set([
  "user-agent",
  "accept",
  "accept-language",
  "content-type",
  "idempotency-key",
  "x-app",
  "x-request-id",
  "x-client-request-id",
  "x-session-id",
  "x-parent-session-id",
]);

/** Inbound header name prefixes handed to executors verbatim. */
const forwardedInboundHeaderPrefixes = ["anthropic-", "x-stainless-", "x-claude-", "x-cpa-"];

/** Whether an inbound request header may be forwarded to the provider request builder. */
export function isForwardableInboundHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === "") return false;
  if (forwardedInboundHeaders.has(lower)) return true;
  return forwardedInboundHeaderPrefixes.some((prefix) => lower.startsWith(prefix));
}

/**
 * A filtered copy of the inbound request headers for ExecOptions.headers. The
 * inbound credentials (Authorization, x-api-key, x-goog-api-key), Host and the
 * hop-by-hop headers never reach an executor.
 */
export function forwardableInboundHeaders(src: Headers | undefined | null): Headers {
  const dst = new Headers();
  if (!src) return dst;
  src.forEach((value, key) => {
    if (isForwardableInboundHeader(key)) dst.append(key, value);
  });
  return dst;
}
