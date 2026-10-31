// Local helpers that reproduce gjson/encoding-json value semantics the Go
// translator relied on (no shared equivalent exists in src/translator/common).
import { isObj } from "../../../../util/gpath.ts";

/**
 * Deep copy with object keys sorted, i.e. the shape Go's json.Marshal gives a
 * gjson Result.Value() (map[string]interface{}) when sjson.SetBytes stores it.
 * Deviation: JSON.stringify does not HTML-escape <, > and & like encoding/json.
 */
export function goValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(goValue);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) out[key] = goValue(v[key]);
    return out;
  }
  return v;
}

/** gjson Result.Float(). */
export function gfloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) && v.trim() !== "" ? n : 0;
  }
  return 0;
}

/** gjson.Valid on a string: whether it is one complete JSON value. */
export function validJSON(raw: string): boolean {
  if (raw.trim() === "") return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** Parses raw JSON or returns undefined (gjson.Parse on valid input). */
export function parseJSON(raw: string | undefined): unknown {
  if (raw === undefined || !validJSON(raw)) return undefined;
  return JSON.parse(raw);
}
