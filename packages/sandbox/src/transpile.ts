import { transformSync } from 'esbuild';
import type { Message } from 'esbuild';
import { RpError } from '@rp/shared';
import type { ActionLanguage } from '@rp/shared';

/** Name of the async function the user's code is wrapped into. */
export const ENTRY_FUNCTION_NAME = '__rp_main';

/**
 * First line of the wrapper. The user's code starts on line 2, so esbuild line
 * numbers are shifted by one when reported.
 */
const PRELUDE = `async function ${ENTRY_FUNCTION_NAME}() { "use strict";\n`;
/** Lines the wrapper adds before the model's first line (used to map positions back). */
export const PRELUDE_LINES = 1;
/** Lines `wrapAsAsyncFunctionBody` adds before the transpiled code. */
export const ASYNC_WRAPPER_LINES = 1;

export interface TranspileOptions {
  /**
   * Source placed between the wrapper's first line and the user's code (plus a
   * newline), inside the same async function: the character's function library
   * (`CodeRunRequest.prelude`). Its lines are counted in `preludeLines` so that
   * positions can still be reported against the user's own code.
   */
  prelude?: string;
}

export interface Transpiled {
  js: string;
  /** esbuild's source map (JSON). */
  map?: string;
  /** Lines the prelude occupies in front of the user's code (0 without one). */
  preludeLines: number;
}

/** Number of lines a prelude occupies once its trailing newline is added. */
export function countPreludeLines(prelude: string | undefined): number {
  if (prelude === undefined || prelude.length === 0) return 0;
  return prelude.split('\n').length;
}

/**
 * Transpile the body of an async function (TypeScript or JavaScript) to plain
 * ES2020 JavaScript. The result declares `async function __rp_main() { ... }`
 * (preceded by any esbuild helper definitions); it does not invoke it.
 *
 * `map` is esbuild's source map: the runner uses it to report failures against
 * the code the model wrote instead of the reformatted output.
 *
 * @throws RpError('SANDBOX_COMPILE') with `details: { line, column, lineText? }`
 *   (1-based, relative to the user's code) on syntax errors.
 */
export function transpile(code: string, language: ActionLanguage, options: TranspileOptions = {}): Transpiled {
  const preludeLines = countPreludeLines(options.prelude);
  const preludeText = preludeLines > 0 ? `${options.prelude}\n` : '';
  const wrapped = `${PRELUDE}${preludeText}${code}\n}`;
  try {
    const out = transformSync(wrapped, {
      loader: language === 'ts' ? 'ts' : 'js',
      target: 'es2020',
      charset: 'utf8',
      legalComments: 'none',
      logLevel: 'silent',
      sourcefile: 'action.ts',
      sourcemap: true,
    });
    return out.map ? { js: out.code, map: out.map, preludeLines } : { js: out.code, preludeLines };
  } catch (err) {
    throw toCompileError(err, preludeLines);
  }
}

/**
 * Wrap already-transpiled JavaScript as an immediately-invoked async arrow so
 * that top-level `return` and `await` are valid.
 */
export function wrapAsAsyncFunctionBody(js: string): string {
  return `(async () => {\n${js}\n})()`;
}

interface EsbuildFailure {
  errors?: Message[];
}

function toCompileError(err: unknown, preludeLines: number): RpError {
  if (err instanceof RpError) return err;
  const failure = err as EsbuildFailure | undefined;
  const first = failure?.errors?.[0];
  if (!first) {
    return new RpError('SANDBOX_COMPILE', err instanceof Error ? err.message : String(err), undefined, {
      cause: err,
    });
  }
  const loc = first.location;
  if (!loc) {
    return new RpError('SANDBOX_COMPILE', first.text, { errors: failure?.errors?.map((e) => e.text) });
  }
  const column = loc.column + 1;
  const inSource = loc.line - PRELUDE_LINES; // 1-based line in prelude + user code
  if (preludeLines > 0 && inSource >= 1 && inSource <= preludeLines) {
    // The library, not the code the model just wrote: say so instead of pointing at its lines.
    return new RpError(
      'SANDBOX_COMPILE',
      `syntax error in your function library, not in this action: ${first.text} (library line ${inSource}, column ${column}); fix or remove the function with sdk.lib`,
      { library: true, libraryLine: inSource, libraryColumn: column, lineText: loc.lineText },
    );
  }
  const line = Math.max(1, inSource - preludeLines);
  return new RpError('SANDBOX_COMPILE', `${first.text} (line ${line}, column ${column})`, {
    line,
    column,
    lineText: loc.lineText,
  });
}
