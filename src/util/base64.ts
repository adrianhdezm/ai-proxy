// Go-compatible base64 encoders/decoders (encoding/base64 semantics).
//
// Go's decoders differ from atob in ways the signature validators depend on:
// newline characters are skipped, padding is mandatory for the padded encodings
// and forbidden for the Raw ones, and Strict() rejects non-canonical trailing bits.

export interface Base64Options {
  /** Use the URL-safe alphabet ("-_") instead of the standard one ("+/"). */
  url?: boolean;
  /** Padding is required (true, StdEncoding/URLEncoding) or forbidden (false, Raw*). */
  padding: boolean;
  /** Reject non-zero trailing bits (Go's Strict()). */
  strict?: boolean;
}

const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function decodeTable(alphabet: string): Int16Array {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  return table;
}

const STD_TABLE = decodeTable(STD_ALPHABET);
const URL_TABLE = decodeTable(URL_ALPHABET);

/** Decodes base64 text with Go semantics; returns null on any corrupt input. */
export function decodeBase64(input: string, opts: Base64Options): Uint8Array | null {
  const table = opts.url ? URL_TABLE : STD_TABLE;
  // Go skips \r and \n anywhere in the input.
  const chars: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 10 || c === 13) continue;
    chars.push(c);
  }
  const n = chars.length;
  const out: number[] = [];
  let i = 0;
  while (i < n) {
    const remaining = n - i;
    if (remaining < 4) {
      if (opts.padding) return null; // padded encodings require full quanta
      if (remaining === 1) return null;
    }
    const quad: number[] = [];
    let pads = 0;
    for (let j = 0; j < 4 && i < n; j++, i++) {
      const c = chars[i]!;
      if (c === 61 /* = */) {
        if (!opts.padding) return null;
        // Padding only allowed in positions 2 and 3 of the final quantum.
        if (j < 2) return null;
        pads++;
        if (j === 2) {
          // next must also be '='
          if (i + 1 >= n || chars[i + 1] !== 61) return null;
          i++;
          pads++;
          j++;
        }
        break;
      }
      if (c > 255) return null;
      const v = table[c]!;
      if (v < 0) return null;
      quad.push(v);
    }
    if (pads > 0 && i !== n) return null; // padding must end the input
    if (opts.padding && pads === 0 && quad.length < 4) return null;
    const have = quad.length;
    if (have === 1) return null;
    const b0 = quad[0]! << 2 | quad[1]! >> 4;
    out.push(b0 & 0xff);
    if (have >= 3) {
      out.push(((quad[1]! & 0x0f) << 4 | quad[2]! >> 2) & 0xff);
    } else if (opts.strict && (quad[1]! & 0x0f) !== 0) {
      return null;
    }
    if (have === 4) {
      out.push(((quad[2]! & 0x03) << 6 | quad[3]!) & 0xff);
    } else if (have === 3 && opts.strict && (quad[2]! & 0x03) !== 0) {
      return null;
    }
  }
  return Uint8Array.from(out);
}

export function encodeBase64(bytes: Uint8Array, opts: Base64Options): string {
  const alphabet = opts.url ? URL_ALPHABET : STD_ALPHABET;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    if (opts.padding) out += "==";
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]!;
    if (opts.padding) out += "=";
  }
  return out;
}

export const stdEncoding: Base64Options = { padding: true };
export const rawStdEncoding: Base64Options = { padding: false };
export const urlEncoding: Base64Options = { url: true, padding: true };
export const rawURLEncoding: Base64Options = { url: true, padding: false };

export function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const strictUTF8 = new TextDecoder("utf-8", { fatal: true });

/** Decodes UTF-8, returning undefined when the bytes are not valid UTF-8. */
export function utf8DecodeStrict(bytes: Uint8Array): string | undefined {
  try {
    return strictUTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
