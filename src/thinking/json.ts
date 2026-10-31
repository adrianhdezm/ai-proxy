// gjson/sjson-style helpers over JSON strings for the thinking package.
//
// Doc wraps one request body: it parses once, lets callers get/set/delete dotted paths, and
// serialises back. When nothing changed it returns the original string untouched so byte-level
// "unchanged" expectations from upstream hold.
import { deletePath, getPath, isObject, isValidJSON, setPath, tryParse, type JSONObject } from "../util/json.ts";

export class Doc {
  readonly raw: string;
  readonly obj: JSONObject | undefined;
  private readonly before: string;

  constructor(raw: string) {
    this.raw = raw;
    const parsed = tryParse(raw);
    this.obj = isObject(parsed) ? parsed : undefined;
    this.before = this.obj ? JSON.stringify(this.obj) : "";
  }

  /** True when the body parsed as a JSON object. */
  get valid(): boolean {
    return this.obj !== undefined;
  }

  get(path: string): unknown {
    return this.obj ? getPath(this.obj, path) : undefined;
  }

  exists(path: string): boolean {
    return this.get(path) !== undefined;
  }

  set(path: string, value: unknown): void {
    if (this.obj) setPath(this.obj, path, value);
  }

  del(path: string): void {
    if (this.obj) deletePath(this.obj, path);
  }

  /** Deletes `path` when it is an empty object (sjson idiom used to avoid leaving `{}` behind). */
  deleteIfEmptyObject(path: string): void {
    const v = this.get(path);
    if (isObject(v) && Object.keys(v).length === 0) this.del(path);
  }

  /** Serialises the document, returning the original string when nothing changed. */
  toString(): string {
    if (!this.obj) return this.raw;
    const after = JSON.stringify(this.obj);
    return after === this.before ? this.raw : after;
  }
}

/** gjson.ValidBytes equivalent (empty input is invalid). */
export function validJSON(raw: string): boolean {
  return raw.length > 0 && isValidJSON(raw);
}

/** gjson Result.String(): strings as-is, numbers/booleans formatted, null/absent empty. */
export function gjsonString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

/** gjson Result.Int(): numbers truncated, numeric strings parsed, booleans 1/0, else 0. */
export function gjsonInt(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

export function isEmptyObject(v: unknown): boolean {
  return isObject(v) && Object.keys(v).length === 0;
}
