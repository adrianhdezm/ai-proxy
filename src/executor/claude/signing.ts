// CCH request signing. Port of internal/runtime/executor/claude_signing.go
// (claudeCCHSigningEnabled, signAnthropicMessagesBody, normalizeClaudeCCHInput,
// claudeBillingCCHDigitsOffset, ensureClaudeBillingHeaderCCHPlaceholder,
// prependClaudeBillingSystemBlock, finalizeAnthropicMessagesBodyCCH,
// claudeBodyNeedsBillingFallback).
//
// The hash runs over the exact serialized body, so every edit here works on the
// raw JSON text and never re-serialises it. Offsets are UTF-16 indices into the
// JS string; every edit sits on ASCII JSON structure, so hashing the UTF-8
// encoding of the edited string matches the Go byte-level algorithm.
// Kimi-specific helpers (isKimiMessagesUpstream, stripDefaultKimiClaudeCodeAttribution)
// are not ported: Kimi is not a kept upstream.
import { getAt } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { isAnthropicUpstreamBase, isClaudeOAuthToken } from "./upstream.ts";

export const claudeCCHSeed = 0x4d659218e32a3268n;
export const claudeCCHLength = 5;
export const claudeCCHZero = "00000";
const billingPrefix = "x-anthropic-billing-header:";

/** Kind of upstream the request goes to (Go: claudeCCHUpstreamKind). */
export enum ClaudeCCHUpstreamKind {
  Other = 0,
  Anthropic = 1,
  Vertex = 2,
}

/**
 * CPA's CCH policy (Go: claudeCCHSigningEnabled). A real Claude OAuth credential
 * always signs; an API key signs only when it opted into the claude-code-cli
 * profile and the concrete upstream is api.anthropic.com over https on the
 * default port. Vertex always signs.
 */
export function claudeCCHSigningEnabled(apiKey: string, kind: ClaudeCCHUpstreamKind, cliFingerprint: boolean, origin: string): boolean {
  if (isClaudeOAuthToken(apiKey)) return true;
  if (kind === ClaudeCCHUpstreamKind.Vertex) return true;
  if (!cliFingerprint) return false;
  return kind === ClaudeCCHUpstreamKind.Anthropic && isAnthropicUpstreamBase(origin);
}

/**
 * Whether a confirmed native helper request still needs the billing fallback
 * (Go: claudeBodyNeedsBillingFallback): only when a system field exists.
 */
export function claudeBodyNeedsBillingFallback(body: string): boolean {
  const root = tryParse(body);
  return getAt(root, "system") !== undefined;
}

// --- raw JSON scanning ------------------------------------------------------

class RawScanner {
  pos = 0;
  constructor(readonly body: string) {}

  skipWhitespace(): void {
    while (this.pos < this.body.length) {
      const c = this.body[this.pos];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") this.pos++;
      else return;
    }
  }

  consume(ch: string): boolean {
    if (this.body[this.pos] !== ch) return false;
    this.pos++;
    return true;
  }

  /** Scans a string token and returns [start, end) including the quotes. */
  parseString(): [number, number] {
    if (this.body[this.pos] !== '"') throw new Error(`missing JSON string at byte ${this.pos}`);
    const start = this.pos;
    this.pos++;
    while (this.pos < this.body.length) {
      const c = this.body[this.pos];
      if (c === "\\") this.pos += 2;
      else if (c === '"') {
        this.pos++;
        return [start, this.pos];
      } else this.pos++;
    }
    throw new Error(`unterminated JSON string at byte ${start}`);
  }

  /** Skips one value without collecting anything. */
  skipValue(): void {
    this.skipWhitespace();
    const c = this.body[this.pos];
    if (c === undefined) throw new Error(`missing JSON value at byte ${this.pos}`);
    if (c === '"') {
      this.parseString();
      return;
    }
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      this.pos++;
      this.skipWhitespace();
      if (this.consume(close)) return;
      for (;;) {
        if (c === "{") {
          this.skipWhitespace();
          this.parseString();
          this.skipWhitespace();
          if (!this.consume(":")) throw new Error(`missing object colon at byte ${this.pos}`);
        }
        this.skipValue();
        this.skipWhitespace();
        if (this.consume(",")) continue;
        if (!this.consume(close)) throw new Error(`missing container end at byte ${this.pos}`);
        return;
      }
    }
    const start = this.pos;
    while (this.pos < this.body.length && !",}] \t\r\n".includes(this.body[this.pos]!)) this.pos++;
    if (this.pos === start) throw new Error(`missing JSON value at byte ${start}`);
  }
}

/**
 * Locates the raw span [start, end) of the value at `path` (object keys and
 * array indices), taking the first matching key like gjson does.
 */
export function rawJSONValueSpan(body: string, path: ReadonlyArray<string | number>): { start: number; end: number } | undefined {
  const s = new RawScanner(body);
  try {
    for (const segment of path) {
      s.skipWhitespace();
      const c = s.body[s.pos];
      if (typeof segment === "number") {
        if (c !== "[") return undefined;
        s.pos++;
        s.skipWhitespace();
        if (s.body[s.pos] === "]") return undefined;
        for (let i = 0; ; i++) {
          s.skipWhitespace();
          if (i === segment) break;
          s.skipValue();
          s.skipWhitespace();
          if (!s.consume(",")) return undefined;
        }
        continue;
      }
      if (c !== "{") return undefined;
      s.pos++;
      s.skipWhitespace();
      if (s.body[s.pos] === "}") return undefined;
      for (;;) {
        s.skipWhitespace();
        const [ks, ke] = s.parseString();
        s.skipWhitespace();
        if (!s.consume(":")) return undefined;
        s.skipWhitespace();
        if (JSON.parse(body.slice(ks, ke)) === segment) break;
        s.skipValue();
        s.skipWhitespace();
        if (!s.consume(",")) return undefined;
      }
    }
    s.skipWhitespace();
    const start = s.pos;
    s.skipValue();
    return { start, end: s.pos };
  } catch {
    return undefined;
  }
}

function billingText(body: string): string | undefined {
  const text = getAt(tryParse(body), "system.0.text");
  return typeof text === "string" && text.startsWith(billingPrefix) ? text : undefined;
}

function isLowerHex(value: string): boolean {
  return value.length === claudeCCHLength && /^[0-9a-f]+$/.test(value);
}

/** Offset of the five CCH digits inside the raw body (Go: claudeBillingCCHDigitsOffset). */
export function claudeBillingCCHDigitsOffset(body: string): number | undefined {
  if (billingText(body) === undefined) return undefined;
  const span = rawJSONValueSpan(body, ["system", 0, "text"]);
  if (!span) return undefined;
  const raw = body.slice(span.start, span.end);
  for (let searchFrom = 0; searchFrom < raw.length; ) {
    const prefix = raw.indexOf("cch=", searchFrom);
    if (prefix < 0) return undefined;
    const digits = prefix + "cch=".length;
    const end = digits + claudeCCHLength;
    if (end < raw.length && raw[end] === ";" && isLowerHex(raw.slice(digits, end))) return span.start + digits;
    searchFrom = digits;
  }
  return undefined;
}

// --- hash view --------------------------------------------------------------

interface Edit {
  start: number;
  end: number;
}

interface Member {
  start: number;
  end: number;
  commaBefore: number;
  commaAfter: number;
  excluded: boolean;
}

function isClaudeCCHExcludedKey(rawKey: string): boolean {
  return rawKey === `"max_tokens"` || rawKey === `"fallbacks"` || rawKey === `"fallback_credit_token"`;
}

class CCHScanner extends RawScanner {
  readonly edits: Edit[] = [];

  addEdit(start: number, end: number): void {
    if (start < end) this.edits.push({ start, end });
  }

  parseValue(collect: boolean): void {
    this.skipWhitespace();
    const c = this.body[this.pos];
    if (c === undefined) throw new Error(`missing JSON value at byte ${this.pos}`);
    if (c === "{") return this.parseObject(collect);
    if (c === "[") return this.parseArray(collect);
    if (c === '"') {
      this.parseString();
      return;
    }
    const start = this.pos;
    while (this.pos < this.body.length && !",}] \t\r\n".includes(this.body[this.pos]!)) this.pos++;
    if (this.pos === start) throw new Error(`missing JSON value at byte ${start}`);
  }

  parseObject(collect: boolean): void {
    this.pos++;
    this.skipWhitespace();
    if (this.consume("}")) return;
    const members: Member[] = [];
    let commaBefore = -1;
    for (;;) {
      this.skipWhitespace();
      const memberStart = this.pos;
      const [keyStart, keyEnd] = this.parseString();
      this.skipWhitespace();
      if (!this.consume(":")) throw new Error(`missing object colon at byte ${this.pos}`);
      this.skipWhitespace();
      const key = this.body.slice(keyStart, keyEnd);
      const excluded = collect && isClaudeCCHExcludedKey(key);
      if (collect && key === `"model"` && this.body[this.pos] === '"') {
        const [valueStart, valueEnd] = this.parseString();
        this.addEdit(valueStart + 1, valueEnd - 1);
      } else {
        this.parseValue(collect && !excluded);
      }
      const memberEnd = this.pos;
      this.skipWhitespace();
      let commaAfter = -1;
      if (this.consume(",")) commaAfter = this.pos - 1;
      members.push({ start: memberStart, end: memberEnd, commaBefore, commaAfter, excluded });
      if (commaAfter >= 0) {
        commaBefore = commaAfter;
        continue;
      }
      if (!this.consume("}")) throw new Error(`missing object end at byte ${this.pos}`);
      break;
    }
    if (collect) this.addExcludedMemberEdits(members);
  }

  parseArray(collect: boolean): void {
    this.pos++;
    this.skipWhitespace();
    if (this.consume("]")) return;
    for (;;) {
      this.parseValue(collect);
      this.skipWhitespace();
      if (this.consume(",")) continue;
      if (!this.consume("]")) throw new Error(`missing array end at byte ${this.pos}`);
      return;
    }
  }

  addExcludedMemberEdits(members: Member[]): void {
    for (let start = 0; start < members.length; ) {
      if (!members[start]!.excluded) {
        start++;
        continue;
      }
      let end = start;
      while (end + 1 < members.length && members[end + 1]!.excluded) end++;
      if (end + 1 < members.length) {
        this.addEdit(members[start]!.start, members[end]!.commaAfter + 1);
      } else if (start > 0 && end > start) {
        // Claude Code 2.1.220 leaves the preceding comma in its hash view when an
        // object ends with multiple consecutive dispatch members.
        this.addEdit(members[start]!.start, members[end]!.end);
      } else if (start > 0) {
        this.addEdit(members[start]!.commaBefore, members[end]!.end);
      } else {
        this.addEdit(members[start]!.start, members[end]!.end);
      }
      start = end + 1;
    }
  }
}

/**
 * Builds the hash view without reserialising JSON (Go: normalizeClaudeCCHInput):
 * model string values are emptied and dispatch-only members are omitted.
 */
export function normalizeClaudeCCHInput(body: string): string {
  if (tryParse(body) === undefined) throw new Error("invalid JSON body");
  const scanner = new CCHScanner(body);
  scanner.parseValue(true);
  scanner.skipWhitespace();
  if (scanner.pos !== body.length) throw new Error(`unexpected JSON data at byte ${scanner.pos}`);
  const edits = [...scanner.edits].sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const edit of edits) {
    if (edit.start < last || edit.end > body.length) throw new Error(`overlapping CCH normalization edit at byte ${edit.start}`);
    out += body.slice(last, edit.start);
    last = edit.end;
  }
  return out + body.slice(last);
}

/**
 * Reproduces Claude Code 2.1.220's final-body CCH (Go: signAnthropicMessagesBody).
 * Only the five CCH digits change. Throws on an invalid body.
 */
export function signAnthropicMessagesBody(body: string): string {
  const offset = claudeBillingCCHDigitsOffset(body);
  if (offset === undefined) return body;
  const unsigned = body.slice(0, offset) + claudeCCHZero + body.slice(offset + claudeCCHLength);
  const normalized = normalizeClaudeCCHInput(unsigned);
  const hash = Bun.hash.xxHash64(new TextEncoder().encode(normalized), claudeCCHSeed);
  const cch = (BigInt.asUintN(64, BigInt(hash)) & 0xfffffn).toString(16).padStart(claudeCCHLength, "0");
  return unsigned.slice(0, offset) + cch + unsigned.slice(offset + claudeCCHLength);
}

/** A {"type":"text","text":...} block without HTML escaping (Go: buildTextBlock with nil cache control). */
function rawTextBlock(text: string): string {
  return `{"type":"text","text":${JSON.stringify(text)}}`;
}

/** Prepends the billing block to the system field, keeping the existing raw blocks (Go: prependClaudeBillingSystemBlock). */
export function prependClaudeBillingSystemBlock(body: string, billing: string): string {
  const billingBlock = rawTextBlock(billing);
  const span = rawJSONValueSpan(body, ["system"]);
  const system = getAt(tryParse(body), "system");
  let systemArray: string;
  if (typeof system === "string") {
    systemArray = `[${billingBlock},${rawTextBlock(system)}]`;
  } else if (Array.isArray(system) && span) {
    const raw = body.slice(span.start, span.end).trim();
    systemArray = system.length === 0 ? `[${billingBlock}]` : `[${billingBlock},${raw.slice(1)}`;
  } else {
    systemArray = `[${billingBlock}]`;
  }
  if (span) return body.slice(0, span.start) + systemArray + body.slice(span.end);
  // sjson appends a new member at the end of the root object.
  const root = tryParse<Record<string, unknown>>(body);
  if (root === undefined || typeof root !== "object" || root === null || Array.isArray(root)) throw new Error("prepend Claude CCH billing block: body is not a JSON object");
  const close = body.lastIndexOf("}");
  const hasMembers = Object.keys(root).length > 0;
  return body.slice(0, close) + (hasMembers ? "," : "") + `"system":${systemArray}` + body.slice(close);
}

/**
 * Ensures system[0] is a billing header carrying a cch=00000 placeholder
 * (Go: ensureClaudeBillingHeaderCCHPlaceholder). Without a billing block the
 * fallback is prepended; without a fallback the body is returned unchanged.
 */
export function ensureClaudeBillingHeaderCCHPlaceholder(body: string, fallbackBilling: string): string {
  let billing = billingText(body);
  if (billing === undefined) {
    if (fallbackBilling === "") return body;
    body = prependClaudeBillingSystemBlock(body, fallbackBilling);
    billing = billingText(body);
    if (billing === undefined) return body;
  }
  if (claudeBillingCCHDigitsOffset(body) !== undefined) return body;
  const entrypoint = billing.indexOf("cc_entrypoint=");
  if (entrypoint < 0) return body;
  const entrypointEnd = billing.slice(entrypoint).indexOf(";");
  if (entrypointEnd < 0) return body;
  const insertAt = entrypoint + entrypointEnd + 1;
  const updated = billing.slice(0, insertAt) + " cch=00000;" + billing.slice(insertAt);
  const span = rawJSONValueSpan(body, ["system", 0, "text"]);
  if (!span) return body;
  return body.slice(0, span.start) + JSON.stringify(updated) + body.slice(span.end);
}

/** Inserts the placeholder (or fallback block) and signs (Go: finalizeAnthropicMessagesBodyCCH). */
export function finalizeAnthropicMessagesBodyCCH(body: string, fallbackBilling: string): string {
  return signAnthropicMessagesBody(ensureClaudeBillingHeaderCCHPlaceholder(body, fallbackBilling));
}
