// Upstream header policy for the Codex executor. Port of
// applyCodexHeadersWithSIWC (non-SIWC branch), applyCodexRoutingHint,
// applyCodexCloakingHeaders, isCodexCloakingDisabled and applyModelHeaderOverrides
// (codex_executor_request.go) plus codexHeaderDefaults / ensureHeaderWithConfigPrecedence
// (codex_websockets_request.go) and misc.EnsureHeader.
import type { Auth } from "../../auth/types.ts";
import { modelOverrideHeaders } from "../../registry/index.ts";
import { applyCustomHeadersFromAttrs, extractCustomHeaders } from "../../util/header_helpers.ts";
import { getAt } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { codexAuthUsesAPIKey, headerValueCaseInsensitive } from "./creds.ts";

/** Native Codex CLI identity (Go: codexUserAgent / codexOriginator, copied verbatim). */
export const codexUserAgent = "codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)";
export const codexOriginator = "codex-tui";
export const codexRoutingHintHeader = "X-Codex-Routing-Hint";

/** Attribute that disables cloaking per credential (Go: cliproxyauth.AttributeCodexDisableCloaking). */
export const AttributeCodexDisableCloaking = "codex_disable_cloaking";

/** Operator header defaults (Go: config.CodexHeaderDefaults); applied to OAuth credentials only. */
export interface CodexHeaderDefaults {
  userAgent?: string;
  betaFeatures?: string;
}

export interface CodexHeaderPolicy {
  /** Skip forcing the official User-Agent/Originator (Go: codex.disable-codex-cloaking). */
  disableCloaking?: boolean;
  headerDefaults?: CodexHeaderDefaults;
}

/** Client headers forwarded verbatim when the inbound request carries them (Go: misc.EnsureHeader calls). */
const forwardedClientHeaders = [
  "Version",
  "X-Codex-Turn-Metadata",
  "X-Codex-Turn-State",
  "X-Client-Request-Id",
  "X-Codex-Window-Id",
  "Thread-Id",
  "Session-Id",
  "X-Openai-Internal-Codex-Responses-Lite",
];

/**
 * Sets `key` from the client's request when it sent a non-empty value, else
 * keeps an existing value, else sets the default when non-empty (Go: misc.EnsureHeader).
 */
export function ensureHeader(target: Headers, source: Headers | undefined, key: string, defaultValue: string): void {
  const incoming = headerValueCaseInsensitive(source, key);
  if (incoming !== "") {
    target.set(key, incoming);
    return;
  }
  if ((target.get(key) ?? "").trim() !== "") return;
  if (defaultValue.trim() !== "") target.set(key, defaultValue.trim());
}

/** Existing target > config value > client value > fallback (Go: ensureHeaderWithConfigPrecedence). */
export function ensureHeaderWithConfigPrecedence(target: Headers, source: Headers | undefined, key: string, configValue: string, fallbackValue: string): void {
  if ((target.get(key) ?? "").trim() !== "") return;
  if (configValue.trim() !== "") {
    target.set(key, configValue.trim());
    return;
  }
  const incoming = headerValueCaseInsensitive(source, key);
  if (incoming !== "") {
    target.set(key, incoming);
    return;
  }
  if (fallbackValue.trim() !== "") target.set(key, fallbackValue.trim());
}

/** Config header defaults apply to OAuth credentials only (Go: codexHeaderDefaults). */
export function codexHeaderDefaults(policy: CodexHeaderPolicy | undefined, auth: Auth | undefined): { userAgent: string; betaFeatures: string } {
  if (!policy?.headerDefaults || !auth || codexAuthUsesAPIKey(auth)) return { userAgent: "", betaFeatures: "" };
  return { userAgent: (policy.headerDefaults.userAgent ?? "").trim(), betaFeatures: (policy.headerDefaults.betaFeatures ?? "").trim() };
}

/** Whether the credential or the policy turns cloaking off (Go: isCodexCloakingDisabled, config-entry lookup folded into the policy). */
export function isCodexCloakingDisabled(policy: CodexHeaderPolicy | undefined, auth: Auth | undefined): boolean {
  const raw = (auth?.attributes?.[AttributeCodexDisableCloaking] ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "t") return true;
  if (raw === "false" || raw === "0" || raw === "f") return false;
  return policy?.disableCloaking === true;
}

/** Forces the official Codex CLI identity unless cloaking is disabled (Go: applyCodexCloakingHeaders). */
export function applyCodexCloakingHeaders(headers: Headers, policy: CodexHeaderPolicy | undefined, auth: Auth | undefined): void {
  if (isCodexCloakingDisabled(policy, auth)) return;
  headers.set("User-Agent", codexUserAgent);
  headers.set("Originator", codexOriginator);
}

/**
 * Builds the upstream request headers (Go: applyCodexHeadersWithSIWC, useSIWC=false).
 * `clientHeaders` are the inbound request headers; `token` the Bearer credential.
 */
export function applyCodexHeaders(headers: Headers, auth: Auth | undefined, token: string, stream: boolean, policy: CodexHeaderPolicy | undefined, clientHeaders: Headers | undefined): void {
  headers.set("Content-Type", "application/json");
  if (token.trim() !== "") headers.set("Authorization", "Bearer " + token);
  else headers.delete("Authorization");

  const betaFeatures = headerValueCaseInsensitive(clientHeaders, "X-Codex-Beta-Features");
  if (betaFeatures !== "") headers.set("X-Codex-Beta-Features", betaFeatures);
  for (const key of forwardedClientHeaders) ensureHeader(headers, clientHeaders, key, "");

  const defaults = codexHeaderDefaults(policy, auth);
  ensureHeaderWithConfigPrecedence(headers, clientHeaders, "User-Agent", defaults.userAgent, codexUserAgent);

  headers.set("Accept", stream ? "text/event-stream" : "application/json");
  headers.set("Connection", "Keep-Alive");

  const isAPIKey = codexAuthUsesAPIKey(auth);
  const originator = headerValueCaseInsensitive(clientHeaders, "Originator");
  if (originator !== "") headers.set("Originator", originator);
  else if (!isAPIKey) headers.set("Originator", codexOriginator);
  if (!isAPIKey) {
    const accountID = auth?.metadata?.account_id;
    if (typeof accountID === "string") headers.set("Chatgpt-Account-Id", accountID);
  }
  applyCustomHeadersFromAttrs(headers, auth?.attributes, { clientHeaders });
  applyCodexCloakingHeaders(headers, policy, auth);
}

/** The value an auth "header:" rule resolves to for `name`, "" when none (Go: codexOperatorHeaderValue). */
export function codexOperatorHeaderValue(auth: Auth | undefined, clientHeaders: Headers | undefined, name: string): string {
  if (!auth || !auth.attributes || Object.keys(auth.attributes).length === 0) return "";
  const resolved = extractCustomHeaders(auth.attributes, clientHeaders, { clientHeaders });
  for (const [key, value] of Object.entries(resolved)) {
    if (key.toLowerCase() === name.toLowerCase()) return value.trim();
  }
  return "";
}

/**
 * Sends the routing hint native Codex attaches to ChatGPT-backend requests:
 * "model=<slug>[;tier=<service_tier>]". API-key requests are not touched; an
 * operator "header:" rule for the hint keeps precedence (Go: applyCodexRoutingHint).
 */
export function applyCodexRoutingHint(headers: Headers, auth: Auth | undefined, baseModel: string, upstreamBody: string, clientHeaders: Headers | undefined): void {
  if (codexAuthUsesAPIKey(auth)) return;
  headers.delete(codexRoutingHintHeader);
  const operatorHint = codexOperatorHeaderValue(auth, clientHeaders, codexRoutingHintHeader);
  if (operatorHint !== "") {
    headers.set(codexRoutingHintHeader, operatorHint);
    return;
  }
  const model = baseModel.trim();
  if (model === "") return;
  let hint = "model=" + model;
  const tier = getAt(tryParse(upstreamBody), "service_tier");
  if (typeof tier === "string" && tier.trim() !== "") hint += ";tier=" + tier.trim();
  headers.set(codexRoutingHintHeader, hint);
}

/** Forces models.json config.override_header onto the upstream headers (Go: applyModelHeaderOverrides). */
export function applyModelHeaderOverrides(headers: Headers, modelName: string): void {
  const overrides = modelOverrideHeaders(modelName);
  if (!overrides) return;
  for (const [key, value] of Object.entries(overrides)) headers.set(key, value);
  if ((headers.get("User-Agent") ?? "").includes("Mac OS") && codexSessionHeaderValue(headers) === "") {
    headers.set("Session_id", crypto.randomUUID());
  }
}

/** Go: codexSessionHeaderValue. */
export function codexSessionHeaderValue(headers: Headers | undefined): string {
  for (const key of ["Session-Id", "Session_id", "session_id"]) {
    const value = headerValueCaseInsensitive(headers, key);
    if (value !== "") return value;
  }
  return "";
}
