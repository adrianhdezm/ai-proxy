// Port of internal/util/claude_tool_result.go.
import { getAt, gstr, isObj } from "./gpath.ts";

/** A base64-encoded image extracted from a Claude tool_result content block. */
export interface ClaudeToolResultImage {
  mimeType: string;
  data: string;
}

/** The normalized form of a Claude tool_result `content` field, ready for a Gemini-style functionResponse. */
export interface ClaudeToolResult {
  /** The value for functionResponse.response.result. */
  result: string;
  /**
   * Whether `result` holds raw JSON (write it as a parsed value) or a plain string
   * (write it as a string value). Writing raw JSON text as a string would double-encode it.
   */
  resultIsRaw: boolean;
  /** Base64 image blocks separated out of the content. */
  images: ClaudeToolResultImage[];
}

/**
 * Normalizes a Claude tool_result `content` field (parsed; `undefined` when absent)
 * into a deterministic Gemini functionResponse result plus any extracted images.
 *
 *   - string             -> plain string result (no double-encoding)
 *   - single non-image   -> raw JSON result (structure preserved)
 *   - multiple non-image -> raw JSON array result
 *   - base64 image block -> separated into images
 *   - object             -> raw JSON result, or image -> images with empty result
 *   - absent/empty       -> empty string result
 */
export function convertClaudeToolResultContent(content: unknown): ClaudeToolResult {
  if (typeof content === "string") return { result: content, resultIsRaw: false, images: [] };
  if (Array.isArray(content)) {
    const images: ClaudeToolResultImage[] = [];
    let nonImageCount = 0;
    let lastNonImage: unknown;
    const filtered: unknown[] = [];
    for (const block of content) {
      if (isClaudeBase64Image(block)) {
        const img = claudeImageFromBlock(block);
        if (img) images.push(img);
        continue;
      }
      nonImageCount++;
      lastNonImage = block;
      filtered.push(block);
    }
    if (nonImageCount === 1) return { result: JSON.stringify(lastNonImage), resultIsRaw: true, images };
    if (nonImageCount > 1) return { result: JSON.stringify(filtered), resultIsRaw: true, images };
    return { result: "", resultIsRaw: false, images };
  }
  if (isObj(content)) {
    if (isClaudeBase64Image(content)) {
      const img = claudeImageFromBlock(content);
      return { result: "", resultIsRaw: false, images: img ? [img] : [] };
    }
    return { result: JSON.stringify(content), resultIsRaw: true, images: [] };
  }
  if (content !== undefined) return { result: JSON.stringify(content), resultIsRaw: true, images: [] };
  return { result: "", resultIsRaw: false, images: [] };
}

function isClaudeBase64Image(block: unknown): boolean {
  return gstr(getAt(block, "type")) === "image" && gstr(getAt(block, "source.type")) === "base64";
}

function claudeImageFromBlock(block: unknown): ClaudeToolResultImage | undefined {
  const data = gstr(getAt(block, "source.data"));
  if (data === "") return undefined;
  return { mimeType: gstr(getAt(block, "source.media_type")), data };
}
