// Best-effort browser opening and the SSH tunnel hint. Port of the parts of
// internal/browser and util.PrintSSHTunnelInstructions (internal/util/ssh_helper.go)
// that the login flows use. Opening never blocks or throws; the URL is always printed.
import { log } from "../../log.ts";

/** Returns the command that would open a URL on this platform, or undefined. */
export function browserCommand(url: string): string[] | undefined {
  switch (process.platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      return ["rundll32", "url.dll,FileProtocolHandler", url];
    case "linux":
    default: {
      for (const candidate of ["xdg-open", "x-www-browser", "www-browser", "firefox", "chromium", "google-chrome"]) {
        if (Bun.which(candidate)) return [candidate, url];
      }
      return undefined;
    }
  }
}

/** True when a browser opener is available (port of browser.IsAvailable). */
export function isBrowserAvailable(): boolean {
  const cmd = browserCommand("about:blank");
  return cmd !== undefined && Bun.which(cmd[0]!) !== null;
}

/**
 * Tries to open the URL in the user's browser. Returns false when no opener
 * exists or spawning failed. The spawned process is detached so the login
 * flow never waits on it.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const cmd = browserCommand(url);
  if (!cmd || !Bun.which(cmd[0]!)) return false;
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    proc.unref();
    return true;
  } catch (err) {
    log.debug(`browser open failed: ${(err as Error).message}`);
    return false;
  }
}

/** Port of util.PrintSSHTunnelInstructions. */
export function sshTunnelInstructions(port: number, ipAddress = "<server-ip>"): string {
  const border = "================================================================================";
  return [
    "To authenticate from a remote machine, an SSH tunnel may be required.",
    border,
    "  Run one of the following commands on your local machine (NOT the server):",
    "",
    "  # Standard SSH command (assumes SSH port 22):",
    `  ssh -L ${port}:127.0.0.1:${port} root@${ipAddress} -p 22`,
    "",
    "  # If using an SSH key (assumes SSH port 22):",
    `  ssh -i <path_to_your_key> -L ${port}:127.0.0.1:${port} root@${ipAddress} -p 22`,
    "",
    "  NOTE: If your server's SSH port is not 22, please modify the '-p 22' part accordingly.",
    border,
  ].join("\n");
}

export function printSSHTunnelInstructions(port: number, out: (line: string) => void = console.log): void {
  out(sshTunnelInstructions(port));
}
