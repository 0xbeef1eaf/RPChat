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
export function transpile(code: string, language: ActionLanguage): { js: string; map?: string } {
  const wrapped = `${PRELUDE}${code}\n}`;
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
    return out.map ? { js: out.code, map: out.map } : { js: out.code };
  } catch (err) {
    throw toCompileError(err);
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

function toCompileError(err: unknown): RpError {
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
  const line = Math.max(1, loc.line - PRELUDE_LINES);
  const column = loc.column + 1;
  return new RpError('SANDBOX_COMPILE', `${first.text} (line ${line}, column ${column})`, {
    line,
    column,
    lineText: loc.lineText,
  });
}
