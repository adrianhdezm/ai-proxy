// OpenAI image endpoints served by Codex credentials. Port of
// internal/runtime/executor/codex_openai_images.go plus the disable-image-generation
// tool stripping of helps/payload_helpers.go (removeToolTypeFromPayloadWithRoot,
// removeToolChoiceFromPayloadWithRoot) and DisallowFreeAuth selection
// (sdk/cliproxy/auth/conductor_selection.go) folded into the executor.
//
// Requests arrive in the "openai-image" source format with the inbound path
// (/v1/images/generations or /v1/images/edits) in the request_path metadata.
// Two upstream routes, as in upstream:
//
//   - direct: when the route model is a GPT Image model (gpt-image-1.5,
//     gpt-image-2, gpt-image-2.5[-flare|-sunburst], any routing prefix or
//     thinking suffix), the OpenAI Images request is sent as JSON to
//     `<codex base>/images/generations` or `/images/edits` and the answer
//     (JSON or SSE) is passed through. Multipart edits are rewritten to JSON
//     with data: URLs (codexRewriteOpenAIImageEditMultipartToJSON).
//   - Responses tool: otherwise the request becomes a Codex Responses call on
//     gpt-5.4-mini with a forced `image_generation` tool; image_generation_call
//     outputs are converted back to the OpenAI Images shape, and streaming
//     requests get `<prefix>.partial_image` / `<prefix>.completed` SSE frames.
//     Upstream reaches this branch for SIWC credentials (not ported) and for
//     route models that are not GPT Image models.
//
// Not ported: SIWC credentials and body rules, the gpt-image-2-base-model
// config knob (the main model is always gpt-5.4-mini), payload-config media
// rules, thinking application on the main model, usage reporting and request
// logging, and the per-credential config model lookup of directOpenAIImageModel.
import type { Auth } from "../../auth/types.ts";
import { parseSuffix } from "../../thinking/index.ts";
import { getAt, gstr, isArr, isObj } from "../../util/gpath.ts";
import { tryParse, type JSONObject } from "../../util/json.ts";
import { log } from "../../log.ts";
import { RequestedModelMetadataKey, StatusError, type ExecOptions, type ExecRequest, type ExecResponse, type StreamResult } from "../types.ts";
import {
  FormatOpenAIImage,
  ImagesEditsPath,
  ImagesGenerationsPath,
  binaryStringToBytes,
  isJSONPayload,
  uploadedFiles,
  parseMultipartContentType,
  parseMultipartForm,
  payloadRequestPath,
  prepareOpenAICompatImagesPayload,
  rawTextChunks,
  requestBodyOf,
  type ImagesFetchLike,
  type MultipartForm,
  type UploadedFile,
} from "../openai/images.ts";
import { DefaultCodexBaseURL, codexCreds, isCodexFreePlanAuth } from "./creds.ts";
import { codexTerminalFailureErrWithCooling, newCodexStatusErrWithHeadersAndCooling } from "./errors.ts";
import { type CodexHeaderPolicy, applyCodexHeaders, applyModelHeaderOverrides } from "./headers.ts";
import { deleteFields, normalizeCodexInstructions, setBoolIfDifferent, setStringIfDifferent } from "./request.ts";

export const codexDirectImagesGenerations = "/images/generations";
export const codexDirectImagesEdit = "/images/edits";
export const codexGPTImage15Model = "gpt-image-1.5";
export const codexDefaultImageToolModel = "gpt-image-2";
export const codexGPTImage25FlareModel = "gpt-image-2.5-flare";
export const codexGPTImage25SunburstModel = "gpt-image-2.5-sunburst";
export const codexGPTImage25Model = "gpt-image-2.5";
export const codexOpenAIImagesMainModel = "gpt-5.4-mini";

/** Metadata flag asking selection to skip free ChatGPT plans (Go: DisallowFreeAuthMetadataKey). */
export const DisallowFreeAuthMetadataKey = "disallow_free_auth";

export interface CodexOpenAIImagePreparedRequest {
  body: string;
  responseFormat: string;
  streamPrefix: string;
}

export interface CodexImageCallResult {
  result: string;
  revisedPrompt: string;
  outputFormat: string;
  size: string;
  background: string;
  quality: string;
}

/** What the Codex executor lends the image path. */
export interface CodexImagesContext {
  fetch: ImagesFetchLike;
  now: () => number;
  modelLevelCooling: boolean;
  headerPolicy: CodexHeaderPolicy;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Go: isCodexOpenAIImageRequest. */
export function isCodexOpenAIImageRequest(opts: ExecOptions): boolean {
  if ((opts.sourceFormat ?? "").trim().toLowerCase() !== FormatOpenAIImage) return false;
  return codexIsImagesEndpointPath(payloadRequestPath(opts));
}

/** Go: codexIsImagesEndpointPath. */
export function codexIsImagesEndpointPath(path: string): boolean {
  path = path.trim();
  return path.endsWith(ImagesGenerationsPath) || path.endsWith(ImagesEditsPath);
}

/** Lower-cased model without thinking suffix or routing prefix (Go: codexOpenAIImageBaseModel). */
export function codexOpenAIImageBaseModel(model: string): string {
  model = parseSuffix(model.trim()).modelName.trim();
  const idx = model.lastIndexOf("/");
  if (idx >= 0 && idx < model.length - 1) model = model.slice(idx + 1).trim();
  return model.trim().toLowerCase();
}

/** Go: codexIsDirectOpenAIImageModel. */
export function codexIsDirectOpenAIImageModel(model: string): boolean {
  switch (model.trim().toLowerCase()) {
    case codexGPTImage15Model:
    case codexDefaultImageToolModel:
    case codexGPTImage25FlareModel:
    case codexGPTImage25SunburstModel:
    case codexGPTImage25Model:
      return true;
    default:
      return false;
  }
}

function requestedModelOf(opts: ExecOptions): string {
  const raw = opts.metadata?.[RequestedModelMetadataKey];
  return typeof raw === "string" ? raw.trim() : "";
}

/** The GPT Image model the request routes to, "" when none (Go: codexDirectOpenAIImageRouteModel). */
export function codexDirectOpenAIImageRouteModel(req: ExecRequest, opts: ExecOptions): string {
  // Multipart handlers supply the requested model separately from the raw form.
  const payloadModel = isJSONPayload(req.payload) ? gstr(getAt(tryParse(req.payload), "model")) : "";
  for (const model of [requestedModelOf(opts), payloadModel, req.model]) {
    const base = codexOpenAIImageBaseModel(model);
    if (codexIsDirectOpenAIImageModel(base)) return base;
  }
  return "";
}

/** The direct /images/* endpoint, "" when the Responses tool path applies (Go: codexDirectOpenAIImageEndpoint). */
export function codexDirectOpenAIImageEndpoint(req: ExecRequest, opts: ExecOptions): string {
  if (codexDirectOpenAIImageRouteModel(req, opts) === "") return "";
  const path = payloadRequestPath(opts);
  if (path.endsWith(ImagesGenerationsPath)) return codexDirectImagesGenerations;
  if (path.endsWith(ImagesEditsPath)) return codexDirectImagesEdit;
  return "";
}

/**
 * The model sent on the wire for a direct request: the resolved request model,
 * normalised to the builtin GPT Image id when its base is one (Go:
 * directOpenAIImageModel without the per-credential config lookup).
 */
export function directOpenAIImageModel(req: ExecRequest, opts: ExecOptions): string {
  const routeModel = codexDirectOpenAIImageRouteModel(req, opts);
  if (routeModel === "") return "";
  const model = parseSuffix(req.model).modelName.trim();
  if (model === "") return routeModel;
  const base = codexOpenAIImageBaseModel(model);
  if (codexIsDirectOpenAIImageModel(base)) return base;
  return model;
}

// ---------------------------------------------------------------------------
// Direct /images/* payloads
// ---------------------------------------------------------------------------

/** Go: codexPrepareDirectOpenAIImagePayload. */
export async function codexPrepareDirectOpenAIImagePayload(req: ExecRequest, opts: ExecOptions, model: string, stream: boolean): Promise<{ body: string; contentType: string; binary: boolean }> {
  const contentType = opts.headers?.get("Content-Type") ?? "";
  const path = payloadRequestPath(opts);
  if (path.endsWith(ImagesEditsPath)) {
    if (isJSONPayload(req.payload)) return prepareOpenAICompatImagesPayload(req.payload, model, contentType, stream);
    const media = parseMultipartContentType(contentType.trim());
    if (!media || !media.mediaType.startsWith("multipart/")) {
      throw new StatusError(400, `unsupported OpenAI image edit Content-Type ${JSON.stringify(contentType)}`, { requestScoped: true });
    }
    if (media.boundary === "") throw new StatusError(400, "multipart boundary is missing", { requestScoped: true });
    const body = await codexRewriteOpenAIImageEditMultipartToJSON(binaryStringToBytes(req.payload), contentType, model, stream);
    return { body, contentType: "application/json", binary: false };
  }
  return prepareOpenAICompatImagesPayload(req.payload, model, contentType, stream);
}

/** Integer form fields (Go: codexOpenAIImageEditFormJSONValue). */
function codexOpenAIImageEditFormJSONValue(key: string, value: string): unknown {
  value = value.trim();
  switch (key.trim().toLowerCase()) {
    case "n":
    case "output_compression":
    case "partial_images":
      if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return value;
}

/** Go: codexOpenAIImageEditFormJSONPath. */
function codexOpenAIImageEditFormJSONPath(key: string): string[] {
  key = key.trim();
  if (key === "mask[file_id]") return ["mask", "file_id"];
  if (key === "mask[image_url]") return ["mask", "image_url"];
  return [key];
}

function setPath(root: JSONObject, path: string[], value: unknown): void {
  let cursor: JSONObject = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cursor[path[i]!];
    if (!isObj(next)) cursor[path[i]!] = {};
    cursor = cursor[path[i]!] as JSONObject;
  }
  cursor[path[path.length - 1]!] = value as never;
}

/** The uploaded image files: image[] wins over image (Go: codexMultipartImageFiles). */
export function codexMultipartImageFiles(form: MultipartForm): UploadedFile[] {
  const arrayFiles = uploadedFiles(form, "image[]");
  return arrayFiles.length > 0 ? arrayFiles : uploadedFiles(form, "image");
}

/** Sniffs common image signatures (subset of Go's http.DetectContentType). */
function detectContentType(data: Uint8Array): string {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => data[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return "application/octet-stream";
}

/** A data: URL for an uploaded file (Go: codexMultipartFileToDataURL / multipartFileToDataURL). */
export async function codexMultipartFileToDataURL(file: UploadedFile): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
  let mediaType = file.type.trim();
  if (mediaType === "") mediaType = detectContentType(data);
  return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
}

/**
 * Rewrites a multipart image edit to the JSON edit shape: text fields become
 * JSON fields (n / output_compression / partial_images as integers), the mask
 * file becomes mask.image_url and the image files images[].image_url data URLs
 * (Go: codexRewriteOpenAIImageEditMultipartToJSON).
 */
export async function codexRewriteOpenAIImageEditMultipartToJSON(payload: Uint8Array, contentType: string, model: string, stream: boolean): Promise<string> {
  const form = await parseMultipartForm(payload, contentType);
  const out: JSONObject = { model };
  if (stream) out.stream = true;
  const values = new Map<string, string[]>();
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = key.trim();
    if (trimmed === "" || trimmed === "model" || trimmed === "stream") continue;
    const list = values.get(trimmed) ?? [];
    list.push(value);
    values.set(trimmed, list);
  }
  for (const [key, list] of values) {
    const path = codexOpenAIImageEditFormJSONPath(key);
    if (list.length === 1) setPath(out, path, codexOpenAIImageEditFormJSONValue(path.join("."), list[0]!));
    else setPath(out, path, list.map((value) => codexOpenAIImageEditFormJSONValue(key, value)));
  }
  const mask = uploadedFiles(form, "mask")[0];
  if (mask) setPath(out, ["mask", "image_url"], await codexMultipartFileToDataURL(mask));

  const imageFiles = codexMultipartImageFiles(form);
  if (imageFiles.length > 0) {
    const existing = out.images;
    const items: unknown[] = isArr(existing) ? [...existing] : existing === undefined ? [] : [];
    for (const file of imageFiles) items.push({ image_url: await codexMultipartFileToDataURL(file) });
    out.images = items as never;
  }
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// Responses image_generation tool payloads
// ---------------------------------------------------------------------------

/** Go: codexNormalizeImageResponseFormat. */
export function codexNormalizeImageResponseFormat(responseFormat: string): string {
  return responseFormat.trim().toLowerCase() === "url" ? "url" : "b64_json";
}

/** Go: codexOpenAIImageToolModel. */
export function codexOpenAIImageToolModel(requestModel: string, routeModel: string): string {
  let model = requestModel.trim();
  if (model === "") model = routeModel.trim();
  if (model === "") model = codexDefaultImageToolModel;
  return model;
}

/** Go: codexBuildOpenAIImageTool. */
export function codexBuildOpenAIImageTool(raw: unknown, routeModel: string, action: string, stringFields: string[], numberFields: string[]): JSONObject {
  const tool: JSONObject = { type: "image_generation", action, model: codexOpenAIImageToolModel(gstr(getAt(raw, "model")), routeModel) };
  for (const field of stringFields) {
    const value = getAt(raw, field);
    const text = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    if (text !== "") tool[field] = text;
  }
  for (const field of numberFields) {
    const value = getAt(raw, field);
    if (typeof value === "number" && Number.isFinite(value)) tool[field] = Math.trunc(value);
  }
  return tool;
}

/** Go: codexBuildImagesResponsesRequest. */
export function codexBuildImagesResponsesRequest(prompt: string, images: string[], tool: JSONObject | undefined): string {
  const content: JSONObject[] = [{ type: "input_text", text: prompt }];
  for (const image of images) {
    if (image.trim() === "") continue;
    content.push({ type: "input_image", image_url: image });
  }
  const req: JSONObject = {
    instructions: "",
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    model: codexOpenAIImagesMainModel,
    store: false,
    tool_choice: { type: "image_generation" },
    tools: tool ? [tool] : [],
    input: [{ type: "message", role: "user", content }],
  };
  return JSON.stringify(req);
}

const imageGenerateStringFields = ["size", "quality", "background", "output_format", "moderation"];
const imageEditStringFields = ["size", "quality", "background", "output_format", "input_fidelity", "moderation"];
const imageNumberFields = ["output_compression", "partial_images"];

/** Go: codexPrepareOpenAIImageGenerationJSON. */
export function codexPrepareOpenAIImageGenerationJSON(rawJSON: string, routeModel: string): CodexOpenAIImagePreparedRequest {
  const raw = tryParse(rawJSON);
  if (raw === undefined) throw new StatusError(400, "invalid OpenAI image generation request JSON", { requestScoped: true });
  const prompt = gstr(getAt(raw, "prompt")).trim();
  const tool = codexBuildOpenAIImageTool(raw, routeModel, "generate", imageGenerateStringFields, imageNumberFields);
  return {
    body: codexBuildImagesResponsesRequest(prompt, [], tool),
    responseFormat: codexNormalizeImageResponseFormat(gstr(getAt(raw, "response_format"))),
    streamPrefix: "image_generation",
  };
}

/** Go: codexPrepareOpenAIImageEditJSON. */
export function codexPrepareOpenAIImageEditJSON(rawJSON: string, routeModel: string): CodexOpenAIImagePreparedRequest {
  const raw = tryParse(rawJSON);
  if (raw === undefined) throw new StatusError(400, "invalid OpenAI image edit request JSON", { requestScoped: true });
  const prompt = gstr(getAt(raw, "prompt")).trim();
  const images: string[] = [];
  const list = getAt(raw, "images");
  if (isArr(list)) {
    for (const image of list) {
      const url = gstr(getAt(image, "image_url")).trim();
      if (url !== "") images.push(url);
    }
  }
  const tool = codexBuildOpenAIImageTool(raw, routeModel, "edit", imageEditStringFields, imageNumberFields);
  const mask = gstr(getAt(raw, "mask.image_url")).trim();
  if (mask !== "") tool.input_image_mask = { image_url: mask };
  return {
    body: codexBuildImagesResponsesRequest(prompt, images, tool),
    responseFormat: codexNormalizeImageResponseFormat(gstr(getAt(raw, "response_format"))),
    streamPrefix: "image_edit",
  };
}

function formValue(form: MultipartForm, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Go: codexPrepareOpenAIImageEditMultipart. */
export async function codexPrepareOpenAIImageEditMultipart(rawBody: Uint8Array, routeModel: string, contentType: string): Promise<CodexOpenAIImagePreparedRequest> {
  const media = parseMultipartContentType(contentType);
  if (!media) throw new StatusError(400, "parse multipart content type failed", { requestScoped: true });
  if (media.boundary === "") throw new StatusError(400, "multipart boundary is required", { requestScoped: true });
  const form = await parseMultipartForm(rawBody, contentType);
  const prompt = formValue(form, "prompt");
  const tool: JSONObject = { type: "image_generation", action: "edit", model: codexOpenAIImageToolModel(formValue(form, "model"), routeModel) };
  for (const field of imageEditStringFields) {
    const value = formValue(form, field);
    if (value !== "") tool[field] = value;
  }
  for (const field of imageNumberFields) {
    const value = formValue(form, field);
    if (/^[+-]?\d+$/.test(value)) tool[field] = Number.parseInt(value, 10);
  }
  const images: string[] = [];
  for (const file of codexMultipartImageFiles(form)) images.push(await codexMultipartFileToDataURL(file));
  const mask = uploadedFiles(form, "mask")[0];
  if (mask) tool.input_image_mask = { image_url: await codexMultipartFileToDataURL(mask) };
  return {
    body: codexBuildImagesResponsesRequest(prompt, images, tool),
    responseFormat: codexNormalizeImageResponseFormat(formValue(form, "response_format")),
    streamPrefix: "image_edit",
  };
}

/** Go: codexPrepareOpenAIImageRequest. */
export async function codexPrepareOpenAIImageRequest(req: ExecRequest, opts: ExecOptions): Promise<CodexOpenAIImagePreparedRequest> {
  const path = payloadRequestPath(opts);
  if (path.endsWith(ImagesGenerationsPath)) return codexPrepareOpenAIImageGenerationJSON(req.payload, req.model);
  if (!path.endsWith(ImagesEditsPath)) throw new StatusError(400, `unsupported OpenAI image endpoint path ${JSON.stringify(path)}`, { requestScoped: true });
  const contentType = (opts.headers?.get("Content-Type") ?? "").trim();
  const media = parseMultipartContentType(contentType);
  if (media && media.mediaType.startsWith("multipart/")) return codexPrepareOpenAIImageEditMultipart(binaryStringToBytes(req.payload), req.model, contentType);
  return codexPrepareOpenAIImageEditJSON(req.payload, req.model);
}

/** Go: prepareCodexOpenAIImageBody (non-SIWC, without thinking application). */
export function prepareCodexOpenAIImageBody(body: string, mainModel: string): string {
  mainModel = mainModel.trim() === "" ? codexOpenAIImagesMainModel : mainModel.trim();
  let out = setStringIfDifferent(body, "model", mainModel);
  out = setBoolIfDifferent(out, "stream", true);
  out = deleteFields(out, "previous_response_id", "prompt_cache_retention", "safety_identifier", "stream_options");
  return normalizeCodexInstructions(out);
}

// ---------------------------------------------------------------------------
// Responses -> OpenAI Images conversion
// ---------------------------------------------------------------------------

/** Output items collected from response.output_item.done, keyed by output_index. */
export interface CodexImageOutputItems {
  byIndex: Map<number, unknown>;
  fallback: unknown[];
}

export function newCodexImageOutputItems(): CodexImageOutputItems {
  return { byIndex: new Map(), fallback: [] };
}

/** Go: collectCodexOutputItemDone (image path). */
export function collectCodexImageOutputItemDone(event: unknown, items: CodexImageOutputItems): void {
  const item = getAt(event, "item");
  if (!isObj(item)) return;
  const index = getAt(event, "output_index");
  if (typeof index === "number" && Number.isFinite(index)) items.byIndex.set(Math.trunc(index), item);
  else items.fallback.push(item);
}

export interface CodexImageExtraction {
  results: CodexImageCallResult[];
  createdAt: number;
  usage: unknown;
  firstMeta: CodexImageCallResult;
}

const emptyImageMeta = (): CodexImageCallResult => ({ result: "", revisedPrompt: "", outputFormat: "", size: "", background: "", quality: "" });

/**
 * Extracts image_generation_call results from the completed event, falling
 * back to the collected output items (ordered by output_index) when the
 * completed output is empty (Go: codexExtractImageResults).
 */
export function codexExtractImageResults(completed: unknown, items: CodexImageOutputItems | undefined, nowSeconds: () => number): CodexImageExtraction {
  if (gstr(getAt(completed, "type")) !== "response.completed") throw new Error("unexpected event type");
  let createdAt = Math.trunc(Number(getAt(completed, "response.created_at") ?? 0)) || 0;
  if (createdAt <= 0) createdAt = nowSeconds();
  const results: CodexImageCallResult[] = [];
  let firstMeta = emptyImageMeta();
  const appendItem = (item: unknown) => {
    if (gstr(getAt(item, "type")) !== "image_generation_call") return;
    const result = gstr(getAt(item, "result")).trim();
    if (result === "") return;
    const entry: CodexImageCallResult = {
      result,
      revisedPrompt: gstr(getAt(item, "revised_prompt")).trim(),
      outputFormat: gstr(getAt(item, "output_format")).trim(),
      size: gstr(getAt(item, "size")).trim(),
      background: gstr(getAt(item, "background")).trim(),
      quality: gstr(getAt(item, "quality")).trim(),
    };
    if (results.length === 0) firstMeta = entry;
    results.push(entry);
  };
  const output = getAt(completed, "response.output");
  if (isArr(output) && output.length > 0) {
    for (const item of output) appendItem(item);
  } else if (items) {
    for (const index of [...items.byIndex.keys()].sort((a, b) => a - b)) appendItem(items.byIndex.get(index));
    for (const item of items.fallback) appendItem(item);
  }
  const usage = getAt(completed, "response.tool_usage.image_gen");
  return { results, createdAt, usage: isObj(usage) ? usage : undefined, firstMeta };
}

/** Go: codexMimeTypeFromOutputFormat. */
export function codexMimeTypeFromOutputFormat(outputFormat: string): string {
  switch (outputFormat.trim().toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/** The OpenAI Images response (Go: codexBuildImagesAPIResponse). */
export function codexBuildImagesAPIResponse(extraction: CodexImageExtraction, responseFormat: string): string {
  const { results, createdAt, usage, firstMeta } = extraction;
  const out: JSONObject = { created: createdAt, data: [] };
  if (firstMeta.background !== "") out.background = firstMeta.background;
  if (firstMeta.outputFormat !== "") out.output_format = firstMeta.outputFormat;
  if (firstMeta.quality !== "") out.quality = firstMeta.quality;
  if (firstMeta.size !== "") out.size = firstMeta.size;
  if (usage !== undefined) out.usage = usage as never;
  const format = codexNormalizeImageResponseFormat(responseFormat);
  out.data = results.map((img) => {
    const item: JSONObject = {};
    if (img.revisedPrompt !== "") item.revised_prompt = img.revisedPrompt;
    if (format === "url") item.url = `data:${codexMimeTypeFromOutputFormat(img.outputFormat)};base64,${img.result}`;
    else item.b64_json = img.result;
    return item;
  });
  return JSON.stringify(out);
}

/** Go: codexBuildSSEFrame. */
export function codexBuildSSEFrame(eventName: string, data: unknown): string {
  const head = eventName.trim() !== "" ? `event: ${eventName}\n` : "";
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}

/** A `<prefix>.partial_image` frame, "" without image data (Go: codexBuildImagePartialFrame). */
export function codexBuildImagePartialFrame(event: unknown, responseFormat: string, streamPrefix: string): string {
  const b64 = gstr(getAt(event, "partial_image_b64")).trim();
  if (b64 === "") return "";
  const outputFormat = gstr(getAt(event, "output_format")).trim();
  const eventName = `${streamPrefix.trim()}.partial_image`;
  const index = getAt(event, "partial_image_index");
  const data: JSONObject = { type: eventName, partial_image_index: typeof index === "number" ? Math.trunc(index) : 0 };
  if (codexNormalizeImageResponseFormat(responseFormat) === "url") data.url = `data:${codexMimeTypeFromOutputFormat(outputFormat)};base64,${b64}`;
  else data.b64_json = b64;
  return codexBuildSSEFrame(eventName, data);
}

/** A `<prefix>.completed` frame (Go: codexBuildImageCompletedFrame). */
export function codexBuildImageCompletedFrame(img: CodexImageCallResult, usage: unknown, responseFormat: string, streamPrefix: string): string {
  const eventName = `${streamPrefix.trim()}.completed`;
  const data: JSONObject = { type: eventName };
  if (usage !== undefined) data.usage = usage as never;
  if (codexNormalizeImageResponseFormat(responseFormat) === "url") data.url = `data:${codexMimeTypeFromOutputFormat(img.outputFormat)};base64,${img.result}`;
  else data.b64_json = img.result;
  return codexBuildSSEFrame(eventName, data);
}

// ---------------------------------------------------------------------------
// disable-image-generation
// ---------------------------------------------------------------------------

/**
 * Removes the hosted image_generation tool and a tool_choice that forces it
 * (Go: removeToolTypeFromPayloadWithRoot + removeToolChoiceFromPayloadWithRoot
 * for "image_generation", as applied when disable-image-generation is true).
 * `root` addresses a nested request object ("" for the top level).
 */
export function stripImageGenerationTools(payload: string, root = ""): string {
  const parsed = tryParse(payload);
  if (!isObj(parsed)) return payload;
  const target = root === "" ? parsed : getAt(parsed, root);
  if (!isObj(target)) return payload;
  let changed = false;
  const tools = target.tools;
  if (isArr(tools) && tools.some((tool) => gstr(getAt(tool, "type")) === "image_generation")) {
    target.tools = tools.filter((tool) => gstr(getAt(tool, "type")) !== "image_generation");
    changed = true;
  }
  const choice = target.tool_choice;
  if (typeof choice === "string") {
    if (choice.trim().toLowerCase() === "image_generation") {
      delete target.tool_choice;
      changed = true;
    }
  } else if (isObj(choice)) {
    const choiceType = gstr(choice.type).trim().toLowerCase();
    if (choiceType === "image_generation" || (choiceType === "tool" && gstr(choice.name).trim().toLowerCase() === "image_generation")) {
      delete target.tool_choice;
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : payload;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Free ChatGPT plans cannot generate images; the image handlers ask selection
 * to skip them (Go: DisallowFreeAuth). The manager has no such filter here, so
 * the executor rejects them with a model_not_found failure the manager treats
 * as a capability mismatch: the next credential is tried and the free one is
 * not selected for this model again until its model cooldown ends.
 */
function rejectDisallowedFreeAuth(auth: Auth, opts: ExecOptions): void {
  if (opts.metadata?.[DisallowFreeAuthMetadataKey] !== true) return;
  if (!isCodexFreePlanAuth(auth)) return;
  const body = JSON.stringify({ error: { message: "image generation is not available for your plan (free ChatGPT plan)", type: "invalid_request_error", code: "model_not_found" } });
  throw new StatusError(404, body, { body });
}

function codexImageBaseURL(auth: Auth): { apiKey: string; baseURL: string } {
  const { apiKey, baseURL } = codexCreds(auth);
  return { apiKey, baseURL: (baseURL.trim() === "" ? DefaultCodexBaseURL : baseURL.trim()).replace(/\/+$/, "") };
}

function proxyOf(auth: Auth, opts: ExecOptions): string {
  return (opts.proxyUrl ?? auth.proxyUrl ?? "").trim();
}

async function postCodex(ctx: CodexImagesContext, auth: Auth, opts: ExecOptions, url: string, headers: Headers, body: string | Uint8Array): Promise<Response> {
  const init: RequestInit & { proxy?: string } = { method: "POST", headers, body, signal: opts.signal };
  const proxy = proxyOf(auth, opts);
  if (proxy !== "") init.proxy = proxy;
  return ctx.fetch(url, init);
}

async function codexStatusError(ctx: CodexImagesContext, resp: Response): Promise<StatusError> {
  let body = "";
  try {
    body = await resp.text();
  } catch {
    // classified by status alone
  }
  log.debug("codex executor: image request error", { status: resp.status });
  return newCodexStatusErrWithHeadersAndCooling(resp.status, resp.headers, body, ctx.modelLevelCooling, ctx.now());
}

/** Direct /images/* request (Go: executeDirectOpenAIImage / executeDirectOpenAIImageStream head). */
async function sendDirect(ctx: CodexImagesContext, auth: Auth, req: ExecRequest, opts: ExecOptions, endpointPath: string, stream: boolean): Promise<Response> {
  const model = directOpenAIImageModel(req, opts);
  if (model === "") throw new StatusError(400, `unsupported direct OpenAI image model ${JSON.stringify(req.model)}`, { requestScoped: true });
  const prepared = await codexPrepareDirectOpenAIImagePayload(req, opts, model, stream);
  const { apiKey, baseURL } = codexImageBaseURL(auth);
  // Direct image calls never forward the downstream User-Agent (Go: applyCodexDirectImageHeaders).
  const clientHeaders = opts.headers ? new Headers(opts.headers) : undefined;
  clientHeaders?.delete("User-Agent");
  const headers = new Headers();
  applyCodexHeaders(headers, auth, apiKey, stream, ctx.headerPolicy, clientHeaders);
  applyModelHeaderOverrides(headers, model);
  if (prepared.contentType !== "") headers.set("Content-Type", prepared.contentType);
  return postCodex(ctx, auth, opts, baseURL + endpointPath, headers, requestBodyOf(prepared));
}

/** Responses tool request (Go: the shared head of executeOpenAIImage / executeOpenAIImageStream). */
async function sendResponsesTool(ctx: CodexImagesContext, auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<{ resp: Response; prepared: CodexOpenAIImagePreparedRequest }> {
  const prepared = await codexPrepareOpenAIImageRequest(req, opts);
  const mainModel = codexOpenAIImagesMainModel;
  const body = prepareCodexOpenAIImageBody(prepared.body, mainModel);
  const { apiKey, baseURL } = codexImageBaseURL(auth);
  const headers = new Headers();
  applyCodexHeaders(headers, auth, apiKey, true, ctx.headerPolicy, opts.headers);
  applyModelHeaderOverrides(headers, mainModel);
  const resp = await postCodex(ctx, auth, opts, baseURL + "/responses", headers, body);
  return { resp, prepared };
}

function eventDataLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) continue;
    out.push(trimmed.slice(5).trim());
  }
  return out;
}

/** Non-streaming image request through a Codex credential (Go: executeOpenAIImage). */
export async function executeCodexOpenAIImage(ctx: CodexImagesContext, auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
  rejectDisallowedFreeAuth(auth, opts);
  const directEndpoint = codexDirectOpenAIImageEndpoint(req, opts);
  if (directEndpoint !== "") {
    const resp = await sendDirect(ctx, auth, req, opts, directEndpoint, false);
    if (resp.status < 200 || resp.status >= 300) throw await codexStatusError(ctx, resp);
    return { payload: await resp.text(), headers: resp.headers };
  }

  const { resp, prepared } = await sendResponsesTool(ctx, auth, req, opts);
  if (resp.status < 200 || resp.status >= 300) throw await codexStatusError(ctx, resp);
  const text = await resp.text();
  const items = newCodexImageOutputItems();
  for (const data of eventDataLines(text)) {
    const event = tryParse(data);
    const failure = codexTerminalFailureErrWithCooling(data, ctx.modelLevelCooling, ctx.now());
    if (failure) throw failure.error;
    switch (gstr(getAt(event, "type"))) {
      case "response.output_item.done":
        collectCodexImageOutputItemDone(event, items);
        break;
      case "response.completed": {
        const extraction = codexExtractImageResults(event, items, () => Math.floor(ctx.now() / 1000));
        if (extraction.results.length === 0) throw new StatusError(502, "upstream did not return image output");
        return { payload: codexBuildImagesAPIResponse(extraction, prepared.responseFormat), headers: resp.headers };
      }
    }
  }
  throw new StatusError(504, "stream error: stream disconnected before completion");
}

/** Streaming image request through a Codex credential (Go: executeOpenAIImageStream). */
export async function executeCodexOpenAIImageStream(ctx: CodexImagesContext, auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
  rejectDisallowedFreeAuth(auth, opts);
  const directEndpoint = codexDirectOpenAIImageEndpoint(req, opts);
  if (directEndpoint !== "") {
    const resp = await sendDirect(ctx, auth, req, opts, directEndpoint, true);
    if (resp.status < 200 || resp.status >= 300) throw await codexStatusError(ctx, resp);
    return { headers: resp.headers, chunks: rawTextChunks(resp, opts.signal) };
  }

  const { resp, prepared } = await sendResponsesTool(ctx, auth, req, opts);
  if (resp.status < 200 || resp.status >= 300) throw await codexStatusError(ctx, resp);
  return { headers: resp.headers, chunks: codexImageToolFrames(ctx, resp, opts, prepared) };
}

/** Converts the Responses SSE into OpenAI Images stream frames (Go: the ExecuteStream reader goroutine). */
async function* codexImageToolFrames(ctx: CodexImagesContext, resp: Response, opts: ExecOptions, prepared: CodexOpenAIImagePreparedRequest): AsyncGenerator<string> {
  const items = newCodexImageOutputItems();
  let pending = "";
  const handleLine = function* (line: string): Generator<string, boolean> {
    line = line.replace(/\r$/, "");
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    const event = tryParse(data);
    const failure = codexTerminalFailureErrWithCooling(data, ctx.modelLevelCooling, ctx.now());
    if (failure) throw failure.error;
    switch (gstr(getAt(event, "type"))) {
      case "response.output_item.done":
        collectCodexImageOutputItemDone(event, items);
        return false;
      case "response.image_generation_call.partial_image": {
        const frame = codexBuildImagePartialFrame(event, prepared.responseFormat, prepared.streamPrefix);
        if (frame !== "") yield frame;
        return false;
      }
      case "response.completed": {
        const extraction = codexExtractImageResults(event, items, () => Math.floor(ctx.now() / 1000));
        if (extraction.results.length === 0) throw new StatusError(502, "upstream did not return image output");
        for (const img of extraction.results) yield codexBuildImageCompletedFrame(img, extraction.usage, prepared.responseFormat, prepared.streamPrefix);
        return true;
      }
      default:
        return false;
    }
  };
  for await (const chunk of rawTextChunks(resp, opts.signal)) {
    pending += chunk;
    for (;;) {
      const idx = pending.indexOf("\n");
      if (idx < 0) break;
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      if (yield* handleLine(line)) return;
    }
  }
  if (pending !== "" && (yield* handleLine(pending))) return;
  if (opts.signal?.aborted) return;
  throw new StatusError(504, "stream error: stream disconnected before completion");
}
