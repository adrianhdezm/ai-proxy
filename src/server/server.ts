// Bun HTTP server: router, inbound API-key auth, CORS, request size limit and the
// Claude-compatible routes. Port of the kept parts of internal/api/server_routes.go
// and server_middleware.go (corsMiddleware, maxRequestBodyBytesMiddleware,
// accessAuthMiddleware with internal/access/config_access).
import type { Server } from "bun";
import type { Config } from "../config/types.ts";
import { log } from "../log.ts";
import type { ModelRegistry } from "../registry/index.ts";
import { ClaudeCodeAPIHandler, type ExecutionManager } from "./claude_handlers.ts";
import { OpenAIImagesHandler, openAIErrorMessage, openAIErrorResponse } from "./images_handlers.ts";
import { OpenAIResponsesAPIHandler, isOpenAIModelsRequest } from "./responses_handlers.ts";
import { claudeErrorMessage, claudeErrorResponse } from "./errors.ts";
import { usageStatisticsResponse } from "../usage/http.ts";
import type { UsageStatistics } from "../usage/statistics.ts";

export interface ServerOptions {
  manager: ExecutionManager;
  registry?: ModelRegistry;
  /** Interface to bind; "" binds all interfaces. */
  host?: string;
  /** Listening port; 0 picks an ephemeral port. */
  port?: number;
  /** Maximum inbound body size in bytes; 0 disables the limit. */
  maxRequestBodyBytes?: number;
  /** Inbound API keys; empty leaves the API open (upstream legacy behaviour). */
  apiKeys?: string[];
  /** Forward filtered upstream response headers to clients. */
  passthroughHeaders?: boolean;
  /** Rewrite non-claude model ids in /v1/models (see ClaudeHandlerOptions). */
  cloakModelList?: boolean;
  /** Usage statistics store backing GET /v0/usage and the per-request records. */
  usage?: UsageStatistics;
  /** Clock (epoch ms) for usage records. */
  now?: () => number;
  /** multimedia.disableImageGeneration: /v1/images/* answer 404. */
  disableImageGeneration?: boolean;
}

export interface ProxyServer {
  /** The request handler; usable without a listening socket (tests). */
  fetch(request: Request): Promise<Response>;
  /** Starts listening; returns the Bun server. */
  start(): Server<undefined>;
  /** Stops listening (no-op when not started). */
  stop(): Promise<void>;
  /** The listening Bun server, when started. */
  readonly server: Server<undefined> | undefined;
  readonly handler: ClaudeCodeAPIHandler;
  /** The OpenAI Responses handler (/v1/responses, /v1/responses/compact, OpenAI /v1/models). */
  readonly responsesHandler: OpenAIResponsesAPIHandler;
}

/** Request headers browser clients may send (Go: corsAllowedRequestHeaders). */
const corsAllowedRequestHeaders = ["Authorization", "Content-Type", "X-Api-Key", "X-Goog-Api-Key", "Anthropic-Version", "Anthropic-Beta"];
/** Response headers exposed to browsers (Go: corsExposedResponseHeaders, kept subset). */
const corsExposedResponseHeaders = ["Retry-After", "Content-Type", "Content-Length", "ETag", "X-Request-Id", "Request-Id", "Anthropic-Ratelimit-Requests-Remaining"].join(", ");

/** Builds the server options from the loaded config. */
export function serverOptionsFromConfig(config: Config, manager: ExecutionManager, registry?: ModelRegistry): ServerOptions {
  return {
    manager,
    registry,
    host: config.server.host,
    port: config.server.port,
    maxRequestBodyBytes: config.server.maxRequestBodyBytes,
    apiKeys: config.access.apiKeys,
    passthroughHeaders: config.requests.passthroughHeaders,
    disableImageGeneration: config.multimedia.disableImageGeneration,
  };
}

export function createServer(options: ServerOptions): ProxyServer {
  const handler = new ClaudeCodeAPIHandler({
    manager: options.manager,
    registry: options.registry,
    passthroughHeaders: options.passthroughHeaders,
    cloakModelList: options.cloakModelList,
    usage: options.usage,
    now: options.now,
  });
  const apiKeys = new Set((options.apiKeys ?? []).map((key) => key.trim()).filter((key) => key !== ""));
  const maxBodyBytes = Math.max(0, Math.trunc(options.maxRequestBodyBytes ?? 0));
  const imagesHandler = new OpenAIImagesHandler({
    manager: options.manager,
    registry: options.registry,
    passthroughHeaders: options.passthroughHeaders,
    disableImageGeneration: options.disableImageGeneration,
    maxRequestBodyBytes: maxBodyBytes,
    usage: options.usage,
    now: options.now,
  });
  const responsesHandler = new OpenAIResponsesAPIHandler({
    manager: options.manager,
    registry: options.registry,
    passthroughHeaders: options.passthroughHeaders,
    usage: options.usage,
    now: options.now,
  });
  const passthroughHeaders = options.passthroughHeaders ?? false;
  let server: Server<undefined> | undefined;

  const errorResponse = (status: number, type: string, message: string): Response => claudeErrorResponse(claudeErrorMessage(status, type, message), { passthroughHeaders });

  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return new Response(null, { status: 204 });

    if (path === "/" || path === "/health") {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET"]);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (path === "/v0/usage") {
      const usageAuthError = authenticate(request, url, apiKeys);
      if (usageAuthError) return errorResponse(401, "authentication_error", usageAuthError);
      if (!options.usage?.enabled) return errorResponse(404, "not_found_error", "usage statistics are disabled");
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET"]);
      return usageStatisticsResponse(options.usage, url);
    }

    if (!path.startsWith("/v1/")) return errorResponse(404, "not_found_error", `Not Found: ${method} ${path}`);

    const authError = authenticate(request, url, apiKeys);
    const responsesPath = path === "/v1/responses" || path === "/v1/responses/compact";
    if (authError && responsesPath) return openAIErrorResponse(openAIErrorMessage(401, { message: authError, type: "authentication_error", code: "invalid_api_key" }));
    if (authError) return errorResponse(401, "authentication_error", authError);

    if (path === "/v1/messages" || path === "/v1/messages/count_tokens") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      const body = await readRequestBody(request, maxBodyBytes);
      if ("error" in body) return body.error;
      return path === "/v1/messages" ? handler.claudeMessages(request, body.text, { clientKey: authenticatedAPIKey(request, url, apiKeys) }) : handler.claudeCountTokens(request, body.text);
    }

    if (path === "/v1/images/generations" || path === "/v1/images/edits") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      const imagesContext = { clientKey: authenticatedAPIKey(request, url, apiKeys) };
      return path === "/v1/images/generations" ? imagesHandler.imagesGenerations(request, imagesContext) : imagesHandler.imagesEdits(request, imagesContext);
    }

    if (responsesPath) {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      const body = await readRequestBody(request, maxBodyBytes);
      if ("error" in body) {
        const status = body.error.status;
        return openAIErrorResponse(openAIErrorMessage(status, { message: status === 413 ? "request body too large" : "Invalid request: unreadable body", type: "invalid_request_error" }));
      }
      const responsesContext = { clientKey: authenticatedAPIKey(request, url, apiKeys) };
      return path === "/v1/responses" ? responsesHandler.responses(request, body.text, responsesContext) : responsesHandler.compact(request, body.text, responsesContext);
    }

    if (path === "/v1/models") {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      return isOpenAIModelsRequest(request, url) ? responsesHandler.openAIModels() : handler.claudeModels();
    }
    if (path.startsWith("/v1/models/")) {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      const modelID = decodeURIComponent(path.slice("/v1/models/".length));
      return isOpenAIModelsRequest(request, url) ? responsesHandler.openAIModelDetail(modelID) : handler.claudeModelDetail(modelID);
    }

    return errorResponse(404, "not_found_error", `Not Found: ${method} ${path}`);
  };

  const methodNotAllowed = (allow: string[]): Response => {
    const response = errorResponse(405, "invalid_request_error", "Method Not Allowed");
    response.headers.set("Allow", allow.join(", "));
    return response;
  };

  const fetch = async (request: Request): Promise<Response> => {
    let response: Response;
    try {
      response = await route(request);
    } catch (err) {
      log.error("unhandled request error:", err instanceof Error ? err.message : String(err));
      response = errorResponse(500, "api_error", "Internal Server Error");
    }
    applyCORS(response.headers, request);
    return response;
  };

  return {
    fetch,
    get server() {
      return server;
    },
    handler,
    responsesHandler,
    start() {
      if (server) return server;
      server = Bun.serve({
        hostname: options.host && options.host !== "" ? options.host : undefined,
        port: options.port ?? 0,
        idleTimeout: 0,
        maxRequestBodySize: maxBodyBytes > 0 ? maxBodyBytes : undefined,
        fetch,
      });
      log.info(`listening on http://${server.hostname}:${server.port}`);
      return server;
    },
    async stop() {
      if (!server) return;
      const current = server;
      server = undefined;
      await current.stop(true);
    },
  };
}

/** Adds the CORS headers upstream sends on every response (Go: corsMiddleware). */
export function applyCORS(headers: Headers, request: Request): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", corsAllowHeadersValue(request));
  headers.set("Access-Control-Expose-Headers", corsExposedResponseHeaders);
}

/** Names the known API request headers and, on preflight, echoes the requested ones (Go: corsAllowHeadersValue). */
export function corsAllowHeadersValue(request: Request): string {
  const allowed: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const canonical = canonicalHeaderKey(name.trim());
    if (canonical === "") return;
    const key = canonical.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    allowed.push(canonical);
  };
  for (const name of corsAllowedRequestHeaders) add(name);
  if (request.method.toUpperCase() === "OPTIONS") {
    for (const name of (request.headers.get("Access-Control-Request-Headers") ?? "").split(",")) add(name);
  }
  return allowed.join(", ");
}

function canonicalHeaderKey(name: string): string {
  return name
    .split("-")
    .map((part) => (part === "" ? "" : part[0]!.toUpperCase() + part.slice(1).toLowerCase()))
    .join("-");
}

/**
 * Checks the inbound credential against the configured keys. Accepted forms:
 * `Authorization: Bearer <key>`, `x-api-key`, `x-goog-api-key`, `?key=` and
 * `?auth_token=` (Go: config_access provider). Returns an error message or
 * undefined when the request is allowed; no configured keys means open access.
 */
export function authenticate(request: Request, url: URL, apiKeys: ReadonlySet<string>): string | undefined {
  if (apiKeys.size === 0) return undefined;
  const authHeader = request.headers.get("Authorization") ?? "";
  const candidates = [
    extractBearerToken(authHeader),
    request.headers.get("X-Goog-Api-Key") ?? "",
    request.headers.get("X-Api-Key") ?? "",
    url.searchParams.get("key") ?? "",
    url.searchParams.get("auth_token") ?? "",
  ];
  if (authHeader === "" && candidates.every((candidate) => candidate === "")) return "missing API key";
  for (const candidate of candidates) {
    if (candidate !== "" && apiKeys.has(candidate)) return undefined;
  }
  return "invalid API key";
}

/**
 * The configured inbound key the request authenticated with, checked in the
 * same order as authenticate(); "" when access is open or nothing matched.
 * Only used for usage attribution, where it is stored masked.
 */
export function authenticatedAPIKey(request: Request, url: URL, apiKeys: ReadonlySet<string>): string {
  if (apiKeys.size === 0) return "";
  const candidates = [
    extractBearerToken(request.headers.get("Authorization") ?? ""),
    request.headers.get("X-Goog-Api-Key") ?? "",
    request.headers.get("X-Api-Key") ?? "",
    url.searchParams.get("key") ?? "",
    url.searchParams.get("auth_token") ?? "",
  ];
  return candidates.find((candidate) => candidate !== "" && apiKeys.has(candidate)) ?? "";
}

function extractBearerToken(header: string): string {
  if (header === "") return "";
  const idx = header.indexOf(" ");
  if (idx === -1) return "";
  const scheme = header.slice(0, idx);
  if (scheme.toLowerCase() !== "bearer") return "";
  return header.slice(idx + 1).trim();
}

/**
 * Reads the request body enforcing the configured size limit
 * (Go: maxRequestBodyBytesMiddleware). Oversized bodies yield a 413 in the
 * Claude error shape.
 */
export async function readRequestBody(request: Request, maxBytes: number): Promise<{ text: string } | { error: Response }> {
  const tooLarge = () => ({ error: claudeErrorResponse(claudeErrorMessage(413, "request_too_large", "request body too large")) });
  if (maxBytes > 0) {
    const declared = Number(request.headers.get("Content-Length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch (err) {
    return { error: claudeErrorResponse(claudeErrorMessage(400, "invalid_request_error", `Invalid request: ${err instanceof Error ? err.message : String(err)}`)) };
  }
  if (maxBytes > 0 && bytes.byteLength > maxBytes) return tooLarge();
  return { text: new TextDecoder().decode(bytes) };
}
