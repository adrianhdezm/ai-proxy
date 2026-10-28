// Code Assist onboarding for the Gemini CLI: discovers or activates the Google
// Cloud project behind a login (loadCodeAssist / onboardUser) and checks that
// the Cloud AI companion API is enabled. Port of performGeminiCLISetup,
// callGeminiCLI and checkCloudAPIIsEnabled from v7.0.12 internal/cmd/login.go
// and misc.GeminiCLIUserAgent from internal/misc/header_utils.go. The
// interactive project picker (fetchGCPProjects / promptForProjectSelection)
// is not ported: the project id is either configured or auto-discovered.
import { log } from "../../log.ts";
import { type FetchLike, withProxy } from "../oauth/http.ts";
import { type Clock, type Sleep, realSleep } from "../oauth/time.ts";
import type { GeminiEndpoints } from "./gemini_auth.ts";

export const geminiCLIVersion = "0.34.0";
export const geminiCLIAPIVersion = "v1internal";

function geminiCLIOS(): string {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    default:
      return process.platform;
  }
}

/** "GeminiCLI/<version>/<model> (<os>; <arch>; terminal)". */
export function geminiCLIUserAgent(model = ""): string {
  return `GeminiCLI/${geminiCLIVersion}/${model || "unknown"} (${geminiCLIOS()}; ${process.arch}; terminal)`;
}

/** Thrown when onboarding cannot proceed without an explicit project id. */
export class ProjectSelectionRequiredError extends Error {
  constructor() {
    super("gemini cli: project selection required");
    this.name = "ProjectSelectionRequiredError";
  }
}

/** Authenticated access to the Code Assist and Service Usage APIs. */
export interface CodeAssistClient {
  fetch: FetchLike;
  accessToken: string;
  endpoints: Pick<GeminiEndpoints, "codeAssistEndpoint" | "serviceUsageUrl">;
  proxyUrl?: string;
}

export interface SetupOptions {
  signal?: AbortSignal;
  sleep?: Sleep;
  now?: Clock;
  /** Auto-discovery budget (default 30s) and onboarding poll intervals. */
  autoDiscoveryTimeoutMs?: number;
  autoDiscoveryPollMs?: number;
  onboardPollMs?: number;
}

const defaultMetadata = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };

/** POST {endpoint}/v1internal:{method} (or {endpoint}/operations/... for LROs). */
export async function callGeminiCLI<T = Record<string, unknown>>(client: CodeAssistClient, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const base = client.endpoints.codeAssistEndpoint.replace(/\/+$/, "");
  const url = method.startsWith("operations/") ? `${base}/${method}` : `${base}/${geminiCLIAPIVersion}:${method}`;
  let resp: Response;
  try {
    resp = await client.fetch(
      url,
      withProxy(
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": geminiCLIUserAgent(""), Authorization: `Bearer ${client.accessToken}` },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        },
        client.proxyUrl,
      ),
    );
  } catch (err) {
    throw new Error(`execute request: ${(err as Error).message}`);
  }
  const text = await resp.text();
  if (resp.status < 200 || resp.status >= 300) throw new Error(`api request failed with status ${resp.status}: ${text.trim()}`);
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`decode response body: ${(err as Error).message}`);
  }
}

function projectIdOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return ((value as { id: string }).id).trim();
  return "";
}

function defaultTierId(loadResp: Record<string, unknown>): string {
  const tiers = loadResp["allowedTiers"];
  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (tier && typeof tier === "object" && (tier as { isDefault?: unknown }).isDefault === true) {
        const id = (tier as { id?: unknown }).id;
        if (typeof id === "string" && id.trim() !== "") return id.trim();
      }
    }
  }
  return "legacy-tier";
}

/**
 * Port of performGeminiCLISetup. With a requested project it is onboarded
 * (the backend may map it to another id, which wins). Without one the
 * project advertised by loadCodeAssist is used, or onboardUser is called
 * without a project so Google auto-provisions one. Returns the final project id.
 */
export async function performGeminiCLISetup(client: CodeAssistClient, requestedProject: string, opts: SetupOptions = {}): Promise<string> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const trimmedRequest = requestedProject.trim();
  const explicitProject = trimmedRequest !== "";

  const loadReqBody: Record<string, unknown> = { metadata: defaultMetadata };
  if (explicitProject) loadReqBody.cloudaicompanionProject = trimmedRequest;
  let loadResp: Record<string, unknown>;
  try {
    loadResp = await callGeminiCLI(client, "loadCodeAssist", loadReqBody, opts.signal);
  } catch (err) {
    throw new Error(`load code assist: ${(err as Error).message}`, { cause: err });
  }
  const tierId = defaultTierId(loadResp);

  let projectId = trimmedRequest;
  if (projectId === "") projectId = projectIdOf(loadResp["cloudaicompanionProject"]);

  if (projectId === "") {
    // Auto-discovery: onboard without a project so Google provisions one.
    const budget = opts.autoDiscoveryTimeoutMs ?? 30_000;
    const deadline = now() + budget;
    const autoReq = { tierId, metadata: defaultMetadata };
    for (let attempt = 1; ; attempt++) {
      let onboardResp: Record<string, unknown>;
      try {
        onboardResp = await callGeminiCLI(client, "onboardUser", autoReq, opts.signal);
      } catch (err) {
        throw new Error(`auto-discovery onboardUser: ${(err as Error).message}`, { cause: err });
      }
      if (onboardResp["done"] === true) {
        const response = onboardResp["response"];
        if (response && typeof response === "object") projectId = projectIdOf((response as Record<string, unknown>)["cloudaicompanionProject"]);
        break;
      }
      log.debug(`Auto-discovery: onboarding in progress, attempt ${attempt}...`);
      if (now() + (opts.autoDiscoveryPollMs ?? 2000) > deadline) throw new ProjectSelectionRequiredError();
      await sleep(opts.autoDiscoveryPollMs ?? 2000, opts.signal);
    }
    if (projectId === "") throw new ProjectSelectionRequiredError();
    log.info(`Auto-discovered project ID via onboarding: ${projectId}`);
  }

  const onboardReqBody = { tierId, metadata: defaultMetadata, cloudaicompanionProject: projectId };
  for (;;) {
    let onboardResp: Record<string, unknown>;
    try {
      onboardResp = await callGeminiCLI(client, "onboardUser", onboardReqBody, opts.signal);
    } catch (err) {
      throw new Error(`onboard user: ${(err as Error).message}`, { cause: err });
    }
    if (onboardResp["done"] === true) {
      let responseProjectId = "";
      const response = onboardResp["response"];
      if (response && typeof response === "object") responseProjectId = projectIdOf((response as Record<string, unknown>)["cloudaicompanionProject"]);
      let finalProjectId = projectId;
      if (responseProjectId !== "") {
        if (explicitProject && responseProjectId.toLowerCase() !== projectId.toLowerCase()) {
          log.info(`Gemini onboarding: requested project ${projectId} maps to backend project ${responseProjectId}`);
        }
        finalProjectId = responseProjectId;
      }
      finalProjectId = finalProjectId.trim() || projectId.trim();
      if (finalProjectId === "") throw new Error("onboard user completed without project id");
      log.info(`Onboarding complete. Using Project ID: ${finalProjectId}`);
      return finalProjectId;
    }
    log.info("Onboarding in progress, waiting 5 seconds...");
    await sleep(opts.onboardPollMs ?? 5000, opts.signal);
  }
}

/**
 * Port of checkCloudAPIIsEnabled: verifies cloudaicompanion.googleapis.com is
 * enabled for the project, enabling it when needed. Throws with the API's
 * message when activation is required and fails.
 */
export async function checkCloudAPIIsEnabled(client: CodeAssistClient, projectId: string, signal?: AbortSignal): Promise<boolean> {
  const base = client.endpoints.serviceUsageUrl.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", "User-Agent": geminiCLIUserAgent(""), Authorization: `Bearer ${client.accessToken}` };
  for (const service of ["cloudaicompanion.googleapis.com"]) {
    const checkUrl = `${base}/v1/projects/${projectId}/services/${service}`;
    let resp: Response;
    try {
      resp = await client.fetch(checkUrl, withProxy({ method: "GET", headers, signal }, client.proxyUrl));
    } catch (err) {
      throw new Error(`failed to execute request: ${(err as Error).message}`);
    }
    if (resp.status === 200) {
      const body = (await resp.text().catch(() => "")) || "{}";
      let state = "";
      try {
        state = String((JSON.parse(body) as { state?: unknown }).state ?? "");
      } catch {
        state = "";
      }
      if (state === "ENABLED") continue;
    } else {
      await resp.text().catch(() => "");
    }

    const enableUrl = `${base}/v1/projects/${projectId}/services/${service}:enable`;
    try {
      resp = await client.fetch(enableUrl, withProxy({ method: "POST", headers, body: "{}", signal }, client.proxyUrl));
    } catch (err) {
      throw new Error(`failed to execute request: ${(err as Error).message}`);
    }
    const body = await resp.text().catch(() => "");
    let errMessage = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") errMessage = parsed.error.message;
    } catch {
      // keep raw body
    }
    if (resp.status === 200 || resp.status === 201) continue;
    if (resp.status === 400 && errMessage.toLowerCase().includes("already enabled")) continue;
    throw new Error(`project activation required: ${errMessage}`);
  }
  return true;
}
