import { DEFAULT_RUN_LIMITS, DEFAULT_SETTINGS, clampChatZoom } from '@rp/shared';
import type { AppSettings, CommandTemplates, RunLimits } from '@rp/shared';

/** A fresh, fully populated `AppSettings` (deep copies of the defaults). */
export function defaultSettings(): AppSettings {
  const { runLimits, ...rest } = DEFAULT_SETTINGS;
  return { ...rest, providers: [], runLimits: { ...(runLimits ?? DEFAULT_RUN_LIMITS) } };
}

/** Merge a stored/partial settings object onto the defaults (run limits merged field by field). */
/** `contextTokenBudget` default before the abridged SDK index; migrated on load. */
export const LEGACY_CONTEXT_TOKEN_BUDGET = 24_000;
/** `history.keepActionDetailFor` default before it became 0; migrated on load. */
export const LEGACY_KEEP_ACTION_DETAIL_FOR = 2;

export function mergeSettings(stored: Partial<AppSettings> | undefined, base: AppSettings = defaultSettings()): AppSettings {
  if (!stored) return base;
  const runLimits: RunLimits = { ...base.runLimits, ...(stored.runLimits ?? {}) };
  const merged: AppSettings = { ...base, ...stored, runLimits };
  if (!Array.isArray(merged.providers)) merged.providers = [];
  // Every read goes through here, so a value from an older build or a hand-edited file cannot
  // leave the chat unreadably small or large.
  merged.chatZoom = clampChatZoom(merged.chatZoom);
  // The 24k default of early builds left almost no room for the transcript; move it to the current default.
  if (stored.contextTokenBudget === LEGACY_CONTEXT_TOKEN_BUDGET) merged.contextTokenBudget = base.contextTokenBudget;
  // Nested records are merged per key so a patch of one entry keeps the others. Command templates
  // are also filtered to the known names so keys from older versions (e.g. the removed input
  // templates) are dropped instead of carried along forever.
  if (stored.commandTemplates && typeof stored.commandTemplates === 'object') {
    merged.commandTemplates = { ...base.commandTemplates };
    for (const name of Object.keys(base.commandTemplates) as Array<keyof CommandTemplates>) {
      const tpl = (stored.commandTemplates as Partial<CommandTemplates>)[name];
      if (tpl && typeof tpl === 'object') merged.commandTemplates[name] = tpl;
    }
  }
  if (stored.memory && typeof stored.memory === 'object') {
    merged.memory = { ...base.memory, ...stored.memory };
  }
  if (stored.history && typeof stored.history === 'object') {
    merged.history = { ...base.history, ...stored.history };
    // Early builds defaulted to re-sending the last two turns' tool calls; that overloads smaller models.
    if (stored.history.keepActionDetailFor === LEGACY_KEEP_ACTION_DETAIL_FOR) merged.history.keepActionDetailFor = base.history.keepActionDetailFor;
  }
  if (stored.autonomy && typeof stored.autonomy === 'object') {
    merged.autonomy = { ...base.autonomy, ...stored.autonomy };
  }
  if (stored.senses && typeof stored.senses === 'object') merged.senses = { ...base.senses, ...stored.senses };
  if (stored.web && typeof stored.web === 'object') merged.web = { ...base.web, ...stored.web };
  if (stored.desktop && typeof stored.desktop === 'object') merged.desktop = { ...base.desktop, ...stored.desktop };
  if (stored.browser && typeof stored.browser === 'object') merged.browser = { ...base.browser, ...stored.browser };
  if (stored.messaging && typeof stored.messaging === 'object') merged.messaging = { ...base.messaging, ...stored.messaging };
  if (stored.updates && typeof stored.updates === 'object') merged.updates = { ...base.updates, ...stored.updates };
  if (stored.debug && typeof stored.debug === 'object') merged.debug = { ...base.debug, ...stored.debug };
  if (stored.permissions && typeof stored.permissions === 'object') {
    merged.permissions = { ...base.permissions, ...stored.permissions, moduleAllow: { ...base.permissions.moduleAllow, ...(stored.permissions.moduleAllow ?? {}) } };
  }
  return merged;
}
