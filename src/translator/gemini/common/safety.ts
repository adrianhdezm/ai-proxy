// Port of internal/translator/gemini/common/safety.go.
import { getAt, setAt } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";

/** The default Gemini safety configuration attached to outgoing requests. */
export function defaultSafetySettings(): Array<{ category: string; threshold: string }> {
  return [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
  ];
}

/**
 * Ensures the default safety settings are present when absent. `path` is the
 * target JSON path (e.g. "safetySettings" or "request.safetySettings").
 */
export function attachDefaultSafetySettings(rawJSON: string, path: string): string {
  const root = tryParse<unknown>(rawJSON);
  if (root === undefined) return rawJSON;
  if (getAt(root, path) !== undefined) return rawJSON;
  return JSON.stringify(setAt(root, path, defaultSafetySettings()));
}
