// Shared gjson-style helpers for the thinking tests.
import { getPath, tryParse } from "../../src/util/json.ts";

/** gjson.GetBytes(body, path) with .String() semantics ("" when absent or not a string/number). */
export function getString(body: string, path: string): string {
  const v = getPath(tryParse(body), path);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

export function getValue(body: string, path: string): unknown {
  return getPath(tryParse(body), path);
}

export function exists(body: string, path: string): boolean {
  return getValue(body, path) !== undefined;
}

/** gjson Result.Raw for a path (compact JSON), or "" when absent. */
export function raw(body: string, path: string): string {
  const v = getValue(body, path);
  return v === undefined ? "" : JSON.stringify(v);
}
