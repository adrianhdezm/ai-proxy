// Port of internal/runtime/executor/helps/responses_tool_search.go.
//
// Helpers the Claude executor uses to decide whether a Responses payload needs
// client tool_search support and, when upstream.claude.tool-search is off, to
// strip the tool_search pieces so the translator behaves as it did before
// tool_search was supported.
import { getAt, gstr, isArr } from "./gpath.ts";
import { tryParse } from "./json.ts";

const responsesToolSearchType = "tool_search";
const responsesToolSearchCallType = "tool_search_call";
const responsesToolSearchOutputType = "tool_search_output";

/** Reports whether a Responses payload carries a client tool_search declaration or tool_search history items. */
export function responsesHasToolSearch(payload: string): boolean {
  const root = tryParse<unknown>(payload);
  if (hasClientToolSearchDeclaration(getAt(root, "tools"))) return true;
  const input = getAt(root, "input");
  if (!isArr(input)) return false;
  for (const item of input) {
    switch (gstr(getAt(item, "type")).trim()) {
      case responsesToolSearchCallType:
      case responsesToolSearchOutputType:
        return true;
      case "additional_tools":
        if (hasClientToolSearchDeclaration(getAt(item, "tools"))) return true;
        break;
    }
  }
  return false;
}

/**
 * Removes client tool_search declarations and every tool_search_call /
 * tool_search_output input item. Hosted declarations are left for the
 * translator. An unchanged payload is returned as is (same string).
 */
export function stripResponsesToolSearch(payload: string): string {
  const root = tryParse<unknown>(payload);
  if (typeof root !== "object" || root === null || Array.isArray(root)) return payload;
  const obj = root as Record<string, unknown>;
  let changed = false;
  if (isArr(obj.tools)) {
    const { kept, changed: toolsChanged } = withoutClientToolSearch(obj.tools);
    if (toolsChanged) {
      obj.tools = kept;
      changed = true;
    }
  }
  if (isArr(obj.input)) {
    let inputChanged = false;
    const items: unknown[] = [];
    for (const item of obj.input) {
      switch (gstr(getAt(item, "type")).trim()) {
        case responsesToolSearchCallType:
        case responsesToolSearchOutputType:
          inputChanged = true;
          continue;
        case "additional_tools": {
          const tools = getAt(item, "tools");
          if (isArr(tools)) {
            const { kept, changed: toolsChanged } = withoutClientToolSearch(tools);
            if (toolsChanged) {
              items.push({ ...(item as Record<string, unknown>), tools: kept });
              inputChanged = true;
              continue;
            }
          }
          break;
        }
      }
      items.push(item);
    }
    if (inputChanged) {
      obj.input = items;
      changed = true;
    }
  }
  return changed ? JSON.stringify(obj) : payload;
}

function isClientToolSearchDeclaration(tool: unknown): boolean {
  return gstr(getAt(tool, "type")).trim() === responsesToolSearchType && gstr(getAt(tool, "execution")).trim() === "client";
}

function hasClientToolSearchDeclaration(tools: unknown): boolean {
  return isArr(tools) && tools.some(isClientToolSearchDeclaration);
}

function withoutClientToolSearch(tools: unknown[]): { kept: unknown[]; changed: boolean } {
  const kept = tools.filter((tool) => !isClientToolSearchDeclaration(tool));
  return { kept, changed: kept.length !== tools.length };
}
