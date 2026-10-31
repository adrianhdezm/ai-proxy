// Port of internal/translator/common/openai_tools.go onto parsed messages.
import { getAt, gstr } from "../../util/gpath.ts";

/**
 * Reorders tool result messages to immediately follow the assistant message that
 * issued their matching tool_calls by tool_call_id. Ambiguous, orphan and
 * incomplete histories are left untouched; untouched messages keep their identity.
 */
export function alignOpenAIToolCallMessages(messages: unknown[], ...extraAmbiguousIDs: string[]): unknown[] {
  if (messages.length <= 1) return messages;

  interface AssistantRecord {
    msgIndex: number;
    callIDs: string[];
    hasInvalidOrEmptyID: boolean;
  }
  const assistants: AssistantRecord[] = [];
  const assistantByCallID = new Map<string, number>();
  const ambiguousCallIDs = new Set<string>();
  for (const id of extraAmbiguousIDs) {
    const trimmed = id.trim();
    if (trimmed !== "") ambiguousCallIDs.add(trimmed);
  }
  const toolMsgIndicesByCallID = new Map<string, number[]>();

  messages.forEach((raw, i) => {
    const role = gstr(getAt(raw, "role"));
    if (role === "assistant") {
      const toolCalls = getAt(raw, "tool_calls");
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const callIDs: string[] = [];
        let hasEmptyCallID = false;
        for (const tc of toolCalls) {
          const callID = gstr(getAt(tc, "id"));
          if (callID === "") {
            ambiguousCallIDs.add("");
            hasEmptyCallID = true;
            continue;
          }
          if (assistantByCallID.has(callID)) ambiguousCallIDs.add(callID);
          assistantByCallID.set(callID, i);
          callIDs.push(callID);
        }
        if (callIDs.length > 0 || hasEmptyCallID) assistants.push({ msgIndex: i, callIDs, hasInvalidOrEmptyID: hasEmptyCallID });
      }
    } else if (role === "tool") {
      const callID = gstr(getAt(raw, "tool_call_id"));
      if (callID === "") {
        ambiguousCallIDs.add("");
      } else {
        const list = toolMsgIndicesByCallID.get(callID) ?? [];
        list.push(i);
        toolMsgIndicesByCallID.set(callID, list);
        if (list.length > 1) ambiguousCallIDs.add(callID);
      }
    }
  });

  if (assistants.length === 0) return messages;

  const groups: { assistantIndex: number; toolIndices: number[] }[] = [];
  let needsReorder = false;
  for (const ast of assistants) {
    if (ast.hasInvalidOrEmptyID) continue;
    let isEligible = true;
    const matched: number[] = [];
    for (const callID of ast.callIDs) {
      if (ambiguousCallIDs.has(callID)) {
        isEligible = false;
        break;
      }
      const indices = toolMsgIndicesByCallID.get(callID) ?? [];
      if (indices.length !== 1) {
        isEligible = false;
        break;
      }
      const toolIdx = indices[0]!;
      if (toolIdx <= ast.msgIndex) {
        isEligible = false;
        break;
      }
      matched.push(toolIdx);
    }
    if (!isEligible) continue;
    matched.sort((a, b) => a - b);
    const alreadyAdjacent = matched.every((toolIdx, offset) => toolIdx === ast.msgIndex + offset + 1);
    if (!alreadyAdjacent) {
      needsReorder = true;
      groups.push({ assistantIndex: ast.msgIndex, toolIndices: matched });
    }
  }
  if (!needsReorder) return messages;

  const movedToolIndices = new Set<number>();
  const toolsToInsert = new Map<number, unknown[]>();
  for (const g of groups) {
    const toolList: unknown[] = [];
    for (const idx of g.toolIndices) {
      movedToolIndices.add(idx);
      toolList.push(messages[idx]);
    }
    toolsToInsert.set(g.assistantIndex, toolList);
  }
  const reordered: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (movedToolIndices.has(i)) continue;
    reordered.push(messages[i]);
    const tools = toolsToInsert.get(i);
    if (tools) reordered.push(...tools);
  }
  return reordered;
}
