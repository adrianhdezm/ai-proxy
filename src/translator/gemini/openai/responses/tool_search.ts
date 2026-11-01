// Port of internal/translator/gemini/openai/responses/gemini_openai-responses_tool_search.go.
import { getAt, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import {
  isResponsesClientToolSearchItem,
  qualifyResponsesNamespaceToolName,
  responsesToolSearchCallType,
  responsesToolSearchOutputType,
} from "../../../../util/responses_tools.ts";
import { extractResponsesCallID } from "../../../common/responses.ts";
import { str } from "./helpers.ts";
import { mapResponsesClientToolSearchName, mapResponsesToolName } from "./tools.ts";

const openAIResponsesToolSearchIDPrefix = "ts_";

/**
 * Rewrites replayed client-executed tool_search history into the function_call /
 * function_call_output shape that the Gemini request conversion already pairs.
 */
export function normalizeOpenAIResponsesToolSearchItems(items: unknown[], forwardMap: Map<string, string> | undefined): unknown[] {
  const normalized: unknown[] = [];
  for (const item of items) {
    switch (str(item, "type")) {
      case responsesToolSearchCallType:
        if (isResponsesClientToolSearchItem(item)) normalized.push(openAIResponsesToolSearchCallAsFunctionCall(item, forwardMap));
        break;
      case responsesToolSearchOutputType:
        if (isResponsesClientToolSearchItem(item)) normalized.push(openAIResponsesToolSearchOutputAsFunctionCallOutput(item, forwardMap));
        break;
      default:
        normalized.push(item);
    }
  }
  return normalized;
}

function openAIResponsesToolSearchCallAsFunctionCall(item: unknown, forwardMap: Map<string, string> | undefined): unknown {
  const call: Record<string, unknown> = { type: "function_call", name: mapResponsesClientToolSearchName(forwardMap), call_id: extractResponsesCallID(item), arguments: "{}" };
  const id = getAt(item, "id");
  if (id !== undefined) call.id = gstr(id);
  const status = getAt(item, "status");
  if (status !== undefined) call.status = gstr(status);
  const args = getAt(item, "arguments");
  if (typeof args === "string") call.arguments = args;
  else if (isObj(args) || isArr(args)) call.arguments = JSON.stringify(args);
  return call;
}

function openAIResponsesToolSearchOutputAsFunctionCallOutput(item: unknown, forwardMap: Map<string, string> | undefined): unknown {
  const output: Record<string, unknown> = { type: "function_call_output", name: mapResponsesClientToolSearchName(forwardMap), call_id: extractResponsesCallID(item), output: "" };
  const id = getAt(item, "id");
  if (id !== undefined) output.id = gstr(id);
  const summary: Record<string, unknown> = { status: "completed", tools: [] };
  const status = str(item, "status").trim();
  if (status !== "") summary.status = status;
  const errorResult = getAt(item, "error");
  if (errorResult !== undefined && errorResult !== null) summary.error = errorResult;
  summary.tools = openAIResponsesDiscoveredToolNames(getAt(item, "tools"), forwardMap);
  output.output = JSON.stringify(summary);
  return output;
}

function openAIResponsesDiscoveredToolNames(tools: unknown, forwardMap: Map<string, string> | undefined): string[] {
  const names: string[] = [];
  if (!isArr(tools)) return names;
  const seen = new Set<string>();
  const appendName = (name: string): void => {
    name = name.trim();
    if (name === "") return;
    const mapped = mapResponsesToolName(forwardMap, name);
    if (seen.has(mapped)) return;
    seen.add(mapped);
    names.push(mapped);
  };
  for (const tool of tools) {
    switch (str(tool, "type").trim()) {
      case "":
      case "function":
      case "custom": {
        let name = str(tool, "name").trim();
        if (name === "") name = str(tool, "function.name").trim();
        appendName(name);
        break;
      }
      case "namespace": {
        const namespaceName = str(tool, "name").trim();
        let children = getAt(tool, "tools");
        if (!isArr(children)) children = getAt(tool, "children");
        if (!isArr(children)) break;
        for (const child of children) {
          let childName = str(child, "name").trim();
          if (childName === "") childName = str(child, "function.name").trim();
          if (childName !== "") appendName(qualifyResponsesNamespaceToolName(namespaceName, childName));
        }
        break;
      }
    }
  }
  return names;
}

function parseObject(argsJSON: string): Record<string, unknown> | undefined {
  const trimmed = argsJSON.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function openAIResponsesToolSearchCallStatus(status: string, argsJSON: string): string {
  if (status === "completed" && parseObject(argsJSON) === undefined) return "incomplete";
  return status;
}

/** A Responses tool_search_call output item (parsed). */
export function buildOpenAIResponsesToolSearchCallItem(id: string, callID: string, status: string, argsJSON: string): Record<string, unknown> {
  status = openAIResponsesToolSearchCallStatus(status, argsJSON);
  const item: Record<string, unknown> = { id, type: "tool_search_call", status, execution: "client", call_id: callID, arguments: {} };
  const args = parseObject(argsJSON);
  if (args) item.arguments = args;
  return item;
}

export function openAIResponsesToolSearchCallItemID(callID: string): string {
  return openAIResponsesToolSearchIDPrefix + callID;
}
