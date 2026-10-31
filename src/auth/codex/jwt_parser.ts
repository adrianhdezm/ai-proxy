// Unverified JWT claim parsing for the Codex ID token. Port of
// internal/auth/codex/jwt_parser.go.

export interface Organizations {
  id: string;
  is_default: boolean;
  role: string;
  title: string;
}

export interface CodexAuthInfo {
  chatgpt_account_id: string;
  chatgpt_plan_type: string;
  chatgpt_subscription_active_start?: unknown;
  chatgpt_subscription_active_until?: unknown;
  chatgpt_subscription_last_checked?: string;
  chatgpt_user_id: string;
  groups: unknown[];
  organizations: Organizations[];
  user_id: string;
}

export interface JWTClaims {
  at_hash: string;
  aud: string[];
  auth_provider: string;
  auth_time: number;
  email: string;
  email_verified: boolean;
  exp: number;
  /** The "https://api.openai.com/auth" claim. */
  codexAuthInfo: CodexAuthInfo;
  iat: number;
  iss: string;
  jti: string;
  rat: number;
  sid: string;
  sub: string;
}

/** Default subscription plan type when not present in the claims. */
export const DefaultPlanType = "free";

export const CodexAuthClaimKey = "https://api.openai.com/auth";

function emptyAuthInfo(): CodexAuthInfo {
  return { chatgpt_account_id: "", chatgpt_plan_type: "", chatgpt_user_id: "", groups: [], organizations: [], user_id: "" };
}

/** Base64url decode adding padding when needed. */
export function base64URLDecode(data: string): Uint8Array {
  let s = data;
  switch (s.length % 4) {
    case 2:
      s += "==";
      break;
    case 3:
      s += "=";
      break;
  }
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Parses the claims of a JWT without verifying the signature. */
export function parseJWTToken(token: string): JWTClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error(`invalid JWT token format: expected 3 parts, got ${parts.length}`);
  let payload: string;
  try {
    payload = new TextDecoder().decode(base64URLDecode(parts[1]!));
  } catch (err) {
    throw new Error(`failed to decode JWT claims: ${(err as Error).message}`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`failed to unmarshal JWT claims: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object") throw new Error("failed to unmarshal JWT claims: not an object");
  const info = (raw[CodexAuthClaimKey] ?? {}) as Partial<CodexAuthInfo>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    at_hash: str(raw.at_hash),
    aud: Array.isArray(raw.aud) ? raw.aud.map(String) : typeof raw.aud === "string" ? [raw.aud] : [],
    auth_provider: str(raw.auth_provider),
    auth_time: num(raw.auth_time),
    email: str(raw.email),
    email_verified: raw.email_verified === true,
    exp: num(raw.exp),
    codexAuthInfo: {
      ...emptyAuthInfo(),
      ...info,
      chatgpt_account_id: str(info.chatgpt_account_id),
      chatgpt_plan_type: str(info.chatgpt_plan_type),
      chatgpt_user_id: str(info.chatgpt_user_id),
      user_id: str(info.user_id),
      groups: Array.isArray(info.groups) ? info.groups : [],
      organizations: Array.isArray(info.organizations) ? info.organizations : [],
    },
    iat: num(raw.iat),
    iss: str(raw.iss),
    jti: str(raw.jti),
    rat: num(raw.rat),
    sid: str(raw.sid),
    sub: str(raw.sub),
  };
}

export function getUserEmail(claims: JWTClaims | undefined): string {
  return claims?.email ?? "";
}

/** The ChatGPT account id. */
export function getAccountID(claims: JWTClaims | undefined): string {
  return claims?.codexAuthInfo.chatgpt_account_id ?? "";
}

/** The ChatGPT plan type, defaulting to "free" when missing or blank. */
export function getPlanType(claims: JWTClaims | undefined): string {
  const pt = claims?.codexAuthInfo.chatgpt_plan_type?.trim() ?? "";
  return pt !== "" ? pt : DefaultPlanType;
}
