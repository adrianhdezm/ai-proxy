// Port of internal/translator/codex/openai/responses/codex_openai-responses_request.go.
//
// OpenAI Responses request -> Codex Responses request. Both sides speak the
// Responses API, so this is a normalising passthrough: required Codex flags are
// forced (stream, store, parallel_tool_calls, include), fields Codex rejects are
// dropped, system input roles become developer, legacy built-in tool aliases are
// renamed and blank function_call arguments become "{}".
//
// The request body is returned unchanged (the very same string) when nothing
// needed rewriting, matching Go's zero-copy reuse of a normalised payload.
// The model field is left alone; the executor sets it.
import { getAt, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { log } from "../../../../log.ts";

type JSONObject = Record<string, unknown>;

const reasoningEncryptedContent = "reasoning.encrypted_content";
const webSearchSources = "web_search_call.action.sources";

/** Normalises an OpenAI Responses request for the Codex Responses upstream (Go: ConvertOpenAIResponsesRequestToCodex). */
export function convertOpenAIResponsesRequestToCodex(_modelName: string, inputRawJSON: string, _stream: boolean): string {
  let root: unknown;
  try {
    root = JSON.parse(inputRawJSON);
  } catch {
    return inputRawJSON;
  }
  if (!isObj(root)) return inputRawJSON;
  let changed = false;
  const mark = (did: boolean): void => {
    if (did) changed = true;
  };

  if (typeof root.input === "string") {
    root.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: root.input }] }];
    changed = true;
  }

  mark(setCodexRequiredBool(root, "stream", true));
  mark(setCodexRequiredBool(root, "store", false));
  if (root.parallel_tool_calls !== false) mark(setCodexRequiredBool(root, "parallel_tool_calls", true));
  mark(setCodexRequiredInclude(root));
  // Codex Responses rejects token limit fields, so strip them out before forwarding.
  mark(deleteCodexRequestFields(root, "max_output_tokens", "max_completion_tokens", "temperature", "top_p"));
  if ("service_tier" in root) {
    const serviceTier = root.service_tier;
    if (typeof serviceTier === "string") {
      switch (serviceTier.trim().toLowerCase()) {
        case "priority":
        case "fast":
          if (serviceTier !== "priority") {
            root.service_tier = "priority";
            changed = true;
          }
          break;
        case "ultrafast":
          if (serviceTier !== "ultrafast") {
            root.service_tier = "ultrafast";
            changed = true;
          }
          break;
        default:
          mark(deleteCodexRequestFields(root, "service_tier"));
      }
    } else {
      mark(deleteCodexRequestFields(root, "service_tier"));
    }
  }

  mark(deleteCodexRequestFields(root, "truncation", "prompt_cache_options", "prompt_cache_retention"));
  mark(stripCodexResponsesCacheBreakpoints(root));
  mark(applyResponsesCompactionCompatibility(root));

  // Delete the user field as it is not supported by the Codex upstream.
  mark(deleteCodexRequestFields(root, "user"));

  // Convert role "system" to "developer" in input array to comply with Codex API requirements.
  mark(convertSystemRoleToDeveloper(root));
  mark(normalizeCodexBuiltinTools(root));
  mark(normalizeEmptyFunctionCallArguments(root));

  return changed ? JSON.stringify(root) : inputRawJSON;
}

/**
 * Rewrites blank string arguments on history function_call items to "{}" (strict
 * Codex upstreams reject "" with "`arguments` must be valid JSON"). Non-empty
 * strings, non-strings and custom_tool_call items are untouched.
 */
export function normalizeEmptyFunctionCallArguments(root: JSONObject): boolean {
  if (!isArr(root.input)) return false;
  let changed = false;
  for (const item of root.input) {
    if (!isObj(item) || gstr(item.type) !== "function_call") continue;
    if (typeof item.arguments === "string" && item.arguments.trim() === "") {
      item.arguments = "{}";
      changed = true;
    }
  }
  return changed;
}

function setCodexRequiredBool(root: JSONObject, path: string, value: boolean): boolean {
  if (root[path] === value) return false;
  root[path] = value;
  return true;
}

function setCodexRequiredInclude(root: JSONObject): boolean {
  const current = root.include;
  let includeSources = false;
  if (isArr(current)) {
    includeSources = current.some((value) => value === webSearchSources);
    if (!includeSources && current.length === 1 && current[0] === reasoningEncryptedContent) return false;
    if (includeSources && current.length === 2 && current[0] === reasoningEncryptedContent && current[1] === webSearchSources) return false;
  }
  root.include = includeSources ? [reasoningEncryptedContent, webSearchSources] : [reasoningEncryptedContent];
  return true;
}

function deleteCodexRequestFields(root: JSONObject, ...paths: string[]): boolean {
  let changed = false;
  for (const path of paths) {
    if (path in root) {
      delete root[path];
      changed = true;
    }
  }
  return changed;
}

/**
 * Removes "prompt_cache_breakpoint" hints from input items: inside content-part
 * arrays (message content[] and function_call_output output[]) and at item level.
 * Codex rejects them ("prompt_cache_breakpoint is not supported on this model").
 */
export function stripCodexResponsesCacheBreakpoints(root: JSONObject): boolean {
  if (!isArr(root.input) || root.input.length === 0) return false;
  let changed = false;
  for (const item of root.input) {
    if (!isObj(item)) continue;
    for (const arrayPath of ["content", "output"]) {
      const parts = item[arrayPath];
      if (!isArr(parts)) continue;
      for (const part of parts) {
        if (isObj(part) && "prompt_cache_breakpoint" in part) {
          delete part.prompt_cache_breakpoint;
          changed = true;
        }
      }
    }
    if ("prompt_cache_breakpoint" in item) {
      delete item.prompt_cache_breakpoint;
      changed = true;
    }
  }
  return changed;
}

/** Codex /responses rejects context_management ("Unsupported parameter"), so it is removed. */
export function applyResponsesCompactionCompatibility(root: JSONObject): boolean {
  return deleteCodexRequestFields(root, "context_management");
}

/** Converts input message items with role "system" to role "developer" (Codex rejects "system"). */
export function convertSystemRoleToDeveloper(root: JSONObject): boolean {
  if (!isArr(root.input)) return false;
  let changed = false;
  for (const item of root.input) {
    if (isObj(item) && item.role === "system") {
      item.role = "developer";
      changed = true;
    }
  }
  return changed;
}

/** Rewrites legacy/preview built-in tool variants to the stable names the Codex upstream expects. */
export function normalizeCodexBuiltinTools(root: JSONObject): boolean {
  let changed = normalizeCodexBuiltinToolArray(root.tools, "tools");
  const toolChoice = root.tool_choice;
  if (isObj(toolChoice)) {
    const currentType = gstr(toolChoice.type);
    const normalizedType = normalizeCodexBuiltinToolType(currentType);
    if (normalizedType !== "") {
      toolChoice.type = normalizedType;
      changed = true;
      log.debug("codex responses: normalized builtin tool type", { path: "tool_choice.type", from: currentType, to: normalizedType });
    }
    if (normalizeCodexBuiltinToolArray(getAt(toolChoice, "tools"), "tool_choice.tools")) changed = true;
  }
  return changed;
}

function normalizeCodexBuiltinToolArray(tools: unknown, path: string): boolean {
  if (!isArr(tools)) return false;
  let changed = false;
  tools.forEach((tool, index) => {
    const currentType = gstr(getAt(tool, "type"));
    const normalizedType = normalizeCodexBuiltinToolType(currentType);
    if (normalizedType === "" || !isObj(tool)) return;
    tool.type = normalizedType;
    changed = true;
    log.debug("codex responses: normalized builtin tool type", { path: `${path}.${index}.type`, from: currentType, to: normalizedType });
  });
  return changed;
}

/** Known Codex Responses built-in tool aliases; "" when the type needs no rewrite. */
export function normalizeCodexBuiltinToolType(toolType: string): string {
  switch (toolType) {
    case "web_search_preview":
    case "web_search_preview_2025_03_11":
      return "web_search";
    default:
      return "";
  }
}
