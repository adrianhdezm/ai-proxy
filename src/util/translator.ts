// Port of the parts of internal/util/translator.go used by the kept Claude-inbound
// translators and internal/translator/common: FixJSON, the tool-name maps, and the
// Claude tool-argument placeholder cleaning (CleanClaudeToolArguments*).
import { sanitizeFunctionName } from "./function_name.ts";
import { cleanJSONSchemaForAntigravity, placeholderReasonDescription } from "./gemini_schema.ts";
import { sha256Hex } from "./hash.ts";
import { deleteAt, escapeGJSONPathKey, exists, garray, getAt, graw, gstr, isArr, isObj, joinPath, setAt } from "./gpath.ts";
import { log } from "../log.ts";

/**
 * Converts non-standard JSON that uses single quotes for strings into RFC 8259
 * JSON with double-quoted strings and proper escaping. Existing double-quoted
 * strings are preserved as-is.
 */
export function fixJSON(input: string): string {
  let out = "";
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  const runes = Array.from(input);
  for (let i = 0; i < runes.length; i++) {
    const r = runes[i]!;
    if (inDouble) {
      out += r;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (r === "\\") {
        escaped = true;
        continue;
      }
      if (r === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (escaped) {
        escaped = false;
        switch (r) {
          case "n":
          case "r":
          case "t":
          case "b":
          case "f":
          case "/":
          case '"':
            out += "\\" + r;
            break;
          case "\\":
            out += "\\\\";
            break;
          case "'":
            out += "'";
            break;
          case "u": {
            out += "\\u";
            for (let k = 0; k < 4 && i + 1 < runes.length; k++) {
              const peek = runes[i + 1]!;
              if (/^[0-9a-fA-F]$/.test(peek)) {
                out += peek;
                i++;
              } else {
                break;
              }
            }
            break;
          }
          default:
            out += "\\" + r;
        }
        continue;
      }
      if (r === "\\") {
        escaped = true;
        continue;
      }
      if (r === "'") {
        out += '"';
        inSingle = false;
        continue;
      }
      out += r === '"' ? '\\"' : r;
      continue;
    }
    if (r === '"') {
      inDouble = true;
      out += r;
      continue;
    }
    if (r === "'") {
      inSingle = true;
      out += '"';
      continue;
    }
    out += r;
  }
  if (inSingle) out += '"';
  return out;
}

export function canonicalToolName(name: string): string {
  return name.trim().replace(/^_+/, "").toLowerCase();
}

function parseRequest(rawJSON: string | undefined | null): unknown {
  if (!rawJSON) return undefined;
  try {
    return JSON.parse(rawJSON);
  } catch {
    return undefined;
  }
}

/** Canonical-name -> original-name map extracted from a Claude request's tools. */
export function toolNameMapFromClaudeRequest(rawJSON: string): Map<string, string> | undefined {
  return toolNameMapFromClaudeRequestImpl(rawJSON, false);
}

/**
 * Precomputes the legacy Claude mapper's collision policy so response chunks only
 * need mapToolName. Ambiguous canonical keys are stored with an empty value; use
 * mapToolName (which keeps the upstream name for empty values), do not index directly.
 */
export function unambiguousToolNameMapFromClaudeRequest(rawJSON: string): Map<string, string> | undefined {
  return toolNameMapFromClaudeRequestImpl(rawJSON, true);
}

function toolNameMapFromClaudeRequestImpl(rawJSON: string, rejectAmbiguous: boolean): Map<string, string> | undefined {
  const root = parseRequest(rawJSON);
  if (root === undefined) return undefined;
  const tools = getAt(root, "tools");
  if (!isArr(tools)) return undefined;
  const out = new Map<string, string>();
  for (const tool of tools) {
    let name = gstr(getAt(tool, "name")).trim();
    if (name === "") name = gstr(getAt(tool, "function.name")).trim();
    if (name === "") continue;
    const key = canonicalToolName(name);
    if (key === "") continue;
    if (!out.has(key)) out.set(key, name);
    else if (rejectAmbiguous && out.get(key) !== name) out.set(key, "");
  }
  return out.size === 0 ? undefined : out;
}

export function mapToolName(toolNameMap: Map<string, string> | undefined, name: string): string {
  if (name === "" || !toolNameMap) return name;
  const mapped = toolNameMap.get(canonicalToolName(name));
  return mapped ? mapped : name;
}

/**
 * Restores the client-facing tool name while preferring an exact declared name
 * over canonical (case/leading-underscore-insensitive) restoration.
 */
export function mapClaudeToolName(toolNameMap: Map<string, string> | undefined, originalRequestRawJSON: string, name: string): string {
  if (name === "") return name;
  const root = parseRequest(originalRequestRawJSON);
  const tools = getAt(root, "tools");
  if (isArr(tools)) {
    const canonical = canonicalToolName(name);
    const canonicalNames = new Set<string>();
    for (const tool of tools) {
      let declared = gstr(getAt(tool, "name")).trim();
      if (declared === "") declared = gstr(getAt(tool, "function.name")).trim();
      if (declared === name) return name;
      if (declared !== "" && canonicalToolName(declared) === canonical) canonicalNames.add(declared);
    }
    if (canonicalNames.size > 1) return name;
  }
  return mapToolName(toolNameMap, name);
}

/**
 * Builds an original-name -> sanitized-name map from request tools. Exact duplicates
 * share a mapping; distinct names that sanitize to the same value receive
 * deterministic hash suffixes within the 64-byte limit.
 */
export function sanitizedFunctionNameMap(rawJSON: string): Map<string, string> | undefined {
  const names = functionNamesFromRequest(rawJSON);
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
    if ((baseCounts.get(base) ?? 0) > 1 || used.has(base)) mapped = disambiguateSanitizedFunctionName(base, name, used);
    out.set(name, mapped);
    used.set(mapped, name);
  }
  return out.size === 0 ? undefined : out;
}

/** Returns the request-specific sanitized name when available, else sanitizeFunctionName. */
export function mapSanitizedFunctionName(nameMap: Map<string, string> | undefined, name: string): string {
  const mapped = nameMap?.get(name);
  return mapped ? mapped : sanitizeFunctionName(name);
}

/** Sanitized-name -> original-name map using the same collision-aware mapping as sanitizedFunctionNameMap. */
export function disambiguatedToolNameMap(rawJSON: string): Map<string, string> | undefined {
  const forward = sanitizedFunctionNameMap(rawJSON);
  if (!forward) return undefined;
  const out = new Map<string, string>();
  for (const [original, sanitized] of forward) if (sanitized !== original) out.set(sanitized, original);
  return out.size === 0 ? undefined : out;
}

/** Legacy sanitized-name -> original-name map from top-level Claude-style tools. */
export function sanitizedToolNameMap(rawJSON: string): Map<string, string> | undefined {
  const root = parseRequest(rawJSON);
  const tools = getAt(root, "tools");
  if (!isArr(tools)) return undefined;
  const out = new Map<string, string>();
  for (const tool of tools) {
    const name = gstr(getAt(tool, "name")).trim();
    if (name === "") continue;
    const sanitized = sanitizeFunctionName(name);
    if (sanitized === name) continue;
    if (!out.has(sanitized)) out.set(sanitized, name);
    else log.warn(`sanitized tool name collision: ${JSON.stringify(out.get(sanitized))} and ${JSON.stringify(name)} both map to ${JSON.stringify(sanitized)}, keeping first`);
  }
  return out.size === 0 ? undefined : out;
}

function functionNamesFromRequest(rawJSON: string): string[] {
  const root = parseRequest(rawJSON);
  const tools = getAt(root, "tools");
  if (!isArr(tools)) return [];
  const names: string[] = [];
  const collectDeclarations = (declarations: unknown): void => {
    if (!isArr(declarations)) return;
    for (const declaration of declarations) {
      const name = gstr(getAt(declaration, "name"));
      if (name !== "") names.push(name);
    }
  };
  const collectTool = (tool: unknown): void => {
    const nested = getAt(tool, "tools");
    if (isArr(nested)) {
      for (const nestedTool of nested) collectTool(nestedTool);
      return;
    }
    let hasDeclarations = false;
    const camel = getAt(tool, "functionDeclarations");
    if (isArr(camel)) {
      collectDeclarations(camel);
      hasDeclarations = true;
    }
    const snake = getAt(tool, "function_declarations");
    if (isArr(snake)) {
      collectDeclarations(snake);
      hasDeclarations = true;
    }
    if (hasDeclarations) return;
    const fnName = gstr(getAt(tool, "function.name"));
    if (fnName !== "") {
      names.push(fnName);
      return;
    }
    const name = gstr(getAt(tool, "name"));
    if (name !== "") names.push(name);
  };
  for (const tool of tools) collectTool(tool);
  return names;
}

function disambiguateSanitizedFunctionName(base: string, original: string, used: Map<string, string>): string {
  for (let attempt = 0; ; attempt++) {
    const digest = sha256Hex(`${original}\x00${attempt}`);
    const suffix = "_" + digest.slice(0, 12);
    let prefix = base;
    const maxPrefix = 64 - suffix.length;
    if (prefix.length > maxPrefix) prefix = prefix.slice(0, maxPrefix);
    const candidate = prefix + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

/** Removes duplicate named declarations while preserving order (raw JSON array in, JSON array out). */
export function deduplicateFunctionDeclarations(raw: string): string {
  const parsed = parseRequest(raw);
  if (!isArr(parsed)) return raw;
  const seen = new Set<string>();
  const parts: unknown[] = [];
  for (const declaration of parsed) {
    const name = gstr(getAt(declaration, "name"));
    if (name !== "") {
      if (seen.has(name)) continue;
      seen.add(name);
    }
    parts.push(declaration);
  }
  return JSON.stringify(parts);
}

/** Looks up a sanitized function name and returns the original client-facing name, or the input unchanged. */
export function restoreSanitizedToolName(toolNameMap: Map<string, string> | undefined, sanitizedName: string): string {
  if (sanitizedName === "" || !toolNameMap) return sanitizedName;
  const original = toolNameMap.get(sanitizedName);
  return original !== undefined ? original : sanitizedName;
}

// ---- Claude tool-argument placeholder cleaning ----

interface ClaudeObjectSchemaInfo {
  properties: Map<string, unknown[]>;
  required: Set<string>;
  hasProperties: boolean;
  allowsDynamic: boolean;
  forbidsDynamic: boolean;
  hasPatternProperties: boolean;
  complex: boolean;
  unsafeComplex: boolean;
  declaresObject: boolean;
  branchInfos: ClaudeObjectSchemaInfo[];
}

function newInfo(): ClaudeObjectSchemaInfo {
  return {
    properties: new Map(),
    required: new Set(),
    hasProperties: false,
    allowsDynamic: false,
    forbidsDynamic: false,
    hasPatternProperties: false,
    complex: false,
    unsafeComplex: false,
    declaresObject: false,
    branchInfos: [],
  };
}

function claudeSchemaAllowsDynamic(schema: unknown): boolean {
  const pattern = getAt(schema, "patternProperties");
  if (isObj(pattern) && Object.keys(pattern).length > 0) return true;
  const additional = getAt(schema, "additionalProperties");
  return exists(additional) && additional !== false;
}

function claudeSchemaHasPatternProperties(schema: unknown): boolean {
  const pattern = getAt(schema, "patternProperties");
  return isObj(pattern) && Object.keys(pattern).length > 0;
}

function claudeSchemaForbidsDynamic(schema: unknown): boolean {
  return getAt(schema, "additionalProperties") === false;
}

function claudeResolveLocalRef(root: unknown, ref: string): { ok: boolean; value: unknown } {
  if (!ref.startsWith("#/")) return { ok: false, value: undefined };
  let current = root;
  for (let segment of ref.slice(2).split("/")) {
    segment = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (isObj(current) && segment in current) {
      current = current[segment];
    } else if (isArr(current)) {
      if (!/^\d+$/.test(segment)) return { ok: false, value: undefined };
      const index = Number(segment);
      if (index < 0 || index >= current.length) return { ok: false, value: undefined };
      current = current[index];
    } else {
      return { ok: false, value: undefined };
    }
  }
  return { ok: true, value: current };
}

function analyzeClaudeObjectSchema(schema: unknown, root: unknown): ClaudeObjectSchemaInfo {
  return analyzeClaudeObjectSchemaDepth(schema, root, 0, new Set());
}

function claudeSchemaDeclaresObject(schema: unknown): boolean {
  const typeValue = getAt(schema, "type");
  if (gstr(typeValue) === "object") return true;
  if (isArr(typeValue)) return typeValue.some((item) => gstr(item) === "object");
  return false;
}

function claudeUnionBranches(schema: unknown): { branches: unknown[]; ok: boolean } {
  const branches: unknown[] = [];
  const seen = new Set<string>();
  for (const keyword of ["anyOf", "oneOf"]) {
    const union = getAt(schema, keyword);
    if (!exists(union)) continue;
    if (!isArr(union)) return { branches: [], ok: false };
    for (const branch of union) {
      const branchType = getAt(branch, "type");
      if (gstr(branchType) === "null") continue;
      if (isArr(branchType) && branchType.length === 1 && gstr(branchType[0]) === "null") continue;
      const raw = graw(branch);
      if (seen.has(raw)) continue;
      seen.add(raw);
      branches.push(branch);
    }
  }
  return { branches, ok: true };
}

const claudeAnalyzedSchemaKeywords = new Set([
  "type", "description", "title", "properties", "required", "items", "additionalProperties", "patternProperties", "anyOf", "oneOf", "allOf",
  "$ref", "$defs", "definitions", "nullable", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "pattern", "format", "default", "examples", "minItems", "maxItems", "maxProperties", "$schema", "$id", "id", "$comment", "deprecated", "readOnly",
  "writeOnly", "example", "contentEncoding", "contentMediaType",
]);

function claudeSchemaHasUnanalyzedKeyword(schema: Record<string, unknown>): boolean {
  for (const key of Object.keys(schema)) {
    if (key.startsWith("x-")) continue;
    if (!claudeAnalyzedSchemaKeywords.has(key)) return true;
  }
  return false;
}

function analyzeClaudeObjectSchemaDepth(schema: unknown, root: unknown, depth: number, visitedRefs: Set<string>): ClaudeObjectSchemaInfo {
  const info = newInfo();
  if (depth > 16 || !isObj(schema)) {
    info.complex = true;
    return info;
  }
  if (claudeSchemaDeclaresObject(schema)) info.declaresObject = true;
  if (claudeSchemaHasUnanalyzedKeyword(schema)) {
    info.complex = true;
    info.unsafeComplex = true;
    return info;
  }
  if (exists(schema.anyOf) || exists(schema.oneOf)) {
    const { branches, ok } = claudeUnionBranches(schema);
    if (!ok || branches.length === 0) {
      info.complex = true;
      return info;
    }
    if (branches.length > 1) {
      for (const branch of branches) {
        const branchInfo = analyzeClaudeObjectSchemaDepth(branch, root, depth + 1, visitedRefs);
        info.branchInfos.push(branchInfo);
        mergeClaudeObjectSchemaInfo(info, branchInfo);
      }
      if (claudeSchemaAllowsDynamic(schema)) info.allowsDynamic = true;
      if (claudeSchemaForbidsDynamic(schema)) info.forbidsDynamic = true;
      if (claudeSchemaHasPatternProperties(schema)) info.hasPatternProperties = true;
      for (const requiredName of garray(schema.required)) info.required.add(gstr(requiredName));
      const props = schema.properties;
      if (isObj(props)) {
        info.hasProperties = true;
        info.declaresObject = true;
        for (const key of Object.keys(props)) appendUniqueSchema(info.properties, key, props[key]);
      }
      const ref = schema.$ref;
      if (exists(ref)) {
        const refValue = gstr(ref);
        if (!visitedRefs.has(refValue)) {
          const target = claudeResolveLocalRef(root, refValue);
          if (target.ok) {
            visitedRefs.add(refValue);
            const resolved = analyzeClaudeObjectSchemaDepth(target.value, root, depth + 1, visitedRefs);
            visitedRefs.delete(refValue);
            mergeClaudeObjectSchemaInfo(info, resolved);
          }
        }
      }
      if (isArr(schema.allOf)) {
        for (const branch of schema.allOf) mergeClaudeObjectSchemaInfo(info, analyzeClaudeObjectSchemaDepth(branch, root, depth + 1, visitedRefs));
      }
      info.complex = true;
      return info;
    }
    mergeClaudeObjectSchemaInfo(info, analyzeClaudeObjectSchemaDepth(branches[0], root, depth + 1, visitedRefs));
  }
  if (exists(schema.$ref)) {
    const refValue = gstr(schema.$ref);
    if (visitedRefs.has(refValue)) {
      info.complex = true;
      return info;
    }
    const target = claudeResolveLocalRef(root, refValue);
    if (!target.ok) {
      info.complex = true;
      return info;
    }
    visitedRefs.add(refValue);
    const resolved = analyzeClaudeObjectSchemaDepth(target.value, root, depth + 1, visitedRefs);
    visitedRefs.delete(refValue);
    mergeClaudeObjectSchemaInfo(info, resolved);
  }
  if (isArr(schema.allOf)) {
    for (const branch of schema.allOf) mergeClaudeObjectSchemaInfo(info, analyzeClaudeObjectSchemaDepth(branch, root, depth + 1, visitedRefs));
  } else if (exists(schema.allOf)) {
    info.complex = true;
  }
  if (claudeSchemaAllowsDynamic(schema)) info.allowsDynamic = true;
  if (claudeSchemaForbidsDynamic(schema)) info.forbidsDynamic = true;
  if (claudeSchemaHasPatternProperties(schema)) info.hasPatternProperties = true;
  const props = schema.properties;
  if (exists(props)) {
    if (!isObj(props)) {
      info.complex = true;
    } else {
      info.hasProperties = true;
      info.declaresObject = true;
      for (const key of Object.keys(props)) appendUniqueSchema(info.properties, key, props[key]);
    }
  }
  for (const requiredName of garray(schema.required)) info.required.add(gstr(requiredName));
  return info;
}

function appendUniqueSchema(map: Map<string, unknown[]>, key: string, value: unknown): void {
  const list = map.get(key) ?? [];
  if (!map.has(key)) map.set(key, list);
  appendUniqueToList(list, value);
}

function appendUniqueToList(list: unknown[], value: unknown): unknown[] {
  const raw = graw(value);
  for (const existing of list) if (graw(existing) === raw) return list;
  list.push(value);
  return list;
}

function mergeClaudeObjectSchemaInfo(dst: ClaudeObjectSchemaInfo, src: ClaudeObjectSchemaInfo): void {
  if (src.hasProperties) {
    dst.hasProperties = true;
    for (const [key, values] of src.properties) for (const value of values) appendUniqueSchema(dst.properties, key, value);
  }
  for (const name of src.required) dst.required.add(name);
  dst.branchInfos.push(...src.branchInfos);
  dst.allowsDynamic = dst.allowsDynamic || src.allowsDynamic;
  dst.forbidsDynamic = dst.forbidsDynamic || src.forbidsDynamic;
  dst.hasPatternProperties = dst.hasPatternProperties || src.hasPatternProperties;
  dst.complex = dst.complex || src.complex;
  dst.unsafeComplex = dst.unsafeComplex || src.unsafeComplex;
  dst.declaresObject = dst.declaresObject || src.declaresObject;
}

interface FoundSchema {
  schema: unknown; // undefined when the tool declares no schema
  root: unknown;
  found: boolean;
}

function findClaudeToolSchema(originalRequestRawJSON: string | undefined, toolName: string): FoundSchema {
  if (toolName === "") return { schema: undefined, root: undefined, found: false };
  const root = parseRequest(originalRequestRawJSON);
  if (root === undefined) return { schema: undefined, root: undefined, found: false };
  const tools = getAt(root, "tools");
  if (!isArr(tools)) return { schema: undefined, root, found: false };
  interface Candidate {
    name: string;
    schema: unknown;
  }
  const exact: Candidate[] = [];
  const canonicalToolNameValue = canonicalToolName(toolName);
  const canonicalMatches = new Map<string, Candidate[]>();
  for (const tool of tools) {
    let name = gstr(getAt(tool, "name")).trim();
    if (name === "") name = gstr(getAt(tool, "function.name")).trim();
    if (name === "") continue;
    let schema = getAt(tool, "input_schema");
    if (!exists(schema)) schema = getAt(tool, "parameters");
    if (!exists(schema)) schema = getAt(tool, "function.parameters");
    const c: Candidate = { name, schema };
    if (name === toolName) exact.push(c);
    if (canonicalToolName(name) === canonicalToolNameValue) {
      if (!canonicalMatches.has(name)) canonicalMatches.set(name, []);
      canonicalMatches.get(name)!.push(c);
    }
  }
  const allIdentical = (list: Candidate[]): boolean => {
    const first = graw(list[0]!.schema);
    return list.every((other) => graw(other.schema) === first);
  };
  if (exact.length === 1) return { schema: exact[0]!.schema, root, found: true };
  if (exact.length > 1) {
    if (allIdentical(exact)) return { schema: exact[0]!.schema, root, found: true };
    return { schema: undefined, root, found: false };
  }
  if (canonicalMatches.size === 1) {
    const matches = [...canonicalMatches.values()][0]!;
    if (matches.length === 1 || allIdentical(matches)) return { schema: matches[0]!.schema, root, found: true };
  }
  return { schema: undefined, root, found: false };
}

/**
 * Reports whether the tool was declared in the original Claude request with a missing
 * schema or an explicitly closed empty object schema (additionalProperties: false).
 */
export function claudeToolIsParameterless(toolName: string, originalRequestRawJSON: string): boolean {
  const { schema, found } = findClaudeToolSchema(originalRequestRawJSON, toolName);
  if (!found) return false;
  if (!exists(schema)) return true;
  const info = analyzeClaudeObjectSchema(schema, schema);
  if (info.complex || claudeInfoAnyBranchAllowsDynamic(info) || !info.declaresObject || !info.forbidsDynamic) return false;
  return info.required.size === 0 && (!info.hasProperties || info.properties.size === 0);
}

function resolveClaudeArrayItemsSchema(schema: unknown, root: unknown, depth: number, visitedRefs: Set<string>): { items: unknown[]; ok: boolean } {
  if (depth > 16 || !isObj(schema)) return { items: [], ok: false };
  const items: unknown[] = [];
  let deterministic = true;
  if (exists(schema.$ref)) {
    const refValue = gstr(schema.$ref);
    if (visitedRefs.has(refValue)) return { items: [], ok: false };
    const target = claudeResolveLocalRef(root, refValue);
    if (!target.ok) return { items: [], ok: false };
    visitedRefs.add(refValue);
    const resolved = resolveClaudeArrayItemsSchema(target.value, root, depth + 1, visitedRefs);
    visitedRefs.delete(refValue);
    if (!resolved.ok) deterministic = false;
    else for (const item of resolved.items) appendUniqueToList(items, item);
  }
  if (exists(schema.anyOf) || exists(schema.oneOf)) {
    const { branches, ok } = claudeUnionBranches(schema);
    if (!ok || branches.length !== 1) {
      deterministic = false;
    } else {
      const branchItems = resolveClaudeArrayItemsSchema(branches[0], root, depth + 1, visitedRefs);
      if (!branchItems.ok) deterministic = false;
      else for (const item of branchItems.items) appendUniqueToList(items, item);
    }
  }
  if (isArr(schema.allOf)) {
    for (const branch of schema.allOf) {
      const branchItems = resolveClaudeArrayItemsSchema(branch, root, depth + 1, visitedRefs);
      if (!branchItems.ok) {
        deterministic = false;
        continue;
      }
      for (const item of branchItems.items) appendUniqueToList(items, item);
    }
  } else if (exists(schema.allOf)) {
    deterministic = false;
  }
  if (exists(schema.items)) appendUniqueToList(items, schema.items);
  return { items, ok: deterministic };
}

function claudeArraySchemaUnsafe(schema: unknown, root: unknown): boolean {
  return analyzeClaudeObjectSchema(schema, root).unsafeComplex;
}

function cleanClaudeToolArray(args: unknown, schemas: unknown[], root: unknown, path: string): unknown {
  for (const schema of schemas) if (claudeArraySchemaUnsafe(schema, root)) return args;
  const itemSchemas: unknown[] = [];
  let deterministic = true;
  for (const schema of schemas) {
    const resolved = resolveClaudeArrayItemsSchema(schema, root, 0, new Set());
    if (!resolved.ok) {
      deterministic = false;
      continue;
    }
    if (resolved.items.length === 0) {
      appendUniqueToList(itemSchemas, schema);
      continue;
    }
    for (const item of resolved.items) appendUniqueToList(itemSchemas, item);
  }
  if (!deterministic || itemSchemas.length === 0) return args;
  const elementCount = garray(getAt(args, path)).length;
  for (let index = 0; index < elementCount; index++) {
    const elementPath = joinPath(path, String(index));
    const element = getAt(args, elementPath);
    if (isObj(element)) args = cleanClaudeToolObject(args, itemSchemas, root, elementPath, false);
    else if (isArr(element)) args = cleanClaudeToolArray(args, itemSchemas, root, elementPath);
  }
  return args;
}

function cleanClaudeToolObject(args: unknown, schemas: unknown[], root: unknown, path: string, topLevel: boolean): unknown {
  const argsResult = getAt(args, path);
  if (!isObj(argsResult) || schemas.length === 0) return args;
  const merged = newInfo();
  for (const schema of schemas) mergeClaudeObjectSchemaInfo(merged, analyzeClaudeObjectSchema(schema, root));
  if (merged.complex || !merged.declaresObject) return args;
  const isEmptySchema = merged.required.size === 0 && (!merged.hasProperties || merged.properties.size === 0);
  const allSchemasDeclareObject = schemas.every((schema) => analyzeClaudeObjectSchema(schema, root).declaresObject);
  if (
    isEmptySchema &&
    allSchemasDeclareObject &&
    merged.forbidsDynamic &&
    !claudeInfoAnyBranchAllowsDynamic(merged) &&
    !claudeOriginalsAnyBranchAllowsDynamic(schemas, root) &&
    !claudeOriginalsAnyCandidateAcceptsImplicitly(schemas, root, argsResult)
  ) {
    if (Object.keys(argsResult).length === 0) return args;
    if (topLevel) return {};
    return setAt(args, path, {});
  }
  const keys = [...merged.properties.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of keys) {
    const propertySchemas = merged.properties.get(key)!;
    const childPath = joinPath(path, escapeGJSONPathKey(key));
    const child = getAt(args, childPath);
    if (!exists(child)) continue;
    const currentForBranch = getAt(args, path);
    if (claudeParentBranchAcceptsChild(merged, key, currentForBranch) || claudeOriginalsMayPermitChild(schemas, root, key, currentForBranch)) continue;
    if (isObj(child)) args = cleanClaudeToolObject(args, propertySchemas, root, childPath, false);
    else if (isArr(child)) args = cleanClaudeToolArray(args, propertySchemas, root, childPath);
  }
  if (claudeInfoAnyBranchAllowsDynamic(merged)) return args;
  const current = getAt(args, path);
  if (!isObj(current)) return args;
  const reasonDeclared = merged.properties.has("reason");
  const underscoreDeclared = merged.properties.has("_");
  for (const placeholder of ["reason", "_"]) {
    if (placeholder === "reason" && reasonDeclared) continue;
    if (placeholder === "_" && underscoreDeclared) continue;
    if (merged.required.has(placeholder)) continue;
    if (claudeInfoAnyBranchAllowsDynamic(merged) || claudeOriginalsAnyBranchAllowsDynamic(schemas, root)) continue;
    if (claudeParentBranchAcceptsChild(merged, placeholder, current)) continue;
    if (claudeOriginalsAnyCandidateAcceptsImplicitly(schemas, root, current)) continue;
    if (placeholder in current) deleteAt(args, joinPath(path, placeholder));
  }
  const parsedCleaned = getAt(args, path);
  if (isObj(parsedCleaned) && Object.keys(parsedCleaned).length === 0 && path === "") return {};
  return args;
}

function findTranslatedClaudeToolSchemas(translatedRequestRawJSON: string | undefined, toolName: string, originalRequestRawJSON: string | undefined): unknown[] {
  if (toolName === "") return [];
  const root = parseRequest(translatedRequestRawJSON);
  if (root === undefined) return [];
  interface Named {
    name: string;
    schema: unknown;
  }
  const named: Named[] = [];
  const collectNamed = (tools: unknown): void => {
    if (!isArr(tools)) return;
    for (const toolGroup of tools) {
      const decls = getAt(toolGroup, "functionDeclarations");
      if (!isArr(decls)) continue;
      for (const decl of decls) {
        const name = gstr(getAt(decl, "name")).trim();
        if (name === "") continue;
        let schema = getAt(decl, "parametersJsonSchema");
        if (!exists(schema)) schema = getAt(decl, "parameters");
        if (isObj(schema)) named.push({ name, schema });
      }
    }
  };
  collectNamed(getAt(root, "tools"));
  collectNamed(getAt(root, "request.tools"));
  if (named.length === 0) return [];
  const canonical = canonicalToolName(toolName);
  const sanitized = sanitizeFunctionName(toolName);
  let sentName = "";
  const forward = originalRequestRawJSON ? sanitizedFunctionNameMap(originalRequestRawJSON) : undefined;
  if (forward) sentName = forward.get(toolName) ?? "";
  const exact: unknown[] = [];
  const canonicalByName = new Map<string, unknown[]>();
  for (const entry of named) {
    if (entry.name === toolName || (sentName !== "" && entry.name === sentName)) exact.push(entry.schema);
    if (canonicalToolName(entry.name) === canonical || entry.name === sanitized || sanitizeFunctionName(entry.name) === sanitized) {
      if (!canonicalByName.has(entry.name)) canonicalByName.set(entry.name, []);
      canonicalByName.get(entry.name)!.push(entry.schema);
    }
  }
  if (exact.length > 0) return exact;
  if (canonicalByName.size === 1) return [...canonicalByName.values()][0]!;
  return [];
}

function claudeOriginalDeclaresPropertyDeep(schema: unknown, root: unknown, property: string, depth: number, visitedRefs: Set<string>): boolean {
  if (depth > 16 || !isObj(schema)) return false;
  if (exists(schema.$ref)) {
    const refValue = gstr(schema.$ref);
    if (!visitedRefs.has(refValue)) {
      const target = claudeResolveLocalRef(root, refValue);
      if (target.ok) {
        visitedRefs.add(refValue);
        const declared = claudeOriginalDeclaresPropertyDeep(target.value, root, property, depth + 1, visitedRefs);
        visitedRefs.delete(refValue);
        if (declared) return true;
      }
    }
  }
  const props = schema.properties;
  if (isObj(props) && property in props) return true;
  for (const requiredName of garray(schema.required)) if (gstr(requiredName) === property) return true;
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    for (const branch of garray(schema[keyword])) {
      if (claudeOriginalDeclaresPropertyDeep(branch, root, property, depth + 1, visitedRefs)) return true;
    }
  }
  return false;
}

function claudeInfoAnyBranchAllowsDynamic(info: ClaudeObjectSchemaInfo): boolean {
  if (info.hasPatternProperties) return true;
  if (info.branchInfos.length === 0) return info.allowsDynamic && !info.forbidsDynamic;
  for (const branch of info.branchInfos) if (claudeInfoAnyBranchAllowsDynamic(branch)) return true;
  return info.allowsDynamic && !info.forbidsDynamic;
}

function currentHasAllRequired(info: ClaudeObjectSchemaInfo, current: unknown): boolean {
  for (const requiredName of info.required) if (!(isObj(current) && requiredName in current)) return false;
  return true;
}

function claudeBranchMayAccept(info: ClaudeObjectSchemaInfo, key: string, current: unknown): boolean {
  if (info.hasPatternProperties) return true;
  if (!info.forbidsDynamic && currentHasAllRequired(info, current)) return true;
  if (info.allowsDynamic && !info.forbidsDynamic) return true;
  for (const branch of info.branchInfos) {
    if (branch.properties.has(key)) continue;
    if (claudeBranchMayAccept(branch, key, current)) return true;
  }
  return false;
}

function claudeParentBranchAcceptsChild(originalInfo: ClaudeObjectSchemaInfo, key: string, current: unknown): boolean {
  if (originalInfo.branchInfos.length === 0) return false;
  for (const branch of originalInfo.branchInfos) {
    if (branch.properties.has(key)) continue;
    if (claudeBranchMayAccept(branch, key, current)) return true;
  }
  return false;
}

function claudeCandidateMayPermitChild(info: ClaudeObjectSchemaInfo, key: string, current: unknown): boolean {
  if (info.properties.has(key)) return false;
  if (info.hasPatternProperties) return true;
  if (info.forbidsDynamic) return false;
  return currentHasAllRequired(info, current);
}

function claudeOriginalsMayPermitChild(originals: unknown[], root: unknown, key: string, current: unknown): boolean {
  if (originals.length <= 1) return false;
  for (const original of originals) {
    const info = analyzeClaudeObjectSchema(original, root);
    if (info.complex) continue;
    if (claudeCandidateMayPermitChild(info, key, current)) return true;
  }
  return false;
}

function claudeOriginalsAnyCandidateAcceptsImplicitly(originals: unknown[], root: unknown, current: unknown): boolean {
  if (originals.length <= 1) return false;
  for (const original of originals) {
    const info = analyzeClaudeObjectSchema(original, root);
    if (info.complex || info.forbidsDynamic) continue;
    if (currentHasAllRequired(info, current)) return true;
  }
  return false;
}

function claudeOriginalsAnyBranchAllowsDynamic(originals: unknown[], root: unknown): boolean {
  for (const original of originals) if (claudeInfoAnyBranchAllowsDynamic(analyzeClaudeObjectSchema(original, root))) return true;
  return false;
}

function mergedClaudeOriginalInfo(originals: unknown[], root: unknown): ClaudeObjectSchemaInfo {
  const merged = newInfo();
  for (const original of originals) mergeClaudeObjectSchemaInfo(merged, analyzeClaudeObjectSchema(original, root));
  return merged;
}

function requiredIncludes(schema: unknown, name: string): boolean {
  for (const req of garray(getAt(schema, "required"))) if (gstr(req) === name) return true;
  return false;
}

function cleanClaudeToolArgumentsByTranslatedSchema(args: unknown, translatedSchemas: unknown[], originals: unknown[], root: unknown, path: string, topLevel: boolean): unknown {
  const current = getAt(args, path);
  if (!isObj(current) || translatedSchemas.length === 0 || originals.length === 0) return args;
  for (const original of originals) if (!isObj(original)) return args;
  const originalInfo = mergedClaudeOriginalInfo(originals, root);
  if (originalInfo.unsafeComplex) return args;
  if (originalInfo.complex) {
    const hasUnion = originals.some((original) => isArr(getAt(original, "anyOf")) || isArr(getAt(original, "oneOf")));
    if (!hasUnion) return args;
  }
  if (originalInfo.hasProperties) {
    const keys = [...originalInfo.properties.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const key of keys) {
      const childPath = joinPath(path, escapeGJSONPathKey(key));
      const child = getAt(args, childPath);
      if (!exists(child)) continue;
      const translatedChildren: unknown[] = [];
      for (const translated of translatedSchemas) {
        const translatedInfo = analyzeClaudeObjectSchema(translated, translated);
        for (const childSchema of translatedInfo.properties.get(key) ?? []) appendUniqueToList(translatedChildren, childSchema);
      }
      if (translatedChildren.length === 0) continue;
      const originalChildren = originalInfo.properties.get(key) ?? [];
      const currentForBranch = getAt(args, path);
      if (claudeParentBranchAcceptsChild(originalInfo, key, currentForBranch) || claudeOriginalsMayPermitChild(originals, root, key, currentForBranch)) continue;
      if (isObj(child) && originalChildren.length > 0) {
        args = cleanClaudeToolArgumentsByTranslatedSchema(args, translatedChildren, originalChildren, root, childPath, false);
      } else if (isArr(child) && originalChildren.length > 0) {
        args = cleanClaudeTranslatedArray(args, translatedChildren, originalChildren, root, childPath);
      }
    }
  }
  const currentAfterChildren = getAt(args, path);
  if (!isObj(currentAfterChildren)) return args;
  for (const placeholder of ["reason", "_"]) {
    if (originalInfo.properties.has(placeholder)) continue;
    if (originalInfo.required.has(placeholder)) continue;
    if (claudeInfoAnyBranchAllowsDynamic(originalInfo) || claudeOriginalsAnyBranchAllowsDynamic(originals, root)) continue;
    if (claudeOriginalsAnyCandidateAcceptsImplicitly(originals, root, currentAfterChildren)) continue;
    if (claudeParentBranchAcceptsChild(originalInfo, placeholder, currentAfterChildren)) continue;
    if (originals.some((original) => claudeOriginalDeclaresPropertyDeep(original, root, placeholder, 0, new Set()))) continue;
    if (!(placeholder in currentAfterChildren)) continue;
    let injected = false;
    for (const translated of translatedSchemas) {
      const translatedInfo = analyzeClaudeObjectSchema(translated, translated);
      const placeholderSchemas = translatedInfo.properties.get(placeholder);
      if (!placeholderSchemas) continue;
      if (placeholder === "reason") {
        for (const placeholderSchema of placeholderSchemas) {
          if (requiredIncludes(translated, "reason") || gstr(getAt(placeholderSchema, "description")) === placeholderReasonDescription) injected = true;
        }
        if (!injected && requiredIncludes(translated, "reason")) injected = true;
      } else {
        if (requiredIncludes(translated, "_")) injected = true;
        if (!injected && !topLevel) {
          for (const placeholderSchema of placeholderSchemas) if (gstr(getAt(placeholderSchema, "type")) === "boolean") injected = true;
        }
      }
    }
    if (!injected) {
      for (const translated of translatedSchemas) {
        for (const keyword of ["anyOf", "oneOf"]) {
          for (const branch of garray(getAt(translated, keyword))) {
            const branchInfo = analyzeClaudeObjectSchema(branch, branch);
            if (!branchInfo.properties.has(placeholder)) continue;
            if (requiredIncludes(branch, placeholder)) injected = true;
          }
        }
      }
    }
    if (!injected && topLevel && originalInfo.forbidsDynamic) {
      for (const translated of translatedSchemas) {
        const wrapped = JSON.stringify({ schema: translated });
        const recleaned = getAt(parseRequest(cleanJSONSchemaForAntigravity(wrapped)), "schema");
        if (!exists(recleaned)) continue;
        const recleanedInfo = analyzeClaudeObjectSchema(recleaned, recleaned);
        if (!recleanedInfo.properties.has(placeholder)) continue;
        if (requiredIncludes(recleaned, placeholder)) injected = true;
      }
    }
    if (injected) deleteAt(args, joinPath(path, placeholder));
  }
  const allCandidatesDeclareObject = originals.every((original) => analyzeClaudeObjectSchema(original, root).declaresObject);
  const currentForNormalize = getAt(args, path);
  if (
    !originalInfo.complex &&
    allCandidatesDeclareObject &&
    originalInfo.forbidsDynamic &&
    !claudeInfoAnyBranchAllowsDynamic(originalInfo) &&
    !claudeOriginalsAnyBranchAllowsDynamic(originals, root) &&
    !claudeOriginalsAnyCandidateAcceptsImplicitly(originals, root, currentForNormalize) &&
    originalInfo.declaresObject &&
    originalInfo.required.size === 0 &&
    (!originalInfo.hasProperties || originalInfo.properties.size === 0)
  ) {
    if (topLevel) return {};
    return setAt(args, path, {});
  }
  const parsedCleaned = getAt(args, path);
  if (isObj(parsedCleaned) && Object.keys(parsedCleaned).length === 0 && path === "") return {};
  return args;
}

function cleanClaudeTranslatedArray(args: unknown, translatedArraySchemas: unknown[], originalArraySchemas: unknown[], root: unknown, path: string): unknown {
  for (const schema of originalArraySchemas) if (claudeArraySchemaUnsafe(schema, root)) return args;
  const translatedItems: unknown[] = [];
  const originalItems: unknown[] = [];
  let deterministic = true;
  for (const schema of translatedArraySchemas) {
    const resolved = resolveClaudeArrayItemsSchema(schema, schema, 0, new Set());
    if (!resolved.ok) deterministic = false;
    for (const item of resolved.items) appendUniqueToList(translatedItems, item);
  }
  for (const schema of originalArraySchemas) {
    const resolved = resolveClaudeArrayItemsSchema(schema, root, 0, new Set());
    if (!resolved.ok) deterministic = false;
    if (resolved.ok && resolved.items.length === 0) {
      appendUniqueToList(originalItems, schema);
      continue;
    }
    for (const item of resolved.items) appendUniqueToList(originalItems, item);
  }
  if (!deterministic || translatedItems.length === 0 || originalItems.length === 0) return args;
  const elementCount = garray(getAt(args, path)).length;
  for (let index = 0; index < elementCount; index++) {
    const elementPath = joinPath(path, String(index));
    const element = getAt(args, elementPath);
    if (isObj(element)) args = cleanClaudeToolArgumentsByTranslatedSchema(args, translatedItems, originalItems, root, elementPath, false);
    else if (isArr(element)) args = cleanClaudeTranslatedArray(args, translatedItems, originalItems, root, elementPath);
  }
  return args;
}

function serializeCleaned(rawArgs: string, original: unknown, cleaned: unknown): string {
  const originalRaw = JSON.stringify(original);
  const cleanedRaw = JSON.stringify(cleaned);
  return cleanedRaw === originalRaw ? rawArgs : cleanedRaw;
}

/**
 * Strips placeholder arguments ("reason" or "_") only when the translated
 * (actually-sent) tool schema shows that the placeholder was injected for that
 * object. Without a translated schema it falls back to cleanClaudeToolArguments.
 * Parameterless tools are still normalized to "{}".
 */
export function cleanClaudeToolArgumentsWithTranslated(
  rawArgs: string,
  toolName: string,
  originalRequestRawJSON: string | undefined,
  translatedRequestRawJSON: string | undefined,
): string {
  const translatedSchemas = findTranslatedClaudeToolSchemas(translatedRequestRawJSON, toolName, originalRequestRawJSON);
  if (translatedSchemas.length > 0) {
    rawArgs = rawArgs.trim();
    if (rawArgs === "" || rawArgs === "{}") return "{}";
    const parsed = parseRequest(rawArgs);
    if (parsed === undefined || !isObj(parsed)) return rawArgs;
    const { schema, found } = findClaudeToolSchema(originalRequestRawJSON, toolName);
    if (!found) return rawArgs;
    if (!exists(schema)) return "{}";
    const cleaned = cleanClaudeToolArgumentsByTranslatedSchema(parseRequest(rawArgs), translatedSchemas, [schema], schema, "", true);
    return serializeCleaned(rawArgs, parsed, cleaned);
  }
  return cleanClaudeToolArguments(rawArgs, toolName, originalRequestRawJSON);
}

/**
 * Strips placeholder arguments ("reason" or "_") injected during schema
 * normalization for empty object schemas when returning responses to Claude clients.
 */
export function cleanClaudeToolArguments(rawArgs: string, toolName: string, originalRequestRawJSON: string | undefined): string {
  rawArgs = rawArgs.trim();
  if (rawArgs === "" || rawArgs === "{}") return "{}";
  const parsed = parseRequest(rawArgs);
  if (parsed === undefined) return rawArgs;
  const { schema, found } = findClaudeToolSchema(originalRequestRawJSON, toolName);
  if (!found) return rawArgs;
  if (!exists(schema)) return "{}";
  if (!isObj(parsed)) return rawArgs;
  const info = analyzeClaudeObjectSchema(schema, schema);
  if (info.complex || !info.declaresObject) return rawArgs;
  if (info.required.size === 0 && (!info.hasProperties || info.properties.size === 0) && info.forbidsDynamic && !claudeInfoAnyBranchAllowsDynamic(info)) {
    return "{}";
  }
  const cleaned = cleanClaudeToolObject(parseRequest(rawArgs), [schema], schema, "", true);
  return serializeCleaned(rawArgs, parsed, cleaned);
}
