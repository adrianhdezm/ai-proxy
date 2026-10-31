// Port of internal/translator/common/claude_messages.go onto parsed messages.
import { getAt, gstr, isObj } from "../../util/gpath.ts";

/** Groups consecutive Claude messages by role. */
export class ClaudeMessageAccumulator {
  private readonly messagesOut: Record<string, unknown>[] = [];
  private role = "";
  private content: unknown[] = [];
  private toolUseParts: unknown[] = [];

  /** Adds one Claude-shaped message (parsed object or JSON string) to the current role turn. */
  append(message: unknown): void {
    let root: unknown = message;
    if (typeof message === "string") {
      if (message.length === 0) return;
      try {
        root = JSON.parse(message);
      } catch {
        return;
      }
    }
    if (!isObj(root)) return;
    const role = gstr(root.role);
    if (role !== "user" && role !== "assistant") return;
    const parts = claudeMessageContentParts(root.content);
    if (parts.length === 0) return;
    if (this.role !== "" && this.role !== role) this.flush();
    this.role = role;
    for (const part of parts) {
      if (role === "assistant" && gstr(getAt(part, "type")) === "tool_use") {
        this.toolUseParts.push(part);
        continue;
      }
      this.content.push(part);
    }
  }

  /** Closes the current role turn while keeping accumulated messages. */
  flush(): void {
    if (this.role === "") return;
    const parts = this.toolUseParts.length > 0 ? [...this.content, ...this.toolUseParts] : this.content;
    if (parts.length > 0) this.messagesOut.push({ role: this.role, content: parts });
    this.role = "";
    this.content = [];
    this.toolUseParts = [];
  }

  /** Flushes the final turn and returns all accumulated messages. */
  messages(): Record<string, unknown>[] {
    this.flush();
    return this.messagesOut;
  }
}

/**
 * Orders tool_result blocks by the preceding tool_use IDs, preserving non-result
 * content blocks at their existing indexes. If a complete one-to-one match is
 * unavailable, the original content is returned.
 */
export function alignClaudeToolResults(content: unknown, toolUseIDs: string[]): unknown {
  if (!Array.isArray(content) || toolUseIDs.length === 0) return content;
  const parts = content;
  const toolResults: unknown[] = [];
  const toolResultIndices: number[] = [];
  parts.forEach((part, i) => {
    if (gstr(getAt(part, "type")) === "tool_result") {
      toolResults.push(part);
      toolResultIndices.push(i);
    }
  });
  if (toolResults.length !== toolUseIDs.length) return content;
  const reordered: unknown[] = [];
  const used = new Array<boolean>(toolResults.length).fill(false);
  for (const toolUseID of toolUseIDs) {
    let matched = -1;
    for (let i = 0; i < toolResults.length; i++) {
      if (!used[i] && toolUseID !== "" && gstr(getAt(toolResults[i], "tool_use_id")) === toolUseID) {
        matched = i;
        break;
      }
    }
    if (matched < 0) return content;
    used[matched] = true;
    reordered.push(toolResults[matched]);
  }
  const ordered = [...parts];
  toolResultIndices.forEach((slot, i) => {
    ordered[slot] = reordered[i];
  });
  return ordered;
}

function claudeMessageContentParts(content: unknown): unknown[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") {
    if (content === "") return [];
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  return content.filter((part) => isObj(part));
}
