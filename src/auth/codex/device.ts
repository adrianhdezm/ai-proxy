// Codex device-code login (headless alternative to the browser callback).
// Port of sdk/auth/codex_device.go.
import { type FetchLike, resolveFetch, withProxy } from "../oauth/http.ts";
import { type Clock, type Sleep, realSleep } from "../oauth/time.ts";
import type { LoginHooks, LoginOptions } from "../oauth/types.ts";
import { ClientID, CodexAuth } from "./codex_auth.ts";
import type { CodexAuthBundle } from "./token.ts";

export const codexLoginModeMetadataKey = "codex_login_mode";
export const codexLoginModeDevice = "device";
export const codexDeviceUserCodeURL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const codexDeviceTokenURL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const codexDeviceVerificationURL = "https://auth.openai.com/codex/device";
export const codexDeviceTokenExchangeRedirectURI = "https://auth.openai.com/deviceauth/callback";
const codexDeviceTimeoutMs = 15 * 60_000;
const codexDeviceDefaultPollIntervalSeconds = 5;

interface DeviceUserCodeResponse {
  device_auth_id?: string;
  user_code?: string;
  usercode?: string;
  interval?: unknown;
}

interface DeviceTokenResponse {
  authorization_code?: string;
  code_verifier?: string;
  code_challenge?: string;
}

/** True when opts.metadata.codex_login_mode selects the device flow. */
export function shouldUseCodexDeviceFlow(opts: LoginOptions | undefined): boolean {
  const mode = opts?.metadata?.[codexLoginModeMetadataKey];
  return typeof mode === "string" && mode.trim().toLowerCase() === codexLoginModeDevice;
}

/** Parses the poll interval (seconds as number or numeric string); defaults to 5s. */
export function parseCodexDevicePollIntervalMs(raw: unknown): number {
  const fallback = codexDeviceDefaultPollIntervalSeconds * 1000;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "string") {
    const seconds = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
  }
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw * 1000;
  return fallback;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export interface DeviceFlowOptions {
  fetch?: FetchLike;
  proxyUrl?: string;
  now?: Clock;
  sleep?: Sleep;
  signal?: AbortSignal;
  noBrowser?: boolean;
  hooks?: LoginHooks;
  /** Endpoint overrides (tests). */
  userCodeURL?: string;
  tokenURL?: string;
  verificationURL?: string;
}

async function postJSON(fetchFn: FetchLike, proxyUrl: string | undefined, url: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const resp = await fetchFn(url, withProxy({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal }, proxyUrl));
  return { status: resp.status, text: await resp.text() };
}

export async function requestCodexDeviceUserCode(fetchFn: FetchLike, proxyUrl: string | undefined, url: string, signal?: AbortSignal): Promise<DeviceUserCodeResponse> {
  let res: { status: number; text: string };
  try {
    res = await postJSON(fetchFn, proxyUrl, url, { client_id: ClientID }, signal);
  } catch (err) {
    throw new Error(`failed to request codex device code: ${(err as Error).message}`);
  }
  if (!isSuccess(res.status)) {
    if (res.status === 404) throw new Error(`codex device endpoint is unavailable (status ${res.status})`);
    const trimmed = res.text.trim() || "empty response body";
    throw new Error(`codex device code request failed with status ${res.status}: ${trimmed}`);
  }
  try {
    return JSON.parse(res.text) as DeviceUserCodeResponse;
  } catch (err) {
    throw new Error(`failed to decode codex device code response: ${(err as Error).message}`);
  }
}

export async function pollCodexDeviceToken(
  fetchFn: FetchLike,
  proxyUrl: string | undefined,
  url: string,
  deviceAuthID: string,
  userCode: string,
  intervalMs: number,
  now: Clock,
  sleep: Sleep,
  signal?: AbortSignal,
): Promise<DeviceTokenResponse> {
  const deadline = now() + codexDeviceTimeoutMs;
  for (;;) {
    if (now() > deadline) throw new Error("codex device authentication timed out after 15 minutes");
    let res: { status: number; text: string };
    try {
      res = await postJSON(fetchFn, proxyUrl, url, { device_auth_id: deviceAuthID, user_code: userCode }, signal);
    } catch (err) {
      throw new Error(`failed to poll codex device token: ${(err as Error).message}`);
    }
    if (isSuccess(res.status)) {
      try {
        return JSON.parse(res.text) as DeviceTokenResponse;
      } catch (err) {
        throw new Error(`failed to decode codex device token response: ${(err as Error).message}`);
      }
    }
    if (res.status === 403 || res.status === 404) {
      await sleep(intervalMs, signal);
      continue;
    }
    const trimmed = res.text.trim() || "empty response body";
    throw new Error(`codex device token polling failed with status ${res.status}: ${trimmed}`);
  }
}

/**
 * Runs the device flow: request a user code, show the verification URL and
 * code, poll until the user approves, then exchange the returned
 * authorization code with the device redirect URI.
 */
export async function loginWithCodexDeviceFlow(authSvc: CodexAuth, opts: DeviceFlowOptions = {}): Promise<CodexAuthBundle> {
  const fetchFn = resolveFetch(opts);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const print = opts.hooks?.print ?? ((line: string) => console.log(line));
  const userCodeURL = opts.userCodeURL ?? codexDeviceUserCodeURL;
  const tokenURL = opts.tokenURL ?? codexDeviceTokenURL;
  const verificationURL = opts.verificationURL ?? codexDeviceVerificationURL;

  const userCodeResp = await requestCodexDeviceUserCode(fetchFn, opts.proxyUrl, userCodeURL, opts.signal);
  let deviceCode = (userCodeResp.user_code ?? "").trim();
  if (deviceCode === "") deviceCode = (userCodeResp.usercode ?? "").trim();
  const deviceAuthID = (userCodeResp.device_auth_id ?? "").trim();
  if (deviceCode === "" || deviceAuthID === "") throw new Error("codex device flow did not return required fields");
  const pollInterval = parseCodexDevicePollIntervalMs(userCodeResp.interval);

  print("Starting Codex device authentication...");
  print(`Codex device URL: ${verificationURL}`);
  print(`Codex device code: ${deviceCode}`);
  opts.hooks?.onAuthorizationUrl?.(verificationURL, 0);
  if (!opts.noBrowser && opts.hooks?.openBrowser) {
    await opts.hooks.openBrowser(verificationURL).catch(() => false);
  } else if (!opts.noBrowser) {
    const { openBrowser } = await import("../oauth/browser.ts");
    await openBrowser(verificationURL);
  }

  const tokenResp = await pollCodexDeviceToken(fetchFn, opts.proxyUrl, tokenURL, deviceAuthID, deviceCode, pollInterval, now, sleep, opts.signal);
  const authCode = (tokenResp.authorization_code ?? "").trim();
  const codeVerifier = (tokenResp.code_verifier ?? "").trim();
  const codeChallenge = (tokenResp.code_challenge ?? "").trim();
  if (authCode === "" || codeVerifier === "" || codeChallenge === "") throw new Error("codex device flow token response missing required fields");

  return authSvc.exchangeCodeForTokensWithRedirect(authCode, codexDeviceTokenExchangeRedirectURI, { codeVerifier, codeChallenge }, opts.signal);
}
