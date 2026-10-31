// Request preparation shared by the Gemini CLI and AI Studio executors:
// inbound -> Gemini translation, thinking, and the body fix-ups of
// gemini_executor.go (capGeminiMaxOutputTokens, fixGeminiImageAspectRatio),
// gemini_cli_executor.go (fixGeminiCLIImageAspectRatio, applied here to the
// bare body before the Code Assist envelope is added) and aistudio_executor.go
// (normalizeAIStudioThinkingLevel).
import "../../translator/gemini/claude/index.ts";
import { lookupModelInfo } from "../../registry/index.ts";
import { applyThinkingWithSourceAndSummary, extractSummaryConfig, parseSuffix } from "../../thinking/index.ts";
import { defaultRegistry } from "../../translator/registry.ts";
import { FormatGemini } from "../../translator/types.ts";
import { createWhiteImageBase64 } from "../../util/image.ts";
import { getAt, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import type { ExecOptions, ExecRequest } from "../types.ts";

/** Model name without a thinking suffix ("gemini-2.5-pro(8192)" -> "gemini-2.5-pro"). */
export function baseModelOf(model: string): string {
  return parseSuffix(model).modelName;
}

/** The inbound request the response translators see (Go: opts.OriginalRequest, else req.Payload). */
export function originalRequestOf(req: ExecRequest, opts: ExecOptions): string {
  return opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
}

/**
 * Translates the inbound payload to a bare Gemini generateContent body and
 * applies the thinking configuration (model suffix or request fields). The
 * summary visibility intent is read from the original inbound request.
 * Throws RequestRejectedError / ThinkingError (HTTP 400, request-scoped).
 */
export function translateToGemini(req: ExecRequest, opts: ExecOptions, stream: boolean, providerKey: string): string {
  const baseModel = baseModelOf(req.model);
  const from = opts.sourceFormat;
  const translated = defaultRegistry.translateRequest(from, FormatGemini, baseModel, req.payload, stream);
  const summary = extractSummaryConfig(originalRequestOf(req, opts), from);
  return applyThinkingWithSourceAndSummary(translated, req.payload, req.model, from, FormatGemini, providerKey, summary);
}

function parseObject(body: string): Record<string, unknown> | undefined {
  const root = tryParse<unknown>(body);
  return isObj(root) ? root : undefined;
}

/** Removes top-level (or dotted) keys; returns the body unchanged when none existed. */
export function deleteJSONFields(body: string, ...paths: string[]): string {
  const root = parseObject(body);
  if (!root) return body;
  let changed = false;
  for (const path of paths) {
    const segs = path.split(".");
    let cur: unknown = root;
    for (let i = 0; i < segs.length - 1 && isObj(cur); i++) cur = cur[segs[i]!];
    const last = segs[segs.length - 1]!;
    if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, last)) {
      delete cur[last];
      changed = true;
    }
  }
  return changed ? JSON.stringify(root) : body;
}

/** helps.SetStringIfDifferent for a top-level string field. */
export function setStringIfDifferent(body: string, key: string, value: string): string {
  const root = parseObject(body);
  if (!root || root[key] === value) return body;
  root[key] = value;
  return JSON.stringify(root);
}

/**
 * Caps generationConfig.maxOutputTokens at the model's output limit
 * (outputTokenLimit, else maxCompletionTokens). Unknown models and values
 * within the limit are left alone (Go: capGeminiMaxOutputTokens).
 */
export function capGeminiMaxOutputTokens(body: string, modelName: string): string {
  const root = parseObject(body);
  if (!root) return body;
  const maxOut = getAt(root, "generationConfig.maxOutputTokens");
  if (typeof maxOut !== "number") return body;
  const info = lookupModelInfo(modelName, "gemini");
  if (!info) return body;
  let limit = info.outputTokenLimit ?? 0;
  if (limit <= 0) limit = info.maxCompletionTokens ?? 0;
  if (limit <= 0 || Math.trunc(maxOut) <= limit) return body;
  (root.generationConfig as Record<string, unknown>).maxOutputTokens = limit;
  return JSON.stringify(root);
}

const imagePromptText =
  "Based on the following requirements, create an image within the uploaded picture. The new content *MUST* completely cover the entire area of the original picture, maintaining its exact proportions, and *NO* blank areas should appear.";

/**
 * For gemini-2.5-flash-image-preview with generationConfig.imageConfig.aspectRatio:
 * when no content carries inlineData, a white canvas of that ratio is prepended
 * to the first content; imageConfig is always removed (Go: fixGeminiImageAspectRatio /
 * fixGeminiCLIImageAspectRatio).
 */
export function fixGeminiImageAspectRatio(modelName: string, body: string): string {
  if (modelName !== "gemini-2.5-flash-image-preview") return body;
  const root = parseObject(body);
  if (!root) return body;
  const aspectRatio = getAt(root, "generationConfig.imageConfig.aspectRatio");
  if (aspectRatio === undefined) return body;
  const contents = getAt(root, "contents");
  if (Array.isArray(contents) && contents.length > 0) {
    const hasInlineData = contents.some((c) => {
      const parts = getAt(c, "parts");
      return Array.isArray(parts) && parts.some((p) => getAt(p, "inlineData") !== undefined);
    });
    if (!hasInlineData) {
      const ratio = typeof aspectRatio === "string" ? aspectRatio : String(aspectRatio);
      const newParts: unknown[] = [{ text: imagePromptText }, { inlineData: { mime_type: "image/png", data: createWhiteImageBase64(ratio) } }];
      const first = contents[0];
      const firstParts = getAt(first, "parts");
      if (Array.isArray(firstParts)) newParts.push(...firstParts);
      if (isObj(first)) first.parts = newParts;
      else contents[0] = { parts: newParts };
      (root.generationConfig as Record<string, unknown>).responseModalities = ["IMAGE", "TEXT"];
    }
  }
  delete (root.generationConfig as Record<string, unknown>).imageConfig;
  return JSON.stringify(root);
}

/**
 * Upper-cases generationConfig.thinkingConfig.thinkingLevel for the levels the
 * Generative Language API accepts (MINIMAL/LOW/MEDIUM/HIGH); any other value
 * is left alone (Go: normalizeAIStudioThinkingLevel).
 */
export function normalizeAIStudioThinkingLevel(body: string): string {
  const root = parseObject(body);
  if (!root) return body;
  const level = getAt(root, "generationConfig.thinkingConfig.thinkingLevel");
  if (typeof level !== "string") return body;
  const normalized = level.toUpperCase();
  if (!["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(normalized) || normalized === level) return body;
  (getAt(root, "generationConfig.thinkingConfig") as Record<string, unknown>).thinkingLevel = normalized;
  return JSON.stringify(root);
}
