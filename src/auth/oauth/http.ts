// fetch plumbing shared by the auth services: injectable fetch for tests and
// Bun's `proxy` option in place of util.SetProxy / proxyutil.BuildHTTPTransport.

/** Shape of the injected fetch; defaults to the global fetch. */
export type FetchLike = (input: string, init?: RequestInit & BunFetchExtras) => Promise<Response>;

/** Bun-specific fetch options this package relies on. */
export interface BunFetchExtras {
  /** Outbound proxy URL (http/https/socks). */
  proxy?: string;
  /** When false the body is returned as sent (Content-Encoding is left to the caller). */
  decompress?: boolean;
}

export interface HttpOptions {
  /** fetch implementation; tests inject a fake. */
  fetch?: FetchLike;
  /** Proxy URL applied to every request; "" or undefined means direct. */
  proxyUrl?: string;
}

export function resolveFetch(opts?: HttpOptions): FetchLike {
  return opts?.fetch ?? (globalThis.fetch as unknown as FetchLike);
}

/** Adds the proxy option when configured (upstream honours "direct" as "no proxy"). */
export function withProxy<T extends RequestInit & BunFetchExtras>(init: T, proxyUrl?: string): T {
  const trimmed = (proxyUrl ?? "").trim();
  if (trimmed === "" || trimmed.toLowerCase() === "direct") return init;
  return { ...init, proxy: trimmed };
}

/** Reads the body as text, tolerating bodies that were already consumed or are empty. */
export async function readBodyText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch (err) {
    throw new Error(`read response body: ${(err as Error).message}`);
  }
}

/** Error carrying an HTTP status for token endpoint failures. */
export class HttpStatusError extends Error {
  status: number;
  body: string;
  retryable: boolean;
  constructor(prefix: string, status: number, body: string, retryable = false) {
    super(`${prefix} with status ${status}: ${body}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}
