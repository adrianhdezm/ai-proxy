// Port of internal/translator/common/responses.go onto parsed Responses items.
import { deleteAt, getAt, gstr, setAt } from "../../util/gpath.ts";

/** Writes a resolved Responses tool name and namespace onto item (mutating). */
export function setResponsesToolCallIdentity<T>(item: T, name: string, namespace: string, itemPath: string): T {
  const namePath = itemPath !== "" ? itemPath + ".name" : "name";
  const namespacePath = itemPath !== "" ? itemPath + ".namespace" : "namespace";
  let out = setAt(item, namePath, name);
  if (namespace !== "") out = setAt(out, namespacePath, namespace);
  else deleteAt(out, namespacePath);
  return out as T;
}

/**
 * Extracts the tool call ID from a Responses item, prioritising dedicated references:
 * call_id -> tool_call_id -> callId -> id (excluding fco_ output item IDs).
 */
export function extractResponsesCallID(node: unknown): string {
  const callID = gstr(getAt(node, "call_id")).trim();
  if (callID !== "") return callID;
  const toolCallID = gstr(getAt(node, "tool_call_id")).trim();
  if (toolCallID !== "") return toolCallID;
  const callId = gstr(getAt(node, "callId")).trim();
  if (callId !== "") return callId;
  const id = gstr(getAt(node, "id")).trim();
  if (id.startsWith("fco_")) return "";
  return id;
}

function isOutputItem(item: unknown): boolean {
  const typ = gstr(getAt(item, "type"));
  return typ === "function_call_output" || typ === "custom_tool_call_output";
}

/**
 * Pairs function_call_output / custom_tool_call_output items with preceding pending
 * tool calls and assigns missing call_ids: explicit id match first, then function
 * name match, then FIFO fallback. Outputs with an unmatched explicit id are untouched.
 * Returns a new array; rewritten items are copies.
 */
export function normalizeResponsesToolCallOutputs(items: unknown[]): unknown[] {
  if (items.length === 0) return items;
  const normalized = [...items];
  const explicitOutputCounts = new Map<string, number>();
  for (const item of items) {
    if (isOutputItem(item)) {
      const id = extractResponsesCallID(item);
      if (id !== "") explicitOutputCounts.set(id, (explicitOutputCounts.get(id) ?? 0) + 1);
    }
  }
  let pendingCallIDs: string[] = [];
  const pendingCallNames = new Map<string, string>();

  let i = 0;
  while (i < normalized.length) {
    const item = normalized[i];
    const itemType = gstr(getAt(item, "type"));
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callID = extractResponsesCallID(item);
      if (callID !== "") {
        pendingCallIDs.push(callID);
        pendingCallNames.set(callID, gstr(getAt(item, "name")));
      }
      i++;
    } else if (isOutputItem(item)) {
      const start = i;
      while (i < normalized.length && isOutputItem(normalized[i])) i++;
      const outputs = normalized.slice(start, i);
      if (pendingCallIDs.length > 0) {
        const used = new Array<boolean>(outputs.length).fill(false);
        const matchedForPending = new Array<number>(pendingCallIDs.length).fill(-1);

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
            if (!used[outIdx] && extractResponsesCallID(outputs[outIdx]) === pendingID) {
              used[outIdx] = true;
              matchedForPending[pendingIdx] = outIdx;
              explicitOutputCounts.set(pendingID, (explicitOutputCounts.get(pendingID) ?? 0) - 1);
              break;
            }
          }
        });

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          if (matchedForPending[pendingIdx]! >= 0 || (explicitOutputCounts.get(pendingID) ?? 0) > 0) return;
          const expectedName = pendingCallNames.get(pendingID) ?? "";
          if (expectedName === "") return;
          for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
            if (!used[outIdx] && extractResponsesCallID(outputs[outIdx]) === "") {
              const outName = gstr(getAt(outputs[outIdx], "name")).trim();
              if (outName !== "" && outName === expectedName) {
                used[outIdx] = true;
                matchedForPending[pendingIdx] = outIdx;
                break;
              }
            }
          }
        });

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          if (matchedForPending[pendingIdx]! >= 0 || (explicitOutputCounts.get(pendingID) ?? 0) > 0) return;
          for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
            if (!used[outIdx] && extractResponsesCallID(outputs[outIdx]) === "") {
              const outName = gstr(getAt(outputs[outIdx], "name")).trim();
              const expectedName = pendingCallNames.get(pendingID) ?? "";
              if (outName === "" || expectedName === "" || outName === expectedName) {
                used[outIdx] = true;
                matchedForPending[pendingIdx] = outIdx;
                break;
              }
            }
          }
        });

        const remainingPending: string[] = [];
        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          const outIdx = matchedForPending[pendingIdx]!;
          if (outIdx < 0) {
            remainingPending.push(pendingID);
            return;
          }
          const matchedOut = outputs[outIdx];
          if (gstr(getAt(matchedOut, "call_id")) !== pendingID) {
            normalized[start + outIdx] = { ...(matchedOut as Record<string, unknown>), call_id: pendingID };
          }
        });
        pendingCallIDs = remainingPending;
      }
    } else {
      i++;
    }
  }
  return normalized;
}
