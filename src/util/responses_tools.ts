// Port of the tool-descriptor half of internal/util/responses_tools.go, used by the
// Claude -> Codex Responses translator. The Gemini function-declaration builder
// (BuildGeminiFunctionDeclarations and friends) serves the Responses -> Gemini
// path, which is not kept, and is not ported.
import { exists, gbool, getAt, gstr, isArr } from "./gpath.ts";

/** The resolved identity of a tool in OpenAI Responses format. */
export interface ResponsesToolIdentity {
  name: string;
  namespace: string;
  custom: boolean;
  /** Resolved from the winning original declaration, never from the upstream name. */
  applyPatch: boolean;
  /** Marks the function shim standing in for a client-executed tool_search declaration. */
  toolSearch: boolean;
}

export const responsesToolSearchType = "tool_search";
export const responsesToolSearchExecutionClient = "client";
export const responsesToolSearchFunctionName = "tool_search";
export const responsesClientToolSearchKey = "\x00client_tool_search";
export const responsesToolSearchCallType = "tool_search_call";
export const responsesToolSearchOutputType = "tool_search_output";
export const responsesDiscoveredToolPriority = 2;

/** A tool declaration found in a Responses request. */
export interface ResponsesToolDescriptor {
  /** Qualified name (e.g. "functions__exec" or "exec"). */
  name: string;
  /** Local name without namespace (e.g. "exec"). */
  localName: string;
  /** Namespace if any (e.g. "functions"). */
  namespace: string;
  /** "function", "custom", "tool_search". */
  toolType: string;
  /** The parsed tool declaration. */
  tool: unknown;
  /** 0 for top-level tools, 1 for additional_tools, 2 for tool_search_output. */
  sourcePriority: number;
  /** true if declared directly, false if declared as a namespace child. */
  direct: boolean;
  /** Original discovery order. */
  order: number;
  /** true for a client-executed tool_search declaration. */
  clientSearch: boolean;
}

/** Qualifies a child tool name with its namespace. */
export function qualifyResponsesNamespaceToolName(namespaceName: string, childName: string): string {
  childName = childName.trim();
  namespaceName = namespaceName.trim();
  if (childName === "" || namespaceName === "" || childName.startsWith("mcp__")) return childName;
  if (childName === namespaceName || childName.startsWith(namespaceName + "__")) return childName;
  if (namespaceName.endsWith("__")) return namespaceName + childName;
  return namespaceName + "__" + childName;
}

interface ToolSource {
  tools: unknown[];
  priority: number;
}

function responsesToolSources(root: unknown, includeClientToolSearch: boolean): ToolSource[] {
  const sources: ToolSource[] = [];
  const appendSource = (tools: unknown, priority: number): void => {
    if (isArr(tools)) sources.push({ tools, priority });
  };
  appendSource(getAt(root, "tools"), 0);
  const input = getAt(root, "input");
  if (isArr(input)) {
    for (const item of input) if (gstr(getAt(item, "type")) === "additional_tools") appendSource(getAt(item, "tools"), 1);
    if (includeClientToolSearch) {
      for (const item of input) {
        if (gstr(getAt(item, "type")) === responsesToolSearchOutputType && isResponsesClientToolSearchItem(item)) {
          appendSource(getAt(item, "tools"), responsesDiscoveredToolPriority);
        }
      }
    }
  }
  return sources;
}

/** Reports whether a tool declaration is a client-executed Responses tool_search. */
export function isResponsesClientToolSearchDeclaration(tool: unknown): boolean {
  return gstr(getAt(tool, "type")).trim() === responsesToolSearchType && gstr(getAt(tool, "execution")).trim() === responsesToolSearchExecutionClient;
}

/** Reports whether a tool_search_call or tool_search_output input item belongs to client-executed tool search. */
export function isResponsesClientToolSearchItem(item: unknown): boolean {
  const execution = gstr(getAt(item, "execution")).trim();
  return execution === "" || execution === responsesToolSearchExecutionClient;
}

function responsesToolName(tool: unknown): string {
  const name = gstr(getAt(tool, "name")).trim();
  if (name !== "") return name;
  return gstr(getAt(tool, "function.name")).trim();
}

/** Extracts the description from a tool or function object. */
export function responsesToolDescription(tool: unknown): string {
  const description = gstr(getAt(tool, "description"));
  if (description !== "") return description;
  return gstr(getAt(tool, "function.description"));
}

/** Extracts the schema/parameters from a tool or function object (undefined when absent). */
export function responsesToolParameters(tool: unknown): unknown {
  for (const path of ["parameters", "parametersJsonSchema", "input_schema", "function.parameters", "function.parametersJsonSchema"]) {
    const parameters = getAt(tool, path);
    if (exists(parameters)) return parameters;
  }
  return undefined;
}

/** Extracts all tool descriptors from a parsed Responses request root. */
export function collectResponsesToolDescriptors(root: unknown): ResponsesToolDescriptor[] {
  return collectResponsesToolDescriptorsImpl(root, false);
}

export function collectResponsesToolDescriptorsImpl(root: unknown, includeClientToolSearch: boolean): ResponsesToolDescriptor[] {
  const descriptors: ResponsesToolDescriptor[] = [];
  const appendDescriptor = (
    tool: unknown,
    name: string,
    localName: string,
    namespace: string,
    toolType: string,
    sourcePriority: number,
    direct: boolean,
    clientSearch: boolean,
  ): void => {
    if (name === "") return;
    descriptors.push({ name, localName, namespace, toolType, tool, sourcePriority, direct, order: descriptors.length, clientSearch });
  };
  const appendNamespaceChildren = (namespaceTool: unknown, sourcePriority: number): void => {
    const namespaceName = gstr(getAt(namespaceTool, "name")).trim();
    let children = getAt(namespaceTool, "tools");
    if (!isArr(children)) children = getAt(namespaceTool, "children");
    if (!isArr(children)) return;
    for (const child of children) {
      const childName = responsesToolName(child);
      if (childName === "") continue;
      const qualifiedName = qualifyResponsesNamespaceToolName(namespaceName, childName);
      switch (gstr(getAt(child, "type")).trim()) {
        case "":
        case "function":
          appendDescriptor(child, qualifiedName, childName, namespaceName, "function", sourcePriority, false, false);
          break;
        case "custom":
          appendDescriptor(child, qualifiedName, childName, namespaceName, "custom", sourcePriority, false, false);
          break;
      }
    }
  };
  for (const source of responsesToolSources(root, includeClientToolSearch)) {
    for (const tool of source.tools) {
      const toolType = gstr(getAt(tool, "type")).trim();
      switch (toolType) {
        case "":
        case "function": {
          const name = responsesToolName(tool);
          appendDescriptor(tool, name, name, "", "function", source.priority, true, false);
          break;
        }
        case "custom": {
          const name = responsesToolName(tool);
          appendDescriptor(tool, name, name, "", "custom", source.priority, true, false);
          break;
        }
        case "namespace":
          appendNamespaceChildren(tool, source.priority);
          break;
        case responsesToolSearchType:
          if (includeClientToolSearch && source.priority < responsesDiscoveredToolPriority && isResponsesClientToolSearchDeclaration(tool)) {
            appendDescriptor(tool, responsesToolSearchFunctionName, responsesToolSearchFunctionName, "", responsesToolSearchType, source.priority, true, true);
          }
          break;
      }
    }
  }
  if (!includeClientToolSearch || !descriptors.some((d) => d.clientSearch)) return descriptors;
  const kept: ResponsesToolDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor.clientSearch && descriptor.sourcePriority !== responsesDiscoveredToolPriority && gbool(getAt(descriptor.tool, "defer_loading"))) continue;
    kept.push({ ...descriptor, order: kept.length });
  }
  return kept;
}

export function responsesToolDescriptorPrecedes(left: ResponsesToolDescriptor, right: ResponsesToolDescriptor): boolean {
  if (left.sourcePriority !== right.sourcePriority) return left.sourcePriority < right.sourcePriority;
  if (left.direct !== right.direct) return left.direct;
  return left.order < right.order;
}

/** Collects the deduplicated winning descriptor for each qualified tool name. */
export function collectResponsesToolWinners(root: unknown): Map<string, ResponsesToolDescriptor> {
  return collectResponsesToolWinnersFromDescriptors(collectResponsesToolDescriptors(root));
}

export function collectResponsesToolWinnersFromDescriptors(descriptors: ResponsesToolDescriptor[]): Map<string, ResponsesToolDescriptor> {
  const winners = new Map<string, ResponsesToolDescriptor>();
  for (const descriptor of descriptors) {
    const current = winners.get(descriptor.name);
    if (!current || responsesToolDescriptorPrecedes(descriptor, current)) winners.set(descriptor.name, descriptor);
  }
  return winners;
}

/** Extracts the raw input string from custom tool arguments JSON or a plain string. */
export function unwrapResponsesCustomToolInput(args: string): string {
  args = args.trim();
  if (args === "" || args === "{}") return "";
  try {
    const parsed: unknown = JSON.parse(args);
    const v = getAt(parsed, "input");
    if (exists(v)) return typeof v === "string" ? v : JSON.stringify(v);
    if (typeof parsed === "string") return parsed;
  } catch {
    // fall through
  }
  return args;
}

