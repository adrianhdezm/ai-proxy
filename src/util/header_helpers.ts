// Port of internal/util/header_helpers.go onto the Fetch Headers API.
//
// Go carried the internal session id and the client's request headers on the
// request context (and fell back to a Gin context). Here the caller passes them
// explicitly through CustomHeaderContext.

/** Request-scoped inputs that Go read from context.Context. */
export interface CustomHeaderContext {
  /** The client's inbound request headers, for "$Header-Name" references. */
  clientHeaders?: Headers;
  /**
   * The internal session id for "$CPA-SESSION-ID". A present (even empty) value is
   * explicit and overrides the resolver, mirroring WithSessionID(ctx, "") clearing it.
   */
  sessionID?: string;
}

/** Pluggable resolver for the internal session id (Go: util.SessionIDResolver). */
export type SessionIDResolver = (ctx: CustomHeaderContext, clientHeaders: Headers | undefined) => string;

let sessionIDResolver: SessionIDResolver | undefined;

export function setSessionIDResolver(resolver: SessionIDResolver | undefined): void {
  sessionIDResolver = resolver;
}

export function getSessionIDResolver(): SessionIDResolver | undefined {
  return sessionIDResolver;
}

/** Result of applying custom headers: the Host value, if one was set. */
export interface AppliedCustomHeaders {
  host?: string;
}

/**
 * Applies user-defined headers stored in the attributes map ("header:<Name>" keys)
 * onto `target`. A value starting with "$" is resolved from the client's request
 * headers and omitted when absent; "$CPA-SESSION-ID" expands to the internal
 * session id. Custom headers override built-in defaults.
 */
export function applyCustomHeadersFromAttrs(
  target: Headers,
  attrs: Record<string, string> | undefined,
  ctx: CustomHeaderContext = {},
): AppliedCustomHeaders {
  const headers = extractCustomHeaders(attrs, ctx.clientHeaders, ctx);
  return applyCustomHeaders(target, headers);
}

function resolveCPASessionID(ctx: CustomHeaderContext, clientHeaders: Headers | undefined): string {
  if (ctx.sessionID !== undefined) {
    const id = ctx.sessionID.trim();
    // An explicit (even empty) session id wins over the resolver.
    return id;
  }
  if (sessionIDResolver) {
    const id = sessionIDResolver(ctx, clientHeaders);
    if (id !== "") return id.trim();
  }
  return "";
}

export function replaceCPASessionID(val: string, sessionID: string): string {
  const target = "$CPA-SESSION-ID";
  const targetLen = target.length;
  if (val.length < targetLen) return val;
  let out = "";
  let start = 0;
  let i = 0;
  while (i <= val.length - targetLen) {
    if (val[i] === "$" && val.slice(i, i + targetLen).toUpperCase() === target) {
      out += val.slice(start, i) + sessionID;
      i += targetLen;
      start = i;
    } else {
      i++;
    }
  }
  if (start === 0) return val;
  return out + val.slice(start);
}

export function extractCustomHeaders(
  attrs: Record<string, string> | undefined,
  clientHeaders: Headers | undefined,
  ctx: CustomHeaderContext,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!attrs) return headers;
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith("header:")) continue;
    const name = k.slice("header:".length).trim();
    if (name === "") continue;
    let val = v.trim();
    if (val === "") continue;
    if (val.startsWith("$") && val.slice(1).trim().toUpperCase() === "CPA-SESSION-ID") {
      const sessionID = resolveCPASessionID(ctx, clientHeaders);
      if (sessionID === "") continue;
      val = sessionID;
    } else if (val.toUpperCase().includes("$CPA-SESSION-ID")) {
      const sessionID = resolveCPASessionID(ctx, clientHeaders);
      if (sessionID === "") continue;
      val = replaceCPASessionID(val, sessionID);
    } else if (val.startsWith("$")) {
      const varName = val.slice(1).trim();
      if (varName === "") continue;
      if (!clientHeaders) continue;
      const clientVal = clientHeaders.get(varName) ?? "";
      if (clientVal === "") continue;
      val = clientVal;
    }
    headers[name] = val;
  }
  return headers;
}

function applyCustomHeaders(target: Headers, headers: Record<string, string>): AppliedCustomHeaders {
  const applied: AppliedCustomHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === "" || v === "") continue;
    if (k.toLowerCase() === "host") applied.host = v;
    try {
      target.set(k, v);
    } catch {
      // Forbidden header names (e.g. Host) cannot be set on some Headers implementations;
      // the caller still receives them through the returned value.
    }
  }
  return applied;
}
