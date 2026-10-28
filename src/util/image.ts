// Port of internal/util/image.go: a solid white PNG for the given aspect ratio, base64 encoded.
import { deflateSync } from "node:zlib";
import { encodeBase64, stdEncoding } from "./base64.ts";

const dimensions: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "2:3": [832, 1248],
  "3:2": [1248, 832],
  "3:4": [864, 1184],
  "4:3": [1184, 864],
  "4:5": [896, 1152],
  "5:4": [1152, 896],
  "9:16": [768, 1344],
  "16:9": [1344, 768],
  "21:9": [1536, 672],
};

export function createWhiteImageBase64(aspectRatio: string): string {
  const [width, height] = dimensions[aspectRatio] ?? [1024, 1024];
  // RGBA rows, each prefixed with filter byte 0.
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height).fill(0xff);
  for (let y = 0; y < height; y++) raw[y * stride] = 0;
  const idat = new Uint8Array(deflateSync(raw));

  const chunks: Uint8Array[] = [];
  chunks.push(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(pngChunk("IHDR", ihdr));
  chunks.push(pngChunk("IDAT", idat));
  chunks.push(pngChunk("IEND", new Uint8Array(0)));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    png.set(c, offset);
    offset += c.length;
  }
  return encodeBase64(png, stdEncoding);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
