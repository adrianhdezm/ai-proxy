// Port of internal/translator/codex/claude/codex_claude_response_web_search.go.
//
// Maps Codex web_search_call output items onto Claude server_tool_use and
// web_search_tool_result content blocks, for both the stream and non-stream paths.
import { appendSSEEventString } from "../../common/index.ts";
import { getAt, gstr } from "../../../util/gpath.ts";
import { type ConvertCodexResponseToClaudeParams, finalizeCodexThinkingBlock, stopCodexTextBlock } from "./response.ts";

type JSONObject = Record<string, unknown>;

export function appendCodexWebSearchServerToolUse(output: string, params: ConvertCodexResponseToClaudeParams, root: unknown, item: unknown): string {
  const toolUseID = codexWebSearchToolUseID(params, root, item);
  if (toolUseID === "") return output;
  const query = codexWebSearchQuery(root, item);
  let alreadyStarted = false;
  if (params.webSearchToolUseIDs.has(toolUseID)) {
    alreadyStarted = true;
    if (query === "") return output;
  }

  if (!alreadyStarted) {
    output += stopCodexTextBlock(params);
    output += finalizeCodexThinkingBlock(params);
    const template = {
      type: "content_block_start",
      index: params.blockIndex,
      content_block: { type: "server_tool_use", id: toolUseID, name: "web_search", input: {} },
    };
    output = appendSSEEventString(output, "content_block_start", JSON.stringify(template), 2);
  }

  if (query !== "") {
    const delta = {
      type: "content_block_delta",
      index: params.blockIndex,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
    };
    output = appendSSEEventString(output, "content_block_delta", JSON.stringify(delta), 2);
  }

  if (!alreadyStarted) {
    const stop = { type: "content_block_stop", index: params.blockIndex };
    output = appendSSEEventString(output, "content_block_stop", JSON.stringify(stop), 2);
    params.webSearchToolUseIDs.add(toolUseID);
    params.blockIndex++;
  }
  return output;
}

export function appendCodexWebSearchToolResult(output: string, params: ConvertCodexResponseToClaudeParams, root: unknown, item: unknown): string {
  const toolUseID = codexWebSearchToolUseID(params, root, item);
  if (toolUseID === "") return output;
  output = appendCodexWebSearchServerToolUse(output, params, root, item);
  if (params.webSearchToolResultIDs.has(toolUseID)) return output;
  if (codexWebSearchQuery(root, item) === "" && codexWebSearchResultContent(root, item) === undefined && getAt(item, "action") === undefined) {
    return output;
  }

  const template: JSONObject = {
    type: "content_block_start",
    index: params.blockIndex,
    content_block: { type: "web_search_tool_result", tool_use_id: toolUseID, content: [] as unknown[] },
  };
  const content = codexWebSearchResultContent(root, item);
  if (content !== undefined) (template.content_block as JSONObject).content = content;
  output = appendSSEEventString(output, "content_block_start", JSON.stringify(template), 2);

  const stop = { type: "content_block_stop", index: params.blockIndex };
  output = appendSSEEventString(output, "content_block_stop", JSON.stringify(stop), 2);
  params.webSearchToolResultIDs.add(toolUseID);
  params.blockIndex++;
  if (toolUseID === params.lastWebSearchToolUseID) params.lastWebSearchToolUseID = "";
  return output;
}

export function codexWebSearchToolUseID(params: ConvertCodexResponseToClaudeParams, root: unknown, item: unknown): string {
  for (const path of ["id", "output_item_id", "call_id"]) {
    let value = gstr(getAt(item, path)).trim();
    if (value !== "") return value;
    value = gstr(getAt(root, path)).trim();
    if (value !== "") return value;
  }
  if (params.lastWebSearchToolUseID !== "") return params.lastWebSearchToolUseID;
  for (const path of ["item_id"]) {
    let value = gstr(getAt(item, path)).trim();
    if (value !== "") return value;
    value = gstr(getAt(root, path)).trim();
    if (value !== "") return value;
  }
  const id = `web_search_${params.blockIndex}`;
  params.lastWebSearchToolUseID = id;
  return id;
}

export function codexWebSearchQuery(root: unknown, item: unknown): string {
  for (const path of ["action.query", "query", "input.query"]) {
    let value = gstr(getAt(item, path)).trim();
    if (value !== "") return value;
    value = gstr(getAt(root, path)).trim();
    if (value !== "") return value;
  }
  return "";
}

/**
 * Collects web_search_result blocks from the first results array found on the
 * item or event root. Returns undefined when no results array exists (Go: nil)
 * and an empty array when one exists but holds no usable URL (Go: "[]").
 */
export function codexWebSearchResultContent(root: unknown, item: unknown): unknown[] | undefined {
  let results: unknown[] | undefined;
  for (const candidate of [getAt(item, "results"), getAt(root, "results"), getAt(item, "action.sources"), getAt(root, "action.sources")]) {
    if (Array.isArray(candidate)) {
      results = candidate;
      break;
    }
  }
  if (results === undefined) return undefined;
  const resultBlocks: unknown[] = [];
  for (const result of results) {
    const url = gstr(getAt(result, "url")).trim();
    if (url === "") continue;
    let title = gstr(getAt(result, "title")).trim();
    if (title === "") title = url;
    resultBlocks.push({ type: "web_search_result", title, url, page_age: null });
  }
  return resultBlocks;
}

export function appendCodexWebSearchNonStreamBlocks(contentBlocks: unknown[], item: unknown, seen: Set<string>): unknown[] {
  const id = gstr(getAt(item, "id")).trim();
  if (id === "") return contentBlocks;
  if (seen.has(id)) return contentBlocks;
  const query = codexWebSearchQuery(undefined, item);
  const resultContent = codexWebSearchResultContent(undefined, item);
  if (query === "" && resultContent === undefined) return contentBlocks;

  const useBlock: JSONObject = { type: "server_tool_use", id, name: "web_search", input: {} };
  if (query !== "") useBlock.input = { query };
  contentBlocks.push(useBlock);

  const resultBlock: JSONObject = { type: "web_search_tool_result", tool_use_id: id, content: [] as unknown[] };
  if (resultContent !== undefined) resultBlock.content = resultContent;
  contentBlocks.push(resultBlock);
  seen.add(id);
  return contentBlocks;
}

/** Appends the non-stream web search blocks for item to the "content" array of a parsed Claude message. */
export function appendCodexWebSearchNonStreamContent(out: JSONObject, item: unknown, seen: Set<string>): JSONObject {
  const blocks = appendCodexWebSearchNonStreamBlocks([], item, seen);
  if (blocks.length === 0) return out;
  const content = Array.isArray(out.content) ? out.content : [];
  content.push(...blocks);
  out.content = content;
  return out;
}
