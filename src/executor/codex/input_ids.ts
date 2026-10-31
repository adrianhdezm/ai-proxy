// Port of internal/runtime/executor/helps/codex_input_ids.go.
//
// Normalises supported Responses input item ids for Codex (msg_/rs_/fc_/ctc_/
// ctco_ prefixes), drops encrypted reasoning items whose ids exceed the Codex
// limit, and deterministically shortens other overlong ids with a SHA-256 suffix.
import { sha256Hex } from "../../util/hash.ts";
import { getAt, gstr, isArr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

export const codexInputItemIDLimit = 64;
const codexMessageItemIDPrefix = "msg";
const codexReasoningItemIDPrefix = "rs";
const codexFunctionCallItemIDPrefix = "fc";
const codexCustomToolCallItemIDPrefix = "ctc";
const codexCustomToolCallOutputItemIDPrefix = "ctco";

const stateOccupied = 1 << 0;
const statePreserved = 1 << 1;

function runeLen(s: string): number {
  return Array.from(s).length;
}

/** Go: SanitizeCodexInputItemIDs. Returns the body unchanged (same string) when nothing changed. */
export function sanitizeCodexInputItemIDs(body: string): string {
  const root = tryParse(body);
  if (!isObj(root) || !isArr(root.input)) return body;
  const items = root.input;
  const idStates = new Map<string, number>();
  const stateOf = (id: string) => idStates.get(id) ?? 0;
  for (const item of items) {
    if (shouldDropCodexEncryptedReasoningItem(item)) continue;
    const itemID = getAt(item, "id");
    if (typeof itemID !== "string") continue;
    const id = normalizeCodexInputItemID(item, itemID);
    let state = stateOf(id);
    if (id === itemID) state |= statePreserved;
    if (runeLen(id) <= codexInputItemIDLimit) state |= stateOccupied;
    if (state !== 0) idStates.set(id, state);
  }

  const mapped = new Map<string, string>();
  const collisionMapped = new Map<string, string>();
  const rebuilt: unknown[] = [];
  let changed = false;
  for (const item of items) {
    if (shouldDropCodexEncryptedReasoningItem(item)) {
      changed = true;
      continue;
    }
    const itemID = getAt(item, "id");
    if (typeof itemID === "string" && isObj(item)) {
      let id = normalizeCodexInputItemID(item, itemID);
      if (id !== itemID && (stateOf(id) & statePreserved) !== 0) {
        let collisionID = collisionMapped.get(id);
        if (collisionID === undefined) {
          for (let attempt = 0; ; attempt++) {
            collisionID = codexInputItemIDWithHashSuffix(id, attempt);
            if ((stateOf(collisionID) & stateOccupied) !== 0) continue;
            collisionMapped.set(id, collisionID);
            idStates.set(collisionID, stateOf(collisionID) | stateOccupied);
            break;
          }
        }
        id = collisionID!;
      }
      if (runeLen(id) > codexInputItemIDLimit) {
        let shortened = mapped.get(id);
        if (shortened === undefined) {
          shortened = shortenCodexInputItemID(id);
          for (let attempt = 1; ; attempt++) {
            if ((stateOf(shortened) & stateOccupied) === 0) break;
            shortened = shortenCodexInputItemIDWithAttempt(id, attempt);
          }
          mapped.set(id, shortened);
          idStates.set(shortened, stateOf(shortened) | stateOccupied);
        }
        id = shortened;
      }
      if (id !== itemID) {
        const copy: Record<string, unknown> = { ...item, id };
        rebuilt.push(copy);
        changed = true;
        continue;
      }
    }
    rebuilt.push(item);
  }
  if (!changed) return body;
  root.input = rebuilt;
  return JSON.stringify(root);
}

function normalizeCodexInputItemID(item: unknown, id: string): string {
  let prefix: string;
  switch (gstr(getAt(item, "type"))) {
    case "message":
      prefix = codexMessageItemIDPrefix;
      break;
    case "reasoning":
      prefix = codexReasoningItemIDPrefix;
      break;
    case "function_call":
      prefix = codexFunctionCallItemIDPrefix;
      break;
    case "custom_tool_call":
      prefix = codexCustomToolCallItemIDPrefix;
      break;
    case "custom_tool_call_output":
      prefix = codexCustomToolCallOutputItemIDPrefix;
      break;
    default:
      return id;
  }
  if (id === "" || id.startsWith(prefix)) return id;
  return prefix + "_" + id;
}

function shouldDropCodexEncryptedReasoningItem(item: unknown): boolean {
  if (gstr(getAt(item, "type")) !== "reasoning") return false;
  const itemID = getAt(item, "id");
  if (typeof itemID !== "string" || runeLen(itemID) <= codexInputItemIDLimit) return false;
  const encrypted = getAt(item, "encrypted_content");
  return typeof encrypted === "string" && encrypted !== "";
}

/** Go: shortenCodexInputItemID. */
export function shortenCodexInputItemID(id: string): string {
  return shortenCodexInputItemIDWithAttempt(id, 0);
}

function shortenCodexInputItemIDWithAttempt(id: string, attempt: number): string {
  const runes = Array.from(id);
  if (runes.length <= codexInputItemIDLimit) return id;
  return codexInputItemIDWithHashSuffixRunes(id, runes, attempt);
}

function codexInputItemIDWithHashSuffix(id: string, attempt: number): string {
  return codexInputItemIDWithHashSuffixRunes(id, Array.from(id), attempt);
}

function codexInputItemIDWithHashSuffixRunes(id: string, runes: string[], attempt: number): string {
  let hashInput = id;
  if (attempt > 0) hashInput += "\x00" + String(attempt);
  const suffix = "_" + sha256Hex(hashInput).slice(0, 16);
  let prefixLength = codexInputItemIDLimit - suffix.length;
  if (runes.length < prefixLength) prefixLength = runes.length;
  return runes.slice(0, prefixLength).join("") + suffix;
}
