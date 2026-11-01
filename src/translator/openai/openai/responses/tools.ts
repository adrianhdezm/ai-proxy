// Port of internal/translator/openai/openai/responses/openai_openai-responses_tools.go
// and responses_tool_index.go.
//
// Responses tool declarations (top-level "tools", namespace children and Codex
// Desktop "additional_tools" input items) flattened into Chat Completions
// function tools, plus the per-request index that maps emitted Chat Completions
// names back to their Responses identity (name + namespace, custom/shell kind).
import { getAt, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { setResponsesToolCallIdentity } from "../../../common/responses.ts";
import { applyPatchDescription, applyPatchParameters, isApplyPatchCustomTool } from "../../../common/apply_patch_tool.ts";
import { convertResponsesShellToolToOpenAIChat, localShellBaseName } from "./shell_tool.ts";

/** Chat Completions function-name limit enforced by strict upstreams (e.g. z-ai/glm). */
export const responsesChatToolNameLimit = 64;

/** One Responses tool declaration paired with the Chat Completions name it produces. */
export interface ResponsesToolDeclaration {
  tool: unknown;
  chatName: string;
  localName: string;
  namespace: string;
  custom: boolean;
  shell: boolean;
}

/**
 * Visits the declarations in one canonical order: top-level tools first, then
 * additional_tools input items, namespace children in declaration order. The
 * chatName is namespace-qualified, capped and disambiguated (Go: walkResponsesToolDeclarations).
 */
export function walkResponsesToolDeclarations(root: unknown, visit: (d: ResponsesToolDeclaration) => boolean): void {
  const declarations: ResponsesToolDeclaration[] = [];
  const emit = (tool: unknown, namespaceName: string): void => {
    let custom = false;
    let shell = false;
    switch (gstr(getAt(tool, "type")).trim()) {
      case "":
      case "function":
        break;
      case "custom":
        custom = true;
        break;
      case "shell":
        if (namespaceName !== "" || gstr(getAt(tool, "environment.type")) !== "local") return;
        shell = true;
        break;
      default:
        return;
    }
    let localName = responsesToolName(tool);
    if (shell) localName = localShellBaseName;
    if (localName === "") return;
    declarations.push({ tool, chatName: qualifyResponsesNamespaceToolName(namespaceName, localName), localName, namespace: namespaceName, custom, shell });
  };
  const scan = (tools: unknown): void => {
    if (!isArr(tools)) return;
    for (const tool of tools) {
      if (gstr(getAt(tool, "type")).trim() === "namespace") {
        const children = getAt(tool, "tools");
        if (isArr(children)) {
          const namespaceName = gstr(getAt(tool, "name")).trim();
          for (const child of children) emit(child, namespaceName);
        }
        continue;
      }
      emit(tool, "");
    }
  };

  scan(getAt(root, "tools"));
  const input = getAt(root, "input");
  if (isArr(input)) {
    for (const item of input) {
      if (gstr(getAt(item, "type")) === "additional_tools") scan(getAt(item, "tools"));
    }
  }

  // Reserve user identities before assigning the synthetic shell name.
  const reserved = new Set<string>();
  for (const d of declarations) {
    if (!d.shell) {
      reserved.add(d.localName);
      reserved.add(d.chatName);
      reserved.add(rawResponsesNamespaceQualifiedName(d.namespace, d.localName));
    }
  }
  let shellName = localShellBaseName;
  for (let suffix = 1; reserved.has(shellName); suffix++) shellName = `${localShellBaseName}_${suffix}`;
  for (const d of declarations) {
    if (d.shell) {
      d.localName = shellName;
      d.chatName = shellName;
    }
  }
  disambiguateResponsesChatToolNames(declarations);

  for (const d of declarations) {
    if (!visit(d)) break;
  }
}

/**
 * Rewrites flattened names in place when distinct declarations collapse onto the
 * same capped Chat Completions name; local names carried by more than one
 * identity are burned (Go: disambiguateResponsesChatToolNames).
 */
function disambiguateResponsesChatToolNames(declarations: ResponsesToolDeclaration[]): void {
  const claimed = new Map<string, string>();
  const claim = (candidate: string, identity: string): boolean => {
    const owner = claimed.get(candidate);
    if (owner === undefined) {
      claimed.set(candidate, identity);
      return true;
    }
    return owner === identity;
  };
  const longDeclarations: number[] = [];
  const identities: string[] = [];
  const localOwners = new Map<string, string>();
  const ambiguousLocalNames = new Set<string>();
  declarations.forEach((d, i) => {
    const identity = rawResponsesNamespaceQualifiedName(d.namespace, d.localName);
    identities[i] = identity;
    if (identity.length > responsesChatToolNameLimit) longDeclarations.push(i);
    else claim(identity, identity);
    const local = d.localName;
    if (local === "" || local === identity || local.length > responsesChatToolNameLimit) return;
    const owner = localOwners.get(local);
    if (owner === undefined) localOwners.set(local, identity);
    else if (owner !== "" && owner !== identity) localOwners.set(local, "");
  });
  for (const [local, owner] of localOwners) {
    claim(local, owner);
    if (owner === "") ambiguousLocalNames.add(local);
  }
  for (const i of longDeclarations) {
    const identity = identities[i]!;
    const name = declarations[i]!.chatName;
    if (!ambiguousLocalNames.has(name) && claim(name, identity)) continue;
    for (let suffix = 1; ; suffix++) {
      const candidate = capResponsesChatToolName(`${name}_${suffix}`);
      if (ambiguousLocalNames.has(candidate)) continue;
      if (claim(candidate, identity)) {
        declarations[i]!.chatName = candidate;
        break;
      }
    }
  }
}

/** Maps a Responses freeform ("custom") tool onto a function taking {"input": string}. */
export function convertResponsesCustomToolToOpenAIChat(tool: unknown, overrideName: string): JSONObject | undefined {
  let name = overrideName.trim();
  if (name === "") name = responsesToolName(tool);
  if (name === "") return undefined;
  const fn: JSONObject = { name, description: "", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } };
  const description = responsesToolDescription(tool);
  if (description !== "") fn.description = description;
  if (isApplyPatchCustomTool(tool)) {
    fn.description = applyPatchDescription(tool);
    fn.parameters = JSON.parse(applyPatchParameters());
  }
  return { type: "function", function: fn };
}

export function convertResponsesFunctionToolToOpenAIChat(tool: unknown, overrideName: string): JSONObject | undefined {
  let name = overrideName.trim();
  if (name === "") name = responsesToolName(tool);
  if (name === "") return undefined;
  const fn: JSONObject = { name, description: "", parameters: {} };
  const description = responsesToolDescription(tool);
  if (description !== "") fn.description = description;
  const parameters = responsesToolParameters(tool);
  if (parameters !== undefined) fn.parameters = parameters;
  return { type: "function", function: fn };
}

type JSONObject = Record<string, unknown>;

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
    if (parameters !== undefined) return parameters;
  }
  return undefined;
}

/** Flattens a tool output (string or content-part array) into text for a Chat tool message. */
export function responsesToolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (isArr(output)) {
    let b = "";
    for (const part of output) {
      if (typeof part === "string") {
        b += part;
        continue;
      }
      const text = getAt(part, "text");
      if (text !== undefined) b += gstr(text);
    }
    return b;
  }
  if (output !== undefined) return JSON.stringify(output);
  return "";
}

/** Extracts the freeform input from {"input": "..."} arguments, or returns the raw arguments. */
export function unwrapCustomToolInput(args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }
  const v = getAt(parsed, "input");
  if (v !== undefined && isObj(parsed)) return typeof v === "string" ? v : JSON.stringify(v);
  return args;
}

export function qualifyResponsesNamespaceToolName(namespaceName: string, childName: string): string {
  return capResponsesChatToolName(rawResponsesNamespaceQualifiedName(namespaceName, childName));
}

/** qualifyResponsesNamespaceToolName without the length cap. */
export function rawResponsesNamespaceQualifiedName(namespaceName: string, childName: string): string {
  childName = childName.trim();
  if (childName === "" || namespaceName === "" || childName.startsWith("mcp__")) return childName;
  if (childName === namespaceName || childName.startsWith(namespaceName + "__")) return childName;
  if (namespaceName.endsWith("__")) return namespaceName + childName;
  return namespaceName + "__" + childName;
}

/** Truncates a flattened name to the limit keeping the tail, stripping leading "_"/"-". */
export function capResponsesChatToolName(name: string): string {
  if (name.length <= responsesChatToolNameLimit) return name;
  const truncated = name.slice(name.length - responsesChatToolNameLimit);
  const trimmed = truncated.replace(/^[_-]+/, "");
  return trimmed !== "" ? trimmed : truncated;
}

/** Picks the original request when it is valid JSON, else the translated one (Go: pickRequestJSON). */
export function pickRequestJSON(originalRequestRawJSON: string | undefined, requestRawJSON: string | undefined): unknown {
  for (const raw of [originalRequestRawJSON, requestRawJSON]) {
    if (!raw || raw.trim() === "") continue;
    try {
      return JSON.parse(raw);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const identityKey = (namespace: string, name: string): string => namespace + "\u0000" + name;

/** Request-scoped index over the tool declarations (Go: responsesToolIndex). */
export class ResponsesToolIndex {
  readonly declarations: ResponsesToolDeclaration[] = [];
  readonly byChat = new Map<string, ResponsesToolDeclaration>();
  private readonly byIdentity = new Map<string, string>();
  readonly byRaw = new Map<string, string>();
  /** Empty means multiple distinct emitted tools. */
  readonly byLocal = new Map<string, string>();
  readonly custom = new Set<string>();

  constructor(root: unknown) {
    walkResponsesToolDeclarations(root, (d) => {
      this.declarations.push(d);
      const identity = identityKey(d.namespace, d.localName);
      if (!this.byIdentity.has(identity)) this.byIdentity.set(identity, d.chatName);
      const raw = rawResponsesNamespaceQualifiedName(d.namespace, d.localName);
      if (!this.byRaw.has(raw)) this.byRaw.set(raw, d.chatName);
      if (this.byChat.has(d.chatName)) return true;
      this.byChat.set(d.chatName, d);
      if (this.byLocal.has(d.localName)) this.byLocal.set(d.localName, "");
      else this.byLocal.set(d.localName, d.chatName);
      if (d.custom) this.custom.add(d.chatName);
      return true;
    });
  }

  namespaceName(namespace: string, name: string): string {
    const chatName = this.byIdentity.get(identityKey(namespace, name));
    if (chatName !== undefined) return chatName;
    return this.avoidAlias(qualifyResponsesNamespaceToolName(namespace, name));
  }

  canonicalName(name: string): string {
    if (this.byChat.has(name)) return name;
    const raw = this.byRaw.get(name);
    if (raw !== undefined) return raw;
    const local = this.byLocal.get(name);
    if (local) return local;
    return this.avoidAlias(capResponsesChatToolName(name));
  }

  avoidAlias(candidate: string): string {
    if (!this.byChat.has(candidate)) return candidate;
    for (let suffix = 1; ; suffix++) {
      const variant = capResponsesChatToolName(`${candidate}_${suffix}`);
      if (!this.byChat.has(variant)) return variant;
    }
  }

  /** Writes the Responses name/namespace of an emitted Chat name onto item (mutating). */
  applyIdentity<T>(item: T, qualifiedName: string, itemPath: string): T {
    let name = qualifiedName.trim();
    let namespace = "";
    const d = this.byChat.get(name);
    if (d) {
      name = d.localName;
      namespace = d.namespace;
    }
    return setResponsesToolCallIdentity(item, name, namespace, itemPath);
  }

  singleCustomName(): [string, boolean] {
    if (this.custom.size === 1) {
      for (const name of this.custom) return [name, this.byChat.size === 1];
    }
    return ["", false];
  }

  /** Resolves only the original winning custom apply_patch declaration. */
  isApplyPatch(name: string): boolean {
    const d = this.byChat.get(name);
    return !!d && d.custom && isApplyPatchCustomTool(d.tool);
  }

  isShell(name: string): boolean {
    return this.byChat.get(name)?.shell === true;
  }

  shellName(): string {
    for (const d of this.declarations) if (d.shell) return d.chatName;
    return "";
  }

  /** The deduplicated Chat Completions tools, first declaration winning (Go: chatTools). */
  chatTools(): JSONObject[] {
    const merged: JSONObject[] = [];
    const seen = new Set<string>();
    for (const d of this.declarations) {
      if (seen.has(d.chatName)) continue;
      const tool = d.custom
        ? convertResponsesCustomToolToOpenAIChat(d.tool, d.chatName)
        : d.shell
          ? convertResponsesShellToolToOpenAIChat(d.tool, d.chatName)
          : convertResponsesFunctionToolToOpenAIChat(d.tool, d.chatName);
      if (tool) {
        merged.push(tool);
        seen.add(d.chatName);
      }
    }
    return merged;
  }
}

export function newResponsesToolIndex(root: unknown): ResponsesToolIndex {
  return new ResponsesToolIndex(root);
}

/** Chat Completions tools of a Responses request (Go: mergeResponsesRequestChatTools). */
export function mergeResponsesRequestChatTools(root: unknown): JSONObject[] {
  return newResponsesToolIndex(root).chatTools();
}

/** Chat names of the freeform tools that survive the merge (Go: responsesCustomToolNames). */
export function responsesCustomToolNames(requestRawJSON: string): Set<string> {
  return newResponsesToolIndex(pickRequestJSON(requestRawJSON, undefined)).custom;
}

export function responsesSingleCustomToolName(requestRawJSON: string): [string, boolean] {
  return newResponsesToolIndex(pickRequestJSON(requestRawJSON, undefined)).singleCustomName();
}

/** Maps an emitted Chat name back to the declaration identity (Go: resolveResponsesQualifiedToolIdentity). */
export function resolveResponsesQualifiedToolIdentity(root: unknown, qualifiedName: string): [string, string, boolean] {
  const d = newResponsesToolIndex(root).byChat.get(qualifiedName);
  return d ? [d.localName, d.namespace, true] : ["", "", false];
}

export function chatNameForResponsesNamespaceToolCall(requestRawJSON: string, namespace: string, localName: string): string {
  return newResponsesToolIndex(pickRequestJSON(requestRawJSON, undefined)).namespaceName(namespace, localName);
}

export function canonicalResponsesToolName(requestRawJSON: string, name: string): string {
  return newResponsesToolIndex(pickRequestJSON(requestRawJSON, undefined)).canonicalName(name);
}

export function avoidResponsesDeclaredChatAliases(root: unknown, candidate: string): string {
  return newResponsesToolIndex(root).avoidAlias(candidate);
}

export function splitResponsesQualifiedFunctionCallFromRequest(requestRawJSON: string, qualifiedName: string): [string, string] {
  qualifiedName = qualifiedName.trim();
  if (qualifiedName === "") return ["", ""];
  const [name, namespace, ok] = resolveResponsesQualifiedToolIdentity(pickRequestJSON(requestRawJSON, undefined), qualifiedName);
  return ok ? [name, namespace] : [qualifiedName, ""];
}
