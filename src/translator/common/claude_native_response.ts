// Port of internal/translator/common/claude_native_response.go.
import { getAt, gstr, isObj } from "../../util/gpath.ts";

export interface ClaudeMessagesSSE {
  /** The SSE payload, or the input unchanged when it is not a native Messages JSON response. */
  payload: string;
  /** The response model, or "" on passthrough. */
  model: string;
}

/**
 * Adapts a native (non-streaming) Messages response into the SSE event stream the
 * streaming aggregators consume and returns its model. SSE and other payloads pass
 * through unchanged.
 */
export function claudeMessagesJSONToSSE(rawJSON: string): ClaudeMessagesSSE {
  let root: unknown;
  try {
    root = JSON.parse(rawJSON);
  } catch {
    return { payload: rawJSON, model: "" };
  }
  if (!isObj(root) || gstr(root.type) !== "message" || !Array.isArray(root.content)) return { payload: rawJSON, model: "" };

  let out = "";
  const emit = (event: Record<string, unknown>): void => {
    out += "data: " + JSON.stringify(event) + "\n\n";
  };
  const message: Record<string, unknown> = { ...root, content: [], stop_reason: null, stop_sequence: null };
  emit({ type: "message_start", message });

  root.content.forEach((block, index) => {
    const start: Record<string, unknown> = isObj(block) ? { ...block } : {};
    let delta: Record<string, unknown> | undefined;
    const blockType = gstr(getAt(block, "type"));
    switch (blockType) {
      case "text":
        start.text = "";
        delta = { type: "text_delta", text: gstr(getAt(block, "text")) };
        break;
      case "tool_use": {
        start.input = {};
        const inputValue = getAt(block, "input");
        const input = inputValue === undefined ? "{}" : JSON.stringify(inputValue);
        delta = { type: "input_json_delta", partial_json: input };
        break;
      }
      case "thinking":
        start.thinking = "";
        start.signature = "";
        delta = { type: "thinking_delta", thinking: gstr(getAt(block, "thinking")) };
        break;
    }
    emit({ type: "content_block_start", index, content_block: start });
    if (delta) emit({ type: "content_block_delta", index, delta });
    if (blockType === "text") {
      const citations = getAt(block, "citations");
      if (Array.isArray(citations)) {
        for (const citation of citations) emit({ type: "content_block_delta", index, delta: { type: "citations_delta", citation } });
      }
    }
    if (blockType === "thinking" && getAt(block, "signature") !== undefined) {
      emit({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: gstr(getAt(block, "signature")) } });
    }
    emit({ type: "content_block_stop", index });
  });
  const usage = root.usage === undefined ? {} : root.usage;
  emit({
    type: "message_delta",
    delta: { stop_reason: root.stop_reason ?? null, stop_sequence: root.stop_sequence ?? null },
    usage,
  });
  emit({ type: "message_stop" });
  return { payload: out, model: gstr(root.model) };
}
