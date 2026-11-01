// Port of internal/util/claude_schema.go.
import { isObj } from "./gpath.ts";

const emptyClaudeToolInputSchema = `{"type":"object","properties":{}}`;

/**
 * Makes a JSON Schema compatible with Claude's requirement that a tool input
 * schema is an object without root-level unions.
 */
export function normalizeClaudeToolInputSchema(schema: string): string {
  let root: unknown;
  if (schema.length === 0) return emptyClaudeToolInputSchema;
  try {
    root = JSON.parse(schema);
  } catch {
    return emptyClaudeToolInputSchema;
  }
  if (!isObj(root)) return emptyClaudeToolInputSchema;

  const properties = claudeSchemaObject(root.properties);
  for (const unionName of ["anyOf", "oneOf", "allOf"]) {
    if (!(unionName in root)) continue;
    const unionRaw = root[unionName];
    delete root[unionName];
    if (!Array.isArray(unionRaw)) continue;
    for (const branch of unionRaw) {
      if (!isObj(branch) || !claudeSchemaCanBeObject(branch)) continue;
      const branchProps = claudeSchemaObject(branch.properties);
      for (const name of Object.keys(branchProps)) {
        if (!(name in properties)) properties[name] = branchProps[name];
      }
      if (unionName === "allOf") mergeClaudeSchemaRequired(root, branch.required);
    }
  }
  root.type = "object";
  root.properties = properties;
  return JSON.stringify(root);
}

function claudeSchemaObject(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) return {};
  return { ...raw };
}

function claudeSchemaCanBeObject(schema: Record<string, unknown>): boolean {
  if (!("type" in schema)) return true;
  const typeRaw = schema.type;
  if (typeof typeRaw === "string") return typeRaw === "object";
  if (Array.isArray(typeRaw)) {
    if (!typeRaw.every((t) => typeof t === "string")) return false;
    return typeRaw.includes("object");
  }
  return false;
}

function mergeClaudeSchemaRequired(root: Record<string, unknown>, branchRequired: unknown): void {
  let required: string[] = [];
  if ("required" in root) {
    const rootRequired = root.required;
    if (Array.isArray(rootRequired) && rootRequired.every((r) => typeof r === "string")) {
      required = [...(rootRequired as string[])];
    }
  }
  if (!Array.isArray(branchRequired) || !branchRequired.every((r) => typeof r === "string")) return;
  const seen = new Set(required);
  for (const name of branchRequired as string[]) {
    if (seen.has(name)) continue;
    required.push(name);
    seen.add(name);
  }
  if (required.length === 0) return;
  root.required = required;
}

/**
 * Reports whether a regular expression string contains a construct that strict
 * upstream JSON Schema validators reject when compiling "pattern" values:
 * Unicode property escapes (\p{...} / \P{...}) and the octal NUL escape (\0).
 */
export function hasUnsupportedUnicodePropertyEscape(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;
    if (i + 1 >= pattern.length) break;
    const next = pattern[i + 1];
    if ((next === "p" || next === "P") && i + 2 < pattern.length && pattern[i + 2] === "{") return true;
    if (next === "0") return true;
    i++; // skip the escaped character (including escaped backslash)
  }
  return false;
}

/** JSON Schema keywords whose values are maps of subschemas. */
export const schemaMapKeywords = ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas", "dependencies"] as const;

/** JSON Schema keywords with a single nested subschema or a list of subschemas. */
export const schemaValueKeywords = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
  "contentSchema",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
] as const;
