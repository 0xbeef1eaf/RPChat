import { DEFAULT_RUN_LIMITS, DEFAULT_SETTINGS } from '@rp/shared';
import type { AppSettings, RunLimits } from '@rp/shared';

/** A fresh, fully populated `AppSettings` (deep copies of the defaults). */
export function defaultSettings(): AppSettings {
  const { runLimits, ...rest } = DEFAULT_SETTINGS;
  return { ...rest, providers: [], runLimits: { ...(runLimits ?? DEFAULT_RUN_LIMITS) } };
}

/** Merge a stored/partial settings object onto the defaults (run limits merged field by field). */
export function mergeSettings(stored: Partial<AppSettings> | undefined, base: AppSettings = defaultSettings()): AppSettings {
  if (!stored) return base;
  const runLimits: RunLimits = { ...base.runLimits, ...(stored.runLimits ?? {}) };
  const merged: AppSettings = { ...base, ...stored, runLimits };
  if (!Array.isArray(merged.providers)) merged.providers = [];
  // Nested records are merged per key so a patch of one entry keeps the others.
  if (stored.commandTemplates && typeof stored.commandTemplates === 'object') {
    merged.commandTemplates = { ...base.commandTemplates, ...stored.commandTemplates };
  }
  if (stored.memory && typeof stored.memory === 'object') {
    merged.memory = { ...base.memory, ...stored.memory };
  }
  if (stored.autonomy && typeof stored.autonomy === 'object') {
    merged.autonomy = { ...base.autonomy, ...stored.autonomy };
  }
  if (stored.senses && typeof stored.senses === 'object') merged.senses = { ...base.senses, ...stored.senses };
  if (stored.web && typeof stored.web === 'object') merged.web = { ...base.web, ...stored.web };
  if (stored.desktop && typeof stored.desktop === 'object') merged.desktop = { ...base.desktop, ...stored.desktop };
  if (stored.messaging && typeof stored.messaging === 'object') merged.messaging = { ...base.messaging, ...stored.messaging };
  if (stored.permissions && typeof stored.permissions === 'object') {
    merged.permissions = { ...base.permissions, ...stored.permissions, moduleAllow: { ...base.permissions.moduleAllow, ...(stored.permissions.moduleAllow ?? {}) } };
  }
  return merged;
}
