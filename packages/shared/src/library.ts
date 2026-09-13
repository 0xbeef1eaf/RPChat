/**
 * A character's own function library (`sdk.lib`): reusable functions the
 * character defines once and calls as `lib.<name>(...)` from any later action,
 * timer handler or event handler. Each function is a file in the pack,
 * `characters/<id>/lib/<name>.ts`, so pack authors can ship functions and what a
 * character defines itself survives sessions and app restarts (docs/spec/pack.md
 * "Function library", docs/spec/core.md "LibraryService").
 */

/** Directory under the character directory that holds the library files. */
export const LIB_DIR_NAME = 'lib';
/** Extension of a library file (`characters/<id>/lib/<name>.ts`). */
export const LIB_FILE_EXTENSION = '.ts';

/** One library function as the service reports it. `source` is a single function expression (arrow or `function`). */
export interface LibFunction {
  /** Identifier the function is called by: `lib.<name>(...)`. */
  name: string;
  /** The function expression as the character wrote it (already plain JavaScript when it came from an action). */
  source: string;
  /** What the function is for, shown in the prompt's `<library>` section. */
  description?: string;
  /** UTF-8 size of `source`. */
  bytes: number;
  /** ISO-8601 time of the last define (the file's modification time). */
  updatedAt: string;
}

/** What `sdk.lib.define/list` return: a `LibFunction` without its source. */
export type LibFunctionInfo = Omit<LibFunction, 'source'>;

/** Name rules for library functions: a JavaScript identifier, at most this long. */
export const LIB_NAME_PATTERN = /^[a-zA-Z_$][\w$]*$/;
export const LIB_NAME_MAX_CHARS = 64;
/** Functions (files) per character. */
export const LIB_MAX_FUNCTIONS = 50;
/** UTF-8 bytes per function source (per file). */
export const LIB_MAX_SOURCE_BYTES = 16 * 1024;
/** UTF-8 bytes of all sources of one character together. */
export const LIB_MAX_TOTAL_BYTES = 128 * 1024;
