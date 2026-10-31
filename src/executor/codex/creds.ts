// Credential resolution for the Codex executor. Port of codexCreds /
// codexCredsForRequest (codex_executor_auth.go, SIWC branch dropped),
// codexAuthUsesAPIKey (codex_websockets_request.go), isCodexFreePlanAuth
// (codex_executor_request.go) and util.IsCodexResponsesLiteRequest (internal/util/codex.go).
import { type Auth, AttributeAPIKey, AttributeBaseURL } from "../../auth/types.ts";
import { authKind, AuthKindAPIKey } from "../../auth/manager/classification.ts";
import { getAt, gstr } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

/** Default ChatGPT backend used by OAuth credentials without a base_url attribute. */
export const DefaultCodexBaseURL = "https://chatgpt.com/backend-api/codex";

/** Codex Responses Lite marker header (Go: codexResponsesLiteHeader). */
export const codexResponsesLiteHeader = "X-OpenAI-Internal-Codex-Responses-Lite";

export interface CodexCreds {
  /** Bearer token: attributes.api_key, else metadata.access_token. */
  apiKey: string;
  /** attributes.base_url ("" when unset; callers substitute DefaultCodexBaseURL). */
  baseURL: string;
}

/** Credential material of an auth (Go: codexCreds, non-SIWC branch). */
export function codexCreds(auth: Auth | undefined): CodexCreds {
  if (!auth) return { apiKey: "", baseURL: "" };
  const baseURL = auth.attributes?.[AttributeBaseURL] ?? "";
  let apiKey = auth.attributes?.[AttributeAPIKey] ?? "";
  if (apiKey === "") {
    const token = auth.metadata?.access_token;
    if (typeof token === "string") apiKey = token;
  }
  return { apiKey, baseURL };
}

/** The effective base URL: attributes.base_url or the ChatGPT backend. */
export function codexBaseURL(auth: Auth | undefined): string {
  const base = codexCreds(auth).baseURL.trim();
  return base === "" ? DefaultCodexBaseURL : base;
}

/** Whether the credential is an API key rather than a ChatGPT OAuth token (Go: codexAuthUsesAPIKey). */
export function codexAuthUsesAPIKey(auth: Auth | undefined): boolean {
  if (!auth) return false;
  if (authKind(auth) === AuthKindAPIKey) return true;
  return (auth.attributes?.[AttributeAPIKey] ?? "").trim() !== "";
}

/** Whether the auth is a ChatGPT "free" plan credential (Go: isCodexFreePlanAuth). */
export function isCodexFreePlanAuth(auth: Auth | undefined): boolean {
  if (!auth || !auth.attributes) return false;
  if ((auth.provider ?? "").trim().toLowerCase() !== "codex") return false;
  return (auth.attributes.plan_type ?? "").trim().toLowerCase() === "free";
}

/**
 * The ChatGPT plan type of a credential (attributes.plan_type, else
 * metadata.plan_type), used by the app wiring to pick the Codex model catalog
 * (registry.getCodexModelsForPlan). "" when unknown.
 */
export function planTypeOf(auth: Auth | undefined): string {
  if (!auth) return "";
  const attr = (auth.attributes?.plan_type ?? "").trim();
  if (attr !== "") return attr.toLowerCase();
  const meta = auth.metadata?.plan_type;
  return typeof meta === "string" ? meta.trim().toLowerCase() : "";
}

/** First non-empty header value (Go: headerValueCaseInsensitive); Headers is already case-insensitive. */
export function headerValueCaseInsensitive(headers: Headers | undefined, name: string): string {
  if (!headers) return "";
  return (headers.get(name) ?? "").trim();
}

/** Recognises the native Responses Lite header and its websocket metadata mirror (Go: util.IsCodexResponsesLiteRequest). */
export function isCodexResponsesLiteRequest(body: string | unknown, headers: Headers | undefined): boolean {
  if (headerValueCaseInsensitive(headers, codexResponsesLiteHeader).toLowerCase() === "true") return true;
  const root = typeof body === "string" ? tryParse(body) : body;
  const value = getAt(root, "client_metadata.ws_request_header_x_openai_internal_codex_responses_lite");
  if (value === true) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/** Whether a request is the native Codex dialect on both sides and Responses Lite (Go: helps.IsNativeCodexRequest). */
export function isNativeCodexRequest(body: string, sourceFormat: string, responseFormat: string, headers: Headers | undefined): boolean {
  for (const format of [sourceFormat, responseFormat]) {
    const name = (format ?? "").trim().toLowerCase();
    if (name !== "codex" && name !== "openai-response") return false;
  }
  return isCodexResponsesLiteRequest(body, headers);
}

/** Convenience for callers that only have a parsed body. */
export function gstrAt(root: unknown, path: string): string {
  return gstr(getAt(root, path));
}
