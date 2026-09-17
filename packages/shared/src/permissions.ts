/**
 * The permission map and how a key in it is resolved.
 *
 * Permissions are app-wide and per **function**: `AppSettings.permissions.functionAllow` maps a
 * key to a boolean, where a key is either a module id (`avatar`) or one function of it
 * (`avatar.show`). A function entry wins over its module's entry, and anything the map does not
 * mention is allowed — so a function added by a later version of the app, or by a plugin, arrives
 * switched on rather than silently missing.
 *
 * `lib` is the one module outside all of this: `sdk.lib` *is* the character's own function library
 * (the same object as the global `lib`), so switching parts of it off would only break the
 * character's own saved code. It is never listed, never offered as a toggle, and always available.
 */

/** Modules no permission applies to: always available, never shown as a toggle. */
export const ALWAYS_AVAILABLE_MODULES: readonly string[] = ['lib'];

export function isAlwaysAvailableModule(module: string): boolean {
  return ALWAYS_AVAILABLE_MODULES.includes(module);
}

/** The `functionAllow` key of one function: `module.method` (method names may themselves be dotted). */
export function functionKey(module: string, method: string): string {
  return `${module}.${method}`;
}

/** Split a `functionAllow` key into its module and (for a function key) its method. */
export function parseFunctionKey(key: string): { module: string; method?: string } {
  const dot = key.indexOf('.');
  if (dot < 0) return { module: key };
  return { module: key.slice(0, dot), method: key.slice(dot + 1) };
}

/**
 * Whether `module.method` may be called: the function's own entry if the map has one, else the
 * module's, else allowed. `lib` is always allowed.
 */
export function functionAllowed(allow: Record<string, boolean> | undefined, module: string, method: string): boolean {
  if (isAlwaysAvailableModule(module)) return true;
  if (!allow) return true;
  const own = allow[functionKey(module, method)];
  if (typeof own === 'boolean') return own;
  return allow[module] !== false;
}

/** Whether a module is switched off wholesale (its own entry says so and no function re-enables it). */
export function moduleAllowState(allow: Record<string, boolean> | undefined, module: string, methods: readonly string[]): 'all' | 'none' | 'some' {
  if (isAlwaysAvailableModule(module) || methods.length === 0) return 'all';
  let on = 0;
  for (const method of methods) if (functionAllowed(allow, module, method)) on++;
  if (on === methods.length) return 'all';
  return on === 0 ? 'none' : 'some';
}

/**
 * Fold the pre-function `moduleAllow` map of an older build (or an older policy file) into
 * `functionAllow`: its keys were module ids, which is exactly what a module-level entry is now.
 * Entries already in `functionAllow` win.
 */
export function mergeLegacyModuleAllow(functionAllow: Record<string, boolean> | undefined, moduleAllow: Record<string, boolean> | undefined): Record<string, boolean> {
  return { ...(moduleAllow ?? {}), ...(functionAllow ?? {}) };
}

/** Module id → the method names of it that are selected. The shape prompt- and sandbox-side filters share. */
export type FunctionSelection = Record<string, string[]>;

/**
 * Does `selection` (a list of `module` / `module.method` keys, as a pack author writes it) cover
 * `module.method`? A bare module id covers every function of it. `lib` is always covered.
 */
export function selectionCovers(selection: readonly string[] | undefined, module: string, method: string): boolean {
  if (isAlwaysAvailableModule(module)) return true;
  if (!selection) return true;
  return selection.includes(module) || selection.includes(functionKey(module, method));
}
