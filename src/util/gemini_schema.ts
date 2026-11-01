// Port of internal/util/gemini_schema.go.
//
// The Go code rewrites a JSON string with gjson/sjson path operations. This port
// parses once and runs the same passes over the parsed value with gjson-style paths
// (see gpath.ts), then serialises the result. Pass order and semantics follow Go.
//
// Pass a single JSON schema to the functions below, never a whole request document:
// cleaning walks every node and rewrites keys by name, and schema keywords such as
// "title", "format", "default" and "const" are also ordinary data keys.
import {
  deepCopy,
  deleteAt,
  escapeGJSONPathKey,
  exists,
  garray,
  gbool,
  getAt,
  graw,
  gstr,
  isArr,
  isObj,
  joinPath,
  setAt,
  sortByDepth,
  splitGJSONPath,
  trimSuffix,
  unescapeGJSONPathKey,
} from "./gpath.ts";

export const placeholderReasonDescription = "Brief explanation of why you are calling this tool";

interface JSONSchemaCleanOptions {
  addPlaceholder?: boolean;
  addMissingArrayItems?: boolean;
  antigravitySemantics?: boolean;
  removeToolTitle?: boolean;
  removeGeminiMetadata?: boolean;
  flattenUnions?: boolean;
  /** Forces multi-branch anyOf/oneOf unions down to a single strongest branch. */
  flattenMultiBranchUnions?: boolean;
  forceEnumStringType?: boolean;
  dropAllEnums?: boolean;
  dropBooleanEnums?: boolean;
  preserveAdditionalPropertiesFalse?: boolean;
  preserveAllAdditionalProperties?: boolean;
  preserveStandardConstraints?: boolean;
}

/** Transforms a tool schema for the Antigravity API (Claude VALIDATED mode placeholders included). */
export function cleanJSONSchemaForAntigravity(jsonStr: string): string {
  return cleanJSONSchemaForAntigravityTool(jsonStr, true);
}

/** Transforms an Antigravity function schema; requirePlaceholder is used only for Claude VALIDATED mode. */
export function cleanJSONSchemaForAntigravityTool(jsonStr: string, requirePlaceholder: boolean): string {
  return cleanJSONSchemaForAntigravityToolImpl(jsonStr, requirePlaceholder, false);
}

/** Antigravity tool cleaner for Claude models: also flattens multi-branch anyOf/oneOf unions. */
export function cleanJSONSchemaForAntigravityClaudeTool(jsonStr: string, requirePlaceholder: boolean): string {
  return cleanJSONSchemaForAntigravityToolImpl(jsonStr, requirePlaceholder, true);
}

function cleanJSONSchemaForAntigravityToolImpl(jsonStr: string, requirePlaceholder: boolean, flattenMultiBranchUnions: boolean): string {
  return cleanJSONSchema(jsonStr, {
    addPlaceholder: requirePlaceholder,
    addMissingArrayItems: true,
    antigravitySemantics: true,
    removeToolTitle: !requirePlaceholder,
    flattenUnions: true,
    flattenMultiBranchUnions,
    dropAllEnums: true,
  });
}

/** Transforms a response schema without tool-only compatibility rewrites. */
export function cleanJSONSchemaForAntigravityResponse(jsonStr: string): string {
  return cleanJSONSchema(jsonStr, {
    antigravitySemantics: true,
    flattenUnions: true,
    dropBooleanEnums: true,
    preserveAdditionalPropertiesFalse: true,
  });
}

/** Transforms a JSON schema for Gemini tool calling (native Schema carrier). */
export function cleanJSONSchemaForGemini(jsonStr: string): string {
  return cleanJSONSchema(jsonStr, {
    addMissingArrayItems: true,
    removeGeminiMetadata: true,
    flattenUnions: true,
    forceEnumStringType: true,
  });
}

/**
 * Transforms a JSON schema for the Gemini parametersJsonSchema carrier: standard
 * constraints and additionalProperties are preserved, Gemini-incompatible metadata removed.
 */
export function cleanJSONSchemaForGeminiJSONSchema(jsonStr: string): string {
  return cleanJSONSchema(jsonStr, {
    addMissingArrayItems: true,
    removeGeminiMetadata: true,
    flattenUnions: true,
    forceEnumStringType: true,
    preserveAllAdditionalProperties: true,
    preserveStandardConstraints: true,
  });
}

function parseLoose(jsonStr: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(jsonStr) };
  } catch {
    return { ok: false, value: undefined };
  }
}

function cleanJSONSchema(jsonStr: string, options: JSONSchemaCleanOptions): string {
  const parsed = parseLoose(jsonStr);
  if (!parsed.ok) return jsonStr;
  let root: unknown = parsed.value;

  // Phase 0: normalize malformed schemas.
  root = normalizeMalformedSchemaObjects(root);

  // Phase 1: convert and add hints. Local references are expanded here for every route.
  root = inlineLocalRefsForClean(root);
  root = convertRefsToHints(root, !!options.antigravitySemantics);
  root = convertConstToEnum(root);
  root = convertEnumValuesToStrings(root, !!options.forceEnumStringType);
  root = addEnumHints(root);
  root = dropIgnoredEnumsToHints(root, options);
  if (!options.preserveAdditionalPropertiesFalse && !options.preserveAllAdditionalProperties) {
    root = addAdditionalPropertiesHints(root);
  }
  root = moveConstraintsToDescription(root, options);
  if (options.antigravitySemantics) root = moveNotToDescription(root);

  // Phase 2: flatten complex structures.
  const preserveConjunctions = !!options.preserveStandardConstraints && hasSchemaConjunction(root);
  root = mergeConditionals(root);
  if (!options.preserveStandardConstraints) root = mergeAllOf(root);
  if (!preserveConjunctions) {
    if (options.flattenUnions) root = flattenAnyOfOneOf(root, !!options.preserveStandardConstraints, !!options.flattenMultiBranchUnions);
    root = flattenTypeArrays(root, !!options.antigravitySemantics);
  }

  // Phase 3: cleanup.
  root = removeUnsupportedKeywords(root, options);
  if (options.removeGeminiMetadata) {
    root = removeKeywords(root, ["nullable", "title"]);
    root = removePlaceholderFields(root);
  } else if (options.removeToolTitle) {
    root = removeKeywords(root, ["title"]);
  }
  if (!preserveConjunctions) {
    root = cleanupRequiredFields(root);
    root = sanitizeObjectProperties(root);
    root = sanitizeArrayItems(root, !!options.addMissingArrayItems);
  }
  // Phase 4: placeholder for empty object schemas (Claude VALIDATED mode requirement).
  if (options.addPlaceholder) root = addEmptySchemaPlaceholder(root);

  return JSON.stringify(root);
}

function sanitizeObjectProperties(root: unknown): unknown {
  const paths = findPaths(root, "properties");
  sortByDepth(paths);
  for (const p of paths) {
    const parentPath = trimSuffix(p, ".properties");
    if (isPropertyDefinition(parentPath)) continue;
    const props = getAt(root, p);
    if (!isObj(props)) continue;
    const typePath = joinPath(parentPath, "type");
    const t = gstr(getAt(root, typePath));
    if (t.toLowerCase() !== "object") root = setAt(root, typePath, "object");
  }
  return root;
}

function sanitizeArrayItems(root: unknown, addMissing: boolean): unknown {
  const paths = findPaths(root, "items");
  sortByDepth(paths);
  for (const p of paths) {
    const parentPath = trimSuffix(p, ".items");
    if (isPropertyDefinition(parentPath)) continue;
    const typePath = joinPath(parentPath, "type");
    const t = gstr(getAt(root, typePath));
    if (t === "") root = setAt(root, typePath, "array");
    else if (t.toLowerCase() !== "array") deleteAt(root, p);
  }
  if (!addMissing) return root;
  const typePaths = findPaths(root, "type");
  sortByDepth(typePaths);
  for (const p of typePaths) {
    const parentPath = trimSuffix(p, ".type");
    if (isPropertyDefinition(parentPath) || !isArrayDeclaredType(getAt(root, p))) continue;
    if (exists(getAt(root, joinPath(parentPath, "items"))) || exists(getAt(root, joinPath(parentPath, "$ref")))) continue;
    root = setAt(root, joinPath(parentPath, "items"), { type: "string" });
  }
  return root;
}

function removeKeywords(root: unknown, keywords: string[]): unknown {
  const deletePaths: string[] = [];
  const pathsByField = findPathsByFields(root, keywords);
  for (const key of keywords) {
    for (const p of pathsByField.get(key) ?? []) {
      if (isPropertyDefinition(trimSuffix(p, "." + key))) continue;
      deletePaths.push(p);
    }
  }
  sortByDepth(deletePaths);
  for (const p of deletePaths) deleteAt(root, p);
  return root;
}

function filterRequired(root: unknown, reqPath: string, drop: string): unknown {
  const req = getAt(root, reqPath);
  if (!isArr(req)) return root;
  const filtered = req.map((r) => gstr(r)).filter((r) => r !== drop);
  if (filtered.length === 0) deleteAt(root, reqPath);
  else root = setAt(root, reqPath, filtered);
  return root;
}

function removePlaceholderFields(root: unknown): unknown {
  const paths = findPaths(root, "_");
  sortByDepth(paths);
  for (const p of paths) {
    if (!p.endsWith(".properties._")) continue;
    deleteAt(root, p);
    const parentPath = trimSuffix(p, ".properties._");
    root = filterRequired(root, joinPath(parentPath, "required"), "_");
  }
  const reasonPaths = findPaths(root, "reason");
  sortByDepth(reasonPaths);
  for (const p of reasonPaths) {
    if (!p.endsWith(".properties.reason")) continue;
    const parentPath = trimSuffix(p, ".properties.reason");
    const props = getAt(root, joinPath(parentPath, "properties"));
    if (!isObj(props) || Object.keys(props).length !== 1) continue;
    if (gstr(getAt(root, p + ".description")) !== placeholderReasonDescription) continue;
    deleteAt(root, p);
    root = filterRequired(root, joinPath(parentPath, "required"), "reason");
  }
  return root;
}

// ---- Phase 0: malformed schema normalization ----

function normalizeMalformedSchemaObjects(root: unknown): unknown {
  if (root === true) return {};
  if (!isObj(root) || isAPIRequestDocument(root)) return root;
  const keys = Object.keys(root);
  if (keys.length === 1) {
    const inner = root.schema;
    if (isObj(inner)) {
      const { node, modified } = repairSchemaNode(inner);
      if (!modified) return root;
      return { schema: node };
    }
    if (inner === true) return { schema: {} };
  }
  const { node, modified } = repairSchemaNode(root);
  return modified ? node : root;
}

function isKnownSchemaKeywordOrExtension(key: string): boolean {
  if (key.startsWith("x-")) return true;
  switch (key) {
    case "properties":
    case "patternProperties":
    case "additionalProperties":
    case "items":
    case "prefixItems":
    case "$defs":
    case "definitions":
    case "dependentSchemas":
    case "dependentRequired":
    case "dependencies":
    case "if":
    case "then":
    case "else":
    case "not":
    case "contains":
    case "propertyNames":
    case "unevaluatedProperties":
    case "unevaluatedItems":
    case "contentSchema":
    case "additionalItems":
    case "default":
    case "const":
    case "example":
    case "examples":
    case "discriminator":
    case "xml":
    case "externalDocs":
    case "enumDescriptions":
    case "enumTitles":
      return true;
  }
  return false;
}

function isNonObjectDeclaredType(t: unknown): boolean {
  if (typeof t === "string") return t !== "" && t.toLowerCase() !== "object";
  if (Array.isArray(t)) {
    for (const item of t) if (typeof item === "string" && item.toLowerCase() === "object") return false;
    return t.length > 0;
  }
  return false;
}

function isArrayDeclaredType(t: unknown): boolean {
  if (typeof t === "string") return t.toLowerCase() === "array";
  if (Array.isArray(t)) {
    for (const item of t) if (typeof item === "string" && item.toLowerCase() === "array") return true;
  }
  return false;
}

function isAPIRequestDocument(m: Record<string, unknown>): boolean {
  if (isArr(m.tools) || isArr(m.contents) || isArr(m.messages) || isArr(m.functionDeclarations) || isArr(m.function_declarations)) return true;
  if (isObj(m.request) && isAPIRequestDocument(m.request)) return true;
  return false;
}

function repairSchemaNode(node: Record<string, unknown>): { node: Record<string, unknown>; modified: boolean } {
  let modified = false;
  const clone: Record<string, unknown> = { ...node };

  // 1. Collect bare property definition maps.
  if (!isNonObjectDeclaredType(clone.type)) {
    const bareProps: Record<string, unknown> = {};
    let hasBare = false;
    for (const k of Object.keys(clone)) {
      const v = clone[k];
      if (isObj(v) && !isKnownSchemaKeywordOrExtension(k)) {
        bareProps[k] = v;
        hasBare = true;
      }
    }
    if (hasBare) {
      const { props: repairedProps, promoted } = repairPropertyMap(bareProps);
      for (const k of Object.keys(bareProps)) delete clone[k];
      if (isObj(clone.properties)) {
        clone.properties = { ...clone.properties, ...repairedProps };
      } else {
        clone.properties = repairedProps;
        if (!("type" in clone)) clone.type = "object";
      }
      if (promoted.length > 0) clone.required = mergeStringSlices(extractStringArray(clone.required), promoted);
      modified = true;
    }
  }

  // 2. Repair declared properties.
  if (isObj(clone.properties)) {
    const { props, promoted, modified: propsMod } = repairPropertyMap(clone.properties);
    if (propsMod) {
      clone.properties = props;
      modified = true;
    }
    if (promoted.length > 0) {
      clone.required = mergeStringSlices(extractStringArray(clone.required), promoted);
      modified = true;
    }
  }

  // 3. Recurse into other standard schema containers.
  if (isObj(clone.items)) {
    const r = repairSchemaNode(clone.items);
    if (r.modified) {
      clone.items = r.node;
      modified = true;
    }
  } else if (isArr(clone.items)) {
    const r = repairSchemaList(clone.items);
    if (r.modified) {
      clone.items = r.list;
      modified = true;
    }
  } else if (clone.items === true) {
    clone.items = {};
    modified = true;
  }

  if (isObj(clone.additionalProperties)) {
    const r = repairSchemaNode(clone.additionalProperties);
    if (r.modified) {
      clone.additionalProperties = r.node;
      modified = true;
    }
  }

  if (isObj(clone.patternProperties)) {
    const r = repairPropertyMap(clone.patternProperties);
    if (r.modified) {
      clone.patternProperties = r.props;
      modified = true;
    }
  }

  for (const key of ["if", "then", "else", "not", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "contentSchema", "additionalItems"]) {
    const sub = clone[key];
    if (isObj(sub)) {
      const r = repairSchemaNode(sub);
      if (r.modified) {
        clone[key] = r.node;
        modified = true;
      }
    } else if (sub === true) {
      clone[key] = {};
      modified = true;
    }
  }

  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = clone[key];
    if (isArr(list)) {
      const r = repairSchemaList(list);
      if (r.modified) {
        clone[key] = r.list;
        modified = true;
      }
    }
  }

  for (const key of ["$defs", "definitions", "dependentSchemas", "dependencies"]) {
    const defs = clone[key];
    if (isObj(defs)) {
      const repairedDefs: Record<string, unknown> = {};
      let defsModified = false;
      for (const dk of Object.keys(defs)) {
        const dv = defs[dk];
        if (isObj(dv)) {
          const r = repairSchemaNode(dv);
          repairedDefs[dk] = r.node;
          if (r.modified) {
            defsModified = true;
            modified = true;
          }
        } else if (dv === true) {
          repairedDefs[dk] = {};
          defsModified = true;
          modified = true;
        } else {
          repairedDefs[dk] = dv;
        }
      }
      if (defsModified) clone[key] = repairedDefs;
    }
  }

  return { node: clone, modified };
}

function repairSchemaList(list: unknown[]): { list: unknown[]; modified: boolean } {
  const out: unknown[] = [];
  let modified = false;
  for (const item of list) {
    if (isObj(item)) {
      const r = repairSchemaNode(item);
      out.push(r.node);
      if (r.modified) modified = true;
    } else if (item === true) {
      out.push({});
      modified = true;
    } else {
      out.push(item);
    }
  }
  return { list: out, modified };
}

function repairPropertyMap(props: Record<string, unknown>): { props: Record<string, unknown>; promoted: string[]; modified: boolean } {
  const out: Record<string, unknown> = {};
  const promoted: string[] = [];
  let modified = false;
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v === true) {
      out[k] = {};
      modified = true;
      continue;
    }
    if (!isObj(v)) {
      out[k] = v;
      continue;
    }
    const childClone: Record<string, unknown> = { ...v };
    if (typeof childClone.required === "boolean") {
      const reqBool = childClone.required;
      delete childClone.required;
      modified = true;
      if (reqBool) promoted.push(k);
    }
    const r = repairSchemaNode(childClone);
    if (r.modified) modified = true;
    out[k] = r.node;
  }
  promoted.sort();
  return { props: out, promoted, modified };
}

function extractStringArray(val: unknown): string[] {
  if (!isArr(val)) return [];
  return val.filter((s): s is string => typeof s === "string");
}

function mergeStringSlices(existing: string[], promoted: string[]): string[] {
  const seen = new Set<string>();
  const res: string[] = [];
  for (const s of [...existing, ...promoted]) {
    if (!seen.has(s) && s !== "") {
      seen.add(s);
      res.push(s);
    }
  }
  return res;
}

// ---- Local $ref inlining ----

/**
 * Resolves JSON Pointer references against the original schema. Every reference
 * receives its own copy as long as the expansion budget lasts, conflicting sibling
 * assertions remain conjunctive, and cycles terminate as a typed hint.
 */
export function inlineLocalRefs(jsonStr: string): string {
  const parsed = parseLoose(jsonStr);
  if (!parsed.ok) return jsonStr;
  if (!containsRefKey(parsed.value)) return jsonStr;
  return JSON.stringify(inlineLocalRefsRooted(parsed.value, false));
}

const maxInlinedSchemaBytes = 256 * 1024;
const maxFallbackDescriptionBytes = 512;

function containsRefKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRefKey);
  if (isObj(value)) {
    if ("$ref" in value) return true;
    for (const key of Object.keys(value)) if (containsRefKey(value[key])) return true;
  }
  return false;
}

/** Exposed for tests: cleaning-mode inlining that resolves against the inner {"schema": ...} carrier. */
export function inlineLocalRefsForCleanString(jsonStr: string): string {
  const parsed = parseLoose(jsonStr);
  if (!parsed.ok) return jsonStr;
  return JSON.stringify(inlineLocalRefsForClean(parsed.value));
}

function inlineLocalRefsForClean(root: unknown): unknown {
  if (!containsRefKey(root)) return root;
  if (isObj(root) && Object.keys(root).length === 1 && isObj(root.schema)) {
    const state = newRefResolveState();
    return { schema: resolveSchemaRoot(root.schema, state, true) };
  }
  return inlineLocalRefsRooted(root, true);
}

function inlineLocalRefsRooted(root: unknown, forClean: boolean): unknown {
  const state = newRefResolveState();
  return resolveSchemaRoot(root, state, forClean);
}

interface RefResolveState {
  budget: number;
}

function newRefResolveState(): RefResolveState {
  return { budget: maxInlinedSchemaBytes };
}

function sortedKeys(m: Record<string, unknown>): string[] {
  return Object.keys(m).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function resolveSchemaRoot(root: unknown, state: RefResolveState, forClean: boolean): unknown {
  if (!isObj(root)) return resolveLocalRefs(root, root, new Set(), state, false, forClean);
  const rootMap = root;
  let out: Record<string, unknown> = {};
  for (const key of sortedKeys(rootMap)) {
    const item = rootMap[key];
    switch (key) {
      case "$defs":
      case "definitions":
        if (!forClean) out[key] = null; // placeholder, resolved after the schema body
        break;
      case "$ref":
        out[key] = item;
        break;
      default:
        out[key] = resolveSchemaEntry(rootMap, key, item, new Set(), state, forClean);
    }
  }

  const ref = rootMap.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    const target = resolveJSONPointer(rootMap, ref);
    if (target.ok) {
      const size = targetExpansionSize(target.value, forClean);
      if (size <= state.budget) {
        state.budget -= size;
        const active = new Set<string>([ref]);
        const resolved = resolveLocalRefs(rootMap, target.value, active, state, false, forClean);
        if (isObj(resolved)) {
          delete out.$ref;
          delete out.$defs;
          delete out.definitions;
          delete out.$schema;
          out = mergeInlinedRefSchemas(resolved, out);
          if ("$schema" in rootMap) out.$schema = rootMap.$schema;
        } else {
          out = resolveRefFallback(rootMap, out, target.value, ref, new Set(), state, forClean);
        }
      } else {
        out = resolveRefFallback(rootMap, out, target.value, ref, new Set(), state, forClean);
      }
      delete out.$ref;
    }
  }

  if (!forClean) {
    for (const key of ["$defs", "definitions"]) {
      if (key in rootMap) out[key] = resolveSchemaEntry(rootMap, key, rootMap[key], new Set(), state, false);
    }
  }
  return out;
}

function targetExpansionSize(value: unknown, forClean: boolean): number {
  if (!forClean) return jsonValueSize(value);
  return cleanExpansionSize(value, false);
}

function cleanExpansionSize(value: unknown, inNameMap: boolean): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return 5;
  if (typeof value === "number") return gstr(value).length;
  if (typeof value === "string") return jsonStringEncodedSize(value);
  if (Array.isArray(value)) {
    let size = 2;
    for (const item of value) {
      size += cleanExpansionSize(item, false) + 1;
      if (size > maxInlinedSchemaBytes + 1) return maxInlinedSchemaBytes + 1;
    }
    return size;
  }
  if (isObj(value)) {
    let size = 2;
    for (const key of Object.keys(value)) {
      if (!inNameMap && (key === "$defs" || key === "definitions")) continue;
      const child = value[key];
      let childInNameMap = false;
      if (!inNameMap) {
        if (isLiteralValueKeyword(key)) {
          size += jsonStringEncodedSize(key) + 1 + jsonValueSize(child) + 1;
          if (size > maxInlinedSchemaBytes + 1) return maxInlinedSchemaBytes + 1;
          continue;
        }
        if (schemaNameMapKeywords.has(key)) childInNameMap = true;
      }
      size += jsonStringEncodedSize(key) + 1 + cleanExpansionSize(child, childInNameMap) + 1;
      if (size > maxInlinedSchemaBytes + 1) return maxInlinedSchemaBytes + 1;
    }
    return size;
  }
  return 16;
}

function jsonValueSize(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "boolean") return 5;
  if (typeof value === "number") return gstr(value).length;
  if (typeof value === "string") return jsonStringEncodedSize(value);
  if (Array.isArray(value)) {
    let size = 2;
    for (const item of value) size += jsonValueSize(item) + 1;
    return size;
  }
  if (isObj(value)) {
    let size = 2;
    for (const key of Object.keys(value)) size += jsonStringEncodedSize(key) + 1 + jsonValueSize(value[key]) + 1;
    return size;
  }
  return 16;
}

/** Encoded length of one JSON string including quotes, mirroring encoding/json's HTML escaping. */
function jsonStringEncodedSize(s: string): number {
  let size = 2;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20) size += c === 10 || c === 13 || c === 9 ? 2 : 6;
    else if (c === 0x22 || c === 0x5c) size += 2;
    else if (c === 0x3c || c === 0x3e || c === 0x26) size += 6;
    else if (c < 0x80) size += 1;
    else if (c === 0x2028 || c === 0x2029) size += 6;
    else if (c < 0x800) size += 2;
    else if (c < 0x10000) size += 3;
    else size += 4;
  }
  return size;
}

const literalValueKeywords = new Set(["default", "example", "examples", "const", "enum"]);

function isLiteralValueKeyword(key: string): boolean {
  return literalValueKeywords.has(key);
}

function resolveLocalRefs(root: unknown, value: unknown, active: Set<string>, state: RefResolveState, inNameMap: boolean, forClean: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveLocalRefs(root, item, active, state, false, forClean));
  if (!isObj(value)) return value;
  const node = value;
  if (!inNameMap) {
    const ref = node.$ref;
    if (typeof ref === "string" && ref.startsWith("#/")) {
      const target = resolveJSONPointer(root, ref);
      if (target.ok) {
        if (active.has(ref)) return resolveRefFallback(root, node, target.value, ref, active, state, forClean);
        const size = targetExpansionSize(target.value, forClean);
        if (size > state.budget) return resolveRefFallback(root, node, target.value, ref, active, state, forClean);
        state.budget -= size;
        active.add(ref);
        const resolvedTarget = resolveLocalRefs(root, target.value, active, state, false, forClean);
        active.delete(ref);
        if (isObj(resolvedTarget)) {
          const siblings: Record<string, unknown> = {};
          for (const key of sortedKeys(node)) {
            if (key === "$ref") continue;
            if (forClean && (key === "$defs" || key === "definitions")) continue;
            siblings[key] = resolveSchemaEntry(root, key, node[key], active, state, forClean);
          }
          return mergeInlinedRefSchemas(resolvedTarget, siblings);
        }
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys(node)) {
    if (forClean && !inNameMap && (key === "$defs" || key === "definitions")) continue;
    out[key] = resolveSchemaEntry(root, key, node[key], active, state, forClean);
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function nonNil(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function mergeInlinedRefSchemas(target: Record<string, unknown>, siblings: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(siblings).length > 0 && (nonNil(target.unevaluatedProperties) || nonNil(target.unevaluatedItems))) {
    return conjoinInlinedRefSchemas(target, siblings);
  }
  const pairs: [string, string][] = [
    ["additionalProperties", "properties"],
    ["additionalProperties", "patternProperties"],
    ["additionalProperties", "additionalProperties"],
    ["items", "prefixItems"],
    ["contains", "contains"],
    ["contains", "minContains"],
    ["contains", "maxContains"],
  ];
  for (const [a, b] of pairs) {
    if ((nonNil(target[a]) && nonNil(siblings[b])) || (nonNil(siblings[a]) && nonNil(target[b]))) {
      return conjoinInlinedRefSchemas(target, siblings);
    }
  }
  const out: Record<string, unknown> = { ...target };
  for (const key of Object.keys(siblings)) {
    const value = siblings[key];
    switch (key) {
      case "title":
      case "description":
      case "default":
      case "example":
      case "examples":
      case "$comment":
      case "deprecated":
      case "readOnly":
      case "writeOnly":
        break;
      default:
        if (key in target && !deepEqual(target[key], value)) return conjoinInlinedRefSchemas(target, siblings);
    }
    out[key] = value;
  }
  return out;
}

function conjoinInlinedRefSchemas(target: Record<string, unknown>, siblings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...siblings };
  const branches: unknown[] = [target];
  if (isArr(siblings.allOf)) branches.push(...siblings.allOf);
  out.allOf = branches;
  return out;
}

function resolveRefFallback(
  root: unknown,
  node: Record<string, unknown>,
  target: unknown,
  ref: string,
  active: Set<string>,
  state: RefResolveState,
  forClean: boolean,
): Record<string, unknown> {
  const out = cyclicRefFallback(node, target, ref);
  if (isObj(target)) {
    const description = target.description;
    if (typeof description === "string" && description !== "" && description.length <= maxFallbackDescriptionBytes) {
      if (!("description" in node)) {
        const cost = jsonStringEncodedSize(description);
        if (cost > state.budget) out.description = "See: " + refName(ref);
        else state.budget -= cost;
      }
    }
  }
  for (const key of sortedKeys(node)) {
    if (key === "$ref" || key === "description") continue;
    if (forClean && (key === "$defs" || key === "definitions")) {
      delete out[key];
      continue;
    }
    out[key] = resolveSchemaEntry(root, key, node[key], active, state, forClean);
  }
  return out;
}

function resolveSchemaEntry(root: unknown, key: string, item: unknown, active: Set<string>, state: RefResolveState, forClean: boolean): unknown {
  if (isLiteralValueKeyword(key)) return deepCopy(item);
  if (schemaNameMapKeywords.has(key) && isObj(item)) {
    const out: Record<string, unknown> = {};
    for (const name of sortedKeys(item)) out[name] = resolveLocalRefs(root, item[name], active, state, false, forClean);
    return out;
  }
  return resolveLocalRefs(root, item, active, state, false, forClean);
}

function resolveJSONPointer(root: unknown, ref: string): { ok: boolean; value: unknown } {
  let current = root;
  const pointer = ref.startsWith("#/") ? ref.slice(2) : ref;
  for (const rawPart of pointer.split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (isObj(current)) {
      if (!(part in current)) return { ok: false, value: undefined };
      current = current[part];
    } else if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return { ok: false, value: undefined };
      const index = Number(part);
      if (index < 0 || index >= current.length) return { ok: false, value: undefined };
      current = current[index];
    } else {
      return { ok: false, value: undefined };
    }
  }
  return { ok: true, value: current };
}

function cyclicRefFallback(node: Record<string, unknown>, target: unknown, ref: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isObj(target)) {
    for (const key of ["type", "nullable", "description"]) {
      if (key in target) {
        const value = target[key];
        if (key === "description" && typeof value === "string" && value.length > maxFallbackDescriptionBytes) continue;
        out[key] = value;
      }
    }
  }
  for (const key of Object.keys(node)) if (key !== "$ref") out[key] = node[key];
  const hint = "See: " + refName(ref);
  const description = out.description;
  if (typeof description === "string" && description !== "") out.description = mergeHint(description, hint);
  else out.description = hint;
  return out;
}

function refName(ref: string): string {
  const index = ref.lastIndexOf("/");
  if (index >= 0 && index + 1 < ref.length) return ref.slice(index + 1).replace(/~1/g, "/").replace(/~0/g, "~");
  return ref;
}

// ---- Phase 1 helpers ----

function convertRefsToHints(root: unknown, preserveSiblings: boolean): unknown {
  const paths = findPaths(root, "$ref");
  sortByDepth(paths);
  for (const p of paths) {
    const parentPath = trimSuffix(p, ".$ref");
    if (isPropertyDefinition(parentPath)) continue;
    const refVal = gstr(getAt(root, p));
    let hint = "See: " + refName(refVal);
    if (!preserveSiblings) {
      const existing = gstr(getAt(root, descriptionPath(parentPath)));
      if (existing !== "") hint = `${existing} (${hint})`;
      root = setRawAt(root, parentPath, { type: "object", description: hint });
      continue;
    }
    deleteAt(root, p);
    root = appendHint(root, parentPath, hint);
  }
  return root;
}

function convertConstToEnum(root: unknown): unknown {
  for (const p of findPaths(root, "const")) {
    const val = getAt(root, p);
    if (!exists(val)) continue;
    const enumPath = trimSuffix(p, ".const") + ".enum";
    if (!exists(getAt(root, enumPath))) root = setAt(root, enumPath, [deepCopy(val)]);
  }
  return root;
}

function convertEnumValuesToStrings(root: unknown, forceStringType: boolean): unknown {
  for (const p of findPaths(root, "enum")) {
    const arr = getAt(root, p);
    if (!isArr(arr)) continue;
    root = setAt(root, p, arr.map((item) => gstr(item)));
    if (forceStringType) root = setAt(root, joinPath(trimSuffix(p, ".enum"), "type"), "string");
  }
  return root;
}

function addEnumHints(root: unknown): unknown {
  for (const p of findPaths(root, "enum")) {
    const arr = getAt(root, p);
    if (!isArr(arr)) continue;
    if (arr.length <= 1 || arr.length > 10) continue;
    root = appendHint(root, trimSuffix(p, ".enum"), "Allowed: " + arr.map((item) => gstr(item)).join(", "));
  }
  return root;
}

function dropIgnoredEnumsToHints(root: unknown, options: JSONSchemaCleanOptions): unknown {
  for (const path of findPaths(root, "enum")) {
    const parentPath = trimSuffix(path, ".enum");
    const shouldDrop = !!options.dropAllEnums || (!!options.dropBooleanEnums && gstr(getAt(root, joinPath(parentPath, "type"))) === "boolean");
    if (!shouldDrop) continue;
    const enumVal = getAt(root, path);
    if (isArr(enumVal) && enumVal.length === 1) root = appendHint(root, parentPath, "Allowed: " + gstr(enumVal[0]));
    deleteAt(root, path);
  }
  return root;
}

function addAdditionalPropertiesHints(root: unknown): unknown {
  for (const p of findPaths(root, "additionalProperties")) {
    if (getAt(root, p) === false) root = appendHint(root, trimSuffix(p, ".additionalProperties"), "No extra properties allowed");
  }
  return root;
}

const unsupportedConstraints = [
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "format",
  "default",
  "examples",
];

function constraintKeywords(options: JSONSchemaCleanOptions): string[] {
  if (options.preserveStandardConstraints) return [];
  const keywords = [...unsupportedConstraints];
  if (options.antigravitySemantics) keywords.push("minimum", "maximum", "multipleOf");
  return keywords;
}

function moveConstraintsToDescription(root: unknown, options: JSONSchemaCleanOptions): unknown {
  const constraints = constraintKeywords(options);
  if (constraints.length === 0) return root;
  const pathsByField = findPathsByFields(root, constraints);
  for (const key of constraints) {
    for (const p of pathsByField.get(key) ?? []) {
      const val = getAt(root, p);
      if (!exists(val)) continue;
      const parentPath = trimSuffix(p, "." + key);
      if (isPropertyDefinition(parentPath)) continue;
      root = appendHint(root, parentPath, `${key}: ${gstr(val)}`);
    }
  }
  return root;
}

function moveNotToDescription(root: unknown): unknown {
  for (const path of findPaths(root, "not")) {
    const value = getAt(root, path);
    if (!exists(value) || isPropertyDefinition(trimSuffix(path, ".not"))) continue;
    root = appendHint(root, trimSuffix(path, ".not"), "not: " + graw(value));
  }
  return root;
}

// ---- Phase 2 ----

function mergeConditionals(root: unknown): unknown {
  const pathsByField = findPathsByFields(root, ["then", "else"]);
  const paths: string[] = [];
  for (const key of ["then", "else"]) {
    for (const p of pathsByField.get(key) ?? []) {
      if (isPropertyDefinition(trimSuffix(p, "." + key))) continue;
      paths.push(p);
    }
  }
  sortByDepth(paths);
  for (const p of paths) {
    const props = getAt(root, joinPath(p, "properties"));
    if (!isObj(props)) continue;
    let parentPath: string;
    if (p.endsWith(".then")) parentPath = trimSuffix(p, ".then");
    else if (p.endsWith(".else")) parentPath = trimSuffix(p, ".else");
    else if (p === "then" || p === "else") parentPath = "";
    else continue;
    for (const key of Object.keys(props)) {
      const destPath = joinPath(parentPath, "properties." + escapeGJSONPathKey(key));
      if (!exists(getAt(root, destPath))) root = setAt(root, destPath, deepCopy(props[key]));
    }
  }
  return root;
}

function mergeAllOf(root: unknown): unknown {
  const paths = findPaths(root, "allOf");
  sortByDepth(paths);
  for (const p of paths) {
    const allOf = getAt(root, p);
    if (!isArr(allOf)) continue;
    const parentPath = trimSuffix(p, ".allOf");
    for (const item of [...allOf]) {
      if (!isObj(item)) continue;
      for (const field of Object.keys(item)) {
        const value = item[field];
        switch (field) {
          case "required": {
            if (!isArr(value)) break;
            const reqPath = joinPath(parentPath, "required");
            const current = getStrings(root, reqPath);
            for (const required of value) {
              const name = gstr(required);
              if (!current.includes(name)) current.push(name);
            }
            root = setAt(root, reqPath, current);
            break;
          }
          case "if":
          case "then":
          case "else":
          case "allOf":
            break; // conditional applicability cannot be represented upstream
          default:
            root = mergeMissingSchemaAtPath(root, joinPath(parentPath, escapeGJSONPathKey(field)), value);
        }
      }
    }
    deleteAt(root, p);
  }
  return root;
}

function mergeMissingSchemaAtPath(root: unknown, destination: string, incoming: unknown): unknown {
  const existing = getAt(root, destination);
  if (!exists(existing)) return setAt(root, destination, deepCopy(incoming));
  if (!isObj(existing) || !isObj(incoming)) return root;
  for (const key of Object.keys(incoming)) {
    root = mergeMissingSchemaAtPath(root, joinPath(destination, escapeGJSONPathKey(key)), incoming[key]);
  }
  return root;
}

function isRequiredOnlyUnionBranch(item: unknown): boolean {
  if (!isObj(item) || !("required" in item)) return false;
  for (const key of ["type", "properties", "items", "enum", "anyOf", "oneOf", "allOf"]) if (key in item) return false;
  return true;
}

function materializeRequiredOnlyBranch(item: Record<string, unknown>, parentProps: unknown): Record<string, unknown> | undefined {
  if (!isObj(parentProps)) return undefined;
  const reqs = garray(item.required).map((r) => gstr(r));
  if (reqs.length === 0) return undefined;
  const out: Record<string, unknown> = deepCopy(item);
  const props: Record<string, unknown> = isObj(out.properties) ? out.properties : {};
  for (const reqName of reqs) {
    if (!(reqName in parentProps)) return undefined;
    props[reqName] = deepCopy(parentProps[reqName]);
  }
  out.properties = props;
  out.type = "object";
  return out;
}

function isNullOnlyBranch(item: Record<string, unknown>): boolean {
  if ("properties" in item || "items" in item) return false;
  const t = item.type;
  if (typeof t === "string") return t === "null";
  if (isArr(t) && t.length > 0) return t.every((elem) => gstr(elem) === "null");
  return false;
}

function partitionUnionBranches(items: unknown[], parentProps: unknown): { nonNullItems: unknown[]; hasNull: boolean; hasFilteredBranch: boolean } {
  const nonNullItems: unknown[] = [];
  let hasNull = false;
  let hasFilteredBranch = false;
  for (const item of items) {
    if (item === true) {
      nonNullItems.push({});
      hasFilteredBranch = true;
      continue;
    }
    if (!isObj(item)) {
      hasFilteredBranch = true;
      continue;
    }
    if (isNullOnlyBranch(item)) {
      hasNull = true;
      continue;
    }
    if (isRequiredOnlyUnionBranch(item)) {
      const materialized = materializeRequiredOnlyBranch(item, parentProps);
      if (materialized) nonNullItems.push(materialized);
      hasFilteredBranch = true;
      continue;
    }
    nonNullItems.push(item);
  }
  return { nonNullItems, hasNull, hasFilteredBranch };
}

function flattenAnyOfOneOf(root: unknown, preserveOneOf: boolean, flattenMultiBranch: boolean): unknown {
  const pathsByField = findPathsByFields(root, ["oneOf", "anyOf"]);
  const paths: string[] = [];
  for (const key of ["oneOf", "anyOf"]) paths.push(...(pathsByField.get(key) ?? []));
  sortByDepth(paths);

  for (const p of paths) {
    const key = p === "oneOf" || p.endsWith(".oneOf") ? "oneOf" : "anyOf";
    const arr = getAt(root, p);
    if (!isArr(arr) || arr.length === 0) continue;
    const parentPath = trimSuffix(p, "." + key);
    if (isPropertyDefinition(parentPath)) continue;
    const parent = getAt(root, parentPath);

    if (key === "oneOf" && !flattenMultiBranch && !preserveOneOf && isArr(getAt(parent, "anyOf"))) {
      root = appendHint(root, parentPath, "oneOf: " + graw(arr));
      deleteAt(root, p);
      continue;
    }

    const items = [...arr];
    const parentProps = getAt(parent, "properties");
    const { nonNullItems, hasNull, hasFilteredBranch } = partitionUnionBranches(items, parentProps);
    const nullable = hasNull || gbool(getAt(parent, "nullable"));

    if (nonNullItems.length >= 2 && !flattenMultiBranch) {
      let targetKey = key;
      if (key === "oneOf" && !preserveOneOf) targetKey = "anyOf";
      const targetPath = joinPath(parentPath, targetKey);
      if (targetKey !== key || hasNull || hasFilteredBranch) {
        root = setAt(root, targetPath, nonNullItems.map((item) => deepCopy(item)));
        if (targetKey !== key) deleteAt(root, p);
      }
      if (hasNull) {
        root = setAt(root, joinPath(parentPath, "nullable"), true);
        root = appendHint(root, parentPath, "(nullable)");
      }
      continue;
    }

    if (isObj(parentProps)) {
      for (const item of nonNullItems) {
        const branchProps = getAt(item, "properties");
        if (isObj(branchProps)) {
          for (const propKey of Object.keys(branchProps)) {
            root = mergeMissingSchemaAtPath(root, joinPath(parentPath, "properties." + escapeGJSONPathKey(propKey)), branchProps[propKey]);
          }
        }
      }
      if (nullable) root = setAt(root, joinPath(parentPath, "nullable"), true);
      if (gstr(getAt(parent, "type")) === "") root = setAt(root, joinPath(parentPath, "type"), "object");
      deleteAt(root, p);
      continue;
    }

    if (nonNullItems.length === 0) {
      if (!hasNull) {
        deleteAt(root, p);
        continue;
      }
      let selected: Record<string, unknown> = { type: "null" };
      const parentDesc = gstr(getAt(root, descriptionPath(parentPath)));
      if (parentDesc !== "") selected = mergeDescriptionRaw(selected, parentDesc);
      root = setRawAt(root, parentPath, selected);
      continue;
    }

    let candidateItems = items;
    if (hasFilteredBranch || nonNullItems.length >= 2) {
      candidateItems = nonNullItems;
      if (hasNull) candidateItems = [...nonNullItems, { type: "null" }];
    }

    const parentDesc = gstr(getAt(root, descriptionPath(parentPath)));
    const { types: allTypes } = selectBest(candidateItems);
    let selectedIdx = 0;
    const best = selectBest(nonNullItems);
    if (best.bestIdx >= 0 && best.bestIdx < nonNullItems.length) selectedIdx = best.bestIdx;
    let selected: Record<string, unknown> = isObj(nonNullItems[selectedIdx]) ? deepCopy(nonNullItems[selectedIdx] as Record<string, unknown>) : {};
    if (nullable) selected.nullable = true;
    if (parentDesc !== "") selected = mergeDescriptionRaw(selected, parentDesc);
    if (allTypes.length > 1) selected = appendHintRaw(selected, "Accepts: " + allTypes.join(" | "));
    else if (nullable) selected = appendHintRaw(selected, "(nullable)");
    root = setRawAt(root, parentPath, selected);
  }
  return root;
}

function selectBest(items: unknown[]): { bestIdx: number; types: string[] } {
  let bestScore = -1;
  let bestIdx = 0;
  const types: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let t = gstr(getAt(item, "type"));
    let score = 0;
    if (t === "object" || exists(getAt(item, "properties"))) {
      score = 3;
      t = orDefault(t, "object");
    } else if (t === "array" || exists(getAt(item, "items"))) {
      score = 2;
      t = orDefault(t, "array");
    } else if (t !== "" && t !== "null") {
      score = 1;
    } else if (t === "null") {
      score = 0;
      t = "null";
    } else {
      score = 0;
      t = "";
    }
    if (t !== "") types.push(t);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return { bestIdx, types };
}

function flattenTypeArrays(root: unknown, preserveNativeNullable: boolean): unknown {
  const paths = findPaths(root, "type");
  sortByDepth(paths);
  const nullableFields = new Map<string, string[]>();
  const nullableOrder: string[] = [];

  for (const p of paths) {
    const res = getAt(root, p);
    if (!isArr(res) || res.length === 0) continue;
    let hasNull = false;
    const nonNullTypes: string[] = [];
    for (const item of res) {
      const s = gstr(item);
      if (s === "null") hasNull = true;
      else if (s !== "") nonNullTypes.push(s);
    }
    const parentPath = trimSuffix(p, ".type");
    let firstType = "string";
    if (nonNullTypes.length > 0) {
      if (exists(getAt(root, joinPath(parentPath, "items"))) && nonNullTypes.includes("array")) firstType = "array";
      else if (exists(getAt(root, joinPath(parentPath, "properties"))) && nonNullTypes.includes("object")) firstType = "object";
      else firstType = nonNullTypes[0]!;
    }
    root = setAt(root, p, firstType);
    if (firstType !== "array" && exists(getAt(root, joinPath(parentPath, "items")))) deleteAt(root, joinPath(parentPath, "items"));
    if (nonNullTypes.length > 1) root = appendHint(root, parentPath, "Accepts: " + nonNullTypes.join(" | "));

    if (hasNull) {
      if (preserveNativeNullable) {
        root = setAt(root, joinPath(parentPath, "nullable"), true);
        root = appendHint(root, parentPath, "(nullable)");
        continue;
      }
      const parts = splitGJSONPath(p);
      if (parts.length >= 3 && parts[parts.length - 3] === "properties") {
        const fieldNameEscaped = parts[parts.length - 2]!;
        const fieldName = unescapeGJSONPathKey(fieldNameEscaped);
        const objectPath = parts.slice(0, parts.length - 3).join(".");
        if (!nullableFields.has(objectPath)) {
          nullableFields.set(objectPath, []);
          nullableOrder.push(objectPath);
        }
        nullableFields.get(objectPath)!.push(fieldName);
        root = appendHint(root, joinPath(objectPath, "properties." + fieldNameEscaped), "(nullable)");
      }
    }
  }

  for (const objectPath of nullableOrder) {
    const fields = nullableFields.get(objectPath)!;
    const reqPath = joinPath(objectPath, "required");
    const req = getAt(root, reqPath);
    if (!isArr(req)) continue;
    const filtered = req.map((r) => gstr(r)).filter((r) => !fields.includes(r));
    if (filtered.length === 0) deleteAt(root, reqPath);
    else root = setAt(root, reqPath, filtered);
  }
  return root;
}

// ---- Phase 3 ----

function removeUnsupportedKeywords(root: unknown, options: JSONSchemaCleanOptions): unknown {
  const keywords = [
    ...constraintKeywords(options),
    "$schema",
    "$defs",
    "definitions",
    "const",
    "$ref",
    "$id",
    "id",
    "additionalProperties",
    "$anchor",
    "$vocabulary",
    "$dynamicRef",
    "$dynamicAnchor",
    "propertyNames",
    "patternProperties",
    "dependentRequired",
    "dependentSchemas",
    "dependencies",
    "if",
    "then",
    "else",
    "$comment",
    "enumDescriptions",
    "enumTitles",
    "prefill",
    "deprecated",
    "encrypted",
    "discriminator",
    "readOnly",
    "writeOnly",
    "additionalItems",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
    "contentMediaType",
    "contentEncoding",
  ];
  if (options.antigravitySemantics) keywords.push("not");

  const deletePaths: string[] = [];
  const pathsByField = findPathsByFields(root, keywords);
  for (const key of keywords) {
    for (const p of pathsByField.get(key) ?? []) {
      if (isPropertyDefinition(trimSuffix(p, "." + key))) continue;
      if (key === "additionalProperties") {
        if (options.preserveAllAdditionalProperties) continue;
        if (options.preserveAdditionalPropertiesFalse && getAt(root, p) === false) continue;
      }
      deletePaths.push(p);
    }
  }
  sortByDepth(deletePaths);
  for (const p of deletePaths) deleteAt(root, p);
  return removeExtensionFields(root);
}

/** Removes all x-* extension fields (OpenAPI extensions Google APIs reject). Exposed for tests. */
export function removeExtensionFieldsString(jsonStr: string): string {
  const parsed = parseLoose(jsonStr);
  if (!parsed.ok) return jsonStr;
  return JSON.stringify(removeExtensionFields(parsed.value));
}

function removeExtensionFields(root: unknown): unknown {
  const paths: string[] = [];
  walkForExtensions(root, "", paths);
  for (const p of paths) deleteAt(root, p);
  return root;
}

function walkForExtensions(value: unknown, path: string, paths: string[]): void {
  if (isArr(value)) {
    for (let i = value.length - 1; i >= 0; i--) walkForExtensions(value[i], joinPath(path, String(i)), paths);
    return;
  }
  if (isObj(value)) {
    for (const keyStr of Object.keys(value)) {
      const childPath = joinPath(path, escapeGJSONPathKey(keyStr));
      if (keyStr.startsWith("x-") && !isPropertyDefinition(path)) {
        paths.push(childPath);
        continue;
      }
      if (isLiteralValueKeyword(keyStr) && !isPropertyDefinition(path)) continue;
      walkForExtensions(value[keyStr], childPath, paths);
    }
  }
}

function hasSchemaConjunction(root: unknown): boolean {
  for (const path of findPaths(root, "allOf")) if (isArr(getAt(root, path))) return true;
  return false;
}

function cleanupRequiredFields(root: unknown): unknown {
  for (const p of findPaths(root, "required")) {
    const parentPath = trimSuffix(p, ".required");
    const req = getAt(root, p);
    const props = getAt(root, joinPath(parentPath, "properties"));
    if (!isArr(req)) continue;
    if (!isObj(props)) {
      deleteAt(root, p);
      continue;
    }
    const valid = req.map((r) => gstr(r)).filter((key) => key in props);
    if (valid.length !== req.length) {
      if (valid.length === 0) deleteAt(root, p);
      else root = setAt(root, p, valid);
    }
  }
  return root;
}

function addEmptySchemaPlaceholder(root: unknown): unknown {
  const paths = findPaths(root, "type");
  sortByDepth(paths);
  for (const p of paths) {
    if (gstr(getAt(root, p)) !== "object") continue;
    const parentPath = trimSuffix(p, ".type");
    const propsPath = joinPath(parentPath, "properties");
    const propsVal = getAt(root, propsPath);
    const reqPath = joinPath(parentPath, "required");
    const reqVal = getAt(root, reqPath);
    const hasRequiredProperties = isArr(reqVal) && reqVal.length > 0;
    if (isArr(getAt(root, joinPath(parentPath, "anyOf"))) || isArr(getAt(root, joinPath(parentPath, "oneOf")))) continue;

    const needsPlaceholder = !exists(propsVal) || (isObj(propsVal) && Object.keys(propsVal).length === 0);
    if (needsPlaceholder) {
      const reasonPath = joinPath(propsPath, "reason");
      root = setAt(root, reasonPath + ".type", "string");
      root = setAt(root, reasonPath + ".description", placeholderReasonDescription);
      root = setAt(root, reqPath, ["reason"]);
      continue;
    }
    if (isObj(propsVal) && !hasRequiredProperties) {
      if (parentPath === "") continue;
      const placeholderPath = joinPath(propsPath, "_");
      if (!exists(getAt(root, placeholderPath))) root = setAt(root, placeholderPath + ".type", "boolean");
      root = setAt(root, reqPath, ["_"]);
    }
  }
  return root;
}

// ---- Helpers ----

function findPaths(root: unknown, field: string): string[] {
  const paths: string[] = [];
  walkSchema(root, "", field, paths);
  return paths;
}

/** Records every path at which `field` appears, schema-aware (literal keyword values are not entered). Exposed for tests. */
export function walkSchema(value: unknown, path: string, field: string, paths: string[]): void {
  walk(value, path, field, paths, true);
}

/** Records every path at which `field` appears, descending into everything. */
export function walkAll(value: unknown, path: string, field: string, paths: string[]): void {
  walk(value, path, field, paths, false);
}

function walk(value: unknown, path: string, field: string, paths: string[], schemaAware: boolean): void {
  if (isArr(value)) {
    for (let i = 0; i < value.length; i++) walk(value[i], joinPath(path, String(i)), field, paths, schemaAware);
    return;
  }
  if (!isObj(value)) return;
  for (const keyStr of Object.keys(value)) {
    const childPath = joinPath(path, escapeGJSONPathKey(keyStr));
    if (keyStr === field) paths.push(childPath);
    if (schemaAware && isLiteralValueKeyword(keyStr) && !isPropertyDefinition(path)) continue;
    walk(value[keyStr], childPath, field, paths, schemaAware);
  }
}

function findPathsByFields(root: unknown, fields: string[]): Map<string, string[]> {
  const set = new Set(fields);
  const paths = new Map<string, string[]>();
  walkForFields(root, "", set, paths);
  return paths;
}

function walkForFields(value: unknown, path: string, fields: Set<string>, paths: Map<string, string[]>): void {
  if (isArr(value)) {
    for (let i = 0; i < value.length; i++) walkForFields(value[i], joinPath(path, String(i)), fields, paths);
    return;
  }
  if (!isObj(value)) return;
  for (const keyStr of Object.keys(value)) {
    const childPath = joinPath(path, escapeGJSONPathKey(keyStr));
    if (fields.has(keyStr)) {
      if (!paths.has(keyStr)) paths.set(keyStr, []);
      paths.get(keyStr)!.push(childPath);
    }
    if (isLiteralValueKeyword(keyStr) && !isPropertyDefinition(path)) continue;
    walkForFields(value[keyStr], childPath, fields, paths);
  }
}

function setRawAt(root: unknown, path: string, value: unknown): unknown {
  return setAt(root, path, value);
}

const schemaNameMapKeywords = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies", "$defs", "definitions"]);

/**
 * Reports whether path points at a map whose keys are names chosen by the tool author,
 * so a key spelled like a schema keyword there must be preserved. Each trailing
 * name-map keyword flips the answer ("properties" is a map, "properties.properties"
 * the schema of a property named "properties", and so on).
 */
export function isPropertyDefinition(path: string): boolean {
  const segments = splitGJSONPath(path);
  let trailing = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!schemaNameMapKeywords.has(unescapeGJSONPathKey(segments[i]!))) break;
    trailing++;
  }
  return trailing % 2 === 1;
}

function descriptionPath(parentPath: string): string {
  if (parentPath === "" || parentPath === "@this") return "description";
  return parentPath + ".description";
}

function mergeHint(existing: string, hint: string): string {
  if (existing === "") return hint;
  if (existing === hint || existing.startsWith(hint + " (") || existing.includes(`(${hint})`)) return existing;
  return `${existing} (${hint})`;
}

function appendHint(root: unknown, parentPath: string, hint: string): unknown {
  const descPath = descriptionPath(parentPath);
  const merged = mergeHint(gstr(getAt(root, descPath)), hint);
  return setAt(root, descPath, merged);
}

function appendHintRaw(schema: Record<string, unknown>, hint: string): Record<string, unknown> {
  schema.description = mergeHint(gstr(schema.description), hint);
  return schema;
}

function getStrings(root: unknown, path: string): string[] {
  const arr = getAt(root, path);
  return isArr(arr) ? arr.map((r) => gstr(r)) : [];
}

function orDefault(val: string, def: string): string {
  return val === "" ? def : val;
}

function mergeDescriptionRaw(schema: Record<string, unknown>, parentDesc: string): Record<string, unknown> {
  const childDesc = gstr(schema.description);
  if (childDesc === "") schema.description = parentDesc;
  else if (childDesc !== parentDesc) schema.description = `${parentDesc} (${childDesc})`;
  return schema;
}
