// Local port of the Gemini half of internal/util/responses_tools.go
// (BuildGeminiFunctionDeclarations, ResponsesToolReverseIdentityMap,
// MapResponsesToolName, MapResponsesClientToolSearchName,
// ConvertResponsesToolChoiceToGemini). src/util/responses_tools.ts only ports the
// descriptor half; the shared file is not edited from this slice.
import { sanitizeFunctionName } from "../../../../util/function_name.ts";
import { cleanJSONSchemaForGeminiJSONSchema } from "../../../../util/gemini_schema.ts";
import { getAt, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { sha256Bytes } from "../../../../util/hash.ts";
import {
  collectResponsesToolDescriptorsImpl,
  isResponsesClientToolSearchItem,
  qualifyResponsesNamespaceToolName,
  responsesClientToolSearchKey,
  responsesToolDescription,
  responsesToolDescriptorPrecedes,
  responsesToolParameters,
  responsesToolSearchCallType,
  responsesToolSearchFunctionName,
  responsesToolSearchOutputType,
  responsesToolSearchType,
  type ResponsesToolDescriptor,
  type ResponsesToolIdentity,
} from "../../../../util/responses_tools.ts";
import { applyPatchDescription, applyPatchParameters, isApplyPatchCustomTool } from "../../../common/apply_patch_tool.ts";

const responsesToolSearchDefaultParameters = `{"type":"object","properties":{"query":{"type":"string","description":"Search query for deferred tools."},"limit":{"type":"number","description":"Maximum number of tools to return."}},"required":["query"],"additionalProperties":false}`;

function identity(init: Partial<ResponsesToolIdentity>): ResponsesToolIdentity {
  return { name: "", namespace: "", custom: false, applyPatch: false, toolSearch: false, ...init };
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function disambiguateResponsesSanitizedName(base: string, original: string, used: Map<string, string>): string {
  for (let attempt = 0; ; attempt++) {
    const digest = sha256Bytes(`${original}\x00${attempt}`);
    const suffix = "_" + hex(digest.slice(0, 6));
    let prefix = base;
    const maxPrefix = 64 - suffix.length;
    if (prefix.length > maxPrefix) prefix = prefix.slice(0, maxPrefix);
    const candidate = prefix + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

function sanitizeResponsesToolNames(names: string[]): Map<string, string> | undefined {
  if (names.length === 0) return undefined;
  const uniqueNames = new Set<string>();
  const baseCounts = new Map<string, number>();
  for (const name of names) {
    if (name === "" || uniqueNames.has(name)) continue;
    uniqueNames.add(name);
    const base = sanitizeFunctionName(name);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const sortedNames = [...uniqueNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = new Map<string, string>();
  const used = new Map<string, string>();
  for (const name of sortedNames) {
    const base = sanitizeFunctionName(name);
    let mapped = base;
    if ((baseCounts.get(base) ?? 0) > 1 || used.has(base)) mapped = disambiguateResponsesSanitizedName(base, name, used);
    out.set(name, mapped);
    used.set(mapped, name);
  }
  return out;
}

export interface GeminiFunctionDeclarations {
  declarations: unknown[];
  forwardMap: Map<string, string> | undefined;
  reverseMap: Map<string, ResponsesToolIdentity> | undefined;
}

/** Builds Gemini function declarations, the forward name mapping and the reverse identity mapping. */
export function buildGeminiFunctionDeclarations(root: unknown, withDeclarations = true): GeminiFunctionDeclarations {
  const descriptors = collectResponsesToolDescriptorsImpl(root, true);
  const winnerKey = (d: ResponsesToolDescriptor): string => `${d.clientSearch ? "1" : "0"}\x00${d.name}`;
  const winners = new Map<string, ResponsesToolDescriptor>();
  for (const descriptor of descriptors) {
    const key = winnerKey(descriptor);
    const current = winners.get(key);
    if (!current || responsesToolDescriptorPrecedes(descriptor, current)) winners.set(key, descriptor);
  }
  const seenKeys = new Set<string>();
  const winningList: ResponsesToolDescriptor[] = [];
  for (const descriptor of descriptors) {
    const key = winnerKey(descriptor);
    const winner = winners.get(key);
    if (!winner || winner.order !== descriptor.order || seenKeys.has(key)) continue;
    seenKeys.add(key);
    winningList.push(descriptor);
  }

  let hasClientSearchHistory = false;
  const input = getAt(root, "input");
  if (isArr(input)) {
    for (const item of input) {
      const typ = gstr(getAt(item, "type"));
      if ((typ === responsesToolSearchCallType || typ === responsesToolSearchOutputType) && isResponsesClientToolSearchItem(item)) {
        hasClientSearchHistory = true;
        break;
      }
    }
  }

  if (winningList.length === 0) {
    if (!hasClientSearchHistory) return { declarations: [], forwardMap: undefined, reverseMap: undefined };
    return {
      declarations: [],
      forwardMap: new Map([
        [responsesClientToolSearchKey, responsesToolSearchFunctionName],
        [responsesToolSearchFunctionName, responsesToolSearchFunctionName],
      ]),
      reverseMap: new Map([[responsesToolSearchFunctionName, identity({ name: responsesToolSearchFunctionName, toolSearch: true })]]),
    };
  }

  let hasClientSearch = false;
  let userOwnsExactToolSearch = false;
  const qualifiedNames: string[] = [];
  for (const desc of winningList) {
    if (desc.clientSearch) {
      hasClientSearch = true;
      continue;
    }
    if (desc.name === responsesToolSearchFunctionName) userOwnsExactToolSearch = true;
    qualifiedNames.push(desc.name);
  }
  const sanitizedMap = sanitizeResponsesToolNames(qualifiedNames) ?? new Map<string, string>();

  let clientSearchGeminiName = "";
  if (hasClientSearch || hasClientSearchHistory) {
    const used = new Map<string, string>();
    for (const [origName, mappedName] of sanitizedMap) used.set(mappedName, origName);
    if (!userOwnsExactToolSearch) {
      const collidingOrig = used.get(responsesToolSearchFunctionName);
      if (collidingOrig !== undefined && collidingOrig !== responsesToolSearchFunctionName) {
        used.set(responsesToolSearchFunctionName, responsesClientToolSearchKey);
        const newMapped = disambiguateResponsesSanitizedName(responsesToolSearchFunctionName, collidingOrig, used);
        sanitizedMap.set(collidingOrig, newMapped);
        used.set(newMapped, collidingOrig);
      } else {
        used.set(responsesToolSearchFunctionName, responsesClientToolSearchKey);
      }
      clientSearchGeminiName = responsesToolSearchFunctionName;
    } else {
      clientSearchGeminiName = disambiguateResponsesSanitizedName(responsesToolSearchFunctionName, responsesClientToolSearchKey, used);
      used.set(clientSearchGeminiName, responsesClientToolSearchKey);
    }
  }

  const forwardMap = new Map<string, string>();
  const reverseMap = new Map<string, ResponsesToolIdentity>();
  if (clientSearchGeminiName !== "") {
    forwardMap.set(responsesClientToolSearchKey, clientSearchGeminiName);
    forwardMap.set(clientSearchGeminiName, clientSearchGeminiName);
    if (!userOwnsExactToolSearch) forwardMap.set(responsesToolSearchFunctionName, clientSearchGeminiName);
    reverseMap.set(clientSearchGeminiName, identity({ name: responsesToolSearchFunctionName, toolSearch: true }));
  }
  const declarations: unknown[] = [];
  for (const desc of winningList) {
    let geminiName: string;
    const mapped = sanitizedMap.get(desc.name);
    if (desc.clientSearch) geminiName = clientSearchGeminiName;
    else if (mapped !== undefined && mapped !== "") geminiName = mapped;
    else geminiName = sanitizeFunctionName(desc.name);

    if (!desc.clientSearch) forwardMap.set(desc.name, geminiName);
    forwardMap.set(geminiName, geminiName);

    const ident = identity({
      name: desc.localName,
      namespace: desc.namespace,
      custom: desc.toolType === "custom",
      applyPatch: isApplyPatchCustomTool(desc.tool),
      toolSearch: desc.clientSearch,
    });
    reverseMap.set(geminiName, ident);
    if (!desc.clientSearch && desc.name !== geminiName) reverseMap.set(desc.name, ident);
    if (!withDeclarations) continue;

    const funcDecl: Record<string, unknown> = { name: geminiName, description: "", parametersJsonSchema: {} };
    const descStr = responsesToolDescription(desc.tool);
    if (descStr !== "") funcDecl.description = descStr;
    if (isApplyPatchCustomTool(desc.tool)) {
      funcDecl.description = applyPatchDescription(desc.tool);
      funcDecl.parametersJsonSchema = JSON.parse(applyPatchParameters()) as unknown;
    } else if (desc.toolType === "custom") {
      funcDecl.parametersJsonSchema = { type: "object", properties: { input: { type: "string" } }, required: ["input"] };
    } else if (desc.clientSearch) {
      funcDecl.parametersJsonSchema = buildGeminiToolSearchParametersSchema(desc.tool);
    } else {
      const params = responsesToolParameters(desc.tool);
      if (params !== undefined) funcDecl.parametersJsonSchema = parseLoose(cleanJSONSchemaForGeminiJSONSchema(JSON.stringify(params)));
    }
    declarations.push(funcDecl);
  }

  for (const desc of winningList) {
    if (!desc.clientSearch && desc.localName !== "" && desc.localName !== desc.name && !forwardMap.has(desc.localName)) {
      forwardMap.set(desc.localName, forwardMap.get(desc.name) ?? "");
    }
  }
  return { declarations, forwardMap, reverseMap };
}

function parseLoose(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function buildGeminiToolSearchParametersSchema(tool: unknown): unknown {
  const params = responsesToolParameters(tool);
  if (isObj(params)) {
    const cleaned = cleanJSONSchemaForGeminiJSONSchema(JSON.stringify(params));
    try {
      const parsed = JSON.parse(cleaned) as unknown;
      if (isObj(parsed)) return parsed;
    } catch {
      // fall through to the default schema
    }
  }
  return JSON.parse(responsesToolSearchDefaultParameters) as unknown;
}

/** Builds a Gemini function name -> ResponsesToolIdentity map from a Responses request JSON. */
export function responsesToolReverseIdentityMap(rawJSON: string | undefined): Map<string, ResponsesToolIdentity> | undefined {
  if (!rawJSON) return undefined;
  let root: unknown;
  try {
    root = JSON.parse(rawJSON);
  } catch {
    return undefined;
  }
  const req = getAt(root, "request");
  if (req !== undefined && (getAt(req, "model") !== undefined || getAt(req, "input") !== undefined || getAt(req, "tools") !== undefined)) root = req;
  return buildGeminiFunctionDeclarations(root, false).reverseMap;
}

/** The mapped Gemini function name if present in forwardMap, else the sanitized name. */
export function mapResponsesToolName(forwardMap: Map<string, string> | undefined, name: string): string {
  const mapped = forwardMap?.get(name);
  if (mapped !== undefined && mapped !== "") return mapped;
  return sanitizeFunctionName(name);
}

/** The mapped Gemini function name for the client-executed tool_search shim. */
export function mapResponsesClientToolSearchName(forwardMap: Map<string, string> | undefined): string {
  const mapped = forwardMap?.get(responsesClientToolSearchKey);
  if (mapped !== undefined && mapped !== "") return mapped;
  return responsesToolSearchFunctionName;
}

/** Translates Responses tool_choice into a Gemini functionCallingConfig object (undefined when unmapped). */
export function convertResponsesToolChoiceToGemini(toolChoice: unknown, forwardMap: Map<string, string> | undefined): Record<string, unknown> | undefined {
  if (toolChoice === undefined) return undefined;
  let mode = "";
  const allowedNames: string[] = [];
  const modeFor = (v: string): void => {
    switch (v) {
      case "none":
        mode = "NONE";
        break;
      case "auto":
        mode = "AUTO";
        break;
      case "required":
      case "any":
        mode = "ANY";
        break;
    }
  };
  if (typeof toolChoice === "string") {
    modeFor(toolChoice.trim().toLowerCase());
  } else if (isObj(toolChoice)) {
    const toolType = gstr(getAt(toolChoice, "type")).trim().toLowerCase();
    switch (toolType) {
      case "none":
      case "auto":
      case "required":
      case "any":
        modeFor(toolType);
        break;
      case responsesToolSearchType:
        mode = "ANY";
        allowedNames.push(mapResponsesClientToolSearchName(forwardMap));
        break;
      case "function":
      case "custom":
      case "tool":
      case "": {
        mode = "ANY";
        let name = gstr(getAt(toolChoice, "name")).trim();
        if (name === "") name = gstr(getAt(toolChoice, "function.name")).trim();
        if (name === "") name = gstr(getAt(toolChoice, "custom.name")).trim();
        let namespace = gstr(getAt(toolChoice, "namespace")).trim();
        if (namespace === "") namespace = gstr(getAt(toolChoice, "function.namespace")).trim();
        if (namespace === "") namespace = gstr(getAt(toolChoice, "custom.namespace")).trim();
        if (namespace !== "") name = qualifyResponsesNamespaceToolName(namespace, name);
        if (name !== "") allowedNames.push(mapResponsesToolName(forwardMap, name));
        break;
      }
    }
  }
  if (mode === "") return undefined;
  const cfg: Record<string, unknown> = { mode };
  if (allowedNames.length > 0) cfg.allowedFunctionNames = allowedNames;
  return cfg;
}
