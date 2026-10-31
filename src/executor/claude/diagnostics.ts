// Per-session continuity (diagnostics.previous_message_id, cc_prev_req,
// cc_prompt_id) and the session date pin. Port of
// internal/runtime/executor/helps/claude_diagnostics.go (BeginClaudeContinuity,
// CommitClaudeContinuity, PinClaudeSessionDate, LookupClaudeSessionDatePin,
// IsValidClaudePromptID, ClaudeDeterministicPromptID, IsClaudeNewPromptTurn,
// Extract/Strip/InjectClaudeBillingTags) and
// internal/runtime/executor/claude_executor_diagnostics.go (injectClaudeDiagnostics,
// injectClaudeDiagnosticsWithState, commitClaudeContinuity,
// claudeDiagnosticsCredentialIdentity).
//
// The Go state is a process-global map behind a mutex; here it is a
// ClaudeContinuityStore with an injected clock. The executor uses
// defaultClaudeContinuityStore unless a store is configured.
import type { Auth } from "../../auth/types.ts";
import { normalizeDeviceIDPool, readDeviceIDPool } from "../../auth/claude/identity.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { sha256Bytes, sha256Hex } from "../../util/hash.ts";
import { tryParse } from "../../util/json.ts";
import { claudeCredentialAccountUUID } from "./identity.ts";
import { isClaudeProbeOrHelperRequest } from "./request_shape.ts";

export const claudeDiagnosticsTTLMs = 60 * 60_000;
export const claudeDiagnosticsCleanupPeriodMs = 15 * 60_000;
export const claudeDiagnosticsMaxEntries = 4096;
export const claudeDiagnosticsEvictBatchSize = 256;

const claudeRequestIDPattern = /^req_[A-Za-z0-9_-]{1,36}$/;
const claudePromptIDPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Request-scoped continuity resolved during cloaking (Go: helps.ClaudeContinuityContext). */
export interface ClaudeContinuityContext {
  key: string;
  sequence: number;
  previousMessageID: string;
  previousRequestID: string;
  promptID: string;
  /** Calendar date this session was first seen on; the currentDate reminder reuses it. */
  pinnedDate: string;
  initialized: boolean;
}

export function newClaudeContinuityContext(): ClaudeContinuityContext {
  return { key: "", sequence: 0, previousMessageID: "", previousRequestID: "", promptID: "", pinnedDate: "", initialized: false };
}

interface Entry {
  previousMessageID: string;
  previousRequestID: string;
  promptID: string;
  pinnedDate: string;
  minimumSequence: number;
  committedSequence: number;
  lastAccess: number;
  /** 0 = never expires. */
  expiresAt: number;
}

interface DatePin {
  date: string;
  expiresAt: number;
}

export interface ClaudeContinuityBegin {
  key: string;
  sequence: number;
  previousMessageID: string;
  previousRequestID: string;
  promptID: string;
}

/** Strict RFC 4122 UUIDv4 check for an explicit prompt id (Go: IsValidClaudePromptID). */
export function isValidClaudePromptID(id: string): boolean {
  id = id.trim();
  if (!claudePromptIDPattern.test(id)) return false;
  const version = id[14];
  const variant = id[19]!.toLowerCase();
  return version === "4" && (variant === "8" || variant === "9" || variant === "a" || variant === "b");
}

/** A deterministic RFC 4122 UUIDv4 derived from a seed (Go: ClaudeDeterministicPromptID). */
export function claudeDeterministicPromptID(seed: string): string {
  const d = sha256Bytes(seed);
  d[6] = (d[6]! & 0x0f) | 0x40;
  d[8] = (d[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(d.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Credential-independent store key of a session date pin (Go: ClaudeSessionDatePinKey). */
export function claudeSessionDatePinKey(sessionID: string): string {
  sessionID = sessionID.trim();
  return sessionID === "" ? "" : sha256Hex(sessionID);
}

export class ClaudeContinuityStore {
  private entries = new Map<string, Entry>();
  private datePins = new Map<string, DatePin>();
  private lastCleanup = 0;
  private nextSequence = 0;
  private nextAccess = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Starts one request generation for a credential identity and conversation
   * (Go: BeginClaudeContinuity). An explicit valid prompt id is adopted; a new
   * prompt turn (or a missing prompt id) gets a fresh UUIDv4.
   */
  begin(credentialIdentity: string, sessionID: string, isNewPromptTurn: boolean, explicitPromptID: string): ClaudeContinuityBegin {
    credentialIdentity = credentialIdentity.trim();
    sessionID = sessionID.trim();
    if (credentialIdentity === "" || sessionID === "") return { key: "", sequence: 0, previousMessageID: "", previousRequestID: "", promptID: "" };
    const key = sha256Hex(credentialIdentity + "\x00" + sessionID);
    const now = this.now();
    this.cleanup(now);
    let entry = this.entries.get(key);
    const found = entry !== undefined;
    const newGeneration = !entry || (entry.expiresAt !== 0 && now > entry.expiresAt);
    if (newGeneration && !found) this.evictEntries();
    const sequence = ++this.nextSequence;
    if (newGeneration || !entry) {
      entry = { previousMessageID: "", previousRequestID: "", promptID: "", pinnedDate: "", minimumSequence: sequence, committedSequence: 0, lastAccess: 0, expiresAt: 0 };
    }
    let activePromptID = entry.promptID;
    explicitPromptID = explicitPromptID.trim();
    if (explicitPromptID !== "" && isValidClaudePromptID(explicitPromptID)) activePromptID = explicitPromptID.toLowerCase();
    else if (isNewPromptTurn || activePromptID === "") activePromptID = crypto.randomUUID();
    entry.lastAccess = ++this.nextAccess;
    entry.expiresAt = now + claudeDiagnosticsTTLMs;
    this.entries.set(key, entry);
    return { key, sequence, previousMessageID: entry.previousMessageID, previousRequestID: entry.previousRequestID, promptID: activePromptID };
  }

  /** Go: BeginClaudeDiagnostics. */
  beginDiagnostics(credentialIdentity: string, sessionID: string): { key: string; sequence: number; previousMessageID: string } {
    const b = this.begin(credentialIdentity, sessionID, false, "");
    return { key: b.key, sequence: b.sequence, previousMessageID: b.previousMessageID };
  }

  /**
   * Advances continuity after a completed response (Go: CommitClaudeContinuity).
   * An older or expired generation never overwrites a newer committed one.
   */
  commit(key: string, sequence: number, messageID: string, requestID: string, promptID = ""): void {
    key = key.trim();
    messageID = messageID.trim();
    requestID = requestID.trim();
    if (key === "" || sequence === 0 || messageID === "") return;
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry || (entry.expiresAt !== 0 && now > entry.expiresAt) || sequence < entry.minimumSequence || sequence < entry.committedSequence) return;
    entry.previousMessageID = messageID;
    entry.previousRequestID = requestID !== "" && claudeRequestIDPattern.test(requestID) ? requestID : "";
    const pID = promptID.trim();
    if (pID !== "" && isValidClaudePromptID(pID)) entry.promptID = pID.toLowerCase();
    entry.committedSequence = sequence;
    entry.lastAccess = ++this.nextAccess;
    entry.expiresAt = now + claudeDiagnosticsTTLMs;
  }

  /** Go: CommitClaudeDiagnostics. */
  commitDiagnostics(key: string, sequence: number, messageID: string): void {
    this.commit(key, sequence, messageID, "");
  }

  /**
   * Returns the date pinned for a session, recording `date` on the first call
   * (Go: PinClaudeSessionDate). A non-positive retention keeps the
   * continuity-scoped pin; a positive one stores it under a session-only key so
   * continuity expiry or a credential switch cannot re-anchor it.
   */
  pinSessionDate(key: string, sessionID: string, date: string, retentionMs: number): string {
    key = key.trim();
    sessionID = sessionID.trim();
    date = date.trim();
    if (key === "" || date === "") return date;
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry) return date;
    if (retentionMs <= 0 || sessionID === "") {
      if (entry.pinnedDate === "") {
        entry.pinnedDate = date;
        return date;
      }
      return entry.pinnedDate;
    }
    this.cleanup(now);
    const pinKey = claudeSessionDatePinKey(sessionID);
    let pin = this.datePins.get(pinKey);
    if (!pin) {
      this.evictDatePins();
      pin = { date: "", expiresAt: 0 };
    }
    if (pin.date === "" || now > pin.expiresAt) pin.date = date;
    pin.expiresAt = now + retentionMs;
    this.datePins.set(pinKey, pin);
    return pin.date;
  }

  /** The retained pin without creating or refreshing it (Go: LookupClaudeSessionDatePin). */
  lookupSessionDatePin(sessionID: string, retentionMs: number): string {
    if (retentionMs <= 0) return "";
    const pinKey = claudeSessionDatePinKey(sessionID);
    if (pinKey === "") return "";
    const pin = this.datePins.get(pinKey);
    if (!pin || this.now() > pin.expiresAt) return "";
    return pin.date;
  }

  private cleanup(now: number): void {
    if (this.lastCleanup !== 0 && now - this.lastCleanup < claudeDiagnosticsCleanupPeriodMs) return;
    for (const [key, entry] of this.entries) if (entry.expiresAt !== 0 && now > entry.expiresAt) this.entries.delete(key);
    for (const [key, pin] of this.datePins) if (now > pin.expiresAt) this.datePins.delete(key);
    this.lastCleanup = now;
  }

  private evictEntries(): void {
    if (this.entries.size < claudeDiagnosticsMaxEntries) return;
    const candidates = [...this.entries].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [key] of candidates.slice(0, claudeDiagnosticsEvictBatchSize)) this.entries.delete(key);
  }

  private evictDatePins(): void {
    if (this.datePins.size < claudeDiagnosticsMaxEntries) return;
    const candidates = [...this.datePins].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [key] of candidates.slice(0, claudeDiagnosticsEvictBatchSize)) this.datePins.delete(key);
  }

  // --- test hooks (Go: Reset/Expire/...ForTest) ---

  reset(): void {
    this.entries.clear();
    this.datePins.clear();
    this.lastCleanup = 0;
    this.nextSequence = 0;
    this.nextAccess = 0;
  }

  /** Expires continuity entries and/or moves every pin expiry to now+offset. */
  expireForTest(expireContinuity: boolean, pinExpiryOffsetMs?: number): void {
    const now = this.now();
    if (expireContinuity) for (const entry of this.entries.values()) entry.expiresAt = now - 1000;
    if (pinExpiryOffsetMs !== undefined) for (const pin of this.datePins.values()) pin.expiresAt = now + pinExpiryOffsetMs;
    this.lastCleanup = 0;
  }

  expireEntryForTest(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.expiresAt = this.now() - 1000;
    this.lastCleanup = 0;
  }

  deleteEntryForTest(key: string): void {
    this.entries.delete(key);
  }

  sessionDatePinExpiryForTest(sessionID: string): number {
    return this.datePins.get(claudeSessionDatePinKey(sessionID))?.expiresAt ?? 0;
  }

  hasEntry(key: string): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Process-wide continuity state shared by every Claude executor without its own store. */
export const defaultClaudeContinuityStore = new ClaudeContinuityStore();

/**
 * Whether the request starts a new user prompt turn rather than a tool
 * continuation (Go: IsClaudeNewPromptTurn).
 */
export function isClaudeNewPromptTurn(body: string | unknown): boolean {
  const root = typeof body === "string" ? tryParse(body) : body;
  if (isClaudeProbeOrHelperRequest(root)) return false;
  const messages = getAt(root, "messages");
  if (!Array.isArray(messages) || messages.length === 0) return true;
  const last = messages[messages.length - 1];
  if (gstr(getAt(last, "role")) !== "user") return false;
  const content = getAt(last, "content");
  if (Array.isArray(content)) {
    for (const part of content) if (gstr(getAt(part, "type")) === "tool_result") return false;
  }
  return true;
}

const claudePrevReqBillingPattern = /\s*cc_prev_req=[^;]+;/g;
const claudePromptIDBillingPattern = /\s*cc_prompt_id=[^;]+;/g;
const billingPrefix = "x-anthropic-billing-header:";

function billingTextOf(root: unknown): string {
  const system = getAt(root, "system");
  if (Array.isArray(system) && system.length > 0) return gstr(getAt(system[0], "text"));
  if (typeof system === "string") return system;
  return "";
}

/** Existing cc_prev_req / cc_prompt_id of a billing header (Go: ExtractClaudeBillingTags). */
export function extractClaudeBillingTags(body: string | unknown): { prevReq: string; promptID: string } {
  const root = typeof body === "string" ? tryParse(body) : body;
  const text = billingTextOf(root);
  let prevReq = "";
  let promptID = "";
  if (text === "" || !text.startsWith(billingPrefix)) return { prevReq, promptID };
  const tag = (name: string): string | undefined => {
    const idx = text.indexOf(name);
    if (idx < 0) return undefined;
    let val = text.slice(idx + name.length);
    const end = val.indexOf(";");
    if (end >= 0) val = val.slice(0, end);
    return val;
  };
  const pr = tag("cc_prev_req=");
  if (pr !== undefined && claudeRequestIDPattern.test(pr)) prevReq = pr;
  const pid = tag("cc_prompt_id=");
  if (pid !== undefined && isValidClaudePromptID(pid)) promptID = pid.toLowerCase();
  return { prevReq, promptID };
}

function setBillingText(body: string, update: (text: string) => string): string {
  const root = tryParse<Record<string, unknown>>(body);
  if (!isObj(root) || !Array.isArray(root.system) || root.system.length === 0) return body;
  const first = root.system[0];
  if (!isObj(first)) return body;
  const text = gstr(first.text);
  if (!text.startsWith(billingPrefix)) return body;
  const updated = update(text);
  if (updated === text) return body;
  first.text = updated;
  return JSON.stringify(root);
}

/** Removes cc_prev_req and cc_prompt_id from the billing header (Go: StripClaudeBillingTags). */
export function stripClaudeBillingTags(body: string): string {
  return setBillingText(body, (t) => t.replace(claudePrevReqBillingPattern, "").replace(claudePromptIDBillingPattern, ""));
}

/** Replaces cc_prev_req and cc_prompt_id on the billing header (Go: InjectClaudeBillingTags). */
export function injectClaudeBillingTags(body: string, prevReq: string, promptID: string): string {
  return setBillingText(body, (t) => {
    let cleaned = t.replace(claudePrevReqBillingPattern, "").replace(claudePromptIDBillingPattern, "").trim();
    if (!cleaned.endsWith(";")) cleaned += ";";
    if (prevReq !== "") cleaned += " cc_prev_req=" + prevReq + ";";
    if (promptID !== "") cleaned += " cc_prompt_id=" + promptID + ";";
    return cleaned;
  });
}

// --- executor-level diagnostics ----------------------------------------------

/** What a request needs to commit continuity after its response (Go: claudeDiagnosticsRequestState). */
export interface ClaudeDiagnosticsRequestState {
  key: string;
  sequence: number;
  promptID: string;
}

export function emptyClaudeDiagnosticsState(): ClaudeDiagnosticsRequestState {
  return { key: "", sequence: 0, promptID: "" };
}

/** A stable credential identity that survives token rotation (Go: claudeDiagnosticsCredentialIdentity). */
export function claudeDiagnosticsCredentialIdentity(auth: Auth | undefined): string {
  if (!auth) return "";
  const id = (auth.id ?? "").trim();
  if (id !== "") return "id:" + id;
  const index = typeof (auth as { index?: unknown }).index === "string" ? ((auth as { index?: string }).index ?? "").trim() : "";
  if (index !== "") return "index:" + index;
  const deviceIDs = normalizeDeviceIDPool(readDeviceIDPool(auth.metadata));
  if (deviceIDs.length > 0) return "device:" + deviceIDs[0];
  const account = claudeCredentialAccountUUID(auth);
  if (account !== "") return "account:" + account;
  return "";
}

/**
 * Sets diagnostics.previous_message_id in Claude Code's native field order:
 * replaced in place when present, otherwise right after context_management,
 * otherwise appended (Go: injectClaudeDiagnosticsWithState).
 */
export function injectClaudeDiagnosticsWithState(body: string, key: string, sequence: number, previousMessageID: string, promptID = ""): { body: string; state: ClaudeDiagnosticsRequestState } {
  if (key === "") return { body, state: emptyClaudeDiagnosticsState() };
  const root = tryParse<Record<string, unknown>>(body);
  if (!isObj(root)) return { body, state: emptyClaudeDiagnosticsState() };
  const value = { previous_message_id: previousMessageID !== "" ? previousMessageID : null };
  const state = { key, sequence, promptID };
  if (root.diagnostics !== undefined || root.context_management === undefined) {
    root.diagnostics = value;
    return { body: JSON.stringify(root), state };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) {
    out[k] = v;
    if (k === "context_management") out.diagnostics = value;
  }
  return { body: JSON.stringify(out), state };
}

/** Starts continuity for the request and injects diagnostics (Go: injectClaudeDiagnostics). */
export function injectClaudeDiagnostics(store: ClaudeContinuityStore, body: string, auth: Auth | undefined, sessionID: string): { body: string; state: ClaudeDiagnosticsRequestState } {
  const b = store.begin(claudeDiagnosticsCredentialIdentity(auth), sessionID, false, "");
  return injectClaudeDiagnosticsWithState(body, b.key, b.sequence, b.previousMessageID, b.promptID);
}

/** Commits the upstream message and request ids for the request (Go: commitClaudeContinuity). */
export function commitClaudeContinuity(store: ClaudeContinuityStore, state: ClaudeDiagnosticsRequestState, messageID: string, requestID: string): void {
  store.commit(state.key, state.sequence, messageID, requestID, state.promptID);
}
