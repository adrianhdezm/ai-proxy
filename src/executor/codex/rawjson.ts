// A JSON parser/serialiser that preserves number literals verbatim. The Go code
// edited tool schemas with gjson/sjson on raw bytes, which never re-encodes a
// number; JSON.parse would round 9007199254740993 or 2^63 bounds, so the tool
// schema normaliser works on this representation instead. Strings, objects
// (insertion order) and arrays are plain JS values; numbers are RawNumber.

export class RawNumber {
  constructor(readonly raw: string) {}
  toJSON(): number {
    return Number(this.raw);
  }
}

export function isRawNumber(v: unknown): v is RawNumber {
  return v instanceof RawNumber;
}

const numberRe = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

/** Parses JSON text; throws on invalid input or trailing content. */
export function parseRawJSON(text: string): unknown {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const fail = (msg: string): never => {
    throw new SyntaxError(`${msg} at position ${i}`);
  };
  const parseString = (): string => {
    // text[i] === '"'
    const start = i;
    i++;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return JSON.parse(text.slice(start, i)) as string;
      }
      if (text.charCodeAt(i) < 0x20) fail("control character in string");
      i++;
    }
    return fail("unterminated string");
  };
  const parseValue = (): unknown => {
    ws();
    if (i >= n) fail("unexpected end of input");
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected object key");
        const key = parseString();
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        obj[key] = parseValue();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    const m = numberRe.exec(text.slice(i));
    if (m && m[0].length > 0) {
      i += m[0].length;
      return new RawNumber(m[0]);
    }
    return fail("unexpected token");
  };
  const value = parseValue();
  ws();
  if (i !== n) fail("trailing content");
  return value;
}

/** Serialises a value produced by parseRawJSON (RawNumber literals verbatim, no extra whitespace). */
export function stringifyRawJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof RawNumber) return value.raw;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object":
      if (Array.isArray(value)) return "[" + value.map((v) => stringifyRawJSON(v)).join(",") + "]";
      return (
        "{" +
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => JSON.stringify(k) + ":" + stringifyRawJSON(v))
          .join(",") +
        "}"
      );
    default:
      return "null";
  }
}

/** Deep clone of a raw-JSON tree (RawNumber instances are shared; they are immutable). */
export function cloneRawJSON<T>(value: T): T {
  if (value === null || typeof value !== "object" || value instanceof RawNumber) return value;
  if (Array.isArray(value)) return value.map((v) => cloneRawJSON(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneRawJSON(v);
  return out as T;
}
