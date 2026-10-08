import type { CharacterLibrary, LibFunction, LoadedPack } from '@rp/shared';
import { RpError } from '@rp/shared';

/**
 * Key in the character state scope (`char:<packId>/<characterId>`) where very old
 * versions kept the functions a character saved with `lib.register`. Nothing reads
 * it any more; it is only kept out of the prompt's `<state>` block, where the raw
 * sources of a profile that still holds it would be noise.
 */
export const LIB_STATE_KEY = 'lib.functions';
/**
 * The prelude of a character without a library. `__rp_lib` is the sandbox
 * bootstrap's library factory: what it returns is also the value of `sdk.lib`,
 * so an empty library is still an (empty) object there.
 */
export const EMPTY_PRELUDE = 'const lib = __rp_lib({});';

/** The character a library belongs to. */
export interface LibraryTarget {
  packId: string;
  characterId: string;
}

/** What the service needs from `PackService`: the loaded pack. */
export interface LibraryPacks {
  getLoaded(packId: string): LoadedPack;
}

/**
 * Turn a character's library into the `const lib = __rp_lib(...);` prelude the sandbox
 * prepends to every run. `library.code` is the `lib/` folder bundled into one expression
 * evaluating to the object of its exports; `__rp_lib` (sandbox bootstrap) wraps each
 * function and makes the object the value of `sdk.lib`, so `sdk.lib.<name>(...)` reaches
 * the same function as `lib.<name>(...)`.
 *
 * There is one `lib`, holding every export, in every run: `@internal` exports are not
 * hidden by a second scope. A nested `lib` would be renamed by the transpiler (`lib2`), and
 * a handler a library function hands to `sdk.events.on` / `sdk.timers.runLater` is stored as
 * its compiled source — so the rename used to travel into the stored code and fail there
 * with `ReferenceError: 'lib2' is not defined`.
 *
 * Instead the internal names are passed to `__rp_lib` as its second argument, and the
 * sandbox refuses them to the action body of an LLM-authored run (`trigger.kind === 'llm'`)
 * while the library's own functions keep calling each other. `<library>` in the prompt
 * lists the rest (`prompt.ts`, `visibleLibrary`).
 */
export function buildPrelude(library: Pick<CharacterLibrary, 'code' | 'functions'>): string {
  if (library.code.length === 0) return EMPTY_PRELUDE;
  const internal = Object.values(library.functions).filter((f) => f.internal === true).map((f) => f.name);
  const hidden = internal.length > 0 ? `, ${JSON.stringify(internal)}` : '';
  return `const lib = __rp_lib(${library.code}${hidden});`;
}

/**
 * A character's function library (`lib`, which is also `sdk.lib`): the TypeScript the
 * pack author ships under `characters/<id>/lib/`, read and bundled by the pack loader.
 * Every export is `lib.<name>(...)` in every action, timer handler and event handler.
 * The library is the author's: nothing at run time adds to it or takes from it. The
 * prelude that defines `lib` is cached per character and dropped when a pack changes.
 */
export class LibraryService {
  private readonly preludes = new Map<string, string>();

  constructor(private readonly packs: LibraryPacks) {}

  /** Every function of the library, internal ones included (the prompt lists the rest). */
  async functions(target: LibraryTarget): Promise<LibFunction[]> {
    return Object.values(this.read(target).functions);
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
    const prelude = buildPrelude(this.read({ packId, characterId }));
    this.preludes.set(key, prelude);
    return prelude;
  }

  /** Drop cached preludes (one character's, or all). */
  invalidate(target?: LibraryTarget): void {
    if (target) this.preludes.delete(cacheKey(target));
    else this.preludes.clear();
  }

  /** The library of an installed character; an uninstalled pack, or a character it lacks, has none. */
  private read(target: LibraryTarget): Pick<CharacterLibrary, 'code' | 'functions'> {
    let pack: LoadedPack;
    try {
      pack = this.packs.getLoaded(target.packId);
    } catch (err) {
      if (err instanceof RpError && err.code === 'NOT_FOUND') return { code: '', functions: {} };
      throw err;
    }
    const character = pack.characters.find((c) => c.definition.id === target.characterId);
    return character ? character.library : { code: '', functions: {} };
  }
}

function cacheKey(target: LibraryTarget): string {
  return `${target.packId}/${target.characterId}`;
}
