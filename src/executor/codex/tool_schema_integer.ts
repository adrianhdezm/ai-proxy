// Codex client tool integer normalisation. Port of
// internal/client/codex/tool-schema/tool_schema.go (IsCodexUserAgent,
// NormalizeCodexToolIntegerTypes).
//
// Codex clients deserialise some tool arguments (exec_command.yield_time_ms,
// write_stdin.session_id, ...) as integers. Upstreams other than Codex may
// declare those parameters as "number" and then produce 1.5, which the client
// rejects; for Codex-client requests the declared type of exactly those known
// fields is rewritten from "number" to "integer" (also inside type arrays, with
// duplicates removed). Only built-in Codex tools are touched: bare names,
// "functions__" / "collab__" prefixed names, and namespace tools whose
// "<namespace>__<tool>" name is known; MCP and user tools keep their schema.
// Supported shapes: Responses tools (parameters), chat tools
// (function.parameters), Claude tools (input_schema), Gemini
// function_declarations / functionDeclarations (parameters or
// parametersJsonSchema), namespace tools and input[].additional_tools.
//
// Go applies this only when the target executor is not Codex (the Codex
// backend accepts its own declarations); the Codex executor of this port never
// calls it. The body is parsed with the literal-preserving raw JSON parser and
// re-serialised only when a field changed (an unchanged body is returned as the
// same string).
import { RawNumber, parseRawJSON, stringifyRawJSON } from "./rawjson.ts";

type JSONObject = Record<string, unknown>;

function isObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RawNumber);
}

/** Whether the User-Agent names a Codex client (Go: IsCodexUserAgent). */
export function isCodexUserAgent(headers: Headers | undefined): boolean {
  if (!headers) return false;
  const ua = (headers.get("User-Agent") ?? "").trim();
  return ua !== "" && ua.toLowerCase().includes("codex");
}

/** Explicit schema paths relative to parameters.properties, per built-in Codex tool (Go: codexClientToolIntegerFields). */
export const codexClientToolIntegerFields: Readonly<Record<string, readonly string[]>> = {
  exec_command: ["yield_time_ms", "max_output_tokens", "timeout_ms"],
  write_stdin: ["session_id", "yield_time_ms", "max_output_tokens"],
  sleep: ["duration_ms"],
  wait_agent: ["timeout_ms"],
  wait: ["yield_time_ms", "max_tokens"],
  tool_search: ["limit"],
  test_sync_tool: ["sleep_before_ms", "sleep_after_ms", "participants", "timeout_ms", "barrier.properties.participants", "barrier.properties.timeout_ms"],
  create_goal: ["token_budget"],
  get_channels: ["limit"],
  list_threads: ["limit", "max_chars_per_post"],
  search_posts: ["limit", "max_chars_per_post"],
  read_thread: ["limit", "max_chars_per_post"],
  read_post: ["offset_chars", "limit_chars"],
  memories__list: ["max_results"],
  memories__read: ["line_offset", "max_lines"],
  memories__search: ["context_lines", "max_results"],
  history__list_windows: ["limit"],
  history__list_items: ["limit", "max_chars_per_item"],
  history__read_item: ["offset_chars", "limit_chars"],
  history__search_contents: ["limit"],
  notes__list_files_by_prefix: ["max_results"],
  // Codex declares signed line numbers in the first nullable union branch.
  notes__read_file: ["start_line", "stop_line", "start_line.anyOf.0", "stop_line.anyOf.0"],
  notes__search_contents: ["max_matches_per_file", "max_files"],
  image_gen__imagegen: ["num_last_images_to_include"],
  web__run: [
    "search_query.items.properties.recency",
    "image_query.items.properties.recency",
    "open.items.properties.lineno",
    "click.items.properties.id",
    "screenshot.items.properties.pageno",
    "weather.items.properties.duration",
    "sports.items.properties.num_games",
  ],
};

/** Go: matchCodexTargetTool. */
function matchCodexTargetTool(toolName: string): readonly string[] | undefined {
  let baseName = toolName.trim();
  if (baseName.startsWith("functions__")) baseName = baseName.slice("functions__".length);
  else if (baseName.startsWith("collab__")) baseName = baseName.slice("collab__".length);
  switch (baseName) {
    case "multi_agent_v1__wait_agent":
    case "collaboration__wait_agent":
      baseName = "wait_agent";
      break;
    case "collaboration__get_channels":
    case "collaboration__list_threads":
    case "collaboration__search_posts":
    case "collaboration__read_thread":
    case "collaboration__read_post":
      baseName = baseName.slice("collaboration__".length);
      break;
  }
  return Object.hasOwn(codexClientToolIntegerFields, baseName) ? codexClientToolIntegerFields[baseName] : undefined;
}

/** Walks a gjson-style dotted path (numeric segments index arrays). */
function walk(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".")) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (isObject(cur)) {
      if (!Object.hasOwn(cur, seg)) return undefined;
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Go: normalizeCodexToolFieldTypes. */
function normalizeCodexToolFieldTypes(params: JSONObject, targetFields: readonly string[]): boolean {
  const properties = params.properties;
  if (!isObject(properties)) return false;
  let changed = false;
  for (const field of targetFields) {
    const prop = walk(properties, field);
    if (!isObject(prop) || !Object.hasOwn(prop, "type")) continue;
    const typeVal = prop.type;
    if (typeVal === "number") {
      prop.type = "integer";
      changed = true;
    } else if (Array.isArray(typeVal)) {
      let hasNumber = false;
      const seen = new Set<string>();
      const next: string[] = [];
      for (const item of typeVal) {
        let s = typeof item === "string" ? item : item instanceof RawNumber ? item.raw : item === null ? "" : String(item);
        if (s === "number") {
          hasNumber = true;
          s = "integer";
        }
        if (!seen.has(s)) {
          seen.add(s);
          next.push(s);
        }
      }
      if (hasNumber) {
        prop.type = next;
        changed = true;
      }
    }
  }
  return changed;
}

/** Go: normalizeToolIntegerTypesInArray. */
function normalizeToolArray(tools: unknown[], namespace: string): boolean {
  let changed = false;
  for (const tool of tools) {
    if (normalizeToolElement(tool, namespace)) changed = true;
  }
  return changed;
}

/** Go: normalizeToolIntegerTypesInElement. */
function normalizeToolElement(tool: unknown, namespace: string): boolean {
  if (!isObject(tool)) return false;
  if (tool.type === "namespace") {
    if (namespace !== "") return false;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (name === "") return false;
    return Array.isArray(tool.tools) ? normalizeToolArray(tool.tools, name) : false;
  }
  for (const declKey of ["function_declarations", "functionDeclarations"]) {
    const decls = tool[declKey];
    if (Array.isArray(decls)) return normalizeToolArray(decls, namespace);
  }

  let toolName = typeof tool.name === "string" ? tool.name : "";
  let params: JSONObject | undefined;
  if (isObject(tool.parameters)) {
    params = tool.parameters;
  } else if (isObject(tool.function) && isObject(tool.function.parameters)) {
    params = tool.function.parameters;
    if (toolName === "" && typeof tool.function.name === "string") toolName = tool.function.name;
  } else if (isObject(tool.input_schema)) {
    params = tool.input_schema;
  } else if (isObject(tool.parametersJsonSchema)) {
    params = tool.parametersJsonSchema;
  } else {
    return false;
  }
  if (namespace !== "") toolName = namespace + "__" + toolName;
  const targetFields = matchCodexTargetTool(toolName);
  if (!targetFields || targetFields.length === 0) return false;
  return normalizeCodexToolFieldTypes(params, targetFields);
}

/**
 * Rewrites the known integer fields of built-in Codex tools from "number" to
 * "integer" for Codex-client requests (Go: NormalizeCodexToolIntegerTypes).
 */
export function normalizeCodexToolIntegerTypes(body: string, headers: Headers | undefined): string {
  if (body.length === 0 || !isCodexUserAgent(headers)) return body;
  let root: unknown;
  try {
    root = parseRawJSON(body);
  } catch {
    return body;
  }
  if (!isObject(root)) return body;
  let changed = false;
  if (Array.isArray(root.tools) && normalizeToolArray(root.tools, "")) changed = true;
  if (Array.isArray(root.input)) {
    for (const item of root.input) {
      if (isObject(item) && item.type === "additional_tools" && Array.isArray(item.tools) && normalizeToolArray(item.tools, "")) changed = true;
    }
  }
  return changed ? stringifyRawJSON(root) : body;
}
