// Minimal protobuf wire-format reader/writer (google.golang.org/protobuf/encoding/protowire subset).
// Used by the signature validators to walk opaque provider envelopes.

export const WireVarint = 0;
export const WireFixed64 = 1;
export const WireBytes = 2;
export const WireStartGroup = 3;
export const WireEndGroup = 4;
export const WireFixed32 = 5;

const maxValidNumber = (1 << 29) - 1;

/** Consumes a varint; returns null on malformed input (unterminated or overflowing). */
export function consumeVarint(b: Uint8Array, offset: number): { value: bigint; n: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (offset + i >= b.length) return null;
    const byte = b[offset + i]!;
    value |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) {
      if (i === 9 && byte > 1) return null; // overflow beyond 64 bits
      return { value, n: i + 1 };
    }
    shift += 7n;
  }
  return null;
}

/** Consumes a field tag; returns null when malformed or the field number is out of range. */
export function consumeTag(b: Uint8Array, offset: number): { num: number; type: number; n: number } | null {
  const v = consumeVarint(b, offset);
  if (!v) return null;
  const num = Number(v.value >> 3n);
  const type = Number(v.value & 7n);
  if (num < 1 || num > maxValidNumber) return null;
  return { num, type, n: v.n };
}

/** Consumes a length-delimited field value. */
export function consumeBytes(b: Uint8Array, offset: number): { value: Uint8Array; n: number } | null {
  const v = consumeVarint(b, offset);
  if (!v) return null;
  const length = Number(v.value);
  if (v.value > BigInt(b.length) || offset + v.n + length > b.length) return null;
  return { value: b.subarray(offset + v.n, offset + v.n + length), n: v.n + length };
}

export function consumeFixed32(b: Uint8Array, offset: number): number {
  return offset + 4 <= b.length ? 4 : -1;
}

export function consumeFixed64(b: Uint8Array, offset: number): number {
  return offset + 8 <= b.length ? 8 : -1;
}

/** Returns the encoded length of a field value of the given wire type, or -1 when malformed. */
export function consumeFieldValue(num: number, type: number, b: Uint8Array, offset: number): number {
  switch (type) {
    case WireVarint: {
      const v = consumeVarint(b, offset);
      return v ? v.n : -1;
    }
    case WireFixed64:
      return consumeFixed64(b, offset);
    case WireBytes: {
      const v = consumeBytes(b, offset);
      return v ? v.n : -1;
    }
    case WireFixed32:
      return consumeFixed32(b, offset);
    case WireStartGroup: {
      let n = 0;
      for (;;) {
        const tag = consumeTag(b, offset + n);
        if (!tag) return -1;
        n += tag.n;
        if (tag.type === WireEndGroup) {
          if (tag.num !== num) return -1;
          return n;
        }
        const len = consumeFieldValue(tag.num, tag.type, b, offset + n);
        if (len < 0) return -1;
        n += len;
      }
    }
    case WireEndGroup:
    default:
      return -1;
  }
}

export interface WireField {
  num: number;
  type: number;
  /** The raw encoded value bytes (varint bytes, or length prefix + payload for bytes fields). */
  raw: Uint8Array;
}

/** Walks every top-level field of a message; returns null on malformed input. */
export function walkFields(msg: Uint8Array): WireField[] | null {
  const fields: WireField[] = [];
  let offset = 0;
  while (offset < msg.length) {
    const tag = consumeTag(msg, offset);
    if (!tag) return null;
    offset += tag.n;
    const len = consumeFieldValue(tag.num, tag.type, msg, offset);
    if (len < 0) return null;
    fields.push({ num: tag.num, type: tag.type, raw: msg.subarray(offset, offset + len) });
    offset += len;
  }
  return fields;
}

// ---- encoding helpers (used by tests to build synthetic envelopes) ----

export function appendVarint(out: number[], value: number | bigint): number[] {
  let v = BigInt(value);
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

export function appendTag(out: number[], num: number, type: number): number[] {
  return appendVarint(out, (BigInt(num) << 3n) | BigInt(type));
}

export function appendBytes(out: number[], value: Uint8Array | number[]): number[] {
  appendVarint(out, value.length);
  for (const b of value) out.push(b);
  return out;
}

export function appendString(out: number[], value: string): number[] {
  return appendBytes(out, new TextEncoder().encode(value));
}
