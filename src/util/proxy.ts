// Proxy setting interpretation. Port of Parse, ValidRequestProxy and Redact from
// sdk/proxyutil/proxy.go. Transport construction (BuildHTTPTransport, the SOCKS5 and
// HTTP CONNECT dialers) is replaced by Bun's fetch `proxy` option; see
// src/executor/proxy.ts for how the executors pick the effective proxy.

export type ProxyMode = "inherit" | "direct" | "proxy" | "invalid";

export interface ProxySetting {
  raw: string;
  mode: ProxyMode;
  /** Present in "proxy" mode. */
  url?: { scheme: string; userinfo?: string; host: string; hostname: string; port: string };
}

const supportedSchemes = new Set(["socks5", "socks5h", "http", "https"]);

/** Splits scheme://[userinfo@]host[path]; undefined when the shape or a percent-escape is invalid (Go: url.Parse). */
function splitURL(raw: string): { scheme: string; userinfo?: string; host: string } | undefined {
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) return undefined;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/.exec(raw);
  if (!match) return undefined;
  const authority = match[2]!;
  const at = authority.lastIndexOf("@");
  return { scheme: match[1]!.toLowerCase(), userinfo: at >= 0 ? authority.slice(0, at) : undefined, host: at >= 0 ? authority.slice(at + 1) : authority };
}

function hostParts(host: string): { hostname: string; port: string } {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return { hostname: host.slice(1, end), port: host.slice(end + 2) };
  }
  const colon = host.lastIndexOf(":");
  return colon >= 0 ? { hostname: host.slice(0, colon), port: host.slice(colon + 1) } : { hostname: host, port: "" };
}

/**
 * Normalises a proxy value into inherit ("" ), direct ("direct"/"none") or proxy modes. Errors never
 * echo the raw value, which may carry credentials (Go: proxyutil.Parse).
 */
export function parseProxySetting(raw: string): { setting: ProxySetting; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { setting: { raw: trimmed, mode: "inherit" } };
  const lowered = trimmed.toLowerCase();
  if (lowered === "direct" || lowered === "none") return { setting: { raw: trimmed, mode: "direct" } };
  const parts = splitURL(trimmed);
  if (!parts) {
    const shaped = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed);
    return { setting: { raw: trimmed, mode: "invalid" }, error: shaped ? "parse proxy URL failed" : "proxy URL missing scheme/host" };
  }
  if (parts.host === "") return { setting: { raw: trimmed, mode: "invalid" }, error: "proxy URL missing scheme/host" };
  if (!supportedSchemes.has(parts.scheme)) return { setting: { raw: trimmed, mode: "invalid" }, error: `unsupported proxy scheme: ${parts.scheme}` };
  return { setting: { raw: trimmed, mode: "proxy", url: { ...parts, ...hostParts(parts.host) } } };
}

/** A concrete per-request proxy override with a host and, when given, a port in 1..65535 (Go: ValidRequestProxy). */
export function validRequestProxy(raw: string): boolean {
  const { setting, error } = parseProxySetting(raw);
  if (error || setting.mode !== "proxy" || !setting.url || setting.url.hostname.trim() === "") return false;
  if (setting.url.port === "") return true;
  if (!/^\d+$/.test(setting.url.port)) return false;
  const port = Number(setting.url.port);
  return port >= 1 && port <= 65535;
}

/** The proxy URL with userinfo replaced, path and query dropped, for logs (Go: proxyutil.Redact). */
export function redactProxyURL(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const parts = splitURL(trimmed);
  if (!parts || parts.host === "") return "<invalid proxy URL>";
  return `${parts.scheme}://${parts.userinfo !== undefined ? "redacted@" : ""}${parts.host}`;
}
