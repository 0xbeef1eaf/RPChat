/**
 * A character's function library (the `lib` global, which `sdk.lib` is too): the
 * pack author's TypeScript under `characters/<id>/lib/`, callable as
 * `lib.<name>(...)` from every action, timer handler and event handler.
 *
 * The folder is a small TypeScript project. Every `.ts` file in it (sub-folders
 * included) is a module: what it `export`s is public and lands on `lib` under its
 * own name; what it does not export is private to the file. Files may import each
 * other with relative paths (`import { roll } from './dice'`), and the folder is
 * bundled into the code the host puts in front of every run (docs/spec/pack.md
 * "Function library", docs/spec/core.md "LibraryService").
 */

/** JSDoc tag of an exported function the character may not call itself. */
export const LIB_INTERNAL_TAG = '@internal';

/** Directory under the character directory that holds the library files. */
export const LIB_DIR_NAME = 'lib';
/** Extension of a library file (`characters/<id>/lib/<file>.ts`); `.d.ts` files are not modules and are ignored. */
export const LIB_FILE_EXTENSION = '.ts';

/** One `lib.<name>` function: an export of one of the library's files. */
export interface LibFunction {
  /** Identifier the function is called by: `lib.<name>(...)` — the export's own name. */
  name: string;
  /** Path relative to the pack root of the file that exports it, e.g. `characters/luna/lib/cheer.ts`. */
  file: string;
  /** The parameter list as written (`mood: string`), shown in `<library>`; '' when it could not be read. */
  params: string;
  /** The summary of the export's JSDoc, shown in the prompt's `<library>` section. */
  description?: string;
  /**
   * Tagged `@internal` in its JSDoc: other library functions and the pack's behaviour hooks
   * can call it, the character's own action code cannot. It is left out of `<library>` and
   * refused to the model's actions — for an export a sibling file imports and nobody else
   * should call.
   */
  internal?: boolean;
}

/** Where something is wrong in the library, and what. */
export interface LibraryProblem {
  /** Path relative to the pack root of the file it concerns. */
  file: string;
  /** 1-based, when the problem has a position. */
  line?: number;
  /** 1-based, when the problem has a position. */
  column?: number;
  message: string;
}

/** A character's library as loaded: its files, what they export, and the code the run gets. */
export interface CharacterLibrary {
  /** Every library file, path relative to the pack root → source, sorted by path. */
  files: Record<string, string>;
  /**
   * `lib.<name>` → the function, sorted by name: the exports that are functions (or that the
   * loader could not tell apart from one). An exported constant or class is on `lib` too, but
   * not listed here. Empty when the library does not build.
   */
  functions: Record<string, LibFunction>;
  /**
   * The folder bundled into one JavaScript expression evaluating to the object of its
   * exported functions; '' for an empty library or one that does not build.
   */
  code: string;
  /**
   * What is wrong in the files. When the folder does not build (a syntax error, an import that
   * does not resolve) `functions` and `code` are empty; a problem with one export (a default
   * export, a name another file already exports) only leaves that export out.
   */
  problems: LibraryProblem[];
}

/** A library without files. */
export const EMPTY_LIBRARY: CharacterLibrary = Object.freeze({ files: {}, functions: {}, code: '', problems: [] }) as CharacterLibrary;

/** Name rules for library functions: a JavaScript identifier, at most this long. */
export const LIB_NAME_PATTERN = /^[a-zA-Z_$][\w$]*$/;
export const LIB_NAME_MAX_CHARS = 64;
/**
 * Advisory ceiling on public functions per character. Over it the pack still
 * installs, exports and loads; the scan reports a `warning:` line instead.
 * The cost of each one is a `<library>` line in the prompt of every turn
 * (`- lib.<name>(<params>) — <description>`; sources never go in the prompt,
 * and `@internal` exports are not listed at all).
 */
export const LIB_MAX_FUNCTIONS = 50;
/**
 * Advisory ceiling on the UTF-8 bytes of all library files of one character
 * together. Over it the pack still installs, exports and loads; the scan reports
 * a `warning:` line instead. The whole bundle is evaluated in the isolate on
 * every action, timer and event handler, against that run's `cpuMs` budget.
 */
export const LIB_MAX_TOTAL_BYTES = 128 * 1024;
