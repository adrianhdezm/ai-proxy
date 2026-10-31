// Model -> provider resolution shared by the Claude, Responses and Responses
// websocket handlers. Port of getRequestDetailsWithOptions, validateImageOnlyModel,
// isOpenAIImageOnlyModel and routeModelBaseName from sdk/api/handlers/handlers_routing.go
// and ResolveAutoModel from internal/util/provider.go.
//
// Dropped from upstream: Home routing, model-router plugins, forced providers and the
// xAI speech-only check (xAI is not ported).
import type { ErrorMessage } from "../executor/types.ts";
import type { ModelRegistry } from "../registry/index.ts";
import { parseSuffix } from "../thinking/suffix.ts";

export type RequestDetails = { providers: string[]; model: string } | { error: ErrorMessage };

/** The last path segment of a routed model name ("codex/gpt-image-2" -> "gpt-image-2"). */
export function routeModelBaseName(model: string): string {
  const trimmed = model.trim();
  const idx = trimmed.lastIndexOf("/");
  if (idx >= 0 && idx < trimmed.length - 1) return trimmed.slice(idx + 1).trim();
  return trimmed;
}

const imageOnlyModels = new Set(["gpt-image-1.5", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5", "grok-imagine-image", "grok-imagine-image-quality", "grok-imagine-image-2.0"]);

/** Models served only by /v1/images/* (Go: isOpenAIImageOnlyModel). */
export function isOpenAIImageOnlyModel(model: string): boolean {
  return imageOnlyModels.has(routeModelBaseName(model).toLowerCase());
}

/** Rejects image-only models outside the image endpoints with 503 (Go: validateImageOnlyModel). */
export function validateImageOnlyModel(modelName: string, allowImageModel: boolean): ErrorMessage | undefined {
  let baseModel = parseSuffix(modelName).modelName.trim();
  if (baseModel === "") baseModel = modelName.trim();
  if (!isOpenAIImageOnlyModel(baseModel) || allowImageModel) return undefined;
  return { statusCode: 503, error: new Error(`model ${routeModelBaseName(baseModel)} is only supported on /v1/images/generations and /v1/images/edits`) };
}

/** "auto" becomes the newest available model; anything else is returned unchanged (Go: ResolveAutoModel). */
export function resolveAutoModel(registry: ModelRegistry, modelName: string): string {
  if (modelName !== "auto") return modelName;
  try {
    return registry.getFirstAvailableModel("");
  } catch {
    return modelName;
  }
}

/**
 * Resolves the providers serving the requested model (Go: getRequestDetailsWithOptions).
 * The thinking suffix is kept on the returned model and stripped for the lookup; "auto"
 * (with or without a suffix) resolves to the newest available model. An unroutable model
 * is a 400 model_not_found request error whose body is built with JSON.stringify, so a
 * client-supplied name cannot corrupt it.
 */
export function getRequestDetails(registry: ModelRegistry, modelName: string, allowImageModel = false): RequestDetails {
  let resolvedModelName = modelName;
  const initial = parseSuffix(modelName);
  if (initial.modelName === "auto") {
    const resolvedBase = resolveAutoModel(registry, initial.modelName);
    resolvedModelName = initial.hasSuffix ? `${resolvedBase}(${initial.rawSuffix})` : resolvedBase;
  } else {
    resolvedModelName = resolveAutoModel(registry, modelName);
  }

  const baseModel = parseSuffix(resolvedModelName).modelName.trim();
  const imageError = validateImageOnlyModel(baseModel, allowImageModel);
  if (imageError) return { error: imageError };

  let providers = baseModel === "" ? [] : registry.getModelProviders(baseModel);
  if (providers.length === 0 && baseModel !== resolvedModelName) providers = registry.getModelProviders(resolvedModelName);
  if (providers.length === 0) {
    const body = JSON.stringify({ error: { message: `unknown provider for model ${modelName}`, type: "invalid_request_error", code: "model_not_found", param: "model" } });
    return { error: { statusCode: 400, error: new Error(body) } };
  }
  return { providers, model: resolvedModelName };
}
