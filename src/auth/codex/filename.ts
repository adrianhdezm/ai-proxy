// Codex credential file naming. Port of internal/auth/codex/filename.go.

function normalizePlanTypeForFilename(planType: string): string {
  const trimmed = planType.trim();
  if (trimmed === "") return "";
  const parts = trimmed.split(/[^\p{L}\p{N}]+/u).filter((p) => p !== "");
  if (parts.length === 0) return "";
  return parts.map((p) => p.trim().toLowerCase()).join("-");
}

/**
 * Returns the filename used to persist Codex OAuth credentials. The account
 * hash keeps accounts with the same email and plan distinct; the legacy
 * email-based format remains the fallback.
 */
export function credentialFileName(email: string, planType: string, hashAccountID: string, includeProviderPrefix: boolean): string {
  email = email.trim();
  const plan = normalizePlanTypeForFilename(planType);
  hashAccountID = hashAccountID.trim();
  const prefix = includeProviderPrefix ? "codex" : "";

  if (hashAccountID !== "") {
    if (plan === "") return `${prefix}-${hashAccountID}-${email}.json`;
    return `${prefix}-${hashAccountID}-${email}-${plan}.json`;
  }
  if (plan === "") return `${prefix}-${email}.json`;
  return `${prefix}-${email}-${plan}.json`;
}

/** First 8 hex characters of the SHA-256 of the account id (sdk/auth/codex_device.go buildAuthRecord). */
export function hashAccountID(accountID: string): string {
  const trimmed = accountID.trim();
  if (trimmed === "") return "";
  return new Bun.CryptoHasher("sha256").update(trimmed).digest("hex").slice(0, 8);
}
