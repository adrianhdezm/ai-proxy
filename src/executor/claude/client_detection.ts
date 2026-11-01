// Native Claude Code client detection. Port of the kept parts of
// internal/runtime/executor/helps/claude_client_detection.go (the four strong
// Messages signals, the count_tokens relaxation and the entrypoint table) and
// of helps/cloak_utils.go (metadata.user_id shape and fake id generation).
//
// Dropped: the measured Haiku helper profiles (claudeCodeHelperShape*,
// measuredClaudeCode*), so HelperProfile is always false and ConfirmedShape
// equals StrongSignals.
import { getAt, gstr } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { type ClaudeHeaderDefaults, defaultClaudeDeviceProfile, parseClaudeCLIVersion, plausibleClaudeCLIVersion } from "./device_profile.ts";
import { headerValueCaseInsensitive, headerValuesCaseInsensitive } from "./upstream.ts";

export const ClaudeCodeSessionHeader = "X-Claude-Code-Session-Id";

const claudeCodeUserAgentPattern = /^claude-cli\//i;
const claudeCodeUserAgentDetailsPattern = /^claude-cli\/\S+\s+\(external,\s*([^,)]+)(?:,\s*agent-sdk\/([^,)]+))?/i;
const claudeCodeNativeUserAgentPattern = /^claude-cli\/[0-9]+\.[0-9]+\.[0-9]+\s+\(external,\s*[^,)]+(?:,\s*agent-sdk\/[0-9]+\.[0-9]+\.[0-9]+)?\)$/i;

export const claudeCodeSubclientByEntrypoint: Readonly<Record<string, string>> = {
  cli: "claude-code-cli",
  mcp: "claude-code-mcp",
  bench: "claude-code-bench",
  "sdk-cli": "claude-code-cli-sdk",
  "sdk-ts": "claude-code-sdk-ts",
  "sdk-py": "claude-code-sdk-py",
  "claude-vscode": "claude-code-vscode",
  "claude-code-github-action": "claude-code-gh-action",
  "local-agent": "claude-local-agent",
  local_agent: "claude-local-agent",
  "claude-desktop": "claude-desktop",
  "claude-desktop-3p": "claude-desktop-3p",
  remote: "claude-remote",
  remote_baku: "claude-remote-baku",
  remote_cowork: "claude-remote-cowork",
  remote_trigger: "claude-remote-trigger",
  remote_desktop: "claude-remote-desktop",
  remote_mobile: "claude-remote-mobile",
  claude_in_slack: "claude-in-slack",
  "claude-in-slack": "claude-in-slack",
  "claude-in-teams": "claude-in-teams",
  "claude-security": "claude-security",
  "ssh-remote": "claude-ssh-remote",
  "claude-coworker": "claude-coworker",
  "claude-coworker-terminal": "claude-coworker-terminal",
};

/** Only product surfaces with verified 2.1.220+ wire behavior are eligible for pass-through. */
const nativeClaudeEntrypoints: ReadonlySet<string> = new Set(["cli", "sdk-cli", "sdk-ts", "claude-vscode"]);

/** Strong signals and first-party subclient identity of an inbound request (Go: ClaudeCodeRequestDetection). */
export interface ClaudeCodeRequestDetection {
  confirmed: boolean;
  confirmedShape: boolean;
  strongSignals: boolean;
  nativeClient: boolean;
  xAppCLI: boolean;
  userAgent: boolean;
  betasPresent: boolean;
  metadataUserID: boolean;
  /** Always false: the measured Haiku helper profiles are not ported. */
  helperProfile: boolean;
  entrypoint: string;
  subclient: string;
  agentSDKVersion: string;
}

/**
 * Mirrors CCH's strong-signal contract, then applies the native-client policy
 * (Go: DetectClaudeCodeRequest). Standard Messages requests require all four
 * strong signals; count_tokens omits metadata.user_id.
 */
export function detectClaudeCodeRequest(headers: Headers | undefined, payload: string, countTokens: boolean, hd?: ClaudeHeaderDefaults): ClaudeCodeRequestDetection {
  const userAgent = headerValueCaseInsensitive(headers, "User-Agent");
  const { entrypoint, agentSDKVersion } = parseClaudeCodeUserAgentDetails(userAgent);
  const metadataUserID = getAt(tryParse(payload), "metadata.user_id");
  const detection: ClaudeCodeRequestDetection = {
    confirmed: false,
    confirmedShape: false,
    strongSignals: false,
    nativeClient: nativeClaudeEntrypoints.has(entrypoint),
    xAppCLI: headerValueCaseInsensitive(headers, "X-App") === "cli",
    userAgent: plausibleClaudeCodeUserAgent(userAgent, hd),
    betasPresent: headerContainsClaudeCodeBeta(headers),
    metadataUserID: typeof metadataUserID === "string" && isValidUserID(metadataUserID),
    helperProfile: false,
    entrypoint,
    subclient: claudeCodeSubclientByEntrypoint[entrypoint] ?? "",
    agentSDKVersion,
  };
  const standardSignals = detection.xAppCLI && detection.userAgent && detection.betasPresent && (countTokens || detection.metadataUserID);
  detection.strongSignals = standardSignals;
  detection.confirmed = detection.strongSignals && detection.nativeClient;
  detection.confirmedShape = detection.strongSignals;
  return detection;
}

/** Whether userAgent identifies a Claude Code CLI client (Go: IsClaudeCodeUserAgent). */
export function isClaudeCodeUserAgent(userAgent: string): boolean {
  return claudeCodeUserAgentPattern.test(userAgent.trim());
}

/** A well-formed native User-Agent within the measured release line (Go: plausibleClaudeCodeUserAgent). */
export function plausibleClaudeCodeUserAgent(userAgent: string, hd?: ClaudeHeaderDefaults): boolean {
  const ua = userAgent.trim();
  if (!claudeCodeUserAgentPattern.test(ua) || !claudeCodeNativeUserAgentPattern.test(ua)) return false;
  const candidate = parseClaudeCLIVersion(ua);
  const baseline = parseClaudeCLIVersion(defaultClaudeDeviceProfile(hd).userAgent);
  return !!candidate && !!baseline && plausibleClaudeCLIVersion(candidate, baseline);
}

export function parseClaudeCodeUserAgentDetails(userAgent: string): { entrypoint: string; agentSDKVersion: string } {
  const m = claudeCodeUserAgentDetailsPattern.exec(userAgent.trim());
  if (!m) return { entrypoint: "", agentSDKVersion: "" };
  return { entrypoint: (m[1] ?? "").trim().toLowerCase(), agentSDKVersion: (m[2] ?? "").trim() };
}

function headerContainsClaudeCodeBeta(headers: Headers | undefined): boolean {
  return headerValuesCaseInsensitive(headers, "Anthropic-Beta").includes("claude-code-20250219");
}

const claudeMetadataDeviceIDPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(value: string): boolean {
  return uuidPattern.test(value.trim());
}

/** Checks the Claude Code 2.1.220 metadata.user_id JSON shape (Go: isValidUserID). */
export function isValidUserID(userID: string): boolean {
  const value = tryParse<Record<string, unknown>>(userID);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!claudeMetadataDeviceIDPattern.test(gstr(value.device_id))) return false;
  if (!isUUID(gstr(value.session_id))) return false;
  const account = value.account_uuid;
  if (account === undefined || account === "") return true;
  return typeof account === "string" && isUUID(account);
}

/** metadata.user_id in the JSON string format used by Claude Code 2.1.78+ (Go: generateFakeUserIDWithSessionID). */
export function generateFakeUserIDWithSessionID(sessionID: string): string {
  const session = isUUID(sessionID) ? sessionID : crypto.randomUUID();
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const deviceID = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({ device_id: deviceID, account_uuid: "", session_id: session });
}

export function generateFakeUserID(): string {
  return generateFakeUserIDWithSessionID(crypto.randomUUID());
}
