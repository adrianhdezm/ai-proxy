// Port of internal/translator/codex/openai/responses/codex_openai-responses_response.go.
//
// Codex Responses -> OpenAI Responses. Native Codex events already are Responses
// events, so the stream translator passes every line through untouched except
// that response.created / response.in_progress gain response.model (from the
// client request) when upstream omitted it.
//
// Stream input contract: one upstream SSE line per call, exactly as the Codex
// executor scans it ("data: {...}", "event: ...", or ""). A "data:" line is
// returned re-prefixed with "data: "; any other line is returned unchanged. The
// output therefore is raw SSE *lines*, not self-terminated frames: the server
// must write each returned string followed by "\n" (Go's handler did the same).
//
// apply_patch bridging: only an executor-owned bridge stored in
// TranslatorState.value enables it (Go: *ApplyPatchResponsesBridge in param).
// A native Codex request never opts in. The executor creates the bridge with
// `new ApplyPatchResponsesBridge(originalRequest)` (common/apply_patch_responses.ts)
// and stores it in TranslatorState.value before the first chunk; the bridge
// retains its failure via toolInputError(), which the registry honours.
import type { TranslateContext, TranslatorState } from "../../../types.ts";
import { getAt, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { requestModelName } from "../../../common/request.ts";
import { ApplyPatchResponsesBridge } from "../../../common/apply_patch_responses.ts";

/** Returns the executor-owned bridge held in the state, if any (Go: responsesBridge). */
export function responsesBridge(state: TranslatorState | undefined): ApplyPatchResponsesBridge | undefined {
  return state?.value instanceof ApplyPatchResponsesBridge ? state.value : undefined;
}

/** Streams Codex Responses events to OpenAI Responses events (Go: ConvertCodexResponseToOpenAIResponses). */
export function convertCodexResponseToOpenAIResponses(
  _ctx: TranslateContext,
  modelName: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
): string[] {
  const originalEvent = rawJSON;
  const sse = rawJSON.startsWith("data:");
  let payload = rawJSON;
  if (sse) payload = rawJSON.slice(5).trim();
  const updated = setResponsesModel(payload, modelName, originalRequestRawJSON, requestRawJSON);
  const bridge = responsesBridge(state);
  if (!bridge) {
    // Native Codex never opts in, even when configuration supplies the bridge schema.
    if (updated === payload) return [originalEvent];
    return [sse ? "data: " + updated : updated];
  }
  const [outputs] = bridge.transform(updated);
  return sse ? outputs.map((output) => "data: " + output) : outputs;
}

function setResponsesModel(rawJSON: string, modelName: string, originalRequestRawJSON: string, requestRawJSON: string): string {
  // Cheap pre-check: only the two lifecycle events are rewritten.
  if (!rawJSON.includes("response.created") && !rawJSON.includes("response.in_progress")) return rawJSON;
  let root: unknown;
  try {
    root = JSON.parse(rawJSON);
  } catch {
    return rawJSON;
  }
  const eventType = gstr(getAt(root, "type"));
  if (eventType !== "response.created" && eventType !== "response.in_progress") return rawJSON;
  if (getAt(root, "response.model") !== undefined) return rawJSON;
  let model = requestModelName(originalRequestRawJSON, requestRawJSON);
  if (model === "") model = modelName;
  if (model === "") return rawJSON;
  if (!isObj(root)) return rawJSON;
  if (!isObj(root.response)) root.response = {};
  (root.response as Record<string, unknown>).model = model;
  return JSON.stringify(root);
}

/**
 * Returns the response object of a terminal Codex event (response.completed or
 * response.incomplete); a bare response object (no type, output array) is returned
 * as-is, anything else yields "" (Go: ConvertCodexResponseToOpenAIResponsesNonStream).
 */
export function convertCodexResponseToOpenAIResponsesNonStream(
  _ctx: TranslateContext,
  _modelName: string,
  _originalRequestRawJSON: string,
  _requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
): string {
  const bridge = responsesBridge(state);
  let converted = rawJSON;
  if (bridge) {
    const [out, errTransform] = bridge.transformNonStream(rawJSON);
    if (errTransform) return "";
    converted = out;
  }
  let root: unknown;
  try {
    root = JSON.parse(converted);
  } catch {
    root = undefined;
  }
  // Verify this is a terminal response event.
  const responseType = gstr(getAt(root, "type"));
  if (responseType === "" && isArr(getAt(root, "output"))) return converted;
  if (responseType !== "response.completed" && responseType !== "response.incomplete") return "";
  const response = getAt(root, "response");
  return response === undefined ? "" : JSON.stringify(response);
}
