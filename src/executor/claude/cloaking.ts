// Cloaking policy and the simplified Claude Code identity injection. Port of the
// essential parts of internal/runtime/executor/claude_executor_cloaking.go and
// claude_fingerprint_policy.go:
//
//   - resolveClaudeFingerprintPolicy / resolveClaudeWirePolicy / getCloakConfigFromAuth
//   - applyCloaking: identity system block first, caller system blocks kept after it
//     (strict mode drops them), non-text caller system blocks rejected, thinking
//     display default, metadata.user_id (fake id for non-CLI-profile credentials;
//     the CLI identity is applied later by applyClaudeCLIIdentity)
//   - uncloakClaudeCodePayload / stripClaudeCodeSystemBlocks
//   - validateClaudeCallerSystemBlocks / validateClaudeMidSystemMessageModel
//   - rebuildMidSystemMessagesToTopLevel (opt-in)
//
//   - the x-anthropic-billing-header block, continuity tags and the session-pinned
//     currentDate reminder (billing.ts); CCH signing itself is in signing.ts
//
// Not ported: relocation of caller system prompts into mid-conversation
// role=system turns / <system-reminder> blocks, fallbacks / Fable reporting
// injection and sensitive-word obfuscation.
import type { Auth } from "../../auth/types.ts";
import { AttributeAuthKind } from "../../auth/types.ts";
import { isClaudeCodeAttributionSystemText, stripClaudeCodeAttributionSystem } from "../../util/claude_attribution.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { type ClaudeCodeRequestDetection, generateFakeUserIDWithSessionID, isValidUserID } from "./client_detection.ts";
import { newClaudeCallerSystemBlockError, newClaudeMidSystemMessageModelError } from "./errors.ts";
import { claudeModelUsesProgressDisplay } from "./model.ts";
import {
  claudePayloadHasMidSystemMessage,
  claudeSubagentRequests1h,
  claudeUsesLegacySystemReminder,
  isClaudeProbeOrHelperRequest,
  isClaudeSubagentRequest,
} from "./request_shape.ts";
import {
  type ClaudeRequestContext,
  claudeBillingFingerprintMessageText,
  claudeCodeCurrentDate,
  generateBillingHeader,
  injectClaudeCodeCurrentDate,
  resolveClaudeContinuityTags,
  stripFirstUserClaudeCodeCurrentDateReminder,
} from "./billing.ts";
import { stripClaudeCacheControlTTL } from "./cache_control.ts";
import { extractClaudeBillingTags } from "./diagnostics.ts";
import { isClaudeOAuthToken } from "./upstream.ts";

export const claudeCodeCLIIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";

export type ClaudeCloakMode = "auto" | "always" | "never";

/** Credential-scoped fingerprint behaviour (Go: claudeFingerprintPolicy). */
export interface ClaudeFingerprintPolicy {
  authIsOAuthToken: boolean;
  profileClaudeCodeCLI: boolean;
  useOAuthBetas: boolean;
  applyCLIIdentity: boolean;
  synthesizeIdentity: boolean;
}

export interface ClaudeWirePolicy {
  oauth: boolean;
  profileClaudeCodeCLI: boolean;
  confirmedClaudeCode: boolean;
  cloak: boolean;
  uncloak: boolean;
  explicitNever: boolean;
}

export interface ClaudeCloakSettings {
  strictMode: boolean;
  sensitiveWords: string[];
  cacheUserID: boolean;
}

/** The subset of executor configuration the cloaking rules read. */
export interface ClaudeCloakConfig {
  /** Default cloak mode when the credential sets none ("never" is upstream disable-claude-cloak-mode). */
  cloakMode?: ClaudeCloakMode;
}

const claudeFingerprintProfileClaudeCodeCLI = "claude-code-cli";

function metadataString(auth: Auth | undefined, key: string): string {
  const v = auth?.metadata?.[key];
  return typeof v === "string" ? v.trim() : "";
}

function claudeFingerprintProfileFromAuth(auth: Auth | undefined): string {
  if (!auth) return "";
  const attr = (auth.attributes?.fingerprint_profile ?? "").trim();
  if (attr !== "") return attr.toLowerCase();
  for (const key of ["fingerprint_profile", "fingerprint-profile"]) {
    const raw = metadataString(auth, key);
    if (raw !== "") return raw.toLowerCase();
  }
  return "";
}

/** Resolves credential-scoped fingerprint behaviour (Go: resolveClaudeFingerprintPolicy). */
export function resolveClaudeFingerprintPolicy(auth: Auth | undefined, apiKey: string): ClaudeFingerprintPolicy {
  const authIsOAuth = isClaudeOAuthToken(apiKey);
  const profileClaudeCodeCLI = authIsOAuth || claudeFingerprintProfileFromAuth(auth) === claudeFingerprintProfileClaudeCodeCLI;
  return {
    authIsOAuthToken: authIsOAuth,
    profileClaudeCodeCLI,
    useOAuthBetas: profileClaudeCodeCLI,
    applyCLIIdentity: profileClaudeCodeCLI,
    synthesizeIdentity: profileClaudeCodeCLI && !authIsOAuth,
  };
}

/** Cloak configuration from the auth attributes, falling back to its metadata (Go: getCloakConfigFromAuth). */
export function getCloakConfigFromAuth(auth: Auth | undefined): { cloakMode: string } & ClaudeCloakSettings {
  if (!auth) return { cloakMode: "", strictMode: false, sensitiveWords: [], cacheUserID: false };
  const lookup = (key: string): string => {
    const attr = (auth.attributes?.[key] ?? "").trim();
    if (attr !== "") return attr;
    return metadataString(auth, key);
  };
  const words = lookup("cloak_sensitive_words");
  return {
    cloakMode: lookup("cloak_mode"),
    strictMode: lookup("cloak_strict_mode").toLowerCase() === "true",
    sensitiveWords: words === "" ? [] : words.split(",").map((w) => w.trim()),
    cacheUserID: lookup("cloak_cache_user_id").toLowerCase() === "true",
  };
}

/** Resolves the wire policy for one request (Go: resolveClaudeWirePolicy). */
export function resolveClaudeWirePolicy(cfg: ClaudeCloakConfig | undefined, auth: Auth | undefined, apiKey: string, confirmedClaudeCode: boolean): [ClaudeWirePolicy, ClaudeCloakSettings] {
  const attr = getCloakConfigFromAuth(auth);
  let cloakMode: string = cfg?.cloakMode ?? "auto";
  const settings: ClaudeCloakSettings = { strictMode: attr.strictMode, sensitiveWords: attr.sensitiveWords, cacheUserID: attr.cacheUserID };
  const explicitMode = attr.cloakMode.toLowerCase();
  if (attr.cloakMode !== "") cloakMode = attr.cloakMode;
  const fp = resolveClaudeFingerprintPolicy(auth, apiKey);
  const cloakConfigured = attr.cloakMode !== "" || attr.strictMode || attr.sensitiveWords.length > 0 || attr.cacheUserID;
  const trimmedMode = cloakMode.trim().toLowerCase();
  const uncloak = !fp.profileClaudeCodeCLI && (explicitMode === "never" || explicitMode === "uncloak");
  const explicitNever = trimmedMode === "never" && !uncloak;
  const policy: ClaudeWirePolicy = {
    oauth: fp.authIsOAuthToken,
    profileClaudeCodeCLI: fp.profileClaudeCodeCLI,
    confirmedClaudeCode,
    cloak: (fp.profileClaudeCodeCLI || cloakConfigured) && !confirmedClaudeCode && !uncloak,
    uncloak,
    explicitNever,
  };
  if (confirmedClaudeCode) {
    policy.cloak = false;
    return [policy, settings];
  }
  switch (trimmedMode) {
    case "always":
      policy.cloak = true;
      break;
    case "never":
    case "uncloak":
      policy.cloak = false;
      break;
    default:
      // auto: cloak real OAuth credentials, CLI-profile opt-ins and credentials with explicit cloak settings.
      break;
  }
  return [policy, settings];
}

export function isEffectiveConfirmedClaudeCode(detection: ClaudeCodeRequestDetection, policy: ClaudeWirePolicy): boolean {
  if (policy.uncloak) return false;
  if (detection.confirmed) return true;
  return !policy.cloak && policy.explicitNever && detection.confirmedShape;
}

export function isClaudeCodeIdentitySystemText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed === claudeCodeCLIIdentity ||
    trimmed === "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." ||
    trimmed === "You are a Claude agent, built on Anthropic's Claude Agent SDK."
  );
}

/** Removes the attribution and identity system blocks (Go: stripClaudeCodeSystemBlocks). */
export function stripClaudeCodeSystemBlocks(payload: string): string {
  payload = stripClaudeCodeAttributionSystem(payload);
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || root.system === undefined) return payload;
  const system = root.system;
  if (typeof system === "string") {
    if (!isClaudeCodeIdentitySystemText(system)) return payload;
    delete root.system;
    return JSON.stringify(root);
  }
  if (!Array.isArray(system)) return payload;
  const kept = system.filter((block) => !(gstr(getAt(block, "type")) === "text" && isClaudeCodeIdentitySystemText(gstr(getAt(block, "text")))));
  if (kept.length === system.length) return payload;
  if (kept.length === 0) delete root.system;
  else root.system = kept;
  return JSON.stringify(root);
}

/** Strips Claude Code identity, a Claude Code shaped metadata.user_id and diagnostics (Go: uncloakClaudeCodePayload). */
export function uncloakClaudeCodePayload(payload: string, confirmedClaudeCode: boolean): string {
  payload = stripClaudeCodeSystemBlocks(payload);
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root)) return payload;
  let changed = false;
  if (isObj(root.metadata) && root.metadata.user_id !== undefined) {
    const userID = root.metadata.user_id;
    if (confirmedClaudeCode || (typeof userID === "string" && isValidUserID(userID))) {
      delete root.metadata.user_id;
      if (Object.keys(root.metadata).length === 0) delete root.metadata;
      changed = true;
    }
  }
  if (isObj(root.diagnostics) && (confirmedClaudeCode || root.diagnostics.previous_message_id !== undefined)) {
    delete root.diagnostics;
    changed = true;
  }
  return changed ? JSON.stringify(root) : payload;
}

/** Rejects caller system content that no Claude system slot can carry (Go: validateClaudeCallerSystemBlocks). */
export function validateClaudeCallerSystemBlocks(system: unknown): void {
  if (!Array.isArray(system)) return;
  for (let i = 0; i < system.length; i++) {
    const type = gstr(getAt(system[i], "type")).trim();
    if (type !== "text") throw newClaudeCallerSystemBlockError(i, type);
  }
}

/**
 * Rejects a request pairing a legacy model with a caller's mid-conversation
 * role=system turn, which api.anthropic.com answers with a guaranteed 400
 * (Go: validateClaudeMidSystemMessageModel).
 */
export function validateClaudeMidSystemMessageModel(payload: string, confirmedClaudeCode: boolean, firstPartyAnthropic: boolean): void {
  if (confirmedClaudeCode || !firstPartyAnthropic) return;
  const root = tryParse(payload);
  if (!claudeUsesLegacySystemReminder(root) || !claudePayloadHasMidSystemMessage(root)) return;
  throw newClaudeMidSystemMessageModelError(gstr(getAt(root, "model")));
}

function claudeSystemTextParts(content: unknown): unknown[] {
  if (content === undefined) return [];
  if (typeof content === "string") return content.trim() === "" ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item.trim() !== "") parts.push({ type: "text", text: item });
      continue;
    }
    if (isObj(item) && item.type === "text" && gstr(item.text).trim() !== "") parts.push(item);
  }
  return parts;
}

/** Folds {"role":"system"} turns into the top-level system field (Go: rebuildMidSystemMessagesToTopLevel). */
export function rebuildMidSystemMessagesToTopLevel(payload: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || !Array.isArray(root.messages)) return payload;
  const moved: unknown[] = [];
  const kept: unknown[] = [];
  for (const message of root.messages) {
    if (gstr(getAt(message, "role")).trim().toLowerCase() === "system") {
      moved.push(...claudeSystemTextParts(getAt(message, "content")));
      continue;
    }
    kept.push(message);
  }
  if (moved.length === 0) return payload;
  const systemParts = [...claudeSystemTextParts(root.system), ...moved];
  if (systemParts.length > 0) root.system = systemParts;
  root.messages = kept;
  return JSON.stringify(root);
}

/** Fills the latest CLI display only when the caller did not choose one (Go: applyClaudeCloakThinkingDisplay). */
export function applyClaudeCloakThinkingDisplay(payload: string, callerOwned: boolean): string {
  if (callerOwned || payload === "") return payload;
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || !isObj(root.thinking) || root.thinking.display !== undefined) return payload;
  if (!claudeModelUsesProgressDisplay(gstr(root.model))) return payload;
  const type = gstr(root.thinking.type).trim().toLowerCase();
  if (type !== "adaptive" && type !== "enabled") return payload;
  root.thinking.display = "updates";
  return JSON.stringify(root);
}

interface ForwardedSystemBlock {
  text: string;
  cacheControl?: unknown;
}

function collectForwardedClaudeSystemPromptBlocks(system: unknown): ForwardedSystemBlock[] {
  const blocks: ForwardedSystemBlock[] = [];
  const append = (text: string, cacheControl?: unknown): void => {
    if (text.trim() === "" || isClaudeCodeAttributionSystemText(text) || isClaudeCodeIdentitySystemText(text)) return;
    blocks.push({ text, cacheControl });
  };
  if (typeof system === "string") {
    append(system);
    return blocks;
  }
  if (!Array.isArray(system)) return blocks;
  for (const item of system) {
    if (gstr(getAt(item, "type")) !== "text") continue;
    const cc = getAt(item, "cache_control");
    append(gstr(getAt(item, "text")), isObj(cc) && cc.type === "ephemeral" ? cc : undefined);
  }
  return blocks;
}

export interface ApplyCloakingOptions {
  /** Whether the caller runs explicit prompt-cache placement (no synthetic markers). */
  explicitCacheMode?: boolean;
  /** Session UUID written to a synthesized metadata.user_id for non-CLI-profile credentials. */
  sessionID?: string;
  /** Whether the billing header carries the cch=00000 placeholder and the continuity tags. */
  cchSigning?: boolean;
  /** cc_version of the billing header (default 2.1.280). */
  billingVersion?: string;
  /** Request context for continuity, the session date pin and the workload tag. */
  rc?: ClaudeRequestContext;
}

export interface CloakResult {
  payload: string;
  cloaked: boolean;
}

/**
 * Applies the wire policy to a Messages body (Go: applyCloakingInternal).
 * Returns the body and whether cloaking ran. Throws a request-scoped
 * StatusError for caller system blocks Claude cannot carry.
 *
 * The cloaked body carries the billing header block (system[0]), the Claude
 * Code identity block (system[1]), the caller system blocks after them, and the
 * session-pinned currentDate reminder in the first user message. Continuity
 * (cc_prev_req / cc_prompt_id, diagnostics state) is written to opts.rc.continuity.
 * Deviation: caller system blocks stay top-level instead of being relocated into
 * mid-conversation system turns, and fallbacks / Fable reporting blocks are not injected.
 */
export function applyCloaking(cfg: ClaudeCloakConfig | undefined, auth: Auth | undefined, payload: string, apiKey: string, confirmedClaudeCode: boolean, opts: ApplyCloakingOptions = {}): CloakResult {
  const [policy, settings] = resolveClaudeWirePolicy(cfg, auth, apiKey, confirmedClaudeCode);
  if (!policy.cloak) {
    if (policy.uncloak) payload = uncloakClaudeCodePayload(payload, confirmedClaudeCode);
    return { payload, cloaked: false };
  }
  let root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root)) return { payload, cloaked: false };
  if (!settings.strictMode) validateClaudeCallerSystemBlocks(root.system);

  const rc = opts.rc;
  const isExplicit = opts.explicitCacheMode === true;
  const isProbeOrHelper = isClaudeProbeOrHelperRequest(root);
  let isSubagent = false;
  let prevReq = "";
  let promptID = "";
  let pinnedDate = "";
  if (!isProbeOrHelper) {
    isSubagent = isClaudeSubagentRequest(rc?.incomingHeaders, root);
    const existing = extractClaudeBillingTags(root);
    if (rc) {
      const resolved = resolveClaudeContinuityTags(rc, auth, payload, confirmedClaudeCode, existing.prevReq, existing.promptID);
      if (resolved) {
        prevReq = resolved.prevReq;
        promptID = resolved.promptID;
        pinnedDate = resolved.continuity.pinnedDate;
        Object.assign(rc.continuity, resolved.continuity);
      }
    }
  }
  // Without continuity (probe/helper traffic or no session) the date is per request.
  if (pinnedDate === "") pinnedDate = claudeCodeCurrentDate(rc ?? { now: () => Date.now(), timezone: "" }, auth);
  if (!isProbeOrHelper && rc && rc.sessionDatePinRetentionMs > 0) {
    payload = stripFirstUserClaudeCodeCurrentDateReminder(payload);
    root = tryParse<Record<string, unknown>>(payload) as Record<string, unknown>;
  }
  const turnOrigin = !isProbeOrHelper && !isSubagent ? "human" : "";
  const billing = generateBillingHeader(
    opts.cchSigning === true,
    opts.billingVersion ?? "2.1.280",
    claudeBillingFingerprintMessageText(root),
    "cli",
    rc?.workload ?? "",
    isSubagent,
    prevReq,
    promptID,
    turnOrigin,
  );

  const identityBlock: Record<string, unknown> = { type: "text", text: claudeCodeCLIIdentity };
  if (!isExplicit) identityBlock.cache_control = { type: "ephemeral" };
  const systemBlocks: unknown[] = [{ type: "text", text: billing }, identityBlock];
  if (!settings.strictMode) {
    for (const block of collectForwardedClaudeSystemPromptBlocks(root.system)) {
      const forwarded: Record<string, unknown> = { type: "text", text: block.text };
      if (isExplicit) {
        if (block.cacheControl !== undefined) forwarded.cache_control = block.cacheControl;
      } else {
        forwarded.cache_control = { type: "ephemeral" };
      }
      systemBlocks.push(forwarded);
    }
  }
  root.system = systemBlocks;
  let out = injectClaudeCodeCurrentDate(JSON.stringify(root), pinnedDate, isExplicit);
  if (!isProbeOrHelper) out = applyClaudeCloakThinkingDisplay(out, false);
  // Probes never use the 1h pool; subagents keep it only when they asked for it.
  if (!isExplicit && (isProbeOrHelper || (isSubagent && !claudeSubagentRequests1h(rc?.incomingHeaders, out)))) out = stripClaudeCacheControlTTL(out);

  // The CLI identity (real OAuth or claude-code-cli profile) is applied later via
  // applyClaudeCLIIdentity; other cloaked credentials get the legacy fake user_id.
  if (!policy.profileClaudeCodeCLI) out = injectFakeUserID(out, opts.sessionID ?? crypto.randomUUID());
  return { payload: out, cloaked: true };
}

/** Injects a Claude Code shaped metadata.user_id when missing or malformed (Go: injectFakeUserID). */
export function injectFakeUserID(payload: string, sessionID: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root)) return payload;
  if (!isObj(root.metadata)) {
    root.metadata = { user_id: generateFakeUserIDWithSessionID(sessionID) };
    return JSON.stringify(root);
  }
  const existing = root.metadata.user_id;
  if (typeof existing !== "string" || existing === "" || !isValidUserID(existing)) {
    root.metadata.user_id = generateFakeUserIDWithSessionID(sessionID);
    return JSON.stringify(root);
  }
  return payload;
}

/** Whether the auth is an API-key record (used by the wire policy for config scoping). */
export function authIsAPIKeyKind(auth: Auth | undefined): boolean {
  const kind = (auth?.attributes?.[AttributeAuthKind] ?? "").trim().toLowerCase();
  return kind === "apikey" || kind === "api_key" || kind === "api-key";
}
