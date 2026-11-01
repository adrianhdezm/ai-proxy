// Port of internal/translator/claude/openai/responses/claude_openai-responses_web_search.go.
//
// Claude reports server-side web search as a pair of assistant content blocks: a
// `server_tool_use` block carrying the query and a `web_search_tool_result` block
// carrying the hits. OpenAI Responses models the same exchange as a single
// `web_search_call` item. The pair folds into one item on the way out and
// expands back on the way in.
import { deepCopy, exists, getAt, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { tryParse } from "../../../../util/json.ts";

type JSONObject = Record<string, unknown>;

export const claudeWebSearchToolName = "web_search";
/** Namespaces the Claude server_tool_use id inside the Responses item id. */
export const responsesWebSearchIDPrefix = "ws_";
/** Anthropic requires server tool ids to match ^srvtoolu_[a-zA-Z0-9_]+$. */
export const claudeServerToolIDPrefix = "srvtoolu_";

export function responsesWebSearchCallID(claudeToolUseID: string): string {
  return responsesWebSearchIDPrefix + claudeToolUseID;
}

/** Recovers the Claude server_tool_use id from a Responses item id, normalised to Anthropic's shape. */
export function claudeWebSearchToolUseID(responsesItemID: string): string {
  let body = responsesItemID.trim();
  if (body.startsWith(responsesWebSearchIDPrefix)) body = body.slice(responsesWebSearchIDPrefix.length);
  if (body.startsWith(claudeServerToolIDPrefix)) body = body.slice(claudeServerToolIDPrefix.length);
  body = body.replace(/[^a-zA-Z0-9_]/gu, "_");
  if (body === "") return "";
  return claudeServerToolIDPrefix + body;
}

/** Extracts the query from a Claude server_tool_use input (accumulated streaming JSON). */
export function claudeWebSearchQuery(input: string): string {
  if (input === "") return "";
  return gstr(getAt(tryParse<unknown>(input), "query")).trim();
}

/**
 * Converts the content of a Claude web_search_tool_result block into the
 * Responses results array. Entries ride through verbatim (encrypted_content
 * can never be reconstructed later).
 */
export function claudeWebSearchResultsToResponses(content: unknown): unknown {
  if (isObj(content)) return deepCopy(content);
  if (!isArr(content)) return undefined;
  const results: unknown[] = [];
  for (const entry of content) {
    if (gstr(getAt(entry, "type")) === "web_search_tool_result_error" || gstr(getAt(entry, "url")).trim() !== "") results.push(deepCopy(entry));
  }
  return results;
}

/** Whether a results value is non-empty in Go's len(raw) > 0 sense. */
export function hasWebSearchResults(results: unknown): boolean {
  return results !== undefined;
}

/** Renders the Responses item for one Claude server-side search (results may be undefined). */
export function buildResponsesWebSearchCallItem(claudeToolUseID: string, query: string, results: unknown): JSONObject {
  const item: JSONObject = { id: responsesWebSearchCallID(claudeToolUseID), type: "web_search_call", status: "completed", action: { type: "search", query } };
  if (results !== undefined) item.results = deepCopy(results);
  return item;
}

/** Rebuilds the Claude block pair from a Responses web_search_call. */
export function convertResponsesWebSearchCallToClaudeBlocks(item: unknown): JSONObject[] {
  return convertResponsesWebSearchCallToClaudeBlocksWithQuery(item, "", true);
}

export function convertResponsesWebSearchCallToClaudeBlocksWithQuery(item: unknown, fallbackQuery: string, withResult: boolean): JSONObject[] {
  const toolUseID = claudeWebSearchToolUseID(gstr(getAt(item, "id")).trim());
  if (toolUseID === "") return [];
  const use: JSONObject = { type: "server_tool_use", id: toolUseID, name: claudeWebSearchToolName, input: {} };
  let query = responsesWebSearchCallQuery(item);
  if (query === "") query = fallbackQuery;
  if (query !== "") (use.input as JSONObject).query = query;
  if (!withResult) return [use];
  const result: JSONObject = { type: "web_search_tool_result", tool_use_id: toolUseID, content: [] };
  const content = responsesWebSearchResultsToClaude(getAt(item, "results"));
  if (content !== undefined) result.content = content;
  return [use, result];
}

function responsesWebSearchItemIsPaused(item: unknown): boolean {
  return gstr(getAt(item, "type")) === "web_search_call" && gstr(getAt(item, "status")).trim().toLowerCase() === "in_progress" && !exists(getAt(item, "results"));
}

/** Reports a user turn. Tool outputs do not end the assistant turn. */
function responsesItemIsTurnBoundary(item: unknown): boolean {
  let typ = gstr(getAt(item, "type"));
  const role = gstr(getAt(item, "role"));
  if (typ === "" && role !== "") typ = "message";
  return typ === "message" && role !== "assistant";
}

/**
 * Indexes web_search_call items of one request so a search paused by
 * pause_turn or deferred by tool_use replays faithfully.
 */
export class ResponsesWebSearchHistory {
  readonly boundaryAfter: boolean[];
  readonly skip = new Set<number>();
  readonly pausedQuery = new Map<number, string>();

  constructor(items: unknown[]) {
    this.boundaryAfter = new Array<boolean>(items.length).fill(false);
    let boundary = false;
    for (let index = items.length - 1; index >= 0; index--) {
      this.boundaryAfter[index] = boundary;
      if (responsesItemIsTurnBoundary(items[index])) boundary = true;
    }
    items.forEach((item, index) => {
      if (!responsesWebSearchItemIsPaused(item)) return;
      const id = gstr(getAt(item, "id")).trim();
      if (id === "") return;
      for (let next = index + 1; next < items.length; next++) {
        if (responsesItemIsTurnBoundary(items[next])) break;
        if (gstr(getAt(items[next], "type")) === "web_search_call" && gstr(getAt(items[next], "id")).trim() === id) {
          this.skip.add(index);
          let query = responsesWebSearchCallQuery(item);
          const previous = this.pausedQuery.get(index);
          if (previous !== undefined && query === "") query = previous;
          this.pausedQuery.set(next, query);
          break;
        }
      }
    });
  }

  claudeBlocks(index: number, item: unknown): JSONObject[] {
    if (this.skip.has(index)) return [];
    const query = this.pausedQuery.get(index) ?? "";
    const tail = index >= this.boundaryAfter.length || !this.boundaryAfter[index];
    if (responsesWebSearchItemIsPaused(item) && tail) return convertResponsesWebSearchCallToClaudeBlocksWithQuery(item, query, false);
    return convertResponsesWebSearchCallToClaudeBlocksWithQuery(item, query, true);
  }
}

/** Reads the query from a Responses web_search_call, tolerating `queries` and `open_page` shapes. */
export function responsesWebSearchCallQuery(item: unknown): string {
  const query = gstr(getAt(item, "action.query")).trim();
  if (query !== "") return query;
  const first = gstr(getAt(item, "action.queries.0")).trim();
  if (first !== "") return first;
  return gstr(getAt(item, "action.url")).trim();
}

/** Responses results -> Claude web_search_result blocks; entries without encrypted_content are dropped. */
export function responsesWebSearchResultsToClaude(results: unknown): unknown {
  if (isObj(results)) return deepCopy(results);
  if (!isArr(results)) return undefined;
  const blocks: unknown[] = [];
  for (const entry of results) {
    if (gstr(getAt(entry, "type")) === "web_search_tool_result_error") {
      blocks.push(deepCopy(entry));
      continue;
    }
    // Anthropic validates encrypted_content and rejects forged or missing values.
    if (gstr(getAt(entry, "encrypted_content")).trim() === "") continue;
    const block = deepCopy(entry);
    if (isObj(block)) block.type = "web_search_result";
    blocks.push(block);
  }
  return blocks.length === 0 ? undefined : blocks;
}

/**
 * Mirrors Responses annotations back onto a Claude text block as citations;
 * entries without the mandatory encrypted_index are dropped.
 */
export function attachClaudeCitations(textBlock: JSONObject, annotations: unknown): JSONObject {
  if (!isArr(annotations)) return textBlock;
  const citations = annotations.filter((a) => gstr(getAt(a, "encrypted_index")).trim() !== "").map((a) => deepCopy(a));
  if (citations.length === 0) return textBlock;
  textBlock.citations = citations;
  return textBlock;
}
