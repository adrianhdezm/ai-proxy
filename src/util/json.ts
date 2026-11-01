// Small JSON helpers used across translators (replacement for gjson/sjson idioms).

export type JSONObject = Record<string, unknown>;

export function isObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses JSON, returning undefined instead of throwing on invalid input. */
export function tryParse<T = unknown>(raw: string | null | undefined): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = raw.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function isValidJSON(raw: string): boolean {
  return tryParse(raw) !== undefined || raw.trim() === "null";
}

/** Reads a dotted path ("a.b.0.c") from a parsed JSON value. */
export function getPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (isObject(cur)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Sets a dotted path on a parsed JSON object, creating intermediate objects. */
export function setPath(target: JSONObject, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: JSONObject | unknown[] = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const nextIsIndex = /^\d+$/.test(keys[i + 1]!);
    let next: unknown = Array.isArray(cur) ? cur[Number(key)] : cur[key];
    if (!isObject(next) && !Array.isArray(next)) {
      next = nextIsIndex ? [] : {};
      if (Array.isArray(cur)) cur[Number(key)] = next;
      else cur[key] = next;
    }
    cur = next as JSONObject | unknown[];
  }
  const last = keys[keys.length - 1]!;
  if (Array.isArray(cur)) cur[Number(last)] = value;
  else cur[last] = value;
}

/** Deletes a dotted path from a parsed JSON object. */
export function deletePath(target: JSONObject, path: string): void {
  const keys = path.split(".");
  let cur: unknown = target;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = isObject(cur) ? cur[keys[i]!] : Array.isArray(cur) ? cur[Number(keys[i])] : undefined;
    if (cur === undefined) return;
  }
  const last = keys[keys.length - 1]!;
  if (Array.isArray(cur)) cur.splice(Number(last), 1);
  else if (isObject(cur)) delete cur[last];
}

export function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asObject(v: unknown): JSONObject {
  return isObject(v) ? v : {};
}

export function deepClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
