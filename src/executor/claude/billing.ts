// Claude Code billing header, currentDate reminder and continuity tags. Port of
// the billing / date / continuity parts of
// internal/runtime/executor/claude_executor_cloaking.go: computeFingerprint,
// generateBillingHeader, resolveClaudeContinuityTags,
// claudeBillingFingerprintMessageText, claudeCCHFallbackBillingHeader,
// claudeCodeLocalDate / claudeCodeCurrentTime / claudeCodeTimezone,
// claudeCodeCurrentDateReminder, resolveClaudeSessionPinnedDate,
// claudeCallerCurrentDateReminderDate, stripFirstUserClaudeCodeCurrentDateReminder
// and injectClaudeCodeCurrentDate(Internal).
//
// Go threads the request-scoped values (incoming headers, session id, execution
// metadata flag, continuity context, workload) through context.Context; here they
// travel in a ClaudeRequestContext.
import type { Auth } from "../../auth/types.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { sha256Hex } from "../../util/hash.ts";
import { tryParse } from "../../util/json.ts";
import {
  type ClaudeContinuityContext,
  type ClaudeContinuityStore,
  claudeDeterministicPromptID,
  claudeDiagnosticsCredentialIdentity,
  extractClaudeBillingTags,
  isClaudeNewPromptTurn,
} from "./diagnostics.ts";
import { claudeAgentSessionUUIDForRequest } from "./identity.ts";
import { firstClaudeUserMessageIndex, isClaudeProbeOrHelperRequest, isClaudeSubagentRequest } from "./request_shape.ts";

/** Salt Claude Code uses for the 3-char build fingerprint in cc_version. */
export const fingerprintSalt = "59cf53e54c78";

/** Default session-date pin retention in days (Go: DefaultClaudeSessionDatePinDays). */
export const defaultClaudeSessionDatePinDays = 7;

/** Request-scoped state Go carries in context.Context. */
export interface ClaudeRequestContext {
  store: ClaudeContinuityStore;
  incomingHeaders?: Headers;
  /** Session id resolved by the executor for CLI-profile credentials ("" otherwise). */
  sessionID: string;
  /** Whether the request carried execution_session_id metadata. */
  hasExecutionMetadata: boolean;
  /** Mutable continuity filled in by cloaking. */
  continuity: ClaudeContinuityContext;
  /** X-CPA-Claude-Workload of the inbound request. */
  workload: string;
  /** Clock for the currentDate reminder. */
  now: () => number;
  /** Session date pin retention in ms (0 = continuity-scoped pin). */
  sessionDatePinRetentionMs: number;
  /** Configured fallback IANA timezone ("" = process local). */
  timezone: string;
}

/**
 * The 3-char build fingerprint (Go: computeFingerprint): SHA-256 over salt +
 * UTF-16 code units 4, 7, 20 of the message text ('0' when missing) + version.
 */
export function computeFingerprint(messageText: string, version: string): string {
  const sampled = [4, 7, 20].map((idx) => (idx < messageText.length ? messageText.charCodeAt(idx) : 0x30));
  const input = fingerprintSalt + String.fromCharCode(...sampled) + version;
  return sha256Hex(new TextEncoder().encode(input)).slice(0, 3);
}

/** The x-anthropic-billing-header text (Go: generateBillingHeader). cch only on signed paths. */
export function generateBillingHeader(
  cchSigning: boolean,
  version: string,
  messageText: string,
  entrypoint: string,
  workload: string,
  isSubagent: boolean,
  prevReq: string,
  promptID: string,
  turnOrigin = "",
): string {
  if (entrypoint === "") entrypoint = "cli";
  let b = `x-anthropic-billing-header: cc_version=${version}.${computeFingerprint(messageText, version)}; cc_entrypoint=${entrypoint};`;
  if (cchSigning) b += " cch=00000;";
  if (workload !== "") b += ` cc_workload=${workload};`;
  if (isSubagent) b += " cc_is_subagent=true;";
  if (cchSigning) {
    if (prevReq !== "") b += ` cc_prev_req=${prevReq};`;
    if (promptID !== "") b += ` cc_prompt_id=${promptID};`;
    if (turnOrigin === "human") b += " cc_turn_origin=human;";
  }
  return b;
}

export const claudeCodeCurrentDateReminderPrefix = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is ";

export function claudeCodeCurrentDateReminder(date: string): string {
  return (
    claudeCodeCurrentDateReminderPrefix +
    date +
    ".\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n"
  );
}

export function isClaudeCodeContextReminder(text: string): boolean {
  return text.startsWith("<system-reminder>") && text.includes("</system-reminder>");
}

export function isClaudeCodeCurrentDateReminder(text: string): boolean {
  return text.startsWith(claudeCodeCurrentDateReminderPrefix);
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** The YYYY-MM-DD of a currentDate reminder, "" when invalid (Go: claudeCodeCurrentDateReminderDate). */
export function claudeCodeCurrentDateReminderDate(text: string): string {
  if (!text.startsWith(claudeCodeCurrentDateReminderPrefix)) return "";
  const rest = text.slice(claudeCodeCurrentDateReminderPrefix.length);
  if (rest.length < 11 || rest[10] !== ".") return "";
  const date = rest.slice(0, 10);
  return validDate(date) ? date : "";
}

/** The first message text, skipping proxy reminders: it seeds the build hash (Go: claudeBillingFingerprintMessageText). */
export function claudeBillingFingerprintMessageText(payload: string | unknown): string {
  const root = typeof payload === "string" ? tryParse(payload) : payload;
  const idx = firstClaudeUserMessageIndex(root);
  if (idx < 0) return "";
  const content = getAt(root, `messages.${idx}.content`);
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (gstr(getAt(part, "type")) !== "text") continue;
      const text = gstr(getAt(part, "text"));
      if (!isClaudeCodeCurrentDateReminder(text) && !isClaudeCodeContextReminder(text)) return text;
    }
  }
  return "";
}

/** True when the IANA zone is known to the runtime. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date YYYY-MM-DD of an instant in a zone (Go: claudeCodeLocalDate); undefined zone = process local. */
export function claudeCodeLocalDate(epochMs: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

/** The credential's timezone attribute or metadata (Go: claudeCredentialTimezone). */
export function claudeCredentialTimezone(auth: Auth | undefined): string {
  if (!auth) return "";
  const attr = (auth.attributes?.timezone ?? "").trim();
  if (attr !== "") return attr;
  const meta = auth.metadata?.timezone;
  return typeof meta === "string" ? meta.trim() : "";
}

/** Credential zone, then configured zone, then process local (undefined) (Go: claudeCodeTimezone). */
export function claudeCodeTimezone(configured: string | undefined, auth: Auth | undefined): string | undefined {
  const credential = claudeCredentialTimezone(auth);
  if (credential !== "" && isValidTimeZone(credential)) return credential;
  const tz = (configured ?? "").trim();
  if (tz === "" || !isValidTimeZone(tz)) return undefined;
  return tz;
}

/** Today's date for the credential (Go: claudeCodeLocalDate(claudeCodeCurrentTime(cfg, auth))). */
export function claudeCodeCurrentDate(rc: Pick<ClaudeRequestContext, "now" | "timezone">, auth: Auth | undefined): string {
  return claudeCodeLocalDate(rc.now(), claudeCodeTimezone(rc.timezone, auth));
}

/** Date of the first caller currentDate reminder in the first user message (Go: claudeCallerCurrentDateReminderDate). */
export function claudeCallerCurrentDateReminderDate(payload: string | unknown): string {
  const root = typeof payload === "string" ? tryParse(payload) : payload;
  const idx = firstClaudeUserMessageIndex(root);
  if (idx < 0) return "";
  const content = getAt(root, `messages.${idx}.content`);
  if (typeof content === "string") return claudeCodeCurrentDateReminderDate(content);
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (gstr(getAt(block, "type")) !== "text") continue;
    const date = claudeCodeCurrentDateReminderDate(gstr(getAt(block, "text")));
    if (date !== "") return date;
  }
  return "";
}

/** Removes a leading caller currentDate reminder from string content (Go: stripClaudeCodeCurrentDateReminder). */
export function stripClaudeCodeCurrentDateReminder(text: string): string {
  if (claudeCodeCurrentDateReminderDate(text) === "") return text;
  const end = text.indexOf("</system-reminder>");
  if (end < 0) return text;
  return text.slice(end + "</system-reminder>".length).replace(/^\n+/, "");
}

/** Strips a caller reminder from a string-form first user message (Go: stripFirstUserClaudeCodeCurrentDateReminder). */
export function stripFirstUserClaudeCodeCurrentDateReminder(payload: string): string {
  const root = tryParse<Record<string, unknown>>(payload);
  const idx = firstClaudeUserMessageIndex(root);
  if (idx < 0 || !isObj(root) || !Array.isArray(root.messages)) return payload;
  const message = root.messages[idx];
  if (!isObj(message) || typeof message.content !== "string") return payload;
  const stripped = stripClaudeCodeCurrentDateReminder(message.content);
  if (stripped === message.content) return payload;
  message.content = stripped;
  return JSON.stringify(root);
}

/** Native default {"type":"ephemeral"} breakpoint on a block (Go: withEphemeralCacheControl). */
function withEphemeralCacheControl(block: Record<string, unknown>): Record<string, unknown> {
  return { ...block, cache_control: { type: "ephemeral" } };
}

/**
 * Stamps the currentDate reminder into the first user message (Go:
 * injectClaudeCodeCurrentDateInternal). The reminder goes first, or after
 * leading tool_result blocks; the first real user text gets the default
 * ephemeral breakpoint unless the caller runs explicit cache placement.
 */
export function injectClaudeCodeCurrentDate(payload: string, date: string, isExplicit = false): string {
  const root = tryParse<Record<string, unknown>>(payload);
  const idx = firstClaudeUserMessageIndex(root);
  if (idx < 0 || !isObj(root) || !Array.isArray(root.messages)) return payload;
  const message = root.messages[idx];
  if (!isObj(message)) return payload;
  const content = message.content;
  const dateBlock = { type: "text", text: claudeCodeCurrentDateReminder(date) };
  if (typeof content === "string") {
    const userBlock: Record<string, unknown> = { type: "text", text: content };
    if (!isExplicit && content.trim() !== "") userBlock.cache_control = { type: "ephemeral" };
    message.content = [dateBlock, userBlock];
    return JSON.stringify(root);
  }
  if (!Array.isArray(content)) return payload;
  const blocks: unknown[] = [];
  let actualTextCached = false;
  for (const block of content) {
    if (isObj(block) && block.type === "text") {
      const text = gstr(block.text);
      if (isClaudeCodeCurrentDateReminder(text)) continue;
      if (!actualTextCached && !isClaudeCodeContextReminder(text) && text.trim() !== "" && !isExplicit) {
        blocks.push(withEphemeralCacheControl(block));
        actualTextCached = true;
        continue;
      }
    }
    blocks.push(block);
  }
  let insertAt = 0;
  while (insertAt < blocks.length && gstr(getAt(blocks[insertAt], "type")) === "tool_result") insertAt++;
  blocks.splice(insertAt, 0, dateBlock);
  message.content = blocks;
  return JSON.stringify(root);
}

/**
 * Resolves the session date pin (Go: resolveClaudeSessionPinnedDate). With a
 * retention an existing pin always wins; a caller reminder only seeds the first
 * anchor.
 */
export function resolveClaudeSessionPinnedDate(rc: ClaudeRequestContext, auth: Auth | undefined, payload: string, continuityKey: string, sessionID: string): string {
  const retention = rc.sessionDatePinRetentionMs;
  let candidate = claudeCodeCurrentDate(rc, auth);
  if (retention <= 0) return rc.store.pinSessionDate(continuityKey, sessionID, candidate, retention);
  const existing = rc.store.lookupSessionDatePin(sessionID, retention);
  if (existing !== "") return rc.store.pinSessionDate(continuityKey, sessionID, existing, retention);
  const callerDate = claudeCallerCurrentDateReminderDate(payload);
  if (callerDate !== "") candidate = callerDate;
  return rc.store.pinSessionDate(continuityKey, sessionID, candidate, retention);
}

/**
 * Begins continuity for a cloaked request and resolves cc_prev_req /
 * cc_prompt_id and the pinned date (Go: resolveClaudeContinuityTags).
 * Returns undefined without a session identity.
 */
export function resolveClaudeContinuityTags(
  rc: ClaudeRequestContext,
  auth: Auth | undefined,
  payload: string,
  confirmedClaudeCode: boolean,
  existingPrevReq: string,
  existingPromptID: string,
): { prevReq: string; promptID: string; continuity: ClaudeContinuityContext } | undefined {
  const hasExecutionMetadata = rc.hasExecutionMetadata;
  let sessionID = rc.sessionID;
  if (sessionID === "" && auth) sessionID = claudeAgentSessionUUIDForRequest(rc.incomingHeaders, payload, payload, confirmedClaudeCode);
  if (sessionID === "" || !auth) return undefined;

  const isNewTurn = isClaudeNewPromptTurn(payload);
  const begin = rc.store.begin(claudeDiagnosticsCredentialIdentity(auth), sessionID, isNewTurn, existingPromptID);
  const pinnedDate = resolveClaudeSessionPinnedDate(rc, auth, payload, begin.key, sessionID);

  let promptID: string;
  if (existingPromptID !== "") promptID = existingPromptID;
  else if (begin.previousMessageID !== "" && begin.promptID !== "" && (hasExecutionMetadata || !isNewTurn)) promptID = begin.promptID;
  else if (!hasExecutionMetadata) promptID = claudeDeterministicPromptID("cpa:prompt:" + claudeBillingFingerprintMessageText(payload));
  else promptID = begin.promptID;

  const prevReq = (hasExecutionMetadata || existingPrevReq !== "") && begin.previousRequestID !== "" ? begin.previousRequestID : existingPrevReq;
  const carry = hasExecutionMetadata || existingPrevReq !== "";
  return {
    prevReq,
    promptID,
    continuity: {
      key: begin.key,
      sequence: begin.sequence,
      promptID,
      pinnedDate,
      initialized: true,
      previousMessageID: carry ? begin.previousMessageID : "",
      previousRequestID: carry ? begin.previousRequestID : "",
    },
  };
}

/**
 * The billing header CPA adds when the body carries none on a signed path
 * (Go: claudeCCHFallbackBillingHeader). Probe/helper requests omit the
 * continuity tags.
 */
export function claudeCCHFallbackBillingHeader(rc: ClaudeRequestContext, version: string, payload: string, entrypoint: string): string {
  const root = tryParse(payload);
  const isProbeOrHelper = isClaudeProbeOrHelperRequest(root);
  let { prevReq, promptID } = extractClaudeBillingTags(root);
  if (!isProbeOrHelper && rc.continuity) {
    if (prevReq === "") prevReq = rc.continuity.previousRequestID;
    if (promptID === "") promptID = rc.continuity.promptID;
  }
  const isSubagent = isClaudeSubagentRequest(rc.incomingHeaders, root);
  return generateBillingHeader(true, version, claudeBillingFingerprintMessageText(root), entrypoint, rc.workload, isSubagent, prevReq, promptID);
}
