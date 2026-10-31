// The interactive part of a browser login shared by the three providers:
// announce the authorization URL (print, SSH-tunnel hint, best-effort browser
// open) and wait for the callback with the manual paste fallback. Port of the
// waitForCallback select loop in sdk/auth/claude.go, codex.go and v7.0.12
// internal/auth/gemini/gemini_auth.go.
import { log } from "../../log.ts";
import { openBrowser as defaultOpenBrowser, sshTunnelInstructions } from "./browser.ts";
import { parseOAuthCallback } from "./callback.ts";
import type { OAuthCallbackServer, OAuthResult } from "./server.ts";
import type { LoginHooks, PromptFn } from "./types.ts";

export const defaultCallbackTimeoutMs = 5 * 60_000;
export const defaultManualPromptDelayMs = 15_000;

export interface CallbackFlowResult extends OAuthResult {
  /** error_description from a manually pasted callback. */
  errorDescription: string;
}

export interface AnnounceOptions {
  productName: string;
  authUrl: string;
  callbackPort: number;
  noBrowser: boolean;
  hooks?: LoginHooks;
}

/** Prints the URL (and the SSH tunnel hint) and tries to open the browser unless noBrowser. */
export async function announceAuthorizationUrl(opts: AnnounceOptions): Promise<void> {
  const print = opts.hooks?.print ?? ((line: string) => console.log(line));
  opts.hooks?.onAuthorizationUrl?.(opts.authUrl, opts.callbackPort);
  const showManual = () => {
    print(sshTunnelInstructions(opts.callbackPort));
    print(`Visit the following URL to continue authentication:\n${opts.authUrl}`);
  };
  if (opts.noBrowser) {
    showManual();
    return;
  }
  print(`Opening browser for ${opts.productName} authentication`);
  const open = opts.hooks?.openBrowser ?? defaultOpenBrowser;
  let opened = false;
  try {
    opened = await open(opts.authUrl);
  } catch (err) {
    log.warn(`Failed to open browser automatically: ${(err as Error).message}`);
  }
  if (!opened) {
    log.warn("No browser available; please open the URL manually");
    showManual();
  }
}

export interface WaitOptions {
  server: OAuthCallbackServer;
  productName: string;
  prompt?: PromptFn;
  hooks?: LoginHooks;
  signal?: AbortSignal;
}

/**
 * Waits for the callback server result. When a prompt is available, after
 * manualPromptDelayMs the user is offered to paste the callback URL; an empty
 * answer keeps waiting, a pasted URL wins over the server. Rejects with
 * "timeout waiting for OAuth callback" after callbackTimeoutMs.
 */
export async function waitForOAuthResult(opts: WaitOptions): Promise<CallbackFlowResult> {
  const timeoutMs = opts.hooks?.callbackTimeoutMs ?? defaultCallbackTimeoutMs;
  const promptDelayMs = opts.hooks?.manualPromptDelayMs ?? defaultManualPromptDelayMs;
  const print = opts.hooks?.print ?? ((line: string) => console.log(line));
  print(`Waiting for ${opts.productName} authentication callback...`);

  const abort = new AbortController();
  const onOuterAbort = () => abort.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const serverWait = opts.server.waitForCallback(timeoutMs, abort.signal).then(
    (r): CallbackFlowResult => ({ ...r, errorDescription: "" }),
  );

  const racers: Promise<CallbackFlowResult>[] = [serverWait];
  let promptTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.prompt) {
    const prompt = opts.prompt;
    racers.push(
      new Promise<CallbackFlowResult>((resolve, reject) => {
        promptTimer = setTimeout(async () => {
          try {
            while (!abort.signal.aborted) {
              const input = await prompt(`Paste the ${opts.productName} callback URL (or press Enter to keep waiting): `);
              const parsed = parseOAuthCallback(input);
              if (!parsed) continue;
              resolve({ code: parsed.code, state: parsed.state, clientId: parsed.clientId, error: parsed.error, errorDescription: parsed.errorDescription });
              return;
            }
          } catch (err) {
            reject(err);
          }
        }, promptDelayMs);
      }),
    );
  }

  try {
    return await Promise.race(racers);
  } finally {
    if (promptTimer) clearTimeout(promptTimer);
    abort.abort();
    opts.signal?.removeEventListener("abort", onOuterAbort);
    serverWait.catch(() => undefined);
  }
}

export function isCallbackTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.includes("timeout");
}
