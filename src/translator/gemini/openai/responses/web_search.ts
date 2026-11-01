// Port of internal/translator/gemini/openai/responses/gemini_openai-responses_web_search.go.
//
// Maps the Responses web_search tool to Gemini googleSearch and Gemini
// groundingMetadata back to web_search_call items and url_citation annotations.
import modelsJSON from "../../../../registry/models.json" with { type: "json" };
import { lookupModelInfo } from "../../../../registry/index.ts";
import type { ModelInfo } from "../../../../registry/types.ts";
import { getAt, gint, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { has, str, utf8Bytes, utf8RuneCount } from "./helpers.ts";

type WebSearchCapableInfo = ModelInfo & { supportsWebSearch?: boolean; nativeCapabilities?: { webSearch?: boolean } };

const staticSections = ["claude", "gemini", "gemini-cli", "aistudio", "codex-pro"];

/** native_capabilities.web_search from the embedded models.json (ModelInfo does not carry it). */
function staticNativeWebSearch(modelID: string): boolean | undefined {
  const catalog = modelsJSON as unknown as Record<string, unknown>;
  for (const section of staticSections) {
    const models = catalog[section];
    if (!isArr(models)) continue;
    for (const model of models) {
      if (gstr(getAt(model, "id")) !== modelID) continue;
      const v = getAt(model, "native_capabilities.web_search");
      return typeof v === "boolean" ? v : undefined;
    }
  }
  return undefined;
}

function nativeWebSearch(info: WebSearchCapableInfo | undefined, modelID: string, useStatic: boolean): boolean | undefined {
  if (!info) return undefined;
  const v = info.nativeCapabilities?.webSearch;
  if (typeof v === "boolean") return v;
  return useStatic ? staticNativeWebSearch(info.id || modelID) : undefined;
}

/**
 * Whether the model supports native web search, from the registry capability
 * flags and the models.json native_capabilities.web_search definitions. An
 * explicit false wins as a veto.
 */
export function modelSupportsWebSearch(modelID: string): boolean {
  const info = lookupModelInfo(modelID) as WebSearchCapableInfo | undefined;
  const infoAG = lookupModelInfo(modelID, "antigravity") as WebSearchCapableInfo | undefined;
  const native = nativeWebSearch(info, modelID, true);
  const nativeAG = nativeWebSearch(infoAG, modelID, true);
  if (native === false || nativeAG === false) return false;
  if (native === true || nativeAG === true) return true;
  return !!info?.supportsWebSearch || !!infoAG?.supportsWebSearch;
}

function isResponsesWebSearchToolType(toolType: string): boolean {
  switch (toolType) {
    case "web_search":
    case "web_search_2025_08_26":
    case "web_search_preview":
    case "web_search_preview_2025_03_11":
      return true;
    default:
      return false;
  }
}

/** Whether the request tools array contains an OpenAI web search tool. */
export function hasResponsesWebSearchTool(root: unknown): boolean {
  const tools = getAt(root, "tools");
  if (!isArr(tools)) return false;
  return tools.some((tool) => isResponsesWebSearchToolType(str(tool, "type")));
}

/** Whether every tool in the tools array is a web search tool. */
export function hasOnlyResponsesWebSearchTools(root: unknown): boolean {
  const tools = getAt(root, "tools");
  if (!isArr(tools)) return false;
  let hasSearch = false;
  for (const tool of tools) {
    if (!isResponsesWebSearchToolType(str(tool, "type"))) return false;
    hasSearch = true;
  }
  return hasSearch;
}

/** Whether tool_choice permits web search execution. */
export function allowsResponsesWebSearchToolChoice(root: unknown): boolean {
  const toolChoice = getAt(root, "tool_choice");
  if (toolChoice === undefined) return true;
  if (typeof toolChoice === "string") return toolChoice === "" || toolChoice === "auto" || toolChoice === "required";
  if (isObj(toolChoice)) {
    const t = str(toolChoice, "type");
    switch (t) {
      case "":
      case "auto":
      case "required":
        return true;
      case "allowed_tools": {
        const tools = getAt(toolChoice, "tools");
        return isArr(tools) && tools.some((tool) => isResponsesWebSearchToolType(str(tool, "type")));
      }
      default:
        return isResponsesWebSearchToolType(t);
    }
  }
  return false;
}

/** Extracts the search query from OpenAI Responses input (string, messages, flat parts, or instructions). */
export function extractResponsesWebSearchQuery(root: unknown): string {
  const input = getAt(root, "input");
  if (typeof input === "string") return input.trim();
  if (isArr(input)) {
    const flatParts: string[] = [];
    let isFlatParts = true;
    for (const item of input) {
      if (str(item, "type") === "input_text") {
        const text = str(item, "text").trim();
        if (text !== "") flatParts.push(text);
      } else if (has(item, "role")) {
        isFlatParts = false;
        break;
      }
    }
    if (isFlatParts && flatParts.length > 0) return flatParts.join("\n");
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      const role = str(item, "role");
      if (role !== "" && role !== "user") continue;
      const content = getAt(item, "content");
      if (typeof content === "string" && content.trim() !== "") return content.trim();
      if (isArr(content)) {
        const textParts: string[] = [];
        for (const part of content) {
          const text = str(part, "text").trim();
          if (text !== "") textParts.push(text);
        }
        if (textParts.length > 0) return textParts.join("\n");
      }
      const text = str(item, "text").trim();
      if (text !== "") return text;
    }
  }
  const instructions = str(root, "instructions");
  if (instructions.trim() !== "") return instructions.trim();
  return "";
}

/** Allowed domains from tools[].filters.allowed_domains of the first web search tool that has them. */
export function extractResponsesWebSearchAllowedDomains(root: unknown): string[] {
  const tools = getAt(root, "tools");
  if (!isArr(tools)) return [];
  for (const tool of tools) {
    if (!isResponsesWebSearchToolType(str(tool, "type"))) continue;
    const allowedDomains = getAt(tool, "filters.allowed_domains");
    if (!isArr(allowedDomains)) continue;
    const domains: string[] = [];
    for (const domain of allowedDomains) {
      const d = gstr(domain).trim();
      if (d !== "") domains.push(d);
    }
    return domains;
  }
  return [];
}

/** groundingMetadata in a direct or wrapped Gemini response (undefined when absent). */
export function extractGroundingMetadata(root: unknown): unknown {
  const gm = getAt(root, "candidates.0.groundingMetadata");
  if (gm !== undefined) return gm;
  return getAt(root, "response.candidates.0.groundingMetadata");
}

export function extractGroundingQueries(groundingMetadata: unknown): string[] {
  const queries: string[] = [];
  const webSearchQueries = getAt(groundingMetadata, "webSearchQueries");
  if (isArr(webSearchQueries)) {
    for (const q of webSearchQueries) {
      const s = gstr(q).trim();
      if (s !== "") queries.push(s);
    }
  }
  return queries;
}

/** groundingChunks as Responses source objects, deduplicated by URL. */
export function extractGroundingSources(groundingMetadata: unknown): Record<string, unknown>[] {
  const chunks = getAt(groundingMetadata, "groundingChunks");
  const sources: Record<string, unknown>[] = [];
  if (!isArr(chunks)) return sources;
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const uri = str(chunk, "web.uri").trim();
    if (uri === "" || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ type: "url", url: uri });
  }
  return sources;
}

/** A Responses web_search_call output item. */
export function buildResponsesWebSearchCallItem(id: string, query: string, queries: string[], sources: unknown[]): Record<string, unknown> {
  const action: Record<string, unknown> = { type: "search", query };
  if (queries.length > 0) action.queries = [...queries];
  if (sources.length > 0) action.sources = [...sources];
  return { id, type: "web_search_call", status: "completed", action };
}

/** Whether groundingMetadata contains web search queries or web chunks with a non-empty URI. */
export function hasValidWebGrounding(groundingMetadata: unknown): boolean {
  if (groundingMetadata === undefined) return false;
  const queries = getAt(groundingMetadata, "webSearchQueries");
  if (isArr(queries) && queries.some((q) => gstr(q).trim() !== "")) return true;
  const chunks = getAt(groundingMetadata, "groundingChunks");
  if (isArr(chunks) && chunks.some((c) => str(c, "web.uri").trim() !== "")) return true;
  return false;
}

function isEmptyGM(gm: unknown): boolean {
  return gm === undefined || (typeof gm === "string" && gm.trim() === "");
}

/**
 * Merges incremental groundingMetadata into the accumulated one: webSearchQueries
 * are combined, groundingChunks merged with index remapping (persisted in
 * _chunkIndexRemap/_rawChunkCount) and groundingSupports remapped and deduplicated.
 */
export function mergeGroundingMetadata(existingGM: unknown, newGM: unknown): unknown {
  if (isEmptyGM(existingGM) && isEmptyGM(newGM)) return existingGM;
  if (isEmptyGM(existingGM)) existingGM = {};
  if (isEmptyGM(newGM)) return existingGM;
  const merged: Record<string, unknown> = isObj(existingGM) ? JSON.parse(JSON.stringify(existingGM)) : {};

  const existingQueries = extractGroundingQueries(existingGM);
  const newQueries = extractGroundingQueries(newGM);
  if (newQueries.length > 0) {
    const seen = new Set<string>();
    const mergedQueries: string[] = [];
    for (const q of [...existingQueries, ...newQueries]) {
      if (seen.has(q)) continue;
      seen.add(q);
      mergedQueries.push(q);
    }
    merged.webSearchQueries = mergedQueries;
  }

  const existingChunks = asArr(getAt(existingGM, "groundingChunks"));
  const newChunks = asArr(getAt(newGM, "groundingChunks"));
  const cumulativeRemap = new Map<number, number>();
  const remapJSON = getAt(existingGM, "_chunkIndexRemap");
  if (isObj(remapJSON)) {
    for (const [k, v] of Object.entries(remapJSON)) {
      if (/^[+-]?\d+$/.test(k)) cumulativeRemap.set(Number(k), gint(v));
    }
  }
  const rawCount = getAt(existingGM, "_rawChunkCount");
  const prevRawCount = rawCount !== undefined ? gint(rawCount) : existingChunks.length;
  if (cumulativeRemap.size === 0 && existingChunks.length > 0) {
    for (let i = 0; i < existingChunks.length; i++) cumulativeRemap.set(i, i);
  }

  const mergedChunks: unknown[] = [];
  const uriToMergedIndex = new Map<string, number>();
  const rawToMergedIndex = new Map<string, number>();
  existingChunks.forEach((chunk, i) => {
    mergedChunks.push(JSON.parse(JSON.stringify(chunk)));
    const uri = str(chunk, "web.uri").trim();
    if (uri !== "" && !uriToMergedIndex.has(uri)) uriToMergedIndex.set(uri, i);
    rawToMergedIndex.set(JSON.stringify(chunk), i);
  });
  newChunks.forEach((chunk, i) => {
    const uri = str(chunk, "web.uri").trim();
    const title = str(chunk, "web.title").trim();
    const newRawIdx = prevRawCount + i;
    const raw = JSON.stringify(chunk);
    if (uri !== "") {
      const existingIdx = uriToMergedIndex.get(uri);
      if (existingIdx !== undefined) {
        cumulativeRemap.set(newRawIdx, existingIdx);
        if (prevRawCount === 0) cumulativeRemap.set(i, existingIdx);
        if (title !== "") {
          const existingChunk = mergedChunks[existingIdx];
          if (str(existingChunk, "web.title").trim() === "" && isObj(existingChunk)) {
            const web = isObj(existingChunk.web) ? existingChunk.web : {};
            web.title = title;
            existingChunk.web = web;
          }
        }
        return;
      }
    } else {
      const existingIdx = rawToMergedIndex.get(raw);
      if (existingIdx !== undefined) {
        cumulativeRemap.set(newRawIdx, existingIdx);
        if (prevRawCount === 0) cumulativeRemap.set(i, existingIdx);
        return;
      }
    }
    const newIdx = mergedChunks.length;
    mergedChunks.push(JSON.parse(raw));
    if (uri !== "") uriToMergedIndex.set(uri, newIdx);
    rawToMergedIndex.set(raw, newIdx);
    cumulativeRemap.set(newRawIdx, newIdx);
    if (prevRawCount === 0) cumulativeRemap.set(i, newIdx);
  });
  if (mergedChunks.length > 0) merged.groundingChunks = mergedChunks;

  const totalRawCount = prevRawCount + newChunks.length;
  if (cumulativeRemap.size > 0) {
    const remap: Record<string, number> = {};
    for (const k of [...cumulativeRemap.keys()].sort((a, b) => a - b)) remap[String(k)] = cumulativeRemap.get(k)!;
    merged._chunkIndexRemap = remap;
    merged._rawChunkCount = totalRawCount;
  }

  const existingSupports = asArr(getAt(existingGM, "groundingSupports"));
  const newSupports = asArr(getAt(newGM, "groundingSupports"));
  const supportKey = (partIndex: number, startByte: number, endByte: number, indices: number[]): string =>
    `${partIndex}:${startByte}:${endByte}:[${[...indices].sort((a, b) => a - b).join(" ")}]`;
  const seenSupports = new Set<string>();
  const mergedSupports: unknown[] = [];
  const existingChunkCount = existingChunks.length;
  const remapSupportIndices = (origIndices: unknown[], isExisting: boolean): { indices: number[]; needRewrite: boolean } => {
    const remapped: number[] = [];
    let needRewrite = false;
    for (const idxRes of origIndices) {
      const oldIdx = gint(idxRes);
      let targetIdx = oldIdx;
      const shouldRemap = !isExisting || existingChunkCount === 0 || oldIdx >= existingChunkCount;
      if (shouldRemap) {
        const target = cumulativeRemap.get(oldIdx);
        if (target !== undefined) {
          targetIdx = target;
          if (targetIdx !== oldIdx) needRewrite = true;
        }
      }
      if (!remapped.includes(targetIdx)) remapped.push(targetIdx);
    }
    if (remapped.length !== origIndices.length) needRewrite = true;
    return { indices: remapped, needRewrite };
  };
  const addSupports = (supports: unknown[], isExisting: boolean): void => {
    for (const s of supports) {
      const partIndex = has(s, "segment.partIndex") ? gint(getAt(s, "segment.partIndex")) : 0;
      const startByte = gint(getAt(s, "segment.startIndex"));
      const endByte = gint(getAt(s, "segment.endIndex"));
      const { indices, needRewrite } = remapSupportIndices(asArr(getAt(s, "groundingChunkIndices")), isExisting);
      const key = supportKey(partIndex, startByte, endByte, indices);
      if (seenSupports.has(key)) continue;
      seenSupports.add(key);
      const copy = JSON.parse(JSON.stringify(s)) as unknown;
      if (needRewrite && isObj(copy)) copy.groundingChunkIndices = indices;
      mergedSupports.push(copy);
    }
  };
  addSupports(existingSupports, true);
  addSupports(newSupports, false);
  if (mergedSupports.length > 0) merged.groundingSupports = mergedSupports;

  const sep = getAt(newGM, "searchEntryPoint");
  if (sep !== undefined) merged.searchEntryPoint = sep;
  const rq = getAt(newGM, "retrievalQueries");
  if (rq !== undefined && getAt(existingGM, "retrievalQueries") === undefined) merged.retrievalQueries = rq;
  return merged;
}

function asArr(v: unknown): unknown[] {
  return isArr(v) ? v : [];
}

/** Merges url_citation annotations, deduplicating by URL and offsets and filling empty titles. */
export function mergeCitationAnnotations(existing: Record<string, unknown>[], late: Record<string, unknown>[]): Record<string, unknown>[] {
  if (existing.length === 0) return late;
  if (late.length === 0) return existing;
  const result: Record<string, unknown>[] = [];
  const keyToIndex = new Map<string, number>();
  const keyOf = (a: unknown): string => `${str(a, "url")}:${gint(getAt(a, "start_index"))}:${gint(getAt(a, "end_index"))}`;
  for (const a of existing) {
    const key = keyOf(a);
    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, result.length);
      result.push(a);
    }
  }
  for (const a of late) {
    const key = keyOf(a);
    const idx = keyToIndex.get(key);
    if (idx !== undefined) {
      if (str(result[idx], "title") === "" && str(a, "title") !== "") result[idx] = a;
    } else {
      keyToIndex.set(key, result.length);
      result.push(a);
    }
  }
  return result;
}

/** Converts a UTF-8 byte offset in text to a rune (code point) offset. */
export function byteOffsetToRuneOffset(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const bytes = utf8Bytes(text);
  if (byteOffset >= bytes.length) return utf8RuneCount(bytes);
  return utf8RuneCount(bytes.subarray(0, byteOffset));
}

/** The location of a Gemini content part within a Responses message. */
export interface GeminiPartMapping {
  partIndex: number;
  messageIndex: number;
  startRuneInMsg: number;
  partText: string;
}

export interface MessageRuneRange {
  messageIndex: number;
  startIndex: number;
  endIndex: number;
}

/** Translates a byte range across part mappings into message rune ranges. */
export function mapByteOffsetsToRuneRanges(mappings: GeminiPartMapping[], startByte: number, endByte: number): MessageRuneRange[] {
  if (mappings.length === 0) return [];
  if (startByte < 0) startByte = 0;
  if (startByte >= endByte) return [];
  const spans: { m: GeminiPartMapping; cumStart: number; cumEnd: number }[] = [];
  let cumBytes = 0;
  for (const m of mappings) {
    const pBytes = utf8Bytes(m.partText).length;
    spans.push({ m, cumStart: cumBytes, cumEnd: cumBytes + pBytes });
    cumBytes += pBytes;
  }
  if (startByte >= cumBytes) return [];
  if (endByte > cumBytes) endByte = cumBytes;
  const ranges: MessageRuneRange[] = [];
  for (const span of spans) {
    const overlapStart = Math.max(startByte, span.cumStart);
    const overlapEnd = Math.min(endByte, span.cumEnd);
    if (overlapStart >= overlapEnd) continue;
    const partStartRune = byteOffsetToRuneOffset(span.m.partText, overlapStart - span.cumStart);
    const partEndRune = byteOffsetToRuneOffset(span.m.partText, overlapEnd - span.cumStart);
    if (partEndRune <= partStartRune || partStartRune < 0) continue;
    const startRune = span.m.startRuneInMsg + partStartRune;
    const endRune = span.m.startRuneInMsg + partEndRune;
    const last = ranges[ranges.length - 1];
    if (last && last.messageIndex === span.m.messageIndex && last.endIndex === startRune) last.endIndex = endRune;
    else ranges.push({ messageIndex: span.m.messageIndex, startIndex: startRune, endIndex: endRune });
  }
  return ranges;
}

/** The first message rune range for a byte range, or undefined. */
export function mapByteOffsetsToRuneRange(mappings: GeminiPartMapping[], startByte: number, endByte: number): MessageRuneRange | undefined {
  return mapByteOffsetsToRuneRanges(mappings, startByte, endByte)[0];
}

/**
 * url_citation annotations per message index, translating part-level byte
 * offsets to message-level rune offsets. Undefined when there is nothing to cite.
 */
export function buildResponsesURLCitationsForMessages(
  groundingMetadata: unknown,
  mappings: GeminiPartMapping[],
  messageTexts: string[],
): Map<number, Record<string, unknown>[]> | undefined {
  const chunks = asArr(getAt(groundingMetadata, "groundingChunks"));
  const supports = asArr(getAt(groundingMetadata, "groundingSupports"));
  if (supports.length === 0 || chunks.length === 0) return undefined;

  const coalesced: GeminiPartMapping[] = [];
  for (const m of mappings) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.partIndex === m.partIndex && last.messageIndex === m.messageIndex) last.partText += m.partText;
    else coalesced.push({ ...m });
  }
  mappings = coalesced;

  const result = new Map<number, Record<string, unknown>[]>();
  const seen = new Set<string>();
  for (const support of supports) {
    const segment = getAt(support, "segment");
    const hasPartIndex = has(segment, "partIndex");
    const partIndex = gint(getAt(segment, "partIndex"));
    const startByte = gint(getAt(segment, "startIndex"));
    const endByte = gint(getAt(segment, "endIndex"));
    let ranges: MessageRuneRange[] = [];
    if (hasPartIndex) {
      let partMappings = mappings.filter((m) => m.partIndex === partIndex);
      if (partMappings.length === 0 && partIndex === 0 && mappings.length === 1) partMappings = mappings;
      ranges = mapByteOffsetsToRuneRanges(partMappings, startByte, endByte);
    } else if (mappings.length > 0) {
      ranges = mapByteOffsetsToRuneRanges(mappings, startByte, endByte);
    } else if (messageTexts.length > 0) {
      const msgText = messageTexts[0]!;
      const startRune = byteOffsetToRuneOffset(msgText, startByte);
      const endRune = byteOffsetToRuneOffset(msgText, endByte);
      if (endRune > startRune && startRune >= 0) ranges = [{ messageIndex: 0, startIndex: startRune, endIndex: endRune }];
    }
    if (ranges.length === 0) continue;
    for (const idxResult of asArr(getAt(support, "groundingChunkIndices"))) {
      const idx = gint(idxResult);
      if (idx < 0 || idx >= chunks.length) continue;
      const chunk = chunks[idx];
      const uri = str(chunk, "web.uri").trim();
      const title = str(chunk, "web.title").trim();
      if (uri === "") continue;
      for (const r of ranges) {
        const key = `${r.messageIndex}:${uri}:${r.startIndex}:${r.endIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const list = result.get(r.messageIndex) ?? [];
        list.push({ type: "url_citation", url: uri, title, start_index: r.startIndex, end_index: r.endIndex });
        result.set(r.messageIndex, list);
      }
    }
  }
  return result;
}

/** url_citation annotations for a single text (message 0 first, else any message). */
export function buildResponsesURLCitations(groundingMetadata: unknown, ...text: string[]): Record<string, unknown>[] {
  const fullText = text.length > 0 ? text[0]! : "";
  const mappings: GeminiPartMapping[] = fullText !== "" ? [{ partIndex: 0, messageIndex: 0, startRuneInMsg: 0, partText: fullText }] : [];
  const resMap = buildResponsesURLCitationsForMessages(groundingMetadata, mappings, text);
  if (!resMap) return [];
  const first = resMap.get(0);
  if (first && first.length > 0) return first;
  for (const c of resMap.values()) if (c.length > 0) return c;
  return [];
}
