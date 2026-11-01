// Synchronous SHA-256 helper (crypto/sha256 replacement) built on Bun.CryptoHasher.

export function sha256Hex(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return new Uint8Array(hasher.digest());
}
