// Port of internal/runtime/executor/helps/codex_tool_schema.go
// (NormalizeCodexToolSchemas and helpers). The Go code edited raw bytes with
// gjson/sjson so untouched parts kept their formatting; this port parses the body
// with the literal-preserving raw JSON parser, so numbers never lose precision,
// and re-serialises the whole body only when a tool actually changed (an
// unchanged payload is returned as the same string).
//
// NormalizeCodexToolIntegerTypes (Codex client number->integer rewrite for
// non-Codex targets) lives in tool_schema_integer.ts; the Codex executor never applies it.
import { hasUnsupportedUnicodePropertyEscape, schemaMapKeywords, schemaValueKeywords } from "../../util/claude_schema.ts";
import { log } from "../../log.ts";
import { RawNumber, isRawNumber, parseRawJSON, stringifyRawJSON } from "./rawjson.ts";

/** Minimum union branches before a pure constant union becomes an enum (Go: codexComplexUnionBranchThreshold). */
export const codexComplexUnionBranchThreshold = 8;

const codexNumericBoundKeywords = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const;

type JSONObject = Record<string, unknown>;

function isObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RawNumber);
}

/**
 * Simplifies pure constant unions (oneOf/anyOf of >= 8 const branches) into
 * enums and strips schema patterns/bounds strict upstream validators reject
 * (Go: NormalizeCodexToolSchemas).
 */
export function normalizeCodexToolSchemas(body: string): string {
  if (body.length === 0 || !body.includes("tools")) return body;
  let root: unknown;
  try {
    root = parseRawJSON(body);
  } catch {
    return body;
  }
  if (!isObject(root) || !Array.isArray(root.tools)) return body;
  if (!normalizeCodexToolList(root.tools)) return body;
  log.debug("codex: normalized tool schemas to prevent upstream failure");
  return stringifyRawJSON(root);
}

function normalizeCodexToolList(tools: unknown[]): boolean {
  let changed = false;
  for (const tool of tools) {
    if (normalizeCodexTool(tool)) changed = true;
  }
  return changed;
}

function normalizeCodexTool(tool: unknown): boolean {
  if (!isObject(tool)) return false;
  const toolType = tool.type;
  if (toolType === "namespace") {
    return Array.isArray(tool.tools) ? normalizeCodexToolList(tool.tools) : false;
  }
  if (toolType !== "function" && toolType !== "custom") return false;
  const params = tool.parameters;
  if (!isObject(params)) return false;
  if (!normalizeCodexParameters(params)) return false;
  log.debug(`codex: normalized schema for tool ${typeof tool.name === "string" ? tool.name : ""} to avoid upstream abort`);
  return true;
}

function normalizeCodexParameters(params: JSONObject): boolean {
  let changed = stripIncompatiblePatterns(params);
  const properties = params.properties;
  if (isObject(properties)) {
    for (const prop of Object.values(properties)) {
      if (normalizeCodexPropertySchema(prop)) changed = true;
    }
  }
  return changed;
}

/**
 * Recursively removes `pattern` values with unsupported escapes and integer
 * numeric bounds outside int64, visiting only JSON Schema keyword locations so
 * user data (description, default, enum) is never touched (Go: stripIncompatiblePatterns).
 */
export function stripIncompatiblePatterns(v: unknown): boolean {
  let changed = false;
  if (isObject(v)) {
    const schema = v;
    if (typeof schema.pattern === "string" && hasUnsupportedUnicodePropertyEscape(schema.pattern)) {
      delete schema.pattern;
      changed = true;
    }
    for (const boundKey of codexNumericBoundKeywords) {
      const bound = schema[boundKey];
      if (isRawNumber(bound) && isNumericBoundOutOfInt64(bound.raw)) {
        delete schema[boundKey];
        changed = true;
      }
    }
    const patternProps = schema.patternProperties;
    if (isObject(patternProps)) {
      for (const [patternKey, subSchema] of Object.entries(patternProps)) {
        if (hasUnsupportedUnicodePropertyEscape(patternKey)) {
          delete patternProps[patternKey];
          changed = true;
        } else if (stripIncompatiblePatterns(subSchema)) {
          changed = true;
        }
      }
    }
    for (const mapKey of schemaMapKeywords) {
      if (mapKey === "patternProperties") continue;
      const subMap = schema[mapKey];
      if (!isObject(subMap)) continue;
      for (const subSchema of Object.values(subMap)) {
        if (stripIncompatiblePatterns(subSchema)) changed = true;
      }
    }
    for (const valKey of schemaValueKeywords) {
      const val = schema[valKey];
      if (val === undefined) continue;
      if (isObject(val)) {
        if (stripIncompatiblePatterns(val)) changed = true;
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (stripIncompatiblePatterns(item)) changed = true;
        }
      }
    }
  } else if (Array.isArray(v)) {
    for (const item of v) {
      if (stripIncompatiblePatterns(item)) changed = true;
    }
  }
  return changed;
}

const int64Min = -(1n << 63n);
const int64Max = (1n << 63n) - 1n;

/** Whether a JSON number literal is an integer outside the signed 64-bit range (Go: isNumericBoundOutOfInt64). */
export function isNumericBoundOutOfInt64(rawNumber: string): boolean {
  const raw = rawNumber.trim();
  if (raw === "") return false;
  if (!/[.eE]/.test(raw)) {
    try {
      const value = BigInt(raw);
      return value < int64Min || value > int64Max;
    } catch {
      return false;
    }
  }
  let s = raw;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  let mantissa = s;
  let exp = 0n;
  const eIdx = s.search(/[eE]/);
  if (eIdx >= 0) {
    mantissa = s.slice(0, eIdx);
    const expStr = s.slice(eIdx + 1);
    if (!/^[+-]?\d+$/.test(expStr)) return false;
    exp = BigInt(expStr);
    // Go: a parse overflow of the exponent is out of range when positive and the mantissa is non-zero.
    const expOverflow = exp > 9223372036854775807n || exp < -9223372036854775808n;
    if (expOverflow) return !expStr.startsWith("-") && mantissa.replace(/[0.]/g, "") !== "";
  }
  let intPart = mantissa;
  let fracPart = "";
  const dot = mantissa.indexOf(".");
  if (dot >= 0) {
    intPart = mantissa.slice(0, dot);
    fracPart = mantissa.slice(dot + 1);
    if (fracPart.includes(".")) return false;
  }
  if (intPart === "" && fracPart === "") return false;
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return false;
  const allDigits = intPart + fracPart;
  const sig = allDigits.replace(/^0+/, "");
  if (sig === "") return false;
  if (exp < -BigInt(raw.length)) return false;
  if (exp > BigInt(raw.length) + 20n) return true;
  const trimmed = sig.replace(/0+$/, "");
  const trailingZeros = BigInt(sig.length - trimmed.length);
  const effectiveExp = exp - BigInt(fracPart.length) + trailingZeros;
  if (effectiveExp < 0n) return false;
  if (effectiveExp > 19n || BigInt(trimmed.length) + effectiveExp > 19n) return true;
  const intStr = (negative ? "-" : "") + trimmed + "0".repeat(Number(effectiveExp));
  const value = BigInt(intStr);
  return value < int64Min || value > int64Max;
}

function normalizeCodexPropertySchema(prop: unknown): boolean {
  if (!isObject(prop)) return false;
  const hasOneOf = prop.oneOf !== undefined;
  const hasAnyOf = prop.anyOf !== undefined;
  // Both present: leave untouched to preserve compound constraints.
  if (hasOneOf && hasAnyOf) return false;
  const unionName = hasOneOf ? "oneOf" : hasAnyOf ? "anyOf" : "";
  if (unionName === "") return false;
  const union = prop[unionName];
  if (!Array.isArray(union) || union.length < codexComplexUnionBranchThreshold) return false;

  const constRawValues: unknown[] = [];
  const constSemanticKeys: string[] = [];
  const seen = new Set<string>();
  for (const branch of union) {
    const pure = isPureConstBranch(branch);
    if (!pure) return false;
    // Duplicate semantic values in oneOf violate exclusivity; keep the original schema.
    if (seen.has(pure.key)) return false;
    seen.add(pure.key);
    constSemanticKeys.push(pure.key);
    constRawValues.push(pure.value);
  }
  if (constRawValues.length === 0) return false;

  const existingEnum = prop.enum;
  if (Array.isArray(existingEnum)) {
    const existingKeys: string[] = [];
    for (const v of existingEnum) {
      const key = canonicalJSONValueKey(v);
      if (key === undefined) return false;
      existingKeys.push(key);
    }
    if (equalCanonicalSets(existingKeys, constSemanticKeys)) {
      delete prop[unionName];
      return true;
    }
    return false;
  }
  prop.enum = constRawValues;
  delete prop[unionName];
  return true;
}

function isPureConstBranch(branch: unknown): { key: string; value: unknown } | undefined {
  if (!isObject(branch)) return undefined;
  if (!("const" in branch)) return undefined;
  for (const key of Object.keys(branch)) {
    if (key !== "const" && key !== "description" && key !== "title") return undefined;
  }
  const key = canonicalJSONValueKey(branch.const);
  if (key === undefined) return undefined;
  return { key, value: branch.const };
}

/** A type-preserving semantic key for a scalar JSON value (Go: canonicalJSONValueKey). */
export function canonicalJSONValueKey(val: unknown): string | undefined {
  if (typeof val === "string") return "s:" + val;
  if (isRawNumber(val)) return "n:" + canonicalRational(val.raw);
  if (typeof val === "number") return Number.isFinite(val) ? "n:" + canonicalRational(String(val)) : undefined;
  if (val === true) return "b:true";
  if (val === false) return "b:false";
  if (val === null) return "null";
  return undefined;
}

/** Normalises a decimal literal so 1, 1.0 and 1e0 share one key (Go: big.Rat.RatString). */
export function canonicalRational(raw: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return raw.trim();
  const sign = m[1] === "-" ? "-" : "";
  const intPart = m[2] ?? "";
  const frac = m[3] ?? "";
  let exp = m[4] ? BigInt(m[4]) : 0n;
  let digits = (intPart + frac).replace(/^0+/, "");
  exp -= BigInt(frac.length);
  if (digits === "") return "0";
  const trimmed = digits.replace(/0+$/, "");
  exp += BigInt(digits.length - trimmed.length);
  digits = trimmed;
  if (exp >= 0n) return sign + digits + "0".repeat(Number(exp));
  const shift = Number(-exp);
  // A denominator of 10^shift reduced by factors of 2 and 5 is still unique per value;
  // "digits/10^shift" with the trailing zeros stripped is canonical.
  return `${sign}${digits}/1${"0".repeat(shift)}`;
}

function equalCanonicalSets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const v of b) if (!setA.has(v)) return false;
  return setA.size === a.length;
}
