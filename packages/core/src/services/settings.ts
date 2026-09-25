import type { AppSettings, LlmProvider, ModelInfo, ProviderConfig, Storage } from '@rp/shared';
import { RpError, UNLIMITED } from '@rp/shared';
import { mergeSettings } from '../defaults.js';

export type ProviderFactory = (config: ProviderConfig) => LlmProvider;

/** App settings on top of `Storage.settings`, always merged with the defaults. */
export class SettingsService {
  constructor(
    private readonly storage: Storage,
    private readonly providerFactory: ProviderFactory,
  ) {}

  async get(): Promise<AppSettings> {
    return mergeSettings(await this.storage.settings.get());
  }

  /** Shallow patch; `runLimits` is merged field by field; `providers` is replaced as a whole. */
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get();
    const next = mergeSettings(patch, current);
    if (patch.providers) {
      const seen = new Set<string>();
      for (const p of patch.providers) {
        if (!p || typeof p.id !== 'string' || p.id.length === 0) {
          throw new RpError('INVALID_ARGUMENT', 'Every provider needs a non-empty id');
        }
        if (seen.has(p.id)) throw new RpError('INVALID_ARGUMENT', `Duplicate provider id "${p.id}"`);
        seen.add(p.id);
      }
    }
    if (next.defaultProviderId !== undefined && !next.providers.some((p) => p.id === next.defaultProviderId)) {
      delete next.defaultProviderId;
    }
    if (!Number.isFinite(next.maxActionRounds) || next.maxActionRounds < 0) next.maxActionRounds = current.maxActionRounds;
    if (!Number.isFinite(next.maxActionRepairs) || next.maxActionRepairs < UNLIMITED) next.maxActionRepairs = current.maxActionRepairs;
    if (!Number.isFinite(next.contextTokenBudget) || next.contextTokenBudget < 1000) {
      next.contextTokenBudget = current.contextTokenBudget;
    }
    await this.storage.settings.set(next);
    return next;
  }

  /** The provider config a session should use (session override → default → the only provider). */
  async resolveProvider(providerId?: string): Promise<ProviderConfig> {
    const settings = await this.get();
    const wanted = providerId ?? settings.defaultProviderId;
    const found = wanted !== undefined ? settings.providers.find((p) => p.id === wanted) : undefined;
    if (found) return found;
    if (wanted === undefined && settings.providers.length === 1) return settings.providers[0] as ProviderConfig;
    throw new RpError(
      'LLM_PROVIDER',
      wanted === undefined
        ? 'No LLM provider configured. Add one in settings and choose a default.'
        : `LLM provider "${wanted}" is not configured.`,
      { providerId: wanted },
    );
  }

  async testProvider(config: ProviderConfig): Promise<{ ok: boolean; message?: string }> {
    try {
      const provider = this.providerFactory(config);
      if (provider.test) return await provider.test();
      return { ok: true, message: 'Provider created (no connectivity test available).' };
    } catch (err) {
      return { ok: false, message: RpError.from(err, 'LLM_PROVIDER').message };
    }
  }

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const provider = this.providerFactory(config);
    if (!provider.listModels) return config.model ? [{ id: config.model }] : [];
    return provider.listModels();
  }
}
