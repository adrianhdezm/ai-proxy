// Request thinking for the Codex executor. Port of helps.ApplyRequestThinking /
// ApplyRequestThinkingWithModelInfo and translatedRequestSummaryConfig
// (internal/runtime/executor/helps/model_capabilities.go), plus the request-scoped
// error conversion the executor needs for translator/thinking refusals.
import {
  SummaryUnspecified,
  type SummaryConfig,
  applySummaryConfigForModel,
  applyThinkingWithFallbackModelInfoAndSummary,
  applyThinkingWithModelInfoAndSummary,
  extractExplicitSummaryConfig,
  extractSummaryConfig,
  extractTranslatedSummaryConfig,
} from "../../thinking/index.ts";
import { hasRequestTransformer } from "../../translator/registry.ts";
import type { ModelInfo } from "../../registry/index.ts";
import { isObj } from "../../util/gpath.ts";
import { type ExecOptions, type ExecRequest, StatusError } from "../types.ts";

/** Metadata key under which a caller may bind the resolved model definition (Go: cliproxy.resolved_api_key_model_info). */
export const ResolvedModelInfoMetadataKey = "cliproxy.resolved_api_key_model_info";

/** The model definition bound to the request, if any (Go: cliproxyauth.ResolvedModelInfo). */
export function resolvedModelInfo(req: ExecRequest): ModelInfo | undefined {
  const raw = req.metadata?.[ResolvedModelInfoMetadataKey];
  return isObj(raw) ? (raw as unknown as ModelInfo) : undefined;
}

/**
 * Gives the translated target payload precedence for the summary intent, then
 * the current and original source payloads (Go: translatedRequestSummaryConfig).
 */
export function translatedRequestSummaryConfig(body: string, currentSourcePayload: string, originalSourcePayload: string, model: string, fromFormat: string, toFormat: string): SummaryConfig {
  fromFormat = fromFormat.trim().toLowerCase();
  toFormat = toFormat.trim().toLowerCase();
  const targetSummary = fromFormat === toFormat ? extractSummaryConfig(body, toFormat) : extractExplicitSummaryConfig(body, toFormat);
  if (targetSummary.mode !== SummaryUnspecified) return targetSummary;

  const currentSummary = extractTranslatedSummaryConfig(currentSourcePayload, fromFormat, toFormat);
  const originalSummary = extractTranslatedSummaryConfig(originalSourcePayload, fromFormat, toFormat);
  if (currentSummary.mode === SummaryUnspecified) return originalSummary;

  if (!hasRequestTransformer(fromFormat, toFormat)) return { mode: SummaryUnspecified };

  const candidate = applySummaryConfigForModel(body, toFormat, model, currentSummary);
  if (extractExplicitSummaryConfig(candidate, toFormat).mode !== SummaryUnspecified) return { mode: SummaryUnspecified };
  return currentSummary;
}

/** Go: helps.ApplyRequestThinking (global registry unless a model definition is bound to the request). */
export function applyRequestThinking(body: string, req: ExecRequest, opts: ExecOptions, fromFormat: string, toFormat: string, provider: string): string {
  const originalSource = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
  const source = req.payload.length > 0 ? req.payload : (opts.originalRequest ?? "");
  const summaryConfig = translatedRequestSummaryConfig(body, req.payload, originalSource, req.model, fromFormat, toFormat);
  const bound = resolvedModelInfo(req);
  if (bound !== undefined) return applyThinkingWithModelInfoAndSummary(body, source, req.model, fromFormat, toFormat, provider, bound, summaryConfig);
  return applyThinkingWithFallbackModelInfoAndSummary(body, source, req.model, fromFormat, toFormat, provider, undefined, summaryConfig);
}

/** Converts a request-scoped translator/thinking refusal into a StatusError the manager will not fail over. */
export function asRequestError(err: unknown): unknown {
  if (err instanceof StatusError) return err;
  if (err && typeof err === "object" && (err as { requestScoped?: unknown }).requestScoped === true) {
    const status = typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    const body = JSON.stringify({ error: { message, type: "invalid_request_error" } });
    return new StatusError(status, message, { body, requestScoped: true, cause: err });
  }
  return err;
}
