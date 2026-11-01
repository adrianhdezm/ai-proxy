// Small gjson-style accessors shared by the Responses <-> Gemini translator files.
// Items are parsed JSON values; these helpers mirror gjson Result methods.
import { getAt, gstr, isArr, isObj } from "../../../../util/gpath.ts";

/** gjson Get(path).String(). */
export function str(v: unknown, path: string): string {
  return gstr(getAt(v, path));
}

/** gjson Get(path).Exists(). */
export function has(v: unknown, path: string): boolean {
  return getAt(v, path) !== undefined;
}

/** gjson Result.Float(). */
export function gfloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** gjson Result.Raw for a parsed value (undefined -> ""). */
export function rawOf(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v);
}

/** gjson.Parse(raw) tolerant of invalid input: undefined when not valid JSON. */
export function parseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** gjson.Valid. */
export function validJSON(raw: string): boolean {
  if (raw.trim() === "") return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

export { isArr, isObj };

/** Go filepath.Ext: the suffix starting at the final dot in the last path element. */
export function fileExt(path: string): string {
  for (let i = path.length - 1; i >= 0 && path[i] !== "/"; i--) {
    if (path[i] === ".") return path.slice(i);
  }
  return "";
}

/** Go filepath.Base. */
export function fileBase(path: string): string {
  if (path === "") return ".";
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const idx = path.lastIndexOf("/");
  if (idx >= 0) path = path.slice(idx + 1);
  return path === "" ? "/" : path;
}

const textEncoder = new TextEncoder();

/** UTF-8 byte length of s (Go len([]byte(s))). */
export function utf8Len(s: string): number {
  return textEncoder.encode(s).length;
}

/** UTF-8 bytes of s. */
export function utf8Bytes(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/** Go utf8.RuneCount over bytes: each invalid or truncated byte counts as one rune. */
export function utf8RuneCount(bytes: Uint8Array): number {
  let count = 0;
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i]!;
    let size = 1;
    if (c >= 0xc2 && c <= 0xdf) size = 2;
    else if (c >= 0xe0 && c <= 0xef) size = 3;
    else if (c >= 0xf0 && c <= 0xf4) size = 4;
    if (size > 1) {
      let ok = i + size <= bytes.length;
      for (let k = 1; ok && k < size; k++) {
        const b = bytes[i + k]!;
        if (b < 0x80 || b > 0xbf) ok = false;
      }
      if (!ok) size = 1;
    }
    i += size;
    count++;
  }
  return count;
}

/** Go utf8.RuneCountInString for a well-formed JS string (code points). */
export function runeCount(s: string): number {
  let count = 0;
  for (const _ of s) count++;
  return count;
}

let nanoCounter = 0;

/** time.Now().UnixNano() stand-in: milliseconds scaled to nanoseconds plus a monotonic tiebreaker. */
export function unixNano(): bigint {
  nanoCounter = (nanoCounter + 1) % 1_000_000;
  return BigInt(Date.now()) * 1_000_000n + BigInt(nanoCounter);
}

// ---- gjson-compatible lenient parsing with raw spans ----

const rawSpans = new WeakMap<object, string>();

/**
 * The original JSON text of an object or array produced by parseGJSON (gjson
 * Result.Raw), falling back to JSON.stringify for other values.
 */
export function gjsonRaw(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "object" && v !== null) {
    const raw = rawSpans.get(v);
    if (raw !== undefined) return raw;
  }
  return JSON.stringify(v);
}

/**
 * Parses JSON the way gjson reads it: duplicate keys keep the first value,
 * objects and arrays remember their original text (see gjsonRaw), and malformed
 * input is read leniently (mismatched closers close the open container, EOF
 * closes everything). `valid` reports whether the text is strict JSON.
 */
export function parseGJSON(text: string): { value: unknown; valid: boolean } {
  let valid = true;
  try {
    JSON.parse(text);
  } catch {
    valid = false;
  }
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const parseString = (): string => {
    const start = i;
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === "\\") i++;
      i++;
    }
    i = Math.min(i + 1, n);
    const raw = text.slice(start, i);
    try {
      return JSON.parse(raw.endsWith('"') && raw.length > 1 ? raw : raw + '"') as string;
    } catch {
      return raw.slice(1, raw.endsWith('"') ? -1 : undefined);
    }
  };
  const parseValue = (): unknown => {
    ws();
    if (i >= n) return undefined;
    const c = text[i];
    if (c === "{") {
      const start = i;
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (i >= n) break;
        if (text[i] === "}" || text[i] === "]") {
          i++;
          break;
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== '"') {
          i++;
          continue;
        }
        const key = parseString();
        ws();
        if (text[i] === ":") i++;
        const value = parseValue();
        if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = value;
      }
      rawSpans.set(obj, text.slice(start, i));
      return obj;
    }
    if (c === "[") {
      const start = i;
      i++;
      const arr: unknown[] = [];
      for (;;) {
        ws();
        if (i >= n) break;
        if (text[i] === "]" || text[i] === "}") {
          i++;
          break;
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        const before = i;
        arr.push(parseValue());
        if (i === before) i++;
      }
      rawSpans.set(arr, text.slice(start, i));
      return arr;
    }
    if (c === '"') return parseString();
    const start = i;
    while (i < n && !",}] \t\n\r".includes(text[i]!)) i++;
    const token = text.slice(start, i);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    const num = Number(token);
    return Number.isFinite(num) && token !== "" ? num : undefined;
  };
  const value = parseValue();
  return { value, valid };
}
