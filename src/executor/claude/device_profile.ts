// Claude Code software fingerprint defaults. Port of the kept parts of
// internal/runtime/executor/helps/claude_device_profile.go: the pinned 2.1.280
// baseline, the CLI version parser and the legacy header application.
// Dropped: the per-credential device-profile cache and stabilisation learning.

export interface ClaudeDeviceProfile {
  userAgent: string;
  packageVersion: string;
  runtimeVersion: string;
  os: string;
  arch: string;
}

/** Operator overrides for the emitted Claude Code headers (upstream claude-header-defaults). */
export interface ClaudeHeaderDefaults {
  userAgent?: string;
  packageVersion?: string;
  runtimeVersion?: string;
  os?: string;
  arch?: string;
  /** X-Stainless-Timeout sent on Messages requests (default "600"). */
  timeout?: string;
  /** Betas removed from the emitted Anthropic-Beta header. */
  anthropicBetaStrip?: string[];
  /** Betas appended to the emitted Anthropic-Beta header. */
  anthropicBetaAppend?: string[];
  /** "" synthesises x-client-request-id, "passthrough" forwards only the caller's, "off" never sends it. */
  clientRequestId?: "" | "passthrough" | "off";
  /** IANA zone for the cloaked currentDate reminder when the credential sets none ("" = process local). */
  timezone?: string;
  /** false opts out of the injected diagnostics field and its cache-diagnosis beta (default true). */
  injectDiagnostics?: boolean;
}

export const defaultClaudeFingerprintUserAgent = "claude-cli/2.1.280 (external, cli)";
export const defaultClaudeFingerprintPackageVersion = "0.112.1";
export const defaultClaudeFingerprintRuntimeVersion = "v26.3.0";
export const defaultClaudeFingerprintOS = "MacOS";
export const defaultClaudeFingerprintArch = "arm64";

export interface ClaudeCLIVersion {
  major: number;
  minor: number;
  patch: number;
}

const claudeCLIVersionPattern = /^claude-cli\/(\d+)\.(\d+)\.(\d+)/;

/** Parses "claude-cli/2.1.280 (...)" (Go: parseClaudeCLIVersion). */
export function parseClaudeCLIVersion(userAgent: string): ClaudeCLIVersion | undefined {
  const m = claudeCLIVersionPattern.exec(userAgent.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Patch releases within the measured release line preserve native passthrough (Go: plausibleClaudeCLIVersion). */
export function plausibleClaudeCLIVersion(candidate: ClaudeCLIVersion, baseline: ClaudeCLIVersion): boolean {
  return candidate.major === baseline.major && candidate.minor === baseline.minor && candidate.patch >= baseline.patch;
}

function hdrDefault(cfgVal: string | undefined, fallback: string): string {
  const v = (cfgVal ?? "").trim();
  return v !== "" ? v : fallback;
}

/** The baseline profile, with operator overrides applied (Go: defaultClaudeDeviceProfile). */
export function defaultClaudeDeviceProfile(hd: ClaudeHeaderDefaults | undefined): ClaudeDeviceProfile {
  return {
    userAgent: hdrDefault(hd?.userAgent, defaultClaudeFingerprintUserAgent),
    packageVersion: hdrDefault(hd?.packageVersion, defaultClaudeFingerprintPackageVersion),
    runtimeVersion: hdrDefault(hd?.runtimeVersion, defaultClaudeFingerprintRuntimeVersion),
    os: hdrDefault(hd?.os, defaultClaudeFingerprintOS),
    arch: hdrDefault(hd?.arch, defaultClaudeFingerprintArch),
  };
}

/** Version string ("2.1.280") of the baseline profile (Go: DefaultClaudeVersion). */
export function defaultClaudeVersion(hd: ClaudeHeaderDefaults | undefined): string {
  const v = parseClaudeCLIVersion(defaultClaudeDeviceProfile(hd).userAgent);
  return v ? `${v.major}.${v.minor}.${v.patch}` : "2.1.280";
}

export function applyClaudeDeviceProfileHeaders(headers: Headers, profile: ClaudeDeviceProfile): void {
  headers.set("User-Agent", profile.userAgent);
  headers.set("X-Stainless-Package-Version", profile.packageVersion);
  headers.set("X-Stainless-Runtime-Version", profile.runtimeVersion);
  headers.set("X-Stainless-OS", profile.os);
  headers.set("X-Stainless-Arch", profile.arch);
}

/**
 * Applies the software profile headers (Go: ApplyClaudeLegacyDeviceHeaders). A
 * confirmed native client keeps its own plausible values; every other caller
 * receives the pinned baseline so a copied or third-party profile never leaks.
 */
export function applyClaudeLegacyDeviceHeaders(headers: Headers, incoming: Headers | undefined, hd: ClaudeHeaderDefaults | undefined, confirmedClaudeCode: boolean): void {
  const profile = defaultClaudeDeviceProfile(hd);
  if (confirmedClaudeCode) {
    const ensure = (name: string, fallback: string): void => {
      if ((headers.get(name) ?? "").trim() !== "") return;
      const value = (incoming?.get(name) ?? "").trim();
      headers.set(name, value !== "" ? value : fallback);
    };
    ensure("X-Stainless-Runtime-Version", profile.runtimeVersion);
    ensure("X-Stainless-Package-Version", profile.packageVersion);
    ensure("X-Stainless-OS", profile.os);
    ensure("X-Stainless-Arch", profile.arch);
    const clientUA = (incoming?.get("User-Agent") ?? "").trim();
    const candidate = parseClaudeCLIVersion(clientUA);
    const baseline = parseClaudeCLIVersion(profile.userAgent);
    if (candidate && baseline && plausibleClaudeCLIVersion(candidate, baseline)) {
      headers.set("User-Agent", clientUA);
      return;
    }
  }
  applyClaudeDeviceProfileHeaders(headers, profile);
}
