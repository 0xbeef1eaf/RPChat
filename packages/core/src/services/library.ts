import { functionSourceProblem, libraryNameProblem, removeLibraryFunction, unwrapFunctionSource, writeLibraryFunction } from '@rp/pack';
import type { CharacterLibraryEntry, LibFunction, LibFunctionInfo, LoadedCharacter, LoadedPack } from '@rp/shared';
import { LIB_MAX_FUNCTIONS, LIB_MAX_SOURCE_BYTES, LIB_MAX_TOTAL_BYTES, RpError } from '@rp/shared';

export { functionSourceProblem, unwrapFunctionSource } from '@rp/pack';

/**
 * Key in the character state scope (`char:<packId>/<characterId>`) that held
 * `Record<name, LibFunction>` before the library moved into the pack. Only
 * read by the migration in `PackService` (and hidden from the prompt's
 * `<state>` block until it has run).
 */
export const LIB_STATE_KEY = 'lib.functions';
/** The prelude of a character without any library function. */
export const EMPTY_PRELUDE = 'const lib = Object.freeze({});';

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
 */
export function functionParams(source: string): string {
  const text = source.trim();
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

/** Turn stored functions into the `const lib = Object.freeze({...});` prelude the sandbox prepends to every run. */
export function buildPrelude(functions: LibFunction[]): string {
  if (functions.length === 0) return EMPTY_PRELUDE;
  const entries = functions.map((f) => `  ${JSON.stringify(f.name)}: (${f.source}),`);
  return `const lib = Object.freeze({\n${entries.join('\n')}\n});`;
}

function info(f: LibFunction): LibFunctionInfo {
  const out: LibFunctionInfo = { name: f.name, bytes: f.bytes, updatedAt: f.updatedAt };
  if (f.description !== undefined) out.description = f.description;
  return out;
}

/** A loaded library entry as the service reports it. */
export function toLibFunction(name: string, entry: CharacterLibraryEntry): LibFunction {
  const out: LibFunction = { name, source: entry.source, bytes: entry.bytes, updatedAt: entry.updatedAt };
  if (entry.description !== undefined) out.description = entry.description;
  return out;
}

/**
 * A character's own function library (`sdk.lib`): functions it defines once and
 * calls as `lib.<name>(...)` in every later action, timer handler and event
 * handler. Each function is a file in the installed pack,
 * `characters/<id>/lib/<name>.ts`, read by the pack loader; `define` and
 * `remove` write and delete those files and rescan the library, so what a
 * character defines lands next to what the author shipped and survives
 * sessions and restarts (until the pack folder is replaced by a reinstall).
 * The prelude that defines `lib` is cached per character and rebuilt after
 * every write.
 */
export class LibraryService {
  private readonly preludes = new Map<string, string>();

  constructor(private readonly packs: LibraryPacks) {}

  async define(target: LibraryTarget, name: string, fn: string, opts: { description?: string } = {}): Promise<LibFunctionInfo> {
    const nameProblem = libraryNameProblem(name);
    if (nameProblem !== undefined) throw new RpError('INVALID_ARGUMENT', nameProblem, { name });
    if (typeof fn !== 'string') throw new RpError('INVALID_ARGUMENT', 'fn must be a function (or a string holding a function expression)');
    const source = unwrapFunctionSource(fn);
    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes > LIB_MAX_SOURCE_BYTES) {
      throw new RpError('INVALID_ARGUMENT', `fn is ${bytes} bytes; the limit is ${LIB_MAX_SOURCE_BYTES} bytes per function`, { bytes, limit: LIB_MAX_SOURCE_BYTES });
    }
    const problem = functionSourceProblem(source);
    if (problem !== undefined) throw new RpError('INVALID_ARGUMENT', problem);
    if (opts.description !== undefined && opts.description !== null && typeof opts.description !== 'string') {
      throw new RpError('INVALID_ARGUMENT', 'opts.description must be a string');
    }
    const description = typeof opts.description === 'string' ? opts.description.trim().slice(0, 200) : '';

    const { pack, character } = this.resolve(target);
    const functions = character.library;
    if (!(name in functions) && Object.keys(functions).length >= LIB_MAX_FUNCTIONS) {
      throw new RpError('INVALID_ARGUMENT', `the library already holds ${LIB_MAX_FUNCTIONS} functions; remove one first`, { limit: LIB_MAX_FUNCTIONS });
    }
    const total = Object.entries(functions).reduce((n, [other, f]) => n + (other === name ? 0 : f.bytes), 0) + bytes;
    if (total > LIB_MAX_TOTAL_BYTES) {
      throw new RpError('INVALID_ARGUMENT', `the library would be ${total} bytes; the limit is ${LIB_MAX_TOTAL_BYTES} bytes in total`, { bytes: total, limit: LIB_MAX_TOTAL_BYTES });
    }
    await writeLibraryFunction(pack.root, character.dir, name, source, description.length > 0 ? description : undefined);
    const library = await this.reload(target);
    const entry = library[name];
    if (!entry) {
      // The file was written but the scan did not take it (cannot happen after the checks above).
      throw new RpError('INTERNAL', `lib.${name} was written but did not load`, { name });
    }
    return info(toLibFunction(name, entry));
  }

  async remove(target: LibraryTarget, name: string): Promise<boolean> {
    if (typeof name !== 'string' || name.length === 0) throw new RpError('INVALID_ARGUMENT', 'name must be a non-empty string');
    if (libraryNameProblem(name) !== undefined) return false;
    const { pack, character } = this.resolve(target);
    const existed = await removeLibraryFunction(pack.root, character.dir, name);
    if (existed || name in character.library) await this.reload(target);
    return existed;
  }

  /** The functions without their sources, by name. */
  async list(target: LibraryTarget): Promise<LibFunctionInfo[]> {
    return (await this.functions(target)).map(info);
  }

  /** The functions with their sources (for the prompt's `<library>` section), by name. */
  async functions(target: LibraryTarget): Promise<LibFunction[]> {
    return Object.entries(this.read(target)).map(([name, entry]) => toLibFunction(name, entry));
  }

  async source(target: LibraryTarget, name: string): Promise<string> {
    if (typeof name !== 'string' || name.length === 0) throw new RpError('INVALID_ARGUMENT', 'name must be a non-empty string');
    const f = this.read(target)[name];
    if (!f) throw new RpError('NOT_FOUND', `lib.${name} is not defined`, { name });
    return f.source;
  }

  /** The `const lib = …` prelude for a character's runs; cached until the library changes. */
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
