// Prompt cache identity for Codex requests. Port of CodexExecutor.cacheHelper's
// prompt_cache_key / Session-Id half (codex_executor_request.go), the shared
// selection of applyCodexPromptCacheHeadersWithContext (codex_websockets_request.go),
// helps.ClaudeCodePromptCache (claude_code_session.go) and
// helps.ProviderSessionUUID / DerivedSessionUUID (derived_session.go).
//
// The cache id is chosen per inbound format:
//   - Claude Messages: a UUIDv5 of the Claude Code session + agent (X-Claude-Code-Session-Id /
//     X-Claude-Code-Agent-Id headers or metadata.user_id) and the upstream model, so every
//     turn of one Claude Code agent hits the same Codex prompt cache;
//   - OpenAI Responses: the client's prompt_cache_key;
//   - otherwise (and when the above yield nothing): a UUIDv5 of the downstream
//     execution session (Responses websocket) or the derived session id in the metadata.
// The HTTP transport sends it as body prompt_cache_key plus a Session-Id header.
//
// Not ported: the OpenAI chat-completions branch (that inbound format is not
// served) and zstd request compression.
import { parseSuffix } from "../../thinking/index.ts";
import { FormatClaude, FormatOpenAIResponse, type Format } from "../../translator/types.ts";
import { getAt, gstr } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import type { ExecRequest } from "../types.ts";
import { ExecutionSessionMetadataKey, claudeCodeExecutionScope } from "./reasoning_replay.ts";
import { setStringIfDifferent } from "./request.ts";

/** Go: cliproxyexecutor.DerivedSessionIDMetadataKey. */
export const DerivedSessionIDMetadataKey = "derived_session_id";

/** The RFC 4122 OID namespace (Go: uuid.NameSpaceOID). */
const nameSpaceOID = Uint8Array.from([0x6b, 0xa7, 0xb8, 0x12, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);

/** A name-based SHA-1 UUID in the OID namespace (Go: uuid.NewSHA1(uuid.NameSpaceOID, name)). */
export function uuidV5OID(name: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(nameSpaceOID);
  hasher.update(name);
  const sum = Uint8Array.from(hasher.digest().subarray(0, 16));
  sum[6] = (sum[6]! & 0x0f) | 0x50;
  sum[8] = (sum[8]! & 0x3f) | 0x80;
  const hex = Array.from(sum, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const raw = metadata?.[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function stableProviderSessionUUID(provider: string, kind: string, identity: string): string {
  provider = provider.trim().toLowerCase();
  identity = identity.trim();
  if (provider === "" || identity === "") return "";
  return uuidV5OID(["cli-proxy-api", provider, kind, identity].join("\x00"));
}

/** Go: helps.DerivedSessionUUID. */
export function derivedSessionUUID(provider: string, ...metadataSets: Array<Record<string, unknown> | undefined>): string {
  for (const metadata of metadataSets) {
    const derived = metadataString(metadata, DerivedSessionIDMetadataKey);
    if (derived !== "") return stableProviderSessionUUID(provider, "derived-session", derived);
  }
  return "";
}

/** Go: helps.ProviderSessionUUID: the long-lived execution session, else the derived identity. */
export function providerSessionUUID(provider: string, ...metadataSets: Array<Record<string, unknown> | undefined>): string {
  for (const metadata of metadataSets) {
    const executionID = metadataString(metadata, ExecutionSessionMetadataKey);
    if (executionID !== "") return stableProviderSessionUUID(provider, "execution-session", executionID);
  }
  return derivedSessionUUID(provider, ...metadataSets);
}

/** Go: helps.ClaudeCodePromptCache: "" without a Claude Code session or model. */
export function claudeCodePromptCacheID(modelName: string, payload: string, headers: Headers | undefined): string {
  modelName = modelName.trim();
  const scope = claudeCodeExecutionScope(payload, headers);
  if (modelName === "" || scope === "") return "";
  return uuidV5OID(["cli-proxy-api:codex:claude-code", modelName, scope].join("\x00"));
}

function sourceFormatEqual(from: Format, want: Format): boolean {
  return String(from ?? "").trim().toLowerCase() === want.toLowerCase();
}

/**
 * The prompt cache id of a request (Go: the shared head of cacheHelper and
 * applyCodexPromptCacheHeadersWithContext). `body` is the translated upstream body;
 * `optsMetadata` is the execution options' metadata (the TS server binds the
 * execution session there, Go bound it to both request and options).
 */
export function codexPromptCacheID(from: Format, req: ExecRequest, body: string, clientHeaders: Headers | undefined, optsMetadata?: Record<string, unknown>): string {
  let cacheID = "";
  if (sourceFormatEqual(from, FormatClaude)) {
    let modelName = gstr(getAt(tryParse(body), "model")).trim();
    if (modelName === "") modelName = parseSuffix(req.model).modelName;
    cacheID = claudeCodePromptCacheID(modelName, req.payload, clientHeaders);
  } else if (sourceFormatEqual(from, FormatOpenAIResponse)) {
    const key = getAt(tryParse(req.payload), "prompt_cache_key");
    if (key !== undefined) cacheID = key === null ? "" : gstr(key);
  }
  if (cacheID === "") cacheID = providerSessionUUID("codex", req.metadata, optsMetadata);
  return cacheID;
}

/**
 * HTTP transport: sets body prompt_cache_key and returns the Session-Id value
 * ("" when the request has no cache identity) (Go: cacheHelper).
 */
export function applyCodexHTTPPromptCache(from: Format, req: ExecRequest, body: string, clientHeaders: Headers | undefined, optsMetadata?: Record<string, unknown>): { body: string; sessionID: string } {
  const cacheID = codexPromptCacheID(from, req, body, clientHeaders, optsMetadata);
  if (cacheID === "") return { body, sessionID: "" };
  return { body: setStringIfDifferent(body, "prompt_cache_key", cacheID), sessionID: cacheID };
}
