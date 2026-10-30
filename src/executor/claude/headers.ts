// Upstream header assembly for the Claude executor. Port of
// applyClaudeHeadersWithNativeProfile / copyClaudeCallerFingerprintHeaders /
// applyClaudeWireHeaderCasing from internal/runtime/executor/claude_executor_request.go.
//
// Two credential modes remain:
//   (i)  caller-owned (API key, no CLI profile, no cloak): the caller's
//        fingerprint headers and betas are forwarded, with the fast-mode and
//        body-lifted betas appended;
//   (ii) Claude Code CLI profile (OAuth, claude-code-cli opt-in, or cloaked
//        credential): the Claude Code identity headers, software profile and the
//        assembled claudeCodeCLIBetas baseline.
// A confirmed native Claude Code caller (detected, not cloaked) keeps its own
// values in mode (ii) through ensureHeader.
import type { Auth } from "../../auth/types.ts";
import { applyCustomHeadersFromAttrs } from "../../util/header_helpers.ts";
import { getAt, gstr } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import {
  claudeAFKModeBeta,
  claudeAdvisorToolBeta,
  claudeBodyHasAdvisorTool,
  claudeCacheDiagnosisBeta,
  claudeCodeBeta,
  claudeCodeCLIBetas,
  claudeCountTokensBetasForCredential,
  claudeEffortBeta,
  claudeExtendedCacheTTLBeta,
  claudeFallbackCreditBeta,
  claudeFastModeBeta,
  claudeOAuthBeta,
  claudeRedactThinkingBeta,
  claudeRequestSupportsEffort,
  claudeRequestedBetas,
  claudeServerSideFallbackBeta,
  claudeThinkingBindingBeta,
  claudeThinkingDisplayUpdatesBeta,
  isManagedClaudeBeta,
  withClaudeAdvisorToolBeta,
  withClaudeBetaAppended,
  withClaudeCountTokensOAuthBeta,
  withClaudeExtendedCacheTTLBeta,
  withClaudeOAuthCredentialBetas,
  withoutClaudeBeta,
} from "./betas.ts";
import { detectClaudeCodeRequest, isClaudeCodeUserAgent } from "./client_detection.ts";
import { type ClaudeCloakConfig, resolveClaudeFingerprintPolicy, resolveClaudeWirePolicy } from "./cloaking.ts";
import { type ClaudeHeaderDefaults, applyClaudeLegacyDeviceHeaders } from "./device_profile.ts";
import { cachedSessionID } from "./identity.ts";
import { isClaudeHaikuModel } from "./model.ts";
import { claudePayloadHas1hTTL, claudeSubagentRequests1h, isClaudeProbeOrHelperRequest, isClaudeSubagentRequest } from "./request_shape.ts";
import { claudeCredentialUsesOAuth, ensureHeader, headerValueCaseInsensitive, headerValuesCaseInsensitive, isAnthropicUpstreamURL } from "./upstream.ts";

export const claudeAnthropicVersion = "2023-06-01";
export const claudeProxyUserAgent = "ai-proxy/0.1.0";

export interface ClaudeHeaderConfig extends ClaudeCloakConfig {
  headerDefaults?: ClaudeHeaderDefaults;
}

export interface ApplyClaudeHeadersOptions {
  /** Target headers (mutated). */
  headers: Headers;
  /** Fully resolved upstream URL. */
  url: string;
  auth: Auth | undefined;
  apiKey: string;
  stream: boolean;
  extraBetas?: string[];
  body: string;
  cfg?: ClaudeHeaderConfig;
  incomingHeaders?: Headers;
  confirmedClaudeCode: boolean;
  sessionID?: string;
}

/** Copies the caller's fingerprint-relevant headers upstream (Go: copyClaudeCallerFingerprintHeaders). */
export function copyClaudeCallerFingerprintHeaders(dst: Headers, src: Headers | undefined, confirmedClaudeCode: boolean, uncloak: boolean): void {
  if (!src) return;
  src.forEach((value, name) => {
    const lower = name.toLowerCase();
    const keep =
      lower === "accept" ||
      lower === "accept-encoding" ||
      lower === "user-agent" ||
      lower === "x-app" ||
      lower === "x-client-request-id" ||
      lower.startsWith("anthropic-") ||
      lower.startsWith("x-stainless-") ||
      lower.startsWith("x-claude-code-") ||
      lower.startsWith("x-claude-remote-") ||
      lower === "x-client-app" ||
      lower === "x-anthropic-additional-protection";
    if (!keep) return;
    if (!confirmedClaudeCode && (lower.startsWith("x-claude-code-") || lower.startsWith("x-claude-remote-"))) return;
    if (uncloak) {
      if (
        lower === "x-app" ||
        lower === "x-client-request-id" ||
        lower === "x-client-app" ||
        lower === "x-anthropic-additional-protection" ||
        lower === "anthropic-dangerous-direct-browser-access" ||
        lower.startsWith("x-stainless-") ||
        lower.startsWith("x-claude-code-") ||
        lower.startsWith("x-claude-remote-")
      ) {
        return;
      }
      if (lower === "user-agent" && isClaudeCodeUserAgent(value)) return;
    }
    dst.set(name, value);
  });
}

/** Assembles the upstream headers for a Messages or count_tokens request (Go: applyClaudeHeadersWithNativeProfile). */
export function applyClaudeHeaders(o: ApplyClaudeHeadersOptions): void {
  const { headers: r, auth, apiKey, stream, body, incomingHeaders } = o;
  const extraBetas = o.extraBetas ?? [];
  const hd = o.cfg?.headerDefaults;
  let confirmedClaudeCode = o.confirmedClaudeCode;
  let sessionID = (o.sessionID ?? "").trim();

  const credentialUsesBearer = claudeCredentialUsesOAuth(auth, apiKey);
  const useAPIKey = !credentialUsesBearer;
  const fp = resolveClaudeFingerprintPolicy(auth, apiKey);
  const [wirePolicy] = resolveClaudeWirePolicy(o.cfg, auth, apiKey, confirmedClaudeCode);
  if (wirePolicy.uncloak) {
    confirmedClaudeCode = false;
    sessionID = "";
  }
  const applyCLIFingerprint = fp.profileClaudeCodeCLI || wirePolicy.cloak;
  const preserveCallerFingerprint = !applyCLIFingerprint && !confirmedClaudeCode;
  const useOAuthBetas = fp.useOAuthBetas;
  const isAnthropicBase = isAnthropicUpstreamURL(o.url);

  if (apiKey.trim() !== "") {
    if (isAnthropicBase && useAPIKey) {
      r.delete("Authorization");
      r.set("x-api-key", apiKey);
    } else {
      r.delete("x-api-key");
      r.set("Authorization", "Bearer " + apiKey);
    }
  } else {
    r.delete("Authorization");
    r.delete("x-api-key");
  }
  r.set("Content-Type", "application/json");

  const incomingBetas = headerValuesCaseInsensitive(incomingHeaders, "Anthropic-Beta").join(",");
  let countTokens = false;
  try {
    countTokens = new URL(o.url).pathname.endsWith("/count_tokens");
  } catch {
    countTokens = o.url.includes("/count_tokens");
  }
  if (!confirmedClaudeCode && !wirePolicy.cloak && wirePolicy.explicitNever && !wirePolicy.uncloak) {
    const det = detectClaudeCodeRequest(incomingHeaders, body, countTokens, hd);
    if (det.confirmedShape) confirmedClaudeCode = true;
  }
  const requested = claudeRequestedBetas(incomingBetas, extraBetas);
  const advisorNeeded = requested.has(claudeAdvisorToolBeta) || claudeBodyHasAdvisorTool(body);

  let baseBetas = incomingBetas;
  if (!preserveCallerFingerprint) {
    baseBetas = claudeCodeCLIBetas(body, requested, useOAuthBetas);
    if (countTokens) {
      baseBetas = claudeCountTokensBetasForCredential(useOAuthBetas);
      if (advisorNeeded) baseBetas = withClaudeAdvisorToolBeta(baseBetas);
    }
  }
  if (confirmedClaudeCode && incomingBetas !== "") {
    baseBetas = incomingBetas;
    if (advisorNeeded) baseBetas = withClaudeAdvisorToolBeta(baseBetas);
    if (useOAuthBetas) {
      if (countTokens) {
        baseBetas = withClaudeCountTokensOAuthBeta(baseBetas);
      } else {
        const isSubagent = isClaudeSubagentRequest(incomingHeaders, body);
        const isProbe = isClaudeProbeOrHelperRequest(body);
        const subagent1h = isSubagent && claudeSubagentRequests1h(incomingHeaders, body);
        baseBetas = withClaudeOAuthCredentialBetas(baseBetas, (!isSubagent || subagent1h) && !isProbe);
      }
    }
  } else if (preserveCallerFingerprint && useOAuthBetas) {
    baseBetas = countTokens ? withClaudeCountTokensOAuthBeta(baseBetas) : withClaudeOAuthCredentialBetas(baseBetas, false);
  }
  if (preserveCallerFingerprint && advisorNeeded) baseBetas = withClaudeAdvisorToolBeta(baseBetas);
  if (!claudeRequestSupportsEffort(body)) baseBetas = withoutClaudeBeta(baseBetas, claudeEffortBeta);

  const existing = new Set(
    baseBetas
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b !== ""),
  );
  const appendBeta = (beta: string): void => {
    const b = beta.trim();
    if (b === "" || existing.has(b)) return;
    baseBetas = baseBetas.trim() === "" ? b : baseBetas + "," + b;
    existing.add(b);
  };
  const root = tryParse(body);
  if (preserveCallerFingerprint) {
    // Caller-owned mode preserves both header and body-lifted betas verbatim; speed=fast still needs its beta.
    if (gstr(getAt(root, "speed")).trim().toLowerCase() === "fast") appendBeta(claudeFastModeBeta);
    for (const beta of extraBetas) appendBeta(beta);
  } else {
    // On direct Anthropic an unconfirmed caller's managed betas are dropped; unmanaged ones are forwarded (#5738).
    if (!confirmedClaudeCode && incomingBetas !== "") {
      for (const raw of incomingBetas.split(",")) {
        const beta = raw.trim();
        if (beta === "") continue;
        if (isManagedClaudeBeta(beta) && isAnthropicBase) continue;
        appendBeta(beta);
      }
    }
    if (!isAnthropicBase) for (const beta of extraBetas) appendBeta(beta);
  }

  const applyBetaHeader = (): void => {
    if (wirePolicy.uncloak) {
      baseBetas = withoutClaudeBeta(baseBetas, claudeCodeBeta);
      baseBetas = withoutClaudeBeta(baseBetas, claudeOAuthBeta);
      baseBetas = withoutClaudeBeta(baseBetas, claudeRedactThinkingBeta);
      baseBetas = withoutClaudeBeta(baseBetas, claudeAFKModeBeta);
      if (getAt(root, "diagnostics") === undefined) baseBetas = withoutClaudeBeta(baseBetas, claudeCacheDiagnosisBeta);
      if (getAt(root, "fallback_credit_token") === undefined) baseBetas = withoutClaudeBeta(baseBetas, claudeFallbackCreditBeta);
      if (!claudePayloadHas1hTTL(root)) baseBetas = withoutClaudeBeta(baseBetas, claudeExtendedCacheTTLBeta);
    }
    if (!claudeRequestSupportsEffort(root)) baseBetas = withoutClaudeBeta(baseBetas, claudeEffortBeta);
    const probeOrHelper = isClaudeProbeOrHelperRequest(root);
    if (probeOrHelper) {
      baseBetas = withoutClaudeBeta(baseBetas, claudeServerSideFallbackBeta);
      baseBetas = withoutClaudeBeta(baseBetas, claudeThinkingDisplayUpdatesBeta);
      baseBetas = withoutClaudeBeta(baseBetas, claudeExtendedCacheTTLBeta);
    }
    if (gstr(getAt(root, "thinking.type")) === "disabled") baseBetas = withoutClaudeBeta(baseBetas, claudeThinkingDisplayUpdatesBeta);
    if (isClaudeSubagentRequest(incomingHeaders, root) && !claudeSubagentRequests1h(incomingHeaders, root)) {
      baseBetas = withoutClaudeBeta(baseBetas, claudeExtendedCacheTTLBeta);
    }
    if (!probeOrHelper && !countTokens && claudePayloadHas1hTTL(root)) baseBetas = withClaudeExtendedCacheTTLBeta(baseBetas);
    const reqModel = gstr(getAt(root, "model")).trim().toLowerCase();
    if (isClaudeHaikuModel(reqModel) && getAt(root, "fallbacks") === undefined) baseBetas = withoutClaudeBeta(baseBetas, claudeServerSideFallbackBeta);
    if (getAt(root, "thinking.block_binding") !== undefined) baseBetas = withClaudeBetaAppended(baseBetas, claudeThinkingBindingBeta);
    let emitted = baseBetas;
    for (const beta of hd?.anthropicBetaStrip ?? []) emitted = withoutClaudeBeta(emitted, beta);
    for (const beta of hd?.anthropicBetaAppend ?? []) emitted = withClaudeBetaAppended(emitted, beta);
    if (emitted.trim() === "") r.delete("Anthropic-Beta");
    else r.set("Anthropic-Beta", emitted);
  };
  applyBetaHeader();

  const attrs = auth?.attributes;
  if (preserveCallerFingerprint) {
    let defaultAccept = "application/json";
    let defaultAcceptEncoding = "gzip, deflate, br, zstd";
    if (stream && !isAnthropicBase) {
      defaultAccept = "text/event-stream";
      defaultAcceptEncoding = "identity";
    }
    copyClaudeCallerFingerprintHeaders(r, incomingHeaders, confirmedClaudeCode, wirePolicy.uncloak);
    if (hd?.clientRequestId === "off") r.delete("X-Client-Request-Id");
    ensureHeader(r, incomingHeaders, "Anthropic-Version", claudeAnthropicVersion);
    ensureHeader(r, incomingHeaders, "Accept", defaultAccept);
    ensureHeader(r, incomingHeaders, "Accept-Encoding", defaultAcceptEncoding);
    // A caller that sent no User-Agent is identified as the proxy, not a fabricated client.
    const uaSource = wirePolicy.uncloak && isClaudeCodeUserAgent(headerValueCaseInsensitive(incomingHeaders, "User-Agent")) ? undefined : incomingHeaders;
    ensureHeader(r, uaSource, "User-Agent", claudeProxyUserAgent);
    applyBetaHeader();
    if (sessionID !== "") r.set("X-Claude-Code-Session-Id", sessionID);
    applyCustomHeadersFromAttrs(r, attrs, { clientHeaders: incomingHeaders });
    const restoreCallerTransport = (): void => {
      const reset = (name: string, fallback: string): void => {
        const value = (incomingHeaders?.get(name) ?? "").trim();
        r.set(name, value !== "" ? value : fallback);
      };
      reset("Accept", defaultAccept);
      reset("Accept-Encoding", defaultAcceptEncoding);
    };
    if (isAnthropicBase) {
      applyBetaHeader();
      restoreCallerTransport();
    } else if (stream) {
      restoreCallerTransport();
    }
    return;
  }

  const identityHeader = (name: string, fallback: string): void => {
    if (confirmedClaudeCode) ensureHeader(r, incomingHeaders, name, fallback);
    else r.set(name, fallback);
  };
  identityHeader("Anthropic-Version", claudeAnthropicVersion);
  identityHeader("Anthropic-Dangerous-Direct-Browser-Access", "true");
  identityHeader("X-App", "cli");
  // Values below match Claude Code 2.1.280 / @anthropic-ai/sdk 0.112.1.
  identityHeader("X-Stainless-Retry-Count", "0");
  identityHeader("X-Stainless-Runtime", "node");
  identityHeader("X-Stainless-Lang", "js");
  if (confirmedClaudeCode && headerValueCaseInsensitive(incomingHeaders, "X-Stainless-Async") === "async") r.set("X-Stainless-Async", "async");
  if (!countTokens) {
    identityHeader("X-Stainless-Timeout", (hd?.timeout ?? "").trim() !== "" ? hd!.timeout!.trim() : "600");
  } else if (confirmedClaudeCode) {
    const incomingTimeout = headerValueCaseInsensitive(incomingHeaders, "X-Stainless-Timeout");
    if (incomingTimeout !== "") r.set("X-Stainless-Timeout", incomingTimeout);
  }
  if (sessionID !== "") r.set("X-Claude-Code-Session-Id", sessionID);
  else identityHeader("X-Claude-Code-Session-Id", cachedSessionID(apiKey));
  // Native Claude Code subagent and environment headers are preserved when present.
  for (const hdr of ["X-Claude-Code-Agent-Id", "X-Claude-Code-Parent-Agent-Id", "X-Claude-Remote-Container-Id", "X-Claude-Remote-Session-Id", "X-Client-App", "X-Anthropic-Additional-Protection"]) {
    const val = headerValueCaseInsensitive(incomingHeaders, hdr);
    if (val !== "") r.set(hdr, val);
  }
  // Gateway hints are caller-owned software state; only a confirmed native client may forward them.
  if (confirmedClaudeCode) {
    for (const hdr of ["X-Claude-Code-Request-Class", "X-Claude-Code-Agent-Type", "X-Claude-Code-Prev-Tool-Durations", "X-Claude-Code-Compaction", "X-Claude-Code-Context-Compacted"]) {
      const val = headerValueCaseInsensitive(incomingHeaders, hdr);
      if (val !== "") r.set(hdr, val);
    }
  }
  const incomingClientRequestID = headerValueCaseInsensitive(incomingHeaders, "x-client-request-id");
  if (hd?.clientRequestId !== "off" && isAnthropicBase) {
    if (hd?.clientRequestId !== "passthrough") identityHeader("x-client-request-id", crypto.randomUUID());
    else if (incomingClientRequestID !== "") r.set("x-client-request-id", incomingClientRequestID);
  }
  r.set("Connection", "keep-alive");
  const applyTransportNegotiation = (): void => {
    if (stream && !isAnthropicBase) {
      // Other Anthropic-compatible upstreams may select SSE from Accept and need not compress predictably.
      r.set("Accept", "text/event-stream");
      r.set("Accept-Encoding", "identity");
      return;
    }
    r.set("Accept", "application/json");
    r.set("Accept-Encoding", "gzip, deflate, br, zstd");
  };
  applyTransportNegotiation();
  applyClaudeLegacyDeviceHeaders(r, incomingHeaders, hd, confirmedClaudeCode);
  applyCustomHeadersFromAttrs(r, attrs, { clientHeaders: incomingHeaders });
  // Custom credential headers keep the last word on third-party gateways, but on
  // api.anthropic.com they must not rewrite the reconstructed identity.
  if (isAnthropicBase) {
    applyBetaHeader();
    applyTransportNegotiation();
  } else if (stream) {
    applyTransportNegotiation();
  }
}

/**
 * The exact header-name casing Claude Code 2.1.220 puts on the wire for the
 * names whose canonical form differs (Go: claudeWireHeaderCasing). Bun's fetch
 * lower-cases every header name on an HTTP/1.1 wire, so this map documents the
 * native casing and lets a caller build a tuple list; it changes nothing observable.
 */
export const claudeWireHeaderCasing: Readonly<Record<string, string>> = {
  "x-stainless-os": "X-Stainless-OS",
  "anthropic-beta": "anthropic-beta",
  "anthropic-version": "anthropic-version",
  "x-app": "x-app",
  "x-client-request-id": "x-client-request-id",
  "anthropic-dangerous-direct-browser-access": "anthropic-dangerous-direct-browser-access",
};

/** Header tuples in native wire casing for Anthropic's origin; other hosts keep the canonical names (Go: applyClaudeWireHeaderCasing). */
export function applyClaudeWireHeaderCasing(headers: Headers, url: string): Array<[string, string]> {
  const anthropic = isAnthropicUpstreamURL(url);
  const out: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    const wire = anthropic ? claudeWireHeaderCasing[name] : undefined;
    out.push([wire ?? canonicalHeaderName(name), value]);
  });
  return out;
}

function canonicalHeaderName(name: string): string {
  return name
    .split("-")
    .map((p) => (p === "" ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join("-");
}
