// PKCE and state helpers shared by the OAuth flows.
// Port of internal/auth/claude/pkce.go, internal/auth/codex/pkce.go (identical)
// and misc.GenerateRandomState from internal/misc/oauth.go.

/** Verifier/challenge pair for the OAuth2 PKCE (S256) extension. */
export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

function base64UrlNoPad(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 96 random bytes, base64url encoded without padding (128 characters). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  return base64UrlNoPad(bytes);
}

/** SHA-256 of the verifier, base64url encoded without padding. */
export function generateCodeChallenge(codeVerifier: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(codeVerifier).digest();
  return base64UrlNoPad(new Uint8Array(digest));
}

/** Creates a fresh verifier/challenge pair. */
export function generatePKCECodes(): PKCECodes {
  const codeVerifier = generateCodeVerifier();
  return { codeVerifier, codeChallenge: generateCodeChallenge(codeVerifier) };
}

/** 16 random bytes, hex encoded. Used as the OAuth `state` parameter. */
export function generateRandomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
