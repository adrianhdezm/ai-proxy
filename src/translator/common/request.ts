// Port of internal/translator/common/request.go.
import { getAt } from "../../util/gpath.ts";

const tooluLetters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Generates a random "toolu_" + 24 alphanumeric characters ID with uniform rejection sampling. */
export function generateClaudeToolCallID(): string {
  const maxValidByte = 256 - (256 % tooluLetters.length); // 248
  let out = "toolu_";
  let n = 0;
  const buf = new Uint8Array(32);
  while (n < 24) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < maxValidByte) {
        out += tooluLetters[b % tooluLetters.length];
        n++;
        if (n === 24) break;
      }
    }
  }
  return out;
}

/** The model name from the original request, falling back to the translated request. */
export function requestModelName(originalRequestRawJSON: string | undefined, requestRawJSON: string | undefined): string {
  for (const rawJSON of [originalRequestRawJSON, requestRawJSON]) {
    const modelName = requestModelNameOf(rawJSON);
    if (modelName !== "") return modelName;
  }
  return "";
}

function requestModelNameOf(rawJSON: string | undefined): string {
  if (!rawJSON) return "";
  let root: unknown;
  try {
    root = JSON.parse(rawJSON);
  } catch {
    return "";
  }
  for (const path of ["model", "request.model"]) {
    const model = getAt(root, path);
    if (typeof model === "string" && model.trim() !== "") return model;
  }
  return "";
}
