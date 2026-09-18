/**
 * A character's own function library (the `lib` global, which `sdk.lib` is too):
 * reusable functions the character registers once and calls as `lib.<name>(...)` from any later action,
 * timer handler or event handler. Each function is a file in the pack,
 * `characters/<id>/lib/<name>.ts`, so pack authors can ship functions and what a
 * character registers itself survives sessions and app restarts (docs/spec/pack.md
 * "Function library", docs/spec/core.md "LibraryService").
 */

/** First-line marker (`// @internal …`) of a function the character may not call itself. */
export const LIB_INTERNAL_MARKER = '@internal';

/** Directory under the character directory that holds the library files. */
export const LIB_DIR_NAME = 'lib';
/** Extension of a library file (`characters/<id>/lib/<name>.ts`). */
export const LIB_FILE_EXTENSION = '.ts';

/** One library function as the service reports it. `source` is one function expression (arrow or `function`), or a module exporting one. */
export interface LibFunction {
  /** Identifier the function is called by: `lib.<name>(...)`. */
  name: string;
  /** The source as the character or the author wrote it — the function, with any helpers of its file (already plain JavaScript when it came from an action). */
  source: string;
  /** What the function is for, shown in the prompt's `<library>` section. */
  description?: string;
  /**
   * An author's helper (`// @internal` first line): other library functions and the pack's
   * behaviour hooks can call it, the character cannot. It is left out of `<library>` and out
   * of the `lib` object the model's own action code sees; `lib.register` only replaces one
   * when the call asks for `internal` too.
   */
  internal?: boolean;
  /** UTF-8 size of `source`. */
  bytes: number;
  /** ISO-8601 time of the last register (the file's modification time). */
  updatedAt: string;
}

/** What `lib.register` returns: a `LibFunction` without its source. */
export type LibFunctionInfo = Omit<LibFunction, 'source'>;

/** Name rules for library functions: a JavaScript identifier, at most this long. */
export const LIB_NAME_PATTERN = /^[a-zA-Z_$][\w$]*$/;
export const LIB_NAME_MAX_CHARS = 64;
/** Functions (files) per character. */
export const LIB_MAX_FUNCTIONS = 50;
/** UTF-8 bytes of all sources of one character together: what the prelude prepended to every run costs. */
export const LIB_MAX_TOTAL_BYTES = 128 * 1024;
