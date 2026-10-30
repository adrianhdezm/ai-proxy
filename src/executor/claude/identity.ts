// Claude Code CLI credential identity for OAuth / claude-code-cli requests.
// Simplified port of internal/runtime/executor/helps/claude_credential_identity.go
// (ClaudeAgentSessionUUIDForRequest, ApplyClaudeCredentialMetadata) and
// helps/claude_cli_identity_seed.go (StableClaudeCLIAccountUUID,
// ClaudeCLIAuthIdentitySeed, PrepareClaudeCLIFingerprintAuth).
//
// Session identity: a confirmed native caller keeps its X-Claude-Code-Session-Id
// header or metadata.user_id session; every other caller gets a UUID derived from
// the stable conversation root (deriveClaudeUserID) so the id stays constant for
// one conversation and identical between the header and metadata.user_id.
import { type Auth, cloneAuth } from "../../auth/types.ts";
import { ensureDeviceIDPool, selectDeviceID } from "../../auth/claude/identity.ts";
import { deriveClaudeUserID } from "../../translator/common/claude_user_id.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { sha256Hex } from "../../util/hash.ts";
import { tryParse } from "../../util/json.ts";
import { ClaudeCodeSessionHeader, isUUID } from "./client_detection.ts";
import { StatusError } from "../types.ts";

/** Formats the first 16 bytes of a SHA-256 as a name-based (version 5 style) UUID. */
export function stableUUIDFromSeed(seed: string): string {
  const hex = sha256Hex(seed);
  const b = hex.slice(0, 32).split("");
  b[12] = "5";
  b[16] = ["8", "9", "a", "b"][parseInt(b[16]!, 16) % 4]!;
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Stable synthesized account UUID for credentials without a real one (Go: StableClaudeCLIAccountUUID). */
export function stableClaudeCLIAccountUUID(seed: string): string {
  return stableUUIDFromSeed("cli-proxy-api\x00claude\x00account-uuid\x00" + seed);
}

/** A stable credential identity that does not rotate with access tokens (Go: ClaudeCLIAuthIdentitySeed). */
export function claudeCLIAuthIdentitySeed(auth: Auth | undefined): string {
  const id = (auth?.id ?? "").trim();
  return id !== "" ? "auth-id|" + id : "";
}

/** The credential's account UUID from metadata (Go: ClaudeCredentialAccountUUID). */
export function claudeCredentialAccountUUID(auth: Auth | undefined): string {
  if (!auth) return "";
  for (const key of ["account_uuid", "accountUuid"]) {
    const v = auth.metadata?.[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

function sessionFromUserID(payload: string): string {
  const userID = getAt(tryParse(payload), "metadata.user_id");
  if (typeof userID !== "string") return "";
  const session = gstr(getAt(tryParse(userID), "session_id"));
  return isUUID(session) ? session.toLowerCase() : "";
}

/**
 * Resolves the agent-conversation UUID written to X-Claude-Code-Session-Id and
 * metadata.user_id.session_id (Go: ClaudeAgentSessionUUIDForRequest). Claude
 * specific session signals are honoured only for a confirmed native caller.
 */
export function claudeAgentSessionUUIDForRequest(
  headers: Headers | undefined,
  originalPayload: string,
  translatedPayload: string,
  confirmedClaudeCode: boolean,
  ...metadataSets: Array<Record<string, unknown> | undefined>
): string {
  if (confirmedClaudeCode) {
    const header = (headers?.get(ClaudeCodeSessionHeader) ?? "").trim();
    if (isUUID(header)) return header.toLowerCase();
    const fromBody = sessionFromUserID(originalPayload) || sessionFromUserID(translatedPayload);
    if (fromBody !== "") return fromBody;
  }
  for (const metadata of metadataSets) {
    const v = metadata?.["execution_session_id"] ?? metadata?.["session_id"];
    if (typeof v === "string" && v.trim() !== "") {
      const t = v.trim();
      return isUUID(t) ? t.toLowerCase() : stableUUIDFromSeed("cli-proxy-api\x00claude\x00agent-conversation\x00" + t);
    }
  }
  let identity = "";
  for (const payload of [originalPayload, translatedPayload]) {
    if (payload === "") continue;
    const stripped = stripMetadataUserID(payload);
    identity = deriveClaudeUserID(stripped);
    if (identity !== "" && identity !== "unknown") break;
  }
  if (identity === "" || identity === "unknown") return crypto.randomUUID();
  return stableUUIDFromSeed("cli-proxy-api\x00claude\x00agent-conversation\x00" + identity);
}

function stripMetadataUserID(payload: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || !isObj(root.metadata) || root.metadata.user_id === undefined) return payload;
  delete root.metadata.user_id;
  return JSON.stringify(root);
}

/** A cached per-credential session UUID used when a request carries no session identity (Go: CachedSessionIDRequired). */
const cachedSessionIDs = new Map<string, string>();

export function cachedSessionID(apiKey: string): string {
  const key = apiKey.trim();
  let id = cachedSessionIDs.get(key);
  if (!id) {
    id = crypto.randomUUID();
    cachedSessionIDs.set(key, id);
  }
  return id;
}

/** Test hook: forgets the cached session ids. */
export function resetCachedSessionIDs(): void {
  cachedSessionIDs.clear();
}

/**
 * Writes the Claude Code credential identity into metadata.user_id
 * (Go: applyClaudeCLIIdentity / ApplyClaudeCredentialMetadata). Real OAuth
 * credentials use their stored device pool and account UUID (the pool is created
 * on the auth when missing); with `synthesize` (API keys opted into the CLI
 * profile) a deterministic identity is derived from `seed` on a clone so the
 * shared credential metadata is not mutated.
 */
export function applyClaudeCLIIdentity(body: string, auth: Auth, seed: string, sessionID: string, synthesize: boolean): string {
  const root = tryParse<Record<string, unknown>>(body);
  if (!isObj(root)) throw new StatusError(400, "apply Claude credential metadata: request must be a JSON object", { requestScoped: true });
  let target = auth;
  if (synthesize) {
    target = cloneAuth(auth);
    const identitySeed = claudeCLIAuthIdentitySeed(auth) || seed;
    if (!Array.isArray(target.metadata.claude_device_ids) || target.metadata.claude_device_ids.length === 0) {
      target.metadata.claude_device_ids = [sha256Hex("cli-proxy-api\x00claude\x00device-id\x00" + identitySeed)];
    }
    if (claudeCredentialAccountUUID(target) === "") target.metadata.account_uuid = stableClaudeCLIAccountUUID(identitySeed);
  }
  const { deviceIDs } = ensureDeviceIDPool(target.metadata);
  const deviceID = selectDeviceID(deviceIDs, sessionID);
  let accountUUID = claudeCredentialAccountUUID(target);
  if (accountUUID === "") accountUUID = stableClaudeCLIAccountUUID(claudeCLIAuthIdentitySeed(auth) || seed);

  const extras: Record<string, unknown> = {};
  if (isObj(root.metadata) && typeof root.metadata.user_id === "string") {
    const existing = tryParse<Record<string, unknown>>(root.metadata.user_id);
    if (isObj(existing)) {
      for (const [k, v] of Object.entries(existing)) {
        if (k === "device_id" || k === "account_uuid" || k === "session_id") continue;
        extras[k] = v;
      }
    }
  }
  const userID = JSON.stringify({ device_id: deviceID, account_uuid: accountUUID, session_id: sessionID, ...extras });
  if (!isObj(root.metadata)) root.metadata = {};
  (root.metadata as Record<string, unknown>).user_id = userID;
  return JSON.stringify(root);
}
