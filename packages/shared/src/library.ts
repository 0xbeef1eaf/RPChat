/**
 * A character's own function library (`sdk.lib`): reusable functions the
 * character defines once and calls as `lib.<name>(...)` from any later action,
 * timer handler or event handler. Stored per character, so it survives sessions
 * and app restarts (docs/spec/core.md, "LibraryService").
 */

/** One stored library function. `source` is a single function expression (arrow or `function`). */
export interface LibFunction {
  /** Identifier the function is called by: `lib.<name>(...)`. */
  name: string;
  /** The function expression as the character wrote it (already plain JavaScript when it came from an action). */
  source: string;
  /** What the function is for, shown in the prompt's `<library>` section. */
  description?: string;
  /** UTF-8 size of `source`. */
  bytes: number;
  /** ISO-8601 time of the last define. */
  updatedAt: string;
}

/** What `sdk.lib.define/list` return: a `LibFunction` without its source. */
export type LibFunctionInfo = Omit<LibFunction, 'source'>;

/** Name rules for library functions: a JavaScript identifier, at most this long. */
export const LIB_NAME_PATTERN = /^[a-zA-Z_$][\w$]*$/;
export const LIB_NAME_MAX_CHARS = 64;
/** Functions per character. */
export const LIB_MAX_FUNCTIONS = 50;
/** UTF-8 bytes per function source. */
export const LIB_MAX_SOURCE_BYTES = 16 * 1024;
/** UTF-8 bytes of all sources of one character together. */
export const LIB_MAX_TOTAL_BYTES = 128 * 1024;
