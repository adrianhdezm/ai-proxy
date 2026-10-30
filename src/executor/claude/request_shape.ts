// Request-shape classifiers shared by the beta assembly, cloaking and headers.
// Port of the kept parts of internal/runtime/executor/helps/claude_diagnostics.go
// (IsClaudeProbeOrHelperRequest, IsClaudeSubagentRequest, ClaudePayloadHas1hTTL,
// ClaudeSubagentRequests1h) and claudePayloadHasMidSystemMessage /
// firstClaudeUserMessageIndex from the executor package.
import { getAt, gint, gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { claudeModelUsesLegacySystemReminder } from "./model.ts";
import { headerValueCaseInsensitive, headerValuesCaseInsensitive } from "./upstream.ts";

export type Payload = string | unknown;

/** Accepts a JSON string or an already parsed value. */
export function parsePayload(payload: Payload): unknown {
  return typeof payload === "string" ? tryParse(payload) : payload;
}

/** Minimal probe/preflight: max_tokens 1, no tools, a single short user turn (Go: isClaudeProbeRequest). */
export function isClaudeProbeRequest(payload: Payload): boolean {
  const root = parsePayload(payload);
  const maxTokens = getAt(root, "max_tokens");
  if (maxTokens === undefined || gint(maxTokens) !== 1) return false;
  const tools = getAt(root, "tools");
  if (Array.isArray(tools) && tools.length > 0) return false;
  const messages = getAt(root, "messages");
  if (!Array.isArray(messages) || messages.length === 0) return true;
  if (messages.length !== 1) return false;
  const first = messages[0];
  if (gstr(getAt(first, "role")) !== "user") return false;
  const content = getAt(first, "content");
  if (typeof content === "string") {
    const str = content.trim();
    return str === "quota" || str === "test" || str === "." || str === "probe";
  }
  if (Array.isArray(content)) {
    let nonReminder = 0;
    let matched = false;
    for (const part of content) {
      const t = gstr(getAt(part, "text")).trim();
      if (t.includes("<system-reminder>")) continue;
      nonReminder++;
      if (t === "quota" || t === "test" || t === "." || t === "probe" || (t === "Hi" && getAt(part, "cache_control") !== undefined)) matched = true;
    }
    return nonReminder === 1 && matched;
  }
  return false;
}

function matchesSystemTitleInstruction(text: string): boolean {
  return text.includes("naming a coding session") || text.includes("Return a short title") || text.includes("Write the title in the predominant language");
}

/** Automated title generation helper (Go: isClaudeTitleHelperRequest). */
export function isClaudeTitleHelperRequest(payload: Payload): boolean {
  const root = parsePayload(payload);
  const props = getAt(root, "output_config.format.schema.properties");
  if (props !== undefined) {
    if (isObj(props) && props.title !== undefined && Object.keys(props).length === 1) {
      return isClaudeTitleHelperInstruction(root);
    }
    return false;
  }
  const system = getAt(root, "system");
  if (Array.isArray(system)) {
    for (const part of system) if (matchesSystemTitleInstruction(gstr(getAt(part, "text")))) return true;
  } else if (typeof system === "string" && matchesSystemTitleInstruction(system)) {
    return true;
  }
  const messages = getAt(root, "messages");
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (gstr(getAt(msg, "role")) !== "system") continue;
      const content = getAt(msg, "content");
      if (Array.isArray(content)) {
        for (const part of content) if (matchesSystemTitleInstruction(gstr(getAt(part, "text")))) return true;
      } else if (matchesSystemTitleInstruction(gstr(content))) {
        return true;
      }
    }
  }
  return false;
}

function isClaudeTitleHelperInstruction(root: unknown): boolean {
  const system = getAt(root, "system");
  if (Array.isArray(system)) {
    for (const part of system) if (matchesSystemTitleInstruction(gstr(getAt(part, "text")))) return true;
  } else if (typeof system === "string" && matchesSystemTitleInstruction(system)) {
    return true;
  }
  const messages = getAt(root, "messages");
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = getAt(msg, "content");
      if (Array.isArray(content)) {
        for (const part of content) if (matchesSystemTitleInstruction(gstr(getAt(part, "text")))) return true;
      } else if (matchesSystemTitleInstruction(gstr(content))) {
        return true;
      }
    }
  }
  return false;
}

/** Probe/preflight or title helper traffic, which native Claude Code treats specially (Go: IsClaudeProbeOrHelperRequest). */
export function isClaudeProbeOrHelperRequest(payload: Payload): boolean {
  const root = parsePayload(payload);
  return isClaudeProbeRequest(root) || isClaudeTitleHelperRequest(root);
}

/** Whether the request originates from a Claude Code subagent (Go: IsClaudeSubagentRequest). */
export function isClaudeSubagentRequest(headers: Headers | undefined, payload: Payload): boolean {
  if (headerValueCaseInsensitive(headers, "X-Claude-Code-Agent-Id") !== "") return true;
  if (headerValueCaseInsensitive(headers, "X-Claude-Code-Parent-Agent-Id") !== "") return true;
  const root = parsePayload(payload);
  if (getAt(root, "metadata.user_id.parent_session_id") !== undefined) return true;
  const userID = getAt(root, "metadata.user_id");
  if (typeof userID === "string" && userID !== "" && userID.includes(`"parent_session_id"`)) return true;
  const system = getAt(root, "system");
  if (Array.isArray(system) && system.length > 0) {
    if (gstr(getAt(system[0], "text")).includes("cc_is_subagent=true")) return true;
  } else if (typeof system === "string" && system.includes("cc_is_subagent=true")) {
    return true;
  }
  return false;
}

/** Whether any cache_control block carries ttl "1h" (Go: ClaudePayloadHas1hTTL). */
export function claudePayloadHas1hTTL(payload: Payload): boolean {
  const root = parsePayload(payload);
  if (root === undefined) return false;
  const check = (item: unknown): boolean => {
    const cc = getAt(item, "cache_control");
    return isObj(cc) && gstr(cc.ttl) === "1h";
  };
  const tools = getAt(root, "tools");
  if (Array.isArray(tools)) for (const t of tools) if (check(t)) return true;
  const system = getAt(root, "system");
  if (Array.isArray(system)) for (const s of system) if (check(s)) return true;
  const messages = getAt(root, "messages");
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = getAt(msg, "content");
      if (Array.isArray(content)) for (const item of content) if (check(item)) return true;
    }
  }
  return false;
}

/** Whether a subagent explicitly asks for the 1h cache pool (Go: ClaudeSubagentRequests1h). */
export function claudeSubagentRequests1h(headers: Headers | undefined, payload: Payload): boolean {
  if (claudePayloadHas1hTTL(payload)) return true;
  return headerValuesCaseInsensitive(headers, "Anthropic-Beta").join(",").includes("extended-cache-ttl-2025-04-11");
}

/** Whether the caller placed a {"role":"system"} turn inside messages (Go: claudePayloadHasMidSystemMessage). */
export function claudePayloadHasMidSystemMessage(payload: Payload): boolean {
  const messages = getAt(parsePayload(payload), "messages");
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (gstr(getAt(message, "role")).trim().toLowerCase() === "system") return true;
  }
  return false;
}

/** Whether the payload's model keeps caller system prompts on the legacy path (Go: claudeUsesLegacySystemReminder). */
export function claudeUsesLegacySystemReminder(payload: Payload): boolean {
  return claudeModelUsesLegacySystemReminder(gstr(getAt(parsePayload(payload), "model")));
}

/** Index of the first user turn, -1 when none (Go: firstClaudeUserMessageIndex). */
export function firstClaudeUserMessageIndex(payload: Payload): number {
  const messages = getAt(parsePayload(payload), "messages");
  if (!Array.isArray(messages)) return -1;
  for (let i = 0; i < messages.length; i++) {
    if (gstr(getAt(messages[i], "role")) === "user") return i;
  }
  return -1;
}
