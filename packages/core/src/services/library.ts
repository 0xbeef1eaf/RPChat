import {
  exportedFunctionSource,
  functionSourceProblem,
  libraryNameProblem,
  libraryValueExpression,
  removeLibraryFunction,
  stripLeadingComments,
  unwrapFunctionSource,
  writeLibraryFunction,
} from '@rp/pack';
import type { CharacterLibraryEntry, LibFunction, LibFunctionInfo, LoadedCharacter, LoadedPack } from '@rp/shared';
import { LIB_MAX_FUNCTIONS, LIB_MAX_TOTAL_BYTES, RpError } from '@rp/shared';

export { functionSourceProblem, unwrapFunctionSource } from '@rp/pack';

/**
 * Key in the character state scope (`char:<packId>/<characterId>`) that held
 * `Record<name, LibFunction>` before the library moved into the pack. Only
 * read by the migration in `PackService` (and hidden from the prompt's
 * `<state>` block until it has run).
 */
export const LIB_STATE_KEY = 'lib.functions';
/**
 * The prelude of a character without any library function. `__rp_lib` is the
 * sandbox bootstrap's library factory: it adds `register` / `unregister` and
 * makes what it returns the value of `sdk.lib`, so an empty library still has
 * its two methods.
 */
export const EMPTY_PRELUDE = 'const lib = __rp_lib({});';

/** The character a library belongs to. */
export interface LibraryTarget {
  packId: string;
  characterId: string;
}

/** What the service needs from `PackService`: the loaded pack, and a rescan of its library after a write. */
export interface LibraryPacks {
  getLoaded(packId: string): LoadedPack;
  reloadCharacterLibrary(packId: string): Promise<Record<string, CharacterLibraryEntry>>;
}

/**
 * Parameters of a stored function as text: what lies between the first `(` and
 * its matching `)`, whitespace collapsed (`async (mood: string) => …` gives
 * `mood: string`); a parenthesis-free arrow (`x => …`) gives its one parameter.
 * Comments in front of the function are skipped, so one holding a `(` or a `=>`
 * cannot pass itself off as the parameter list. A source written as a module is
 * read from its exported function, not from the first helper in the file.
 */
export function functionParams(source: string): string {
  const text = stripLeadingComments(exportedFunctionSource(source)).trim();
  const open = text.indexOf('(');
  const arrow = text.indexOf('=>');
  if (open < 0 || (arrow >= 0 && arrow < open)) {
    // `x => …` / `async x => …`
    const m = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(text);
    return m ? m[1]! : '';
  }
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i).replace(/\s+/g, ' ').trim();
    }
  }
  return text.slice(open + 1).replace(/\s+/g, ' ').trim();
}

/**
 * Turn stored functions into the `const lib = __rp_lib({...});` prelude the sandbox
 * prepends to every run. `__rp_lib` (sandbox bootstrap) adds the library's own
 * `register` / `unregister` to the object and makes it the value of `sdk.lib`, so
 * `sdk.lib.<name>(...)` reaches the same function as `lib.<name>(...)`.
 *
 * There is one `lib`, holding every function, in every run: internal helpers are not
 * hidden by a second scope. A nested `lib` would be renamed by the transpiler (`lib2`),
 * and a handler a library function hands to `sdk.events.on` / `sdk.timers.runLater` is
 * stored as its compiled source — so the rename used to travel into the stored code and
 * fail there with `ReferenceError: 'lib2' is not defined`.
 *
 * Instead the internal names are passed to `__rp_lib` as its second argument, and the
 * sandbox refuses them to the action body of an LLM-authored run (`trigger.kind === 'llm'`)
 * while the library's own functions keep calling each other. `<library>` in the prompt
 * lists the rest (`prompt.ts`, `visibleLibrary`).
 *
 * A function written as a module (helpers in the file, one export) contributes an arrow
 * that runs those statements and hands back the export — `libraryValueExpression` in
 * `@rp/pack` builds it, and the helpers stay private to that one entry.
 */
export function buildPrelude(functions: LibFunction[]): string {
  if (functions.length === 0) return EMPTY_PRELUDE;
  const entries = functions.map((f) => `  ${JSON.stringify(f.name)}: ${libraryValueExpression(f.source)},`).join('\n');
  const internal = functions.filter((f) => f.internal === true).map((f) => f.name);
  const hidden = internal.length > 0 ? `, ${JSON.stringify(internal)}` : '';
  return `const lib = __rp_lib({\n${entries}\n}${hidden});`;
}

function info(f: LibFunction): LibFunctionInfo {
  const out: LibFunctionInfo = { name: f.name, bytes: f.bytes, updatedAt: f.updatedAt };
  if (f.description !== undefined) out.description = f.description;
  if (f.internal === true) out.internal = true;
  return out;
}

/** A loaded library entry as the service reports it. */
export function toLibFunction(name: string, entry: CharacterLibraryEntry): LibFunction {
  const out: LibFunction = { name, source: entry.source, bytes: entry.bytes, updatedAt: entry.updatedAt };
  if (entry.description !== undefined) out.description = entry.description;
  if (entry.internal === true) out.internal = true;
  return out;
}

/**
 * A character's own function library (`lib`, which is also `sdk.lib`): functions
 * it registers once and calls as `lib.<name>(...)` in every later action, timer
 * handler and event handler. Each function is a file in the installed pack,
 * `characters/<id>/lib/<name>.ts`, read by the pack loader; `register` and
 * `unregister` write and delete those files and rescan the library, so what a
 * character registers lands next to what the author shipped and survives
 * sessions and restarts (until the pack folder is replaced by a reinstall).
 * The prelude that defines `lib` is cached per character and rebuilt after
 * every write.
 */
export class LibraryService {
  private readonly preludes = new Map<string, string>();

  constructor(private readonly packs: LibraryPacks) {}

  /**
   * Save (or replace) `name`. `opts.internal` writes an `// @internal` helper: hidden from the
   * prompt and from the `lib` the character's own action code sees, callable from its other
   * library functions. An existing internal function (the pack author's plumbing, or one the
   * character wrote that way) is only replaced when the call says `internal: true` too, so a
   * name the character cannot see cannot be taken by accident.
   */
  async register(target: LibraryTarget, name: string, fn: string, opts: { description?: string; internal?: boolean } = {}): Promise<LibFunctionInfo> {
    const nameProblem = libraryNameProblem(name);
    if (nameProblem !== undefined) throw new RpError('INVALID_ARGUMENT', nameProblem, { name });
    if (typeof fn !== 'string') throw new RpError('INVALID_ARGUMENT', 'fn must be a function (or a string holding a function expression)');
    const source = unwrapFunctionSource(fn);
    const bytes = Buffer.byteLength(source, 'utf8');
    const problem = functionSourceProblem(source);
    if (problem !== undefined) throw new RpError('INVALID_ARGUMENT', problem);
    if (opts.description !== undefined && opts.description !== null && typeof opts.description !== 'string') {
      throw new RpError('INVALID_ARGUMENT', 'opts.description must be a string');
    }
    if (opts.internal !== undefined && opts.internal !== null && typeof opts.internal !== 'boolean') {
      throw new RpError('INVALID_ARGUMENT', 'opts.internal must be a boolean');
    }
    const description = typeof opts.description === 'string' ? opts.description.trim().slice(0, 200) : '';
    const internal = opts.internal === true;

    const { pack, character } = this.resolve(target);
    const functions = character.library;
    if (functions[name]?.internal === true && !internal) {
      // A helper the character does not see: it must not lose it to a name it picked blind.
      throw new RpError('INVALID_ARGUMENT', `lib.${name} is reserved by this pack (an internal helper); choose another name`, { name });
    }
    if (!(name in functions) && Object.keys(functions).length >= LIB_MAX_FUNCTIONS) {
      throw new RpError('INVALID_ARGUMENT', `the library already holds ${LIB_MAX_FUNCTIONS} functions; remove one first`, { limit: LIB_MAX_FUNCTIONS });
    }
    const total = Object.entries(functions).reduce((n, [other, f]) => n + (other === name ? 0 : f.bytes), 0) + bytes;
    if (total > LIB_MAX_TOTAL_BYTES) {
      throw new RpError('INVALID_ARGUMENT', `the library would be ${total} bytes; the limit is ${LIB_MAX_TOTAL_BYTES} bytes in total`, { bytes: total, limit: LIB_MAX_TOTAL_BYTES });
    }
    await writeLibraryFunction(pack.root, character.dir, name, source, description.length > 0 ? description : undefined, internal);
    const library = await this.reload(target);
    const entry = library[name];
    if (!entry) {
      // The file was written but the scan did not take it (cannot happen after the checks above).
      throw new RpError('INTERNAL', `lib.${name} was written but did not load`, { name });
    }
    return info(toLibFunction(name, entry));
  }

  /** Delete `name`, internal helpers included: a character that can register one can take it back. */
  async unregister(target: LibraryTarget, name: string): Promise<boolean> {
    if (typeof name !== 'string' || name.length === 0) throw new RpError('INVALID_ARGUMENT', 'name must be a non-empty string');
    if (libraryNameProblem(name) !== undefined) return false;
    const { pack, character } = this.resolve(target);
    const existed = await removeLibraryFunction(pack.root, character.dir, name);
    if (existed || name in character.library) await this.reload(target);
    return existed;
  }

  /** Every function with its source, internal helpers included (the prelude's input; the prompt lists the rest). */
  async functions(target: LibraryTarget): Promise<LibFunction[]> {
    return Object.entries(this.read(target)).map(([name, entry]) => toLibFunction(name, entry));
  }

  /**
   * The `const lib = …` prelude for a character's runs; cached until the library changes.
   * The same prelude serves every run: which functions the running code may call is decided
   * in the sandbox from the run's trigger, not by the shape of the prelude.
   */
  async preludeFor(packId: string, characterId: string): Promise<string> {
    const key = cacheKey({ packId, characterId });
    const cached = this.preludes.get(key);
    if (cached !== undefined) return cached;
    const prelude = buildPrelude(await this.functions({ packId, characterId }));
    this.preludes.set(key, prelude);
    return prelude;
  }

  /** Drop cached preludes (one character's, or all). */
  invalidate(target?: LibraryTarget): void {
    if (target) this.preludes.delete(cacheKey(target));
    else this.preludes.clear();
  }

  private resolve(target: LibraryTarget): { pack: LoadedPack; character: LoadedCharacter } {
    const pack = this.packs.getLoaded(target.packId);
    const character = pack.characters.find((c) => c.definition.id === target.characterId);
    if (!character) throw new RpError('NOT_FOUND', `Character "${target.characterId}" does not exist in pack ${target.packId}`, { ...target });
    return { pack, character };
  }

  /** The library of an installed character; an uninstalled pack has none. */
  private read(target: LibraryTarget): Record<string, CharacterLibraryEntry> {
    try {
      return this.resolve(target).character.library;
    } catch (err) {
      if (err instanceof RpError && err.code === 'NOT_FOUND') return {};
      throw err;
    }
  }

  private async reload(target: LibraryTarget): Promise<Record<string, CharacterLibraryEntry>> {
    this.invalidate(target);
    return this.packs.reloadCharacterLibrary(target.packId);
  }
}

function cacheKey(target: LibraryTarget): string {
  return `${target.packId}/${target.characterId}`;
}
