// Upstream error classification for the Claude executor. Port of
// classifyClaudeUpstreamError / claudeBodyIndicatesFastModeCredits
// (claude_executor_request.go), isClaudeOAuthScope403 (claude_executor_auth.go)
// and the request-scoped body errors of claude_executor_cloaking.go, expressed
// through the StatusError fields the auth manager reads:
//
//   status      | headers                                   | flags
//   429         | unified 5h/7d rejection, !modelLevelCooling| credentialScoped (whole credential cools)
//   429         | fast-mode credits refusal body             | requestScoped (no failover, no cooldown)
//   429         | anything else                              | model-scoped quota (no flags)
//   other 4xx/5xx|                                           | plain StatusError (retryAfterMs when headers say so)
import { StatusError } from "../types.ts";
import { getAt, gstr } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { claudeHeadersIndicateUnifiedRateLimitRejection, parseClaudeRateLimitResetForError } from "./ratelimit.ts";

/** Classifies a non-2xx Claude upstream response (Go: classifyClaudeUpstreamError). */
export function classifyClaudeUpstreamError(statusCode: number, headers: Headers | undefined, body: string, nowMs: number = Date.now()): StatusError {
  return classifyClaudeUpstreamErrorWithCooling(statusCode, headers, body, false, nowMs);
}

/**
 * Promotes upstream refusals that no other credential can satisfy into
 * request-scoped errors and marks shared-window rate limits as credential-scoped
 * (Go: classifyClaudeUpstreamErrorWithCooling).
 */
export function classifyClaudeUpstreamErrorWithCooling(
  statusCode: number,
  headers: Headers | undefined,
  body: string,
  modelLevelCooling: boolean,
  nowMs: number = Date.now(),
): StatusError {
  let retryAfterMs: number | undefined;
  if (statusCode === 429 || (statusCode >= 400 && statusCode < 600)) {
    retryAfterMs = parseClaudeRateLimitResetForError(headers, body, nowMs);
  }
  const make = (flags: { credentialScoped?: boolean; requestScoped?: boolean } = {}) =>
    new StatusError(statusCode, body, { headers, body, retryAfterMs, ...flags });
  if (statusCode === 429) {
    if (!modelLevelCooling && claudeHeadersIndicateUnifiedRateLimitRejection(headers)) {
      return make({ credentialScoped: true });
    }
    if (claudeBodyIndicatesFastModeCredits(body)) {
      return make({ requestScoped: true, credentialScoped: false });
    }
    // Ordinary model-level Claude 429 (not a unified 5h/7d rejection)
    return make({ credentialScoped: false });
  }
  return make();
}

/** Matches Anthropic's fast-mode entitlement refusal without matching a genuine rate limit. */
export function claudeBodyIndicatesFastModeCredits(body: string): boolean {
  let message = gstr(getAt(tryParse(body), "error.message")).toLowerCase();
  if (message === "") message = body.toLowerCase();
  return message.includes("fast request rejected") || (message.includes("fast") && (message.includes("usage credits") || message.includes("credits are required")));
}

/** Whether a profile/scope error is a 403-class OAuth scope refusal (Go: isClaudeOAuthScope403). */
export function isClaudeOAuthScope403(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("status 403") ||
    msg.includes("403 forbidden") ||
    msg.includes("403") ||
    msg.includes("forbidden") ||
    msg.includes("permission_error") ||
    msg.includes("scope requirement") ||
    msg.includes("insufficient_scope") ||
    msg.includes("user:profile") ||
    msg.includes("user:office")
  );
}

/** A caller system block Claude cannot carry in any system slot (Go: newClaudeCallerSystemBlockError). */
export function newClaudeCallerSystemBlockError(index: number, blockType: string): StatusError {
  const type = blockType === "" ? "unknown" : blockType;
  const msg =
    `invalid_request_error: system.${index}.type: Input should be 'text'. ` +
    `System instructions support text only, but this block has type "${type}". ` +
    "Move non-text content into a user message.";
  return new StatusError(400, msg, { requestScoped: true });
}

/** A mid-conversation role=system turn addressed to a model that cannot carry it (Go: newClaudeMidSystemMessageModelError). */
export function newClaudeMidSystemMessageModelError(model: string): StatusError {
  const name = model === "" ? "unknown" : model;
  const msg =
    "invalid_request_error: role 'system' is not supported on this model. " +
    `Model "${name}" predates mid-conversation system turns, so system instructions must ` +
    "stay in the top-level system field for it.";
  return new StatusError(400, msg, { requestScoped: true });
}

/** HTTP status for an in-stream `event: error` payload type. */
export function claudeStreamErrorStatus(errorType: string): number {
  switch (errorType) {
    case "overloaded_error":
      return 529;
    case "rate_limit_error":
      return 429;
    case "authentication_error":
      return 401;
    case "permission_error":
      return 403;
    case "not_found_error":
      return 404;
    case "invalid_request_error":
      return 400;
    case "request_too_large":
      return 413;
    case "billing_error":
      return 402;
    case "timeout_error":
      return 504;
    case "api_error":
      return 500;
    default:
      return 502;
  }
}
