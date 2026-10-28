// Provider applier registry (Go: the nativeProviderAppliers map in apply.go, without the
// plugin-provider layer). Provider modules register themselves on import.
import type { ProviderApplier } from "./types.ts";

const providerAppliers = new Map<string, ProviderApplier>();

function normalizedProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Registers (or replaces) the applier for a provider format name. */
export function registerProvider(name: string, applier: ProviderApplier): void {
  name = normalizedProviderName(name);
  if (name === "") return;
  providerAppliers.set(name, applier);
}

/** The ProviderApplier for a provider format name, or undefined when none is registered. */
export function getProviderApplier(provider: string): ProviderApplier | undefined {
  provider = normalizedProviderName(provider);
  if (provider === "") return undefined;
  return providerAppliers.get(provider);
}
