// Outbound proxy selection shared by the executors. Port of
// internal/runtime/executor/helps/proxy_helpers.go (effectiveProxyURL and the
// proxy half of NewProxyAwareHTTPClient) and the direct/none modes of
// sdk/proxyutil. Bun's fetch takes the proxy URL as its `proxy` option, so the
// transport construction reduces to choosing that string.

/**
 * The proxy for one upstream call: the request override, then the credential's
 * proxy, then the global one. Blank values fall through (Go: effectiveProxyURL).
 */
export function effectiveProxyURL(requestProxy: string | undefined, authProxy: string | undefined, globalProxy: string | undefined): string {
  for (const candidate of [requestProxy, authProxy, globalProxy]) {
    const trimmed = (candidate ?? "").trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** "direct" and "none" disable proxying, including an inherited global proxy (Go: proxyutil.ModeDirect). */
export function isDirectProxyURL(proxyURL: string): boolean {
  const trimmed = proxyURL.trim().toLowerCase();
  return trimmed === "direct" || trimmed === "none";
}

/** The value for Bun's fetch `proxy` option, or undefined for a direct connection. */
export function fetchProxyOption(proxyURL: string): string | undefined {
  const trimmed = proxyURL.trim();
  if (trimmed === "" || isDirectProxyURL(trimmed)) return undefined;
  return trimmed;
}

/** Sets init.proxy from the effective proxy (request > credential > global); direct/none leave it unset. */
export function applyFetchProxy<T extends { proxy?: string }>(init: T, requestProxy: string | undefined, authProxy: string | undefined, globalProxy: string | undefined): T {
  const proxy = fetchProxyOption(effectiveProxyURL(requestProxy, authProxy, globalProxy));
  if (proxy !== undefined) init.proxy = proxy;
  else delete init.proxy;
  return init;
}
