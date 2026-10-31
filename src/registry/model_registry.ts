// Port of internal/registry/model_registry.go: a global registry where each credential
// ("client") registers the models it serves for a provider, with reference counting across
// credentials, quota/suspension bookkeeping and the /v1/models projections.
//
// Dropped from upstream: registry hooks, Antigravity web-search capability counters,
// NativeCapabilities / Responses web-search resolution, and the Codex client-model catalog.
// Time is injected (`now`) so quota windows are testable without sleeping.
import type { ModelInfo } from "./types.ts";
import { cloneModelInfo, lookupStaticModelInfo } from "./model_definitions.ts";
import type { JSONObject } from "../util/json.ts";
import { log } from "../log.ts";

export const DefaultClaudeMaxInputTokens = 200000;
export const DefaultClaudeMaxOutputTokens = 64000;

/** How long a quota-exceeded mark hides a client from availability counts (Go: modelQuotaExceededWindow). */
export const modelQuotaExceededWindowMs = 5 * 60 * 1000;

/** Tracks a model's availability across clients (Go: ModelRegistration). */
export interface ModelRegistration {
  info: ModelInfo;
  /** Provider identifier -> provider-specific ModelInfo (capabilities may differ per provider). */
  infoByProvider: Map<string, ModelInfo>;
  /** Number of active client bindings that can provide this model. */
  count: number;
  lastUpdated: number;
  /** Client id -> timestamp (ms) when quota was exceeded. */
  quotaExceededClients: Map<string, number>;
  /** Provider identifier -> number of client bindings. */
  providers: Map<string, number>;
  /** Client id -> suspension reason. */
  suspendedClients: Map<string, string>;
}

/** Desired availability/quota state for one of a client's models (Go: ClientModelProjection). */
export interface ClientModelProjection {
  modelId: string;
  suspended?: boolean;
  suspendReason?: string;
  quotaExceeded?: boolean;
}

interface AvailableModelsCacheEntry {
  models: JSONObject[];
  /** 0 means no expiry. */
  expiresAt: number;
}

export interface ModelRegistryOptions {
  /** Clock in milliseconds since epoch; defaults to Date.now. */
  now?: () => number;
}

/**
 * A quota cooldown keeps the model listed: the limit is temporary and a request meanwhile
 * gets a 429 with its retry time instead of an unknown model (Go: isQuotaSuspension).
 */
function isQuotaSuspension(reason: string): boolean {
  const r = reason.toLowerCase();
  return r === "quota" || r === "credential_quota";
}

function toRFC3339(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelRegistration>();
  private readonly clientModels = new Map<string, string[]>();
  private readonly clientModelInfos = new Map<string, Map<string, ModelInfo>>();
  private readonly clientProviders = new Map<string, string>();
  private readonly clientEpochs = new Map<string, number>();
  private readonly clientGenerations = new Map<string, number>();
  private readonly availableModelsCache = new Map<string, AvailableModelsCacheEntry>();
  private generation = 0;
  private registrationEpochCounter = 0;
  private readonly now: () => number;

  constructor(options: ModelRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private invalidateAvailableModelsCache(): void {
    this.generation++;
    this.availableModelsCache.clear();
  }

  /** Generation counter of model registrations/availability changes. */
  getGeneration(): number {
    return this.generation;
  }

  /** Monotonic epoch incremented on every client registration or deregistration. */
  registrationEpoch(): number {
    return this.registrationEpochCounter;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Registers a client (credential) and the models it provides. Re-registering reconciles the
   * client's model set and resets its quota/suspension state (Go: RegisterClient).
   */
  registerClient(clientId: string, clientProvider: string, models: ReadonlyArray<ModelInfo>): void {
    this.registerClientLocked(clientId, clientProvider, models, false);
  }

  /** Registers only if the client's epoch still equals expectedEpoch and publish() returns true. */
  registerClientIfEpochCurrent(clientId: string, clientProvider: string, expectedEpoch: number, models: ReadonlyArray<ModelInfo>, publish?: () => boolean): boolean {
    if ((this.clientEpochs.get(clientId) ?? 0) !== expectedEpoch || !publish || !publish()) return false;
    this.registerClientLocked(clientId, clientProvider, models, false);
    return true;
  }

  /** Removes a client only if its epoch still equals expectedEpoch and publish() returns true. */
  unregisterClientIfEpochCurrent(clientId: string, expectedEpoch: number, publish?: () => boolean): boolean {
    if ((this.clientEpochs.get(clientId) ?? 0) !== expectedEpoch || !publish || !publish()) return false;
    this.unregisterClientInternal(clientId);
    this.invalidateAvailableModelsCache();
    return true;
  }

  /**
   * Replaces a client's models only if its registration epoch matches. A successful replacement
   * advances the epoch and preserves quota, suspension state and the projection generation for
   * an existing registration with the same provider. Empty models unregister the client
   * (Go: ReplaceClientModels).
   */
  replaceClientModels(clientId: string, clientProvider: string, expectedEpoch: number, models: ReadonlyArray<ModelInfo>): { epoch: number; applied: boolean } {
    if ((this.clientEpochs.get(clientId) ?? 0) !== expectedEpoch) return { epoch: 0, applied: false };
    this.registerClientLocked(clientId, clientProvider, models, true);
    return { epoch: this.clientEpochs.get(clientId) ?? 0, applied: true };
  }

  private storeClientInfos(clientId: string, newModels: Map<string, ModelInfo>): void {
    const infos = new Map<string, ModelInfo>();
    for (const [id, m] of newModels) infos.set(id, cloneModelInfo(m));
    this.clientModelInfos.set(clientId, infos);
  }

  private registerClientLocked(clientId: string, clientProvider: string, models: ReadonlyArray<ModelInfo>, preserveState: boolean): void {
    const provider = clientProvider.toLowerCase();
    const uniqueModelIds: string[] = [];
    const rawModelIds: string[] = [];
    const newModels = new Map<string, ModelInfo>();
    const newCounts = new Map<string, number>();
    for (const model of models) {
      if (!model || model.id === "") continue;
      rawModelIds.push(model.id);
      newCounts.set(model.id, (newCounts.get(model.id) ?? 0) + 1);
      if (newModels.has(model.id)) continue;
      newModels.set(model.id, model);
      uniqueModelIds.push(model.id);
    }

    if (uniqueModelIds.length === 0) {
      // No models supplied; unregister existing client state if present.
      this.unregisterClientInternal(clientId);
      this.clientModels.delete(clientId);
      this.clientModelInfos.delete(clientId);
      this.clientProviders.delete(clientId);
      this.invalidateAvailableModelsCache();
      return;
    }

    const oldModels = this.clientModels.get(clientId);
    const hadExisting = oldModels !== undefined;
    const oldProvider = this.clientProviders.get(clientId) ?? "";
    const providerChanged = oldProvider !== provider;

    this.clientEpochs.set(clientId, (this.clientEpochs.get(clientId) ?? 0) + 1);
    if (!preserveState || !hadExisting || providerChanged) this.clientGenerations.set(clientId, 0);
    this.registrationEpochCounter++;

    const now = this.now();
    if (!hadExisting || oldModels === undefined) {
      // Pure addition: clear orphaned metadata and publish the new catalog.
      this.clientModelInfos.delete(clientId);
      for (const modelId of rawModelIds) this.addModelRegistration(modelId, provider, newModels.get(modelId)!, now);
      this.clientModels.set(clientId, [...rawModelIds]);
      this.storeClientInfos(clientId, newModels);
      if (provider !== "") this.clientProviders.set(clientId, provider);
      else this.clientProviders.delete(clientId);
      this.invalidateAvailableModelsCache();
      log.debug(`Registered client ${clientId} from provider ${clientProvider} with ${rawModelIds.length} models`);
      return;
    }

    const oldCounts = new Map<string, number>();
    for (const id of oldModels) oldCounts.set(id, (oldCounts.get(id) ?? 0) + 1);

    const added = uniqueModelIds.filter((id) => (oldCounts.get(id) ?? 0) === 0);
    const removed: string[] = [];
    for (const id of oldCounts.keys()) {
      if ((newCounts.get(id) ?? 0) === 0) removed.push(id);
    }

    // Handle provider change for overlapping models before modifications.
    if (providerChanged && oldProvider !== "") {
      for (const [id, newCount] of newCounts) {
        if (newCount === 0) continue;
        const oldCount = oldCounts.get(id) ?? 0;
        if (oldCount === 0) continue;
        const toRemove = Math.min(newCount, oldCount);
        const reg = this.models.get(id);
        if (!reg) continue;
        const count = reg.providers.get(oldProvider);
        if (count === undefined) continue;
        if (count <= toRemove) {
          reg.providers.delete(oldProvider);
          reg.infoByProvider.delete(oldProvider);
        } else {
          reg.providers.set(oldProvider, count - toRemove);
        }
      }
    }

    // Apply removals first to keep counters accurate.
    for (const id of removed) {
      const oldCount = oldCounts.get(id) ?? 0;
      for (let i = 0; i < oldCount; i++) this.removeModelRegistration(clientId, id, oldProvider, now, false);
    }
    for (const [id, oldCount] of oldCounts) {
      const newCount = newCounts.get(id) ?? 0;
      if (newCount === 0 || oldCount <= newCount) continue;
      const overage = oldCount - newCount;
      for (let i = 0; i < overage; i++) this.removeModelRegistration(clientId, id, oldProvider, now, preserveState && !providerChanged);
    }

    // Apply additions.
    for (const [id, newCount] of newCounts) {
      const oldCount = oldCounts.get(id) ?? 0;
      if (newCount <= oldCount) continue;
      const model = newModels.get(id)!;
      for (let i = 0; i < newCount - oldCount; i++) this.addModelRegistration(id, provider, model, now);
    }

    // Update metadata for models that remain associated with the client.
    const addedSet = new Set(added);
    for (const id of uniqueModelIds) {
      const model = newModels.get(id)!;
      const reg = this.models.get(id);
      if (!reg) continue;
      reg.info = cloneModelInfo(model);
      if (provider !== "") reg.infoByProvider.set(provider, cloneModelInfo(model));
      reg.lastUpdated = now;
      const oldCount = oldCounts.get(id) ?? 0;
      // Only conditional replacements preserve scheduling state for retained bindings with the
      // same provider. Ordinary registration starts fresh.
      if (!preserveState || providerChanged || oldCount === 0) {
        reg.quotaExceededClients.delete(clientId);
        reg.suspendedClients.delete(clientId);
      }
      if (providerChanged && provider !== "") {
        if (addedSet.has(id)) continue;
        const overlapCount = Math.min(newCounts.get(id) ?? 0, oldCount);
        if (overlapCount <= 0) continue;
        reg.providers.set(provider, (reg.providers.get(provider) ?? 0) + overlapCount);
      }
    }

    // Update client bookkeeping.
    this.clientModels.set(clientId, [...rawModelIds]);
    this.storeClientInfos(clientId, newModels);
    if (provider !== "") this.clientProviders.set(clientId, provider);
    else this.clientProviders.delete(clientId);

    this.invalidateAvailableModelsCache();
    if (added.length === 0 && removed.length === 0 && !providerChanged) return;
    log.debug(`Reconciled client ${clientId} (provider ${provider}) models: +${added.length}, -${removed.length}`);
  }

  private addModelRegistration(modelId: string, provider: string, model: ModelInfo, now: number): void {
    if (!model || modelId === "") return;
    const existing = this.models.get(modelId);
    if (existing) {
      existing.count++;
      existing.lastUpdated = now;
      existing.info = cloneModelInfo(model);
      if (provider !== "") {
        existing.providers.set(provider, (existing.providers.get(provider) ?? 0) + 1);
        existing.infoByProvider.set(provider, cloneModelInfo(model));
      }
      return;
    }
    const registration: ModelRegistration = {
      info: cloneModelInfo(model),
      infoByProvider: new Map(),
      count: 1,
      lastUpdated: now,
      quotaExceededClients: new Map(),
      providers: new Map(),
      suspendedClients: new Map(),
    };
    if (provider !== "") {
      registration.providers.set(provider, 1);
      registration.infoByProvider.set(provider, cloneModelInfo(model));
    }
    this.models.set(modelId, registration);
  }

  /** May preserve state when only a duplicate binding is removed. */
  private removeModelRegistration(clientId: string, modelId: string, provider: string, now: number, preserveState: boolean): void {
    const registration = this.models.get(modelId);
    if (!registration) return;
    registration.count--;
    registration.lastUpdated = now;
    if (!preserveState) {
      registration.quotaExceededClients.delete(clientId);
      registration.suspendedClients.delete(clientId);
    }
    if (registration.count < 0) registration.count = 0;
    if (provider !== "") {
      const count = registration.providers.get(provider);
      if (count !== undefined) {
        if (count <= 1) {
          registration.providers.delete(provider);
          registration.infoByProvider.delete(provider);
        } else {
          registration.providers.set(provider, count - 1);
        }
      }
    }
    if (registration.count <= 0) this.models.delete(modelId);
  }

  /** Removes a client and decrements counts for its models (Go: UnregisterClient). */
  unregisterClient(clientId: string): void {
    this.unregisterClientInternal(clientId);
    this.invalidateAvailableModelsCache();
  }

  private unregisterClientInternal(clientId: string): void {
    this.clientEpochs.set(clientId, (this.clientEpochs.get(clientId) ?? 0) + 1);
    this.clientGenerations.set(clientId, (this.clientGenerations.get(clientId) ?? 0) + 1);
    this.registrationEpochCounter++;

    const models = this.clientModels.get(clientId);
    const provider = this.clientProviders.get(clientId);
    if (models === undefined) {
      this.clientModelInfos.delete(clientId);
      if (provider !== undefined) this.clientProviders.delete(clientId);
      return;
    }

    const now = this.now();
    for (const modelId of models) {
      const registration = this.models.get(modelId);
      if (!registration) continue;
      registration.count--;
      registration.lastUpdated = now;
      registration.quotaExceededClients.delete(clientId);
      registration.suspendedClients.delete(clientId);
      if (provider !== undefined) {
        const count = registration.providers.get(provider);
        if (count !== undefined) {
          if (count <= 1) {
            registration.providers.delete(provider);
            registration.infoByProvider.delete(provider);
          } else {
            registration.providers.set(provider, count - 1);
          }
        }
      }
      if (registration.count <= 0) this.models.delete(modelId);
    }

    this.clientModels.delete(clientId);
    this.clientModelInfos.delete(clientId);
    if (provider !== undefined) this.clientProviders.delete(clientId);
    log.debug(`Unregistered client ${clientId}`);
  }

  // -------------------------------------------------------------------------
  // Quota / suspension state
  // -------------------------------------------------------------------------

  /** Marks a model as quota exceeded for a specific client (Go: SetModelQuotaExceeded). */
  setModelQuotaExceeded(clientId: string, modelId: string): void {
    const registration = this.models.get(modelId);
    if (!registration) return;
    registration.quotaExceededClients.set(clientId, this.now());
    this.invalidateAvailableModelsCache();
  }

  /** Clears quota exceeded status for a model and client (Go: ClearModelQuotaExceeded). */
  clearModelQuotaExceeded(clientId: string, modelId: string): void {
    const registration = this.models.get(modelId);
    if (!registration) return;
    registration.quotaExceededClients.delete(clientId);
    this.invalidateAvailableModelsCache();
  }

  /**
   * Atomically applies suspension and quota state for clientId if the supplied epoch and
   * generation are current (Go: ApplyClientModelProjections). Stale or mismatched epochs,
   * stale generations and projections for unregistered clients/models are rejected.
   */
  applyClientModelProjections(clientId: string, epoch: number, generation: number, projections: ReadonlyArray<ClientModelProjection>): boolean {
    clientId = clientId.trim();
    if (clientId === "") return false;
    const clientRegisteredModels = this.clientModels.get(clientId);
    if (!clientRegisteredModels || clientRegisteredModels.length === 0) return false;
    if (epoch !== (this.clientEpochs.get(clientId) ?? 0)) return false;
    if (generation < (this.clientGenerations.get(clientId) ?? 0)) return false;

    const registeredSet = new Set(clientRegisteredModels.map((m) => m.trim()).filter((m) => m !== ""));
    const hasValidModel = projections.some((proj) => {
      const modelId = proj.modelId.trim();
      return modelId !== "" && registeredSet.has(modelId) && this.models.has(modelId);
    });
    if (!hasValidModel) return false;

    this.clientGenerations.set(clientId, generation);
    const now = this.now();
    let changed = false;
    for (const proj of projections) {
      const modelId = proj.modelId.trim();
      if (modelId === "" || !registeredSet.has(modelId)) continue;
      const registration = this.models.get(modelId);
      if (!registration) continue;

      if (proj.suspended) {
        const reason = proj.suspendReason ?? "";
        if (registration.suspendedClients.get(clientId) !== reason) {
          registration.suspendedClients.set(clientId, reason);
          registration.lastUpdated = now;
          changed = true;
        }
      } else if (registration.suspendedClients.has(clientId)) {
        registration.suspendedClients.delete(clientId);
        registration.lastUpdated = now;
        changed = true;
      }

      if (proj.quotaExceeded) {
        if (!registration.quotaExceededClients.has(clientId)) {
          registration.quotaExceededClients.set(clientId, now);
          registration.lastUpdated = now;
          changed = true;
        }
      } else if (registration.quotaExceededClients.has(clientId)) {
        registration.quotaExceededClients.delete(clientId);
        registration.lastUpdated = now;
        changed = true;
      }
    }
    if (changed) this.invalidateAvailableModelsCache();
    return true;
  }

  /** Marks a client's model as temporarily unavailable until resumed (Go: SuspendClientModel). */
  suspendClientModel(clientId: string, modelId: string, reason: string): void {
    if (clientId === "" || modelId === "") return;
    const registration = this.models.get(modelId);
    if (!registration) return;
    if (registration.suspendedClients.has(clientId)) return;
    registration.suspendedClients.set(clientId, reason);
    registration.lastUpdated = this.now();
    this.invalidateAvailableModelsCache();
  }

  /** Clears a previous suspension (Go: ResumeClientModel). */
  resumeClientModel(clientId: string, modelId: string): void {
    if (clientId === "" || modelId === "") return;
    const registration = this.models.get(modelId);
    if (!registration || !registration.suspendedClients.has(clientId)) return;
    registration.suspendedClients.delete(clientId);
    registration.lastUpdated = this.now();
    this.invalidateAvailableModelsCache();
  }

  /** Whether the client registered support for modelId (case-insensitive). */
  clientSupportsModel(clientId: string, modelId: string): boolean {
    clientId = clientId.trim();
    modelId = modelId.trim().toLowerCase();
    if (clientId === "" || modelId === "") return false;
    const models = this.clientModels.get(clientId);
    if (!models || models.length === 0) return false;
    return models.some((id) => id.trim().toLowerCase() === modelId);
  }

  isModelSuspendedForClient(clientId: string, modelId: string): boolean {
    clientId = clientId.trim();
    modelId = modelId.trim();
    if (clientId === "" || modelId === "") return false;
    return this.models.get(modelId)?.suspendedClients.has(clientId) ?? false;
  }

  /** The suspension reason recorded for a client's model, or undefined when not suspended. */
  modelSuspensionReason(clientId: string, modelId: string): string | undefined {
    return this.models.get(modelId.trim())?.suspendedClients.get(clientId.trim());
  }

  isModelQuotaExceededForClient(clientId: string, modelId: string): boolean {
    clientId = clientId.trim();
    modelId = modelId.trim();
    if (clientId === "" || modelId === "") return false;
    return this.models.get(modelId)?.quotaExceededClients.has(clientId) ?? false;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private modelRegistrationAvailability(registration: ModelRegistration, now: number): { available: boolean; expiresAt: number } {
    const availableClients = registration.count;
    let expiredClients = 0;
    let expiresAt = 0;
    for (const quotaTime of registration.quotaExceededClients.values()) {
      const recoveryAt = quotaTime + modelQuotaExceededWindowMs;
      if (now < recoveryAt) {
        expiredClients++;
        if (expiresAt === 0 || recoveryAt < expiresAt) expiresAt = recoveryAt;
      }
    }

    let cooldownSuspended = 0;
    let otherSuspended = 0;
    let quotaAndSuspended = 0;
    for (const [clientId, reason] of registration.suspendedClients) {
      const quotaTime = registration.quotaExceededClients.get(clientId);
      if (quotaTime !== undefined && now < quotaTime + modelQuotaExceededWindowMs) quotaAndSuspended++;
      if (isQuotaSuspension(reason)) {
        cooldownSuspended++;
        continue;
      }
      otherSuspended++;
    }

    // A quota cooldown can mark the same client both quota-exceeded and suspended; count once.
    let effectiveClients = availableClients - expiredClients - cooldownSuspended - otherSuspended + quotaAndSuspended;
    if (effectiveClients < 0) effectiveClients = 0;
    const available = effectiveClients > 0 || (availableClients > 0 && (expiredClients > 0 || cooldownSuspended > 0) && otherSuspended === 0);
    return { available, expiresAt };
  }

  /**
   * All models with at least one available client, in the list shape of the given handler type
   * ("openai", "claude", "gemini", or generic). Results are cached until the registry changes
   * or a quota window expires (Go: GetAvailableModels).
   */
  getAvailableModels(handlerType: string): JSONObject[] {
    const now = this.now();
    const cached = this.availableModelsCache.get(handlerType);
    if (cached && (cached.expiresAt === 0 || now < cached.expiresAt)) return structuredClone(cached.models);

    const models: JSONObject[] = [];
    let expiresAt = 0;
    for (const registration of this.models.values()) {
      const { available, expiresAt: registrationExpiresAt } = this.modelRegistrationAvailability(registration, now);
      if (registrationExpiresAt !== 0 && (expiresAt === 0 || registrationExpiresAt < expiresAt)) expiresAt = registrationExpiresAt;
      if (!available) continue;
      models.push(convertModelToMap(registration.info, handlerType));
    }
    this.availableModelsCache.set(handlerType, { models: structuredClone(models), expiresAt });
    return models;
  }

  /** Cloned metadata for all currently available models, sorted by id (Go: GetAvailableModelInfos). */
  getAvailableModelInfos(): ModelInfo[] {
    const now = this.now();
    const result: ModelInfo[] = [];
    for (const registration of this.models.values()) {
      if (!this.modelRegistrationAvailability(registration, now).available) continue;
      result.push(cloneModelInfo(registration.info));
    }
    result.sort((a, b) => (a.id.trim() < b.id.trim() ? -1 : a.id.trim() > b.id.trim() ? 1 : 0));
    return result;
  }

  /** Models available for the given provider identifier (Go: GetAvailableModelsByProvider). */
  getAvailableModelsByProvider(provider: string): ModelInfo[] {
    provider = provider.trim().toLowerCase();
    if (provider === "") return [];

    const providerModels = new Map<string, { count: number; info?: ModelInfo }>();
    for (const [clientId, clientProvider] of this.clientProviders) {
      if (clientProvider !== provider) continue;
      const modelIds = this.clientModels.get(clientId);
      if (!modelIds || modelIds.length === 0) continue;
      const clientInfos = this.clientModelInfos.get(clientId);
      for (let modelId of modelIds) {
        modelId = modelId.trim();
        if (modelId === "") continue;
        let entry = providerModels.get(modelId);
        if (!entry) {
          entry = { count: 0 };
          providerModels.set(modelId, entry);
        }
        entry.count++;
        if (!entry.info) {
          entry.info = clientInfos?.get(modelId) ?? this.models.get(modelId)?.info;
        }
      }
    }
    if (providerModels.size === 0) return [];

    const now = this.now();
    const result: ModelInfo[] = [];
    for (const [modelId, entry] of providerModels) {
      if (entry.count <= 0) continue;
      const registration = this.models.get(modelId);
      let expiredClients = 0;
      let cooldownSuspended = 0;
      let otherSuspended = 0;
      let quotaAndSuspended = 0;
      if (registration) {
        for (const [clientId, quotaTime] of registration.quotaExceededClients) {
          if (clientId === "" || this.clientProviders.get(clientId) !== provider) continue;
          if (now - quotaTime < modelQuotaExceededWindowMs) expiredClients++;
        }
        for (const [clientId, reason] of registration.suspendedClients) {
          if (clientId === "" || this.clientProviders.get(clientId) !== provider) continue;
          const quotaTime = registration.quotaExceededClients.get(clientId);
          if (quotaTime !== undefined && now < quotaTime + modelQuotaExceededWindowMs) quotaAndSuspended++;
          if (isQuotaSuspension(reason)) {
            cooldownSuspended++;
            continue;
          }
          otherSuspended++;
        }
      }
      const availableClients = entry.count;
      let effectiveClients = availableClients - expiredClients - cooldownSuspended - otherSuspended + quotaAndSuspended;
      if (effectiveClients < 0) effectiveClients = 0;
      if (effectiveClients > 0 || (availableClients > 0 && (expiredClients > 0 || cooldownSuspended > 0) && otherSuspended === 0)) {
        const info = entry.info ?? registration?.info;
        if (info) result.push(cloneModelInfo(info));
      }
    }
    return result;
  }

  /** Number of available (not quota-exceeded, not suspended) clients for a model (Go: GetModelCount). */
  getModelCount(modelId: string): number {
    const registration = this.models.get(modelId);
    if (!registration) return 0;
    const now = this.now();
    let expiredClients = 0;
    for (const quotaTime of registration.quotaExceededClients.values()) {
      if (now - quotaTime < modelQuotaExceededWindowMs) expiredClients++;
    }
    let suspendedClients = 0;
    for (const clientId of registration.suspendedClients.keys()) {
      const quotaTime = registration.quotaExceededClients.get(clientId);
      if (quotaTime !== undefined && now < quotaTime + modelQuotaExceededWindowMs) continue;
      suspendedClients++;
    }
    const result = registration.count - expiredClients - suspendedClients;
    return result < 0 ? 0 : result;
  }

  /** Provider identifiers that currently supply the model, ordered by client count desc then name (Go: GetModelProviders). */
  getModelProviders(modelId: string): string[] {
    const registration = this.models.get(modelId);
    if (!registration || registration.providers.size === 0) return [];
    const providers: Array<{ name: string; count: number }> = [];
    for (const [name, count] of registration.providers) {
      if (count <= 0) continue;
      providers.push({ name, count });
    }
    providers.sort((a, b) => (a.count === b.count ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : b.count - a.count));
    return providers.map((p) => p.name);
  }

  /** ModelInfo for a registered model, preferring the provider-specific definition (Go: GetModelInfo). */
  getModelInfo(modelId: string, provider: string): ModelInfo | undefined {
    const reg = this.models.get(modelId);
    if (!reg) return undefined;
    if (provider !== "") {
      const count = reg.providers.get(provider);
      if (count !== undefined && count > 0) {
        const info = reg.infoByProvider.get(provider);
        if (info) return cloneModelInfo(info);
      }
    }
    return cloneModelInfo(reg.info);
  }

  /** Removes expired quota tracking entries (Go: CleanupExpiredQuotas). */
  cleanupExpiredQuotas(): void {
    const now = this.now();
    let invalidated = false;
    for (const registration of this.models.values()) {
      for (const [clientId, quotaTime] of registration.quotaExceededClients) {
        if (now - quotaTime >= modelQuotaExceededWindowMs) {
          registration.quotaExceededClients.delete(clientId);
          invalidated = true;
        }
      }
    }
    if (invalidated) this.invalidateAvailableModelsCache();
  }

  /**
   * The newest available model (by created timestamp) with at least one available client for
   * the handler type (Go: GetFirstAvailableModel). Throws when none is available.
   */
  getFirstAvailableModel(handlerType: string): string {
    const models = this.getAvailableModels(handlerType);
    if (models.length === 0) throw new Error(`no models available for handler type: ${handlerType}`);
    models.sort((a, b) => {
      const ca = typeof a.created === "number" ? a.created : undefined;
      const cb = typeof b.created === "number" ? b.created : undefined;
      if (ca === undefined || cb === undefined) return 0;
      return cb - ca;
    });
    for (const model of models) {
      const modelId = model.id;
      if (typeof modelId === "string" && this.getModelCount(modelId) > 0) return modelId;
    }
    throw new Error(`no available clients for any model in handler type: ${handlerType}`);
  }

  /** The models registered for clientId together with the client's current epoch (Go: GetModelsAndEpochForClient). */
  getModelsAndEpochForClient(clientId: string): { models: ModelInfo[]; epoch: number } {
    const epoch = this.clientEpochs.get(clientId) ?? 0;
    const modelIds = this.clientModels.get(clientId);
    if (!modelIds || modelIds.length === 0) return { models: [], epoch };
    const clientInfos = this.clientModelInfos.get(clientId);
    const seen = new Set<string>();
    const result: ModelInfo[] = [];
    for (const modelId of modelIds) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      const own = clientInfos?.get(modelId);
      if (own) {
        result.push(cloneModelInfo(own));
        continue;
      }
      const reg = this.models.get(modelId);
      if (reg) result.push(cloneModelInfo(reg.info));
    }
    return { models: result, epoch };
  }

  /** Current registration epoch for clientId (0 when never registered). */
  clientRegistrationEpoch(clientId: string): number {
    return this.clientEpochs.get(clientId) ?? 0;
  }

  /** Models registered for a specific client, cloned (Go: GetModelsForClient). */
  getModelsForClient(clientId: string): ModelInfo[] {
    return this.getModelsAndEpochForClient(clientId).models;
  }
}

/**
 * Converts a ModelInfo to the list entry shape of a handler type (Go: convertModelToMap).
 * "openai" -> /v1/models entry, "claude" -> Anthropic models entry, "gemini" -> models.list entry.
 */
export function convertModelToMap(model: ModelInfo, handlerType: string): JSONObject {
  switch (handlerType) {
    case "openai": {
      const result: JSONObject = { id: model.id, object: "model", owned_by: model.ownedBy ?? "" };
      if (model.created && model.created > 0) result.created = model.created;
      if (model.type) result.type = model.type;
      if (model.displayName) result.display_name = model.displayName;
      if (model.version) result.version = model.version;
      if (model.description) result.description = model.description;
      if (model.contextLength && model.contextLength > 0) result.context_length = model.contextLength;
      if (model.maxCompletionTokens && model.maxCompletionTokens > 0) result.max_completion_tokens = model.maxCompletionTokens;
      if (model.supportedParameters && model.supportedParameters.length > 0) result.supported_parameters = [...model.supportedParameters];
      return result;
    }
    case "claude": {
      const result: JSONObject = { id: model.id, object: "model", owned_by: model.ownedBy ?? "" };
      if (model.created && model.created > 0) result.created_at = toRFC3339(model.created);
      result.type = "model";
      result.display_name = model.displayName || model.id;
      const maxInput = model.contextLength && model.contextLength > 0 ? model.contextLength : DefaultClaudeMaxInputTokens;
      const maxOutput = model.maxCompletionTokens && model.maxCompletionTokens > 0 ? model.maxCompletionTokens : DefaultClaudeMaxOutputTokens;
      result.max_input_tokens = maxInput;
      result.max_tokens = maxOutput;
      return result;
    }
    case "gemini": {
      const result: JSONObject = {};
      result.name = model.name || model.id;
      if (model.version) result.version = model.version;
      if (model.displayName) result.displayName = model.displayName;
      if (model.description) result.description = model.description;
      let inputTokenLimit = model.inputTokenLimit ?? 0;
      if (inputTokenLimit <= 0) inputTokenLimit = model.contextLength ?? 0;
      if (inputTokenLimit > 0) result.inputTokenLimit = inputTokenLimit;
      let outputTokenLimit = model.outputTokenLimit ?? 0;
      if (outputTokenLimit <= 0) outputTokenLimit = model.maxCompletionTokens ?? 0;
      if (outputTokenLimit > 0) result.outputTokenLimit = outputTokenLimit;
      if (model.supportedGenerationMethods?.length) result.supportedGenerationMethods = [...model.supportedGenerationMethods];
      if (model.supportedInputModalities?.length) result.supportedInputModalities = [...model.supportedInputModalities];
      if (model.supportedOutputModalities?.length) result.supportedOutputModalities = [...model.supportedOutputModalities];
      return result;
    }
    default: {
      const result: JSONObject = { id: model.id, object: "model" };
      if (model.ownedBy) result.owned_by = model.ownedBy;
      if (model.type) result.type = model.type;
      if (model.created) result.created = model.created;
      return result;
    }
  }
}

// ---------------------------------------------------------------------------
// Global registry and lookups (Go: GetGlobalRegistry, LookupModelInfo, ModelOverrideHeaders)
// ---------------------------------------------------------------------------

let globalRegistry: ModelRegistry | undefined;

/** The process-wide model registry instance. */
export function getGlobalRegistry(): ModelRegistry {
  if (!globalRegistry) globalRegistry = new ModelRegistry();
  return globalRegistry;
}

/**
 * Searches the dynamic registry (provider-specific > global) and then the static definitions
 * (Go: LookupModelInfo). Always returns a clone.
 */
export function lookupModelInfo(modelId: string, provider = ""): ModelInfo | undefined {
  modelId = modelId.trim();
  if (modelId === "") return undefined;
  const p = provider.trim().toLowerCase();
  const info = getGlobalRegistry().getModelInfo(modelId, p);
  if (info) return cloneModelInfo(info);
  return cloneModelInfo(lookupStaticModelInfo(modelId));
}

/**
 * models.json config.override_header for the model, if any (Go: ModelOverrideHeaders).
 * Returns a defensive copy; undefined when the model has no overrides.
 */
export function modelOverrideHeaders(modelId: string, provider = ""): Record<string, string> | undefined {
  const info = lookupModelInfo(modelId, provider);
  const headers = info?.config?.overrideHeader;
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.trim();
    if (k === "") continue;
    out[k] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
