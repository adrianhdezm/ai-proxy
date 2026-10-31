// Tool descriptor half of internal/translator/claude/openai/responses/
// claude_openai-responses_request.go plus claude_openai-responses_tool_names.go.
//
// The Responses -> Claude pair keeps its own descriptor model (it differs from
// util/responses_tools.ts: hosted/builtin tools are descriptors too and the
// client tool_search switch is explicit), so request and response translators
// resolve the same Claude names from the same Responses JSON.
import { exists, gbool, getAt, gstr, isArr } from "../../../../util/gpath.ts";
import { sanitizeClaudeFunctionName } from "../../../../util/claude_tool_id.ts";
import { sha256Hex } from "../../../../util/hash.ts";

/** Codex names the client tool search tool after its declaration type. */
export const responsesToolSearchType = "tool_search";
/** Ranks tools loaded by a tool_search_output after every declared tool. */
export const responsesDiscoveredToolPriority = 2;

export interface ResponsesToolDescriptor {
  name: string;
  childName: string;
  namespace: string;
  toolType: string;
  tool: unknown;
  sourcePriority: number;
  direct: boolean;
  order: number;
  /** Marks the Codex client tool_search declaration (only while tool search is on). */
  clientSearch: boolean;
}

export function qualifyResponsesNamespaceToolName(namespaceName: string, childName: string): string {
  childName = childName.trim();
  if (childName === "" || namespaceName === "" || childName.startsWith("mcp__")) return childName;
  if (childName === namespaceName || childName.startsWith(namespaceName + "__")) return childName;
  if (namespaceName.endsWith("__")) return namespaceName + childName;
  return namespaceName + "__" + childName;
}

export function responsesToolName(tool: unknown): string {
  const name = gstr(getAt(tool, "name")).trim();
  if (name !== "") return name;
  return gstr(getAt(tool, "function.name")).trim();
}

export function responsesToolDescription(tool: unknown): string {
  const description = gstr(getAt(tool, "description"));
  if (description !== "") return description;
  return gstr(getAt(tool, "function.description"));
}

export function responsesToolParameters(tool: unknown): unknown {
  for (const path of ["parameters", "parametersJsonSchema", "input_schema", "function.parameters", "function.parametersJsonSchema"]) {
    const parameters = getAt(tool, path);
    if (exists(parameters)) return parameters;
  }
  return undefined;
}

/** Reports whether a tool declaration asks the client to execute tool search. */
export function isResponsesClientToolSearch(tool: unknown): boolean {
  return gstr(getAt(tool, "type")).trim() === responsesToolSearchType && gstr(getAt(tool, "execution")).trim() === "client";
}

export function isUnsupportedOpenAIBuiltinToolType(toolType: string): boolean {
  switch (toolType) {
    case "image_generation":
    case "file_search":
    case "code_interpreter":
    case "computer_use_preview":
      return true;
    default:
      return false;
  }
}

interface ToolSource {
  tools: unknown[];
  priority: number;
}

function responsesToolSources(root: unknown, toolSearch: boolean): ToolSource[] {
  const sources: ToolSource[] = [];
  const appendSource = (tools: unknown, priority: number): void => {
    if (isArr(tools)) sources.push({ tools, priority });
  };
  appendSource(getAt(root, "tools"), 0);
  const input = getAt(root, "input");
  if (isArr(input)) {
    for (const item of input) if (gstr(getAt(item, "type")) === "additional_tools") appendSource(getAt(item, "tools"), 1);
    if (toolSearch) {
      for (const item of input) if (gstr(getAt(item, "type")) === "tool_search_output") appendSource(getAt(item, "tools"), responsesDiscoveredToolPriority);
    }
  }
  return sources;
}

export function responsesToolDescriptors(root: unknown, toolSearch: boolean): ResponsesToolDescriptor[] {
  let descriptors: ResponsesToolDescriptor[] = [];
  for (const source of responsesToolSources(root, toolSearch)) {
    descriptors = appendResponsesToolDescriptors(descriptors, source.tools, source.priority, toolSearch);
  }
  if (!responsesClientToolSearchWins(descriptors)) return descriptors;
  // With client tool search, declared defer_loading tools stay hidden until
  // a tool_search_output in history loads them.
  const kept: ResponsesToolDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.sourcePriority !== responsesDiscoveredToolPriority && gbool(getAt(descriptor.tool, "defer_loading"))) continue;
    kept.push({ ...descriptor, order: kept.length });
  }
  return kept;
}

/**
 * Reports whether the client tool_search declaration owns the tool_search name.
 * A same-named function that wins instead leaves no search tool.
 */
export function responsesClientToolSearchWins(descriptors: ResponsesToolDescriptor[]): boolean {
  let winner: ResponsesToolDescriptor | undefined;
  for (const d of descriptors) {
    if (d.name === responsesToolSearchType && (!winner || responsesToolDescriptorPrecedes(d, winner))) winner = d;
  }
  return winner !== undefined && winner.clientSearch;
}

export function appendResponsesToolDescriptors(
  descriptors: ResponsesToolDescriptor[],
  tools: unknown,
  sourcePriority: number,
  toolSearch: boolean,
): ResponsesToolDescriptor[] {
  const appendDescriptor = (tool: unknown, name: string, childName: string, namespace: string, toolType: string, direct: boolean, clientSearch = false): void => {
    if (name === "") return;
    descriptors.push({ name, childName, namespace, toolType, tool, sourcePriority, direct, order: descriptors.length, clientSearch });
  };
  const appendNamespaceChildren = (namespaceTool: unknown): void => {
    const namespaceName = gstr(getAt(namespaceTool, "name")).trim();
    const children = getAt(namespaceTool, "tools");
    if (!isArr(children)) return;
    for (const child of children) {
      const childName = responsesToolName(child);
      if (childName === "") continue;
      const qualifiedName = qualifyResponsesNamespaceToolName(namespaceName, childName);
      switch (gstr(getAt(child, "type")).trim()) {
        case "":
        case "function":
          appendDescriptor(child, qualifiedName, childName, namespaceName, "function", false);
          break;
        case "custom":
          appendDescriptor(child, qualifiedName, childName, namespaceName, "custom", false);
          break;
      }
    }
  };
  for (const tool of isArr(tools) ? tools : []) {
    const toolType = gstr(getAt(tool, "type")).trim();
    switch (toolType) {
      case "":
      case "function":
        appendDescriptor(tool, responsesToolName(tool), "", "", "function", true);
        break;
      case "custom":
        appendDescriptor(tool, responsesToolName(tool), "", "", "custom", true);
        break;
      case "namespace":
        appendNamespaceChildren(tool);
        break;
      case responsesToolSearchType:
        if (!toolSearch) {
          // Without tool search support a declaration is a generic tool.
          appendDescriptor(tool, gstr(getAt(tool, "name")).trim(), "", "", toolType, true);
          break;
        }
        // Hosted search cannot run on Claude, so only client search is kept.
        if (isResponsesClientToolSearch(tool)) appendDescriptor(tool, responsesToolSearchType, "", "", responsesToolSearchType, true, true);
        break;
      case "web_search": {
        const externalWebAccess = getAt(tool, "external_web_access");
        if (exists(externalWebAccess) && !gbool(externalWebAccess)) break;
        let name = gstr(getAt(tool, "name")).trim();
        if (name === "") name = "web_search";
        appendDescriptor(tool, name, "", "", "web_search", true);
        break;
      }
      default:
        if (isUnsupportedOpenAIBuiltinToolType(toolType)) break;
        appendDescriptor(tool, gstr(getAt(tool, "name")).trim(), "", "", toolType, true);
    }
  }
  return descriptors;
}

export function responsesToolDescriptorPrecedes(left: ResponsesToolDescriptor, right: ResponsesToolDescriptor): boolean {
  // Keep top-level tools ahead of additional_tools, then let direct
  // declarations win over namespace children within the same source class.
  if (left.sourcePriority !== right.sourcePriority) return left.sourcePriority < right.sourcePriority;
  if (left.direct !== right.direct) return left.direct;
  return left.order < right.order;
}

export function responsesToolWinners(root: unknown, toolSearch: boolean): Map<string, ResponsesToolDescriptor> {
  const winners = new Map<string, ResponsesToolDescriptor>();
  for (const descriptor of responsesToolDescriptors(root, toolSearch)) {
    const current = winners.get(descriptor.name);
    if (!current || responsesToolDescriptorPrecedes(descriptor, current)) winners.set(descriptor.name, descriptor);
  }
  return winners;
}

export function responsesToolNameMap(root: unknown, acceptedToolNames: Set<string>, toolSearch: boolean): Map<string, string> {
  const toolNameMap = new Map<string, string>();
  const descriptors = responsesToolDescriptors(root, toolSearch);
  const winners = responsesToolWinners(root, toolSearch);
  // Direct tool names are canonical aliases and must win over namespace child aliases.
  for (const d of descriptors) {
    const winner = winners.get(d.name);
    if (!winner || winner.order !== d.order || !d.direct) continue;
    if (!acceptedToolNames.has(d.name)) continue;
    toolNameMap.set(d.name, d.name);
  }
  // Namespace aliases fill only names not already owned by a winning direct tool.
  for (const d of descriptors) {
    const winner = winners.get(d.name);
    if (!winner || winner.order !== d.order || d.direct || d.childName === "") continue;
    if (!acceptedToolNames.has(d.name)) continue;
    if (toolNameMap.has(d.childName)) continue;
    toolNameMap.set(d.childName, d.name);
  }
  return toolNameMap;
}

const claudeToolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Maps qualified Responses tool identities to unique Claude tool names for one
 * request, and back. Request and response translators build it from the same
 * Responses JSON, so both sides agree.
 */
export class ClaudeToolNames {
  readonly toClaude = new Map<string, string>();
  readonly fromClaude = new Map<string, string>();

  /** The Claude name for a qualified Responses identity. */
  claudeName(identity: string): string {
    return this.toClaude.get(identity) ?? sanitizeClaudeFunctionName(identity);
  }

  /** The qualified Responses identity for a Claude name; unknown names are returned unchanged. */
  identity(claudeName: string): string {
    return this.fromClaude.get(claudeName) ?? claudeName;
  }

  assign(identity: string, name: string, taken: Set<string>): void {
    this.toClaude.set(identity, name);
    this.fromClaude.set(name, identity);
    taken.add(name);
  }

  allocate(identities: string[], taken: Set<string>): void {
    const changed: string[] = [];
    const seen = new Set<string>();
    for (const id of identities) {
      if (this.toClaude.has(id) || id === "" || seen.has(id)) continue;
      seen.add(id);
      if (claudeToolNamePattern.test(id) && !taken.has(id)) {
        this.assign(id, id, taken);
        continue;
      }
      changed.push(id);
    }
    const count = new Map<string, number>();
    for (const id of changed) {
      const base = sanitizeClaudeFunctionName(id);
      count.set(base, (count.get(base) ?? 0) + 1);
    }
    const hashed: string[] = [];
    for (const id of changed) {
      const base = sanitizeClaudeFunctionName(id);
      if (count.get(base) === 1 && !taken.has(base)) this.assign(id, base, taken);
      else hashed.push(id);
    }
    hashed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of hashed) {
      let base = sanitizeClaudeFunctionName(id);
      if (base.length > 53) base = base.slice(0, 53);
      for (let n = 0; ; n++) {
        const seed = n > 0 ? id + "\x00" + String(n) : id;
        const name = base + "_" + sha256Hex(seed).slice(0, 10);
        if (!taken.has(name)) {
          this.assign(id, name, taken);
          break;
        }
      }
    }
  }
}

export function buildClaudeToolNames(root: unknown, toolSearch: boolean): ClaudeToolNames {
  return buildClaudeToolNamesWithWinners(root, responsesToolWinners(root, toolSearch), toolSearch);
}

export function buildClaudeToolNamesWithWinners(root: unknown, winners: Map<string, ResponsesToolDescriptor>, toolSearch: boolean): ClaudeToolNames {
  const m = new ClaudeToolNames();
  const taken = new Set<string>();
  const declared: string[] = [];
  for (const d of responsesToolDescriptors(root, toolSearch)) {
    const w = winners.get(d.name);
    if (!w || w.order !== d.order) continue;
    if (d.toolType === "function" || d.toolType === "custom") declared.push(d.name);
    else m.assign(d.name, d.name, taken);
  }
  m.allocate(declared, taken);
  m.allocate(responsesHistoryToolIdentities(root), taken);
  return m;
}

/** Lists qualified names of function_call and custom_tool_call items in input, in order. */
export function responsesHistoryToolIdentities(root: unknown): string[] {
  const ids: string[] = [];
  const input = getAt(root, "input");
  if (!isArr(input)) return ids;
  for (const item of input) {
    const typ = gstr(getAt(item, "type"));
    if (typ !== "function_call" && typ !== "custom_tool_call") continue;
    let name = gstr(getAt(item, "name"));
    const ns = gstr(getAt(item, "namespace")).trim();
    if (ns !== "") name = qualifyResponsesNamespaceToolName(ns, name);
    if (name !== "") ids.push(name);
  }
  return ids;
}

/** Splits a Claude tool name back into its Responses (name, namespace). */
export function splitResponsesQualifiedFunctionCallFromRequest(requestRawJSON: unknown, qualifiedName: string, toolSearch: boolean): { name: string; namespace: string } {
  qualifiedName = qualifiedName.trim();
  if (qualifiedName === "") return { name: "", namespace: "" };
  const winners = responsesToolWinners(requestRawJSON, toolSearch);
  const toolNames = buildClaudeToolNamesWithWinners(requestRawJSON, winners, toolSearch);
  const identity = toolNames.identity(qualifiedName);
  const descriptor = winners.get(identity);
  if (!descriptor) return { name: identity, namespace: "" };
  if (!descriptor.direct) return { name: descriptor.childName, namespace: descriptor.namespace };
  return { name: identity, namespace: "" };
}
