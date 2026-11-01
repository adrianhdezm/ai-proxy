// gjson/sjson-style dotted path helpers over parsed JSON values.
//
// The Go sources address schema nodes with gjson paths ("properties.my\\.param.type").
// This module keeps that addressing scheme (escaped keys, depth sorting, "#" length)
// but applies it to parsed values so the ports can stay structurally close to Go.

export type GValue = unknown;

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** gjson Result.Exists(): the value is present (null counts as present). */
export function exists(v: unknown): boolean {
  return v !== undefined;
}

/** gjson Result.String(). */
export function gstr(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return numberToString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

function numberToString(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const s = String(n);
  if (s.includes("e")) {
    // Go formats with 'f' (no exponent).
    return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  }
  return s;
}

/** gjson Result.Bool(). */
export function gbool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "1" || t === "t" || t === "true";
  }
  if (typeof v === "number") return v !== 0;
  return false;
}

/** gjson Result.Int(). */
export function gint(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

/** gjson Result.Raw for comparisons (undefined -> ""). */
export function graw(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v);
}

/** gjson Result.Array(): the elements of an array, or [] for anything else. */
export function garray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function deepCopy<T>(v: T): T {
  if (Array.isArray(v)) return v.map((item) => deepCopy(item)) as unknown as T;
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) out[key] = deepCopy(v[key]);
    return out as T;
  }
  return v;
}

export function escapeGJSONPathKey(key: string): string {
  if (!/[.*?]/.test(key)) return key;
  return key.replace(/[.*?]/g, (m) => "\\" + m);
}

export function unescapeGJSONPathKey(key: string): string {
  if (!key.includes("\\")) return key;
  let out = "";
  for (let i = 0; i < key.length; i++) {
    if (key[i] === "\\" && i + 1 < key.length) {
      i++;
      out += key[i];
      continue;
    }
    out += key[i];
  }
  return out;
}

/** Splits a path into escaped segments (escapes are preserved, as in Go). */
export function splitGJSONPath(path: string): string[] {
  if (path === "") return [];
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    if (c === "\\" && i + 1 < path.length) {
      cur += "\\" + path[i + 1];
      i++;
      continue;
    }
    if (c === ".") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

export function joinPath(base: string, suffix: string): string {
  return base === "" ? suffix : base + "." + suffix;
}

export function trimSuffix(path: string, suffix: string): string {
  const bare = suffix.startsWith(".") ? suffix.slice(1) : suffix;
  if (path === bare) return "";
  return path.endsWith(suffix) ? path.slice(0, path.length - suffix.length) : path;
}

/** Sorts paths deepest first (by segment count), stable. */
export function sortByDepth(paths: string[]): void {
  const depth = new Map<string, number>();
  const keyed = paths.map((p, i) => ({ p, i, d: splitGJSONPath(p).length }));
  keyed.sort((a, b) => (b.d !== a.d ? b.d - a.d : a.i - b.i));
  for (let i = 0; i < keyed.length; i++) paths[i] = keyed[i]!.p;
  depth.clear();
}

function stepInto(cur: unknown, seg: string): unknown {
  const key = unescapeGJSONPathKey(seg);
  if (Array.isArray(cur)) {
    if (key === "#") return cur.length;
    if (!/^\d+$/.test(key)) return undefined;
    return cur[Number(key)];
  }
  if (isObj(cur)) return cur[key];
  return undefined;
}

/** gjson Get: reads a dotted path. The empty path returns the root. */
export function getAt(root: unknown, path: string): unknown {
  if (path === "" || path === "@this") return root;
  let cur = root;
  for (const seg of splitGJSONPath(path)) {
    if (cur === undefined || cur === null) return undefined;
    cur = stepInto(cur, seg);
  }
  return cur;
}

/**
 * sjson Set: writes a value at a dotted path, creating intermediate objects.
 * Returns the (possibly replaced) root; the empty path replaces the root.
 * "-1" on an array appends.
 */
export function setAt(root: unknown, path: string, value: unknown): unknown {
  if (path === "" || path === "@this") return value;
  const segs = splitGJSONPath(path);
  if (!isObj(root) && !Array.isArray(root)) root = {};
  let cur: Record<string, unknown> | unknown[] = root as Record<string, unknown> | unknown[];
  for (let i = 0; i < segs.length; i++) {
    const key = unescapeGJSONPathKey(segs[i]!);
    const last = i === segs.length - 1;
    if (Array.isArray(cur)) {
      let idx = key === "-1" ? cur.length : Number(key);
      if (!Number.isInteger(idx) || idx < 0) idx = cur.length;
      if (last) {
        cur[idx] = value;
        return root;
      }
      let next = cur[idx];
      if (!isObj(next) && !Array.isArray(next)) {
        next = {};
        cur[idx] = next;
      }
      cur = next as Record<string, unknown> | unknown[];
    } else {
      if (last) {
        cur[key] = value;
        return root;
      }
      let next = cur[key];
      if (!isObj(next) && !Array.isArray(next)) {
        next = {};
        cur[key] = next;
      }
      cur = next as Record<string, unknown> | unknown[];
    }
  }
  return root;
}

/** sjson Delete: removes the value at a dotted path (no-op when absent). Returns whether it existed. */
export function deleteAt(root: unknown, path: string): boolean {
  if (path === "") return false;
  const segs = splitGJSONPath(path);
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur === undefined || cur === null) return false;
    cur = stepInto(cur, segs[i]!);
  }
  const key = unescapeGJSONPathKey(segs[segs.length - 1]!);
  if (Array.isArray(cur)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return false;
    cur.splice(idx, 1);
    return true;
  }
  if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, key)) {
    delete cur[key];
    return true;
  }
  return false;
}

/** Keys of an object in document order (gjson ForEach order). */
export function keysOf(v: unknown): string[] {
  return isObj(v) ? Object.keys(v) : [];
}
