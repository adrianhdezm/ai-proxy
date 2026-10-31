// Claude credential file naming and legacy-file matching. Port of
// internal/auth/claude/filename.go. The Go Auth has a separate FileName; in
// this port Auth.id is the file name.
import type { Auth } from "../types.ts";
import type { TokenStore } from "../../store/types.ts";
import { metadataString } from "../oauth/metadata.ts";

function sha256Prefix8(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * Returns the filename used to persist Claude OAuth credentials. The
 * organization hash keeps organizations with the same email distinct; the
 * account hash is used without an organization; the legacy email-only form
 * remains the fallback.
 */
export function credentialFileName(email: string, organizationUUID = "", accountUUID = ""): string {
  email = email.trim();
  let identity = organizationUUID.trim();
  if (identity === "") identity = accountUUID.trim();
  if (identity === "") return `claude-${email}.json`;
  return `claude-${sha256Prefix8(identity)}-${email}.json`;
}

function baseName(name: string): string {
  const idx = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function isHashedCredentialTarget(target: Auth): boolean {
  if (target.provider.trim().toLowerCase() !== "claude") return false;
  const email = metadataString(target.metadata, "email");
  const organizationUUID = metadataString(target.metadata, "organization_uuid");
  const accountUUID = metadataString(target.metadata, "account_uuid");
  if (email === "" || (organizationUUID === "" && accountUUID === "")) return false;
  return baseName(target.id.trim()).toLowerCase() === credentialFileName(email, organizationUUID, accountUUID).toLowerCase();
}

/**
 * Locates a prior record for the same Claude identity as target: the
 * email-only legacy name, or an account-hashed name that preceded an
 * organization-hashed target. Returns undefined when nothing matches.
 */
export async function findMatchingLegacyCredential(store: Pick<TokenStore, "list"> | undefined, target: Auth): Promise<Auth | undefined> {
  if (!store || !isHashedCredentialTarget(target)) return undefined;
  const records = await store.list();
  return findMatchingLegacyCredentialIn(records, target);
}

/** Same matching as findMatchingLegacyCredential over an already loaded list. */
export function findMatchingLegacyCredentialIn(records: Auth[], target: Auth): Auth | undefined {
  if (!isHashedCredentialTarget(target)) return undefined;
  const targetEmail = metadataString(target.metadata, "email");
  const targetOrganization = metadataString(target.metadata, "organization_uuid");
  const targetAccount = metadataString(target.metadata, "account_uuid");
  const legacyFileName = credentialFileName(targetEmail, "", "").toLowerCase();
  const accountFileName = targetOrganization !== "" && targetAccount !== "" ? credentialFileName(targetEmail, "", targetAccount).toLowerCase() : "";

  for (const candidate of records) {
    if (!candidate || candidate.provider.trim().toLowerCase() !== "claude") continue;
    const candidateBase = baseName(candidate.id.trim()).toLowerCase();
    const isEmailLegacy = candidateBase === legacyFileName;
    const isAccountPredecessor = accountFileName !== "" && candidateBase === accountFileName;
    if (!isEmailLegacy && !isAccountPredecessor) continue;

    const candidateOrganization = metadataString(candidate.metadata, "organization_uuid");
    const candidateAccount = metadataString(candidate.metadata, "account_uuid");
    if (targetOrganization !== "") {
      if (candidateOrganization !== "" && candidateOrganization.toLowerCase() === targetOrganization.toLowerCase()) return candidate;
      if (candidateOrganization === "" && isAccountPredecessor && candidateAccount !== "" && candidateAccount.toLowerCase() === targetAccount.toLowerCase()) return candidate;
    } else if (isEmailLegacy && candidateOrganization === "" && targetAccount !== "") {
      if (candidateAccount !== "" && candidateAccount.toLowerCase() === targetAccount.toLowerCase()) return candidate;
    }
  }
  return undefined;
}
