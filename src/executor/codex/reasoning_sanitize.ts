// Reasoning item sanitising for Responses requests sent to Codex. Port of
// sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL /
// sanitizeOpenAIResponsesReasoningEncryptedContentWithOptions and
// resolveResponsesSignatureTargetModel (internal/runtime/executor/openai_responses_signature.go),
// plus CodexExecutor.resolveCodexModelIsCompat (codex_executor_auth.go).
//
// For every input item of type "reasoning":
//   - reasoning.content (cleartext reasoning_text replayed by third-party
//     channels) is promoted into an empty summary and cleared to [] unless the
//     selected model is is-compat (DeepSeek-style upstreams need it replayed);
//   - encrypted_content that is not a string, carries surrounding whitespace or
//     is not a signature the target provider accepts is dropped, together with
//     the item id when store is not true (Codex answers "Item with id ... not
//     found" for an id without usable encrypted_content);
//   - a router suffix (".openrouter") is stripped unless the upstream is OpenRouter.
// The body is returned unchanged (same string) when nothing needed editing.
import type { Auth } from "../../auth/types.ts";
import { modelOverridesFor } from "../../config/auths.ts";
import type { Config } from "../../config/types.ts";
import { parseSuffix } from "../../thinking/index.ts";
import {
  type SignatureProvider,
  SignatureProviderClaude,
  SignatureProviderGemini,
  SignatureProviderGPT,
  SignatureProviderGrok,
  SignatureProviderKimi,
  SignatureProviderMeta,
  SignatureProviderSWE,
  SignatureProviderUnknown,
  compatibleSignatureForProvider,
  detectSignatureProvider,
  inspectGPTReasoningSignature,
  inspectGrokEncryptedContent,
  inspectMetaReasoningSignature,
  signatureProviderFromModelName,
  splitSignatureProviderPrefix,
} from "../../signature/index.ts";
import { gstr, isArr, isObj } from "../../util/gpath.ts";
import { type JSONObject, tryParse } from "../../util/json.ts";
import { log } from "../../log.ts";
import { RequestedModelMetadataKey, type ExecOptions, type ExecRequest } from "../types.ts";
import { resolvedModelInfo } from "./thinking.ts";

/** One configured model of a Codex API-key credential (Go: config.CodexModel; only the compat-relevant fields). */
export interface CodexModelOption {
  name: string;
  alias?: string;
  isCompat?: boolean;
}

/** Resolves the configured models of the credential serving a request (Go: resolveCodexConfig(auth).Models). */
export type CodexModelOptionsResolver = (auth: Auth, req: ExecRequest) => ReadonlyArray<CodexModelOption> | undefined;

/** The configured codex-api-key models of a credential (Go: resolveCodexConfig via config_index). */
export function codexModelOptionsFromConfig(config: Config): CodexModelOptionsResolver {
  return (auth) => modelOverridesFor(config, auth);
}

/**
 * Whether the selected model enables compat handling (Go: resolveCodexModelIsCompat):
 * a model definition bound to the request wins; otherwise the first configured
 * model of the credential whose name or alias matches the upstream or the
 * requested model decides; no match (or no configured models) is false.
 */
export function resolveCodexModelIsCompat(auth: Auth | undefined, req: ExecRequest, baseModel: string, modelOptionsFor: CodexModelOptionsResolver | undefined): boolean {
  const bound = resolvedModelInfo(req);
  if (bound !== undefined) return bound.isCompat === true;
  const options = auth && modelOptionsFor ? modelOptionsFor(auth, req) : undefined;
  if (!options || options.length === 0) return false;
  const requested = req.model.trim().toLowerCase();
  const target = baseModel.trim().toLowerCase();
  for (const option of options) {
    const name = (option.name ?? "").trim().toLowerCase();
    const alias = (option.alias ?? "").trim().toLowerCase();
    const matches = (value: string) => value !== "" && ((name !== "" && name === value) || (alias !== "" && alias === value));
    if (matches(target) || matches(requested)) return option.isCompat === true;
  }
  return false;
}

/** The client's requested model from the execution metadata, or `fallback` (Go: helps.PayloadRequestedModel). */
function payloadRequestedModel(opts: ExecOptions, fallback: string): string {
  const raw = opts.metadata?.[RequestedModelMetadataKey];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return fallback.trim();
}

/**
 * The model whose provider family decides which reasoning signatures may replay:
 * the upstream model, or the client-requested one when an alias hides a GPT /
 * Grok / Meta family name (Go: resolveResponsesSignatureTargetModel).
 */
export function resolveResponsesSignatureTargetModel(baseModel: string, req: ExecRequest, opts: ExecOptions): string {
  if (signatureProviderFromModelName(baseModel) !== SignatureProviderUnknown) return baseModel;
  const requested = parseSuffix(payloadRequestedModel(opts, req.model)).modelName;
  switch (signatureProviderFromModelName(requested)) {
    case SignatureProviderMeta:
    case SignatureProviderGrok:
    case SignatureProviderGPT:
      return requested;
  }
  return baseModel;
}

function hostOf(rawURL: string): string | undefined {
  try {
    return new URL(rawURL).hostname.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

/** Go: isNativeMetaUpstreamURL (an empty or unparsable URL counts as native). */
export function isNativeMetaUpstreamURL(rawURL: string): boolean {
  rawURL = rawURL.trim();
  if (rawURL === "") return true;
  const host = hostOf(rawURL);
  if (host === undefined) return true;
  return host === "" || host === "api.meta.ai" || host.endsWith(".meta.ai");
}

/** Go: isOpenRouterUpstreamURL. */
export function isOpenRouterUpstreamURL(rawURL: string): boolean {
  rawURL = rawURL.trim();
  if (rawURL === "") return false;
  const host = hostOf(rawURL);
  if (host === undefined) return false;
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function stripRouterSuffix(rawSignature: string, suffix: string): string {
  if (suffix === "" || rawSignature.length <= suffix.length + 1) return rawSignature;
  return rawSignature.slice(0, rawSignature.length - suffix.length - 1);
}

type MetaSignaturePolicy = "foreign" | "native_only" | "allow_routed";

/** gjson Result.Bool(). */
function gjsonBool(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "t";
  }
  return false;
}

function summaryIsEmpty(summary: unknown): boolean {
  return summary === undefined || summary === null || (isArr(summary) && summary.length === 0);
}

/** Go: promoteOpenAIResponsesReasoningTextToSummary. */
function promoteReasoningTextToSummary(item: JSONObject, content: unknown[]): void {
  const parts: JSONObject[] = [];
  for (const part of content) {
    if (!isObj(part) || gstr(part.type).trim() !== "reasoning_text") continue;
    const text = gstr(part.text);
    if (text === "") continue;
    parts.push({ type: "summary_text", text });
  }
  if (parts.length > 0) item.summary = parts;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Go: sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL.
 * `provider` only labels the debug log.
 */
export function sanitizeResponsesReasoningEncryptedContent(provider: string, body: string, isCompat: boolean, targetModel: string, baseURL: string): string {
  const targetProvider = signatureProviderFromModelName(targetModel);
  let metaPolicy: MetaSignaturePolicy = "foreign";
  if (targetProvider === SignatureProviderMeta) metaPolicy = baseURL.trim() !== "" && isNativeMetaUpstreamURL(baseURL) ? "native_only" : "allow_routed";
  return sanitizeWithOptions(provider, body, isCompat, isCompat, metaPolicy, targetProvider, isOpenRouterUpstreamURL(baseURL));
}

/** Go: sanitizeOpenAIResponsesReasoningEncryptedContentWithOptions. */
function sanitizeWithOptions(
  provider: string,
  body: string,
  isCompat: boolean,
  keepForeign: boolean,
  metaPolicy: MetaSignaturePolicy,
  targetProvider: SignatureProvider,
  allowRouterSuffix: boolean,
): string {
  if (!body.includes("reasoning")) return body;
  const root = tryParse(body);
  if (!isObj(root) || !isArr(root.input)) return body;
  provider = provider.trim() || "openai responses upstream";
  // Codex rejects store=true and does not persist items when store=false, so a
  // reasoning id without usable encrypted_content would be a failing store lookup.
  const stripOrphanReasoningIDs = !gjsonBool(root.store);
  let changedAny = false;

  root.input.forEach((item, index) => {
    if (!isObj(item) || gstr(item.type).trim() !== "reasoning") return;
    const itemID = gstr(item.id).trim() || `input[${index}]`;
    let changed = false;

    // Official Codex sets maxItems: 0 on reasoning.content; is-compat upstreams
    // (such as DeepSeek) need the original reasoning_text replayed there.
    const content = item.content;
    if (!isCompat && isArr(content) && content.length > 0) {
      if (summaryIsEmpty(item.summary)) promoteReasoningTextToSummary(item, content);
      item.content = [];
      changed = true;
      log.debug(`${provider}: cleared reasoning content`, { index, item_id: itemID });
    }

    if (!("encrypted_content" in item)) {
      if (!isCompat && stripOrphanReasoningIDs && "id" in item) {
        delete item.id;
        changed = true;
        log.debug(`${provider}: dropped orphan reasoning id (missing encrypted_content with store disabled)`, { index, item_id: itemID });
      }
      if (changed) changedAny = true;
      return;
    }

    const encrypted = item.encrypted_content;
    let reason = "";
    let rewritten = "";
    if (typeof encrypted === "string") {
      const raw = encrypted;
      if (raw !== raw.trim()) {
        reason = "encrypted_content has leading or trailing whitespace";
      } else if (metaPolicy !== "foreign") {
        // Only a recognised Meta envelope may replay to a Meta target.
        try {
          const info = inspectMetaReasoningSignature(raw);
          if (info.routerSuffix !== "") {
            if (metaPolicy === "native_only") reason = "router-suffixed Meta reasoning signature is not accepted by the native Meta upstream";
            else if (!allowRouterSuffix) rewritten = stripRouterSuffix(raw, info.routerSuffix);
          }
        } catch (err) {
          reason = errorMessage(err);
        }
      } else if (targetProvider === SignatureProviderUnknown || targetProvider === SignatureProviderGPT) {
        let candidate = raw;
        let hasGPTPrefix = false;
        const split = splitSignatureProviderPrefix(raw);
        if (split.ok && split.provider === SignatureProviderGPT) {
          candidate = split.rest;
          hasGPTPrefix = true;
        }
        try {
          const info = inspectGPTReasoningSignature(candidate);
          if (info.routerSuffix !== "" && !allowRouterSuffix) rewritten = stripRouterSuffix(candidate, info.routerSuffix);
          else if (hasGPTPrefix) rewritten = candidate;
        } catch (err) {
          if (!(keepForeign && raw !== "" && detectSignatureProvider(raw) === SignatureProviderUnknown)) reason = errorMessage(err);
        }
      } else {
        // A known non-GPT, non-Meta target (Grok, Gemini, ... behind a Responses router).
        let keep = false;
        if (raw !== "") {
          switch (targetProvider) {
            case SignatureProviderGrok:
              try {
                const info = inspectGrokEncryptedContent(raw);
                keep = true;
                if (info.routerSuffix !== "" && !allowRouterSuffix) rewritten = stripRouterSuffix(raw, info.routerSuffix);
              } catch {
                keep = false;
              }
              break;
            case SignatureProviderGemini:
            case SignatureProviderClaude:
            case SignatureProviderKimi:
            case SignatureProviderSWE: {
              const normalized = compatibleSignatureForProvider(targetProvider, raw);
              keep = normalized !== undefined;
              if (keep && normalized !== raw) rewritten = normalized!;
              break;
            }
          }
          if (!keep && keepForeign) keep = detectSignatureProvider(raw) === SignatureProviderUnknown;
        }
        if (!keep) reason = `reasoning encrypted_content is not compatible with target provider ${targetProvider}`;
      }
    } else if (encrypted === null) {
      reason = "encrypted_content is null";
    } else {
      reason = `encrypted_content must be a string, got ${isArr(encrypted) || isObj(encrypted) ? "JSON" : typeof encrypted}`;
    }

    if (reason === "") {
      if (rewritten !== "") {
        item.encrypted_content = rewritten;
        changed = true;
        log.debug(`${provider}: stripped router suffix from reasoning encrypted_content`, { index, item_id: itemID });
      }
      if (changed) changedAny = true;
      return;
    }

    delete item.encrypted_content;
    if (!isCompat && stripOrphanReasoningIDs && "id" in item) delete item.id;
    changedAny = true;
    log.debug(`${provider}: dropped invalid reasoning encrypted_content`, { index, item_id: itemID, reason });
  });

  return changedAny ? JSON.stringify(root) : body;
}
