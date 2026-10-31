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
