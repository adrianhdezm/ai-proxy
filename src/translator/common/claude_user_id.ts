// Port of internal/translator/common/claude_user_id.go.
import { getAt, gstr } from "../../util/gpath.ts";
import { sha256Hex } from "../../util/hash.ts";
import { isGeminiThoughtPart } from "./gemini.ts";

/**
 * Returns a stable value for the Claude request field metadata.user_id. A
 * caller-supplied metadata.user_id or OpenAI `user` field is preserved; otherwise
 * a deterministic value is derived from stable client signals (prompt_cache_key,
 * session id, conversation id, first user message, model/system instructions).
 */
export function deriveClaudeUserID(rawJSON: string): string {
  let root: unknown;
  try {
    root = JSON.parse(rawJSON);
  } catch {
    root = undefined;
  }
  const metaUserID = getAt(root, "metadata.user_id");
  if (typeof metaUserID === "string" && metaUserID.trim() !== "") return metaUserID;
  const user = getAt(root, "user");
  if (typeof user === "string" && user.trim() !== "") return user;

  let seed = "";
  const pck = getAt(root, "prompt_cache_key");
  if (pck !== undefined) {
    const value = gstr(pck).trim();
    if (value !== "") seed += "prompt_cache_key:" + value;
  }
  if (seed === "") {
    for (const path of ["session_id", "sessionId"]) {
      const v = getAt(root, path);
      if (v !== undefined) {
        const value = gstr(v).trim();
        if (value !== "") {
          seed += "session_id:" + value;
          break;
        }
      }
    }
  }
  if (seed === "") {
    const conversation = getAt(root, "conversation");
    const sid = gstr(getAt(conversation, "id")).trim();
    if (sid !== "") {
      seed += "conversation_id:" + sid;
    } else if (typeof conversation === "string") {
      if (conversation.trim() !== "") seed += "conversation_id:" + conversation.trim();
    } else {
      const v = getAt(root, "conversation_id");
      if (v !== undefined) {
        const value = gstr(v).trim();
        if (value !== "") seed += "conversation_id:" + value;
      }
    }
  }
  if (seed === "") {
    const content = firstStableRequestContent(root);
    if (content !== "") seed += "content:" + content;
  }
  if (seed === "") {
    const model = getAt(root, "model");
    if (model !== undefined) {
      const value = gstr(model).trim();
      if (value !== "") seed += "model:" + value;
    }
    for (const key of ["instructions", "system", "systemInstruction", "system_instruction"]) {
      const v = getAt(root, key);
      if (v !== undefined) seed += `;${key}:` + gstr(v);
    }
  }
  if (seed === "") return "unknown";
  return sha256Hex(seed);
}

function firstStableRequestContent(root: unknown): string {
  const messages = getAt(root, "messages");
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (gstr(getAt(message, "role")).trim().toLowerCase() === "user") {
        const content = extractTextContent(getAt(message, "content"));
        if (content !== "") return content;
      }
    }
  }
  const input = getAt(root, "input");
  if (input !== undefined) {
    if (typeof input === "string") {
      if (input.trim() !== "") return input.trim();
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (isResponsesUserItem(item)) {
          const content = extractResponsesItemText(getAt(item, "content"));
          if (content !== "") return content;
        }
      }
    }
  }
  const contents = getAt(root, "contents");
  if (Array.isArray(contents)) {
    for (const contentItem of contents) {
      const role = gstr(getAt(contentItem, "role")).trim().toLowerCase();
      if (role === "" || role === "user") {
        const parts = getAt(contentItem, "parts");
        if (Array.isArray(parts)) {
          const texts: string[] = [];
          for (const part of parts) {
            if (isGeminiThoughtPart(part)) continue;
            const text = getAt(part, "text");
            if (text !== undefined) {
              const val = gstr(text).trim();
              if (val !== "") texts.push(val);
            }
          }
          if (texts.length > 0) return texts.join("\n");
        }
      }
    }
  }
  return "";
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (gstr(getAt(part, "type")) === "text") {
      const text = getAt(part, "text");
      if (text !== undefined) {
        const val = gstr(text).trim();
        if (val !== "") texts.push(val);
      }
    }
  }
  return texts.join("\n").trim();
}

function isResponsesUserItem(item: unknown): boolean {
  const role = gstr(getAt(item, "role")).trim().toLowerCase();
  if (role === "user") return true;
  if (role === "system" || role === "developer" || role === "assistant") return false;
  return gstr(getAt(item, "type")).trim().toLowerCase() === "message";
}

function extractResponsesItemText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    switch (gstr(getAt(part, "type"))) {
      case "input_text":
      case "output_text":
      case "text": {
        const text = getAt(part, "text");
        if (text !== undefined) {
          const val = gstr(text).trim();
          if (val !== "") texts.push(val);
        }
      }
    }
  }
  return texts.join("\n").trim();
}
