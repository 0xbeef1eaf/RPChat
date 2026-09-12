import { transformSync } from 'esbuild';
import type { Message } from 'esbuild';
import type { Json, LibFunction, LibFunctionInfo, Storage } from '@rp/shared';
import { LIB_MAX_FUNCTIONS, LIB_MAX_SOURCE_BYTES, LIB_MAX_TOTAL_BYTES, LIB_NAME_MAX_CHARS, LIB_NAME_PATTERN, RpError } from '@rp/shared';
import { characterScope } from '../handlers/state.js';
import type { Clock } from '../types.js';

/** Key in the character state scope (`char:<packId>/<characterId>`) holding `Record<name, LibFunction>`. */
export const LIB_STATE_KEY = 'lib.functions';
/** The prelude of a character without any library function. */
export const EMPTY_PRELUDE = 'const lib = Object.freeze({});';

/** The character a library belongs to. */
export interface LibraryTarget {
  packId: string;
  characterId: string;
}

/**
 * Names that are JavaScript reserved words, or that would not behave as a plain
 * property of the `lib` object literal (`__proto__` sets the prototype).
 */
const RESERVED_NAMES = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
  'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'arguments', 'eval', '__proto__',
]);

/** `return await (<fn>)(input);` — how the sandbox serialises a function argument (docs/spec/sandbox.md §4). */
const HANDLER_WRAPPER_RE = /^return await \(([\s\S]*)\)\(input\);$/;
/** What a function expression looks like once esbuild has normalised it (a `function` expression keeps its outer parentheses). */
const FUNCTION_EXPRESSION_RE = /^\(?\s*(async\s+)?(function\b|\([\s\S]*?\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

/**
 * The function expression behind what `sdk.lib.define` received: a function
 * argument arrives as the action body that calls it (see the sandbox
 * bootstrap); a string is taken as the expression itself.
 */
export function unwrapFunctionSource(raw: string): string {
  const text = raw.trim();
  const wrapped = HANDLER_WRAPPER_RE.exec(text);
  return (wrapped ? wrapped[1]! : text).trim();
}

/**
 * Check that `source` is exactly one function expression, using esbuild as the
 * parser (character code is never evaluated on the host). Returns the problem,
 * or undefined when the source is fine.
 */
export function functionSourceProblem(source: string): string | undefined {
  if (source.length === 0) return 'fn must be a function';
  let normalised: string;
  try {
    normalised = transformSync(`(${source})`, { loader: 'ts', target: 'es2020', logLevel: 'silent', legalComments: 'none' }).code.trim();
  } catch (err) {
    return `fn does not parse: ${esbuildMessage(err)}`;
  }
  // esbuild ends every statement with `;`. One expression re-wrapped in parentheses still parses;
  // a source that closed our parenthesis and smuggled in more statements no longer does.
  const expression = normalised.endsWith(';') ? normalised.slice(0, -1) : normalised;
  try {
    transformSync(`(${expression})`, { loader: 'js', target: 'es2020', logLevel: 'silent', legalComments: 'none' });
  } catch {
    return 'fn must be a single function expression (arrow function or `async function`)';
  }
  if (!FUNCTION_EXPRESSION_RE.test(expression)) return 'fn must be a function expression (arrow function or `async function`), not a call or a value';
  return undefined;
}

function esbuildMessage(err: unknown): string {
  const errors = (err as { errors?: Message[] } | undefined)?.errors;
  const first = errors?.[0];
  if (first) return first.location ? `${first.text} (line ${first.location.line}, column ${first.location.column + 1})` : first.text;
  return err instanceof Error ? err.message : String(err);
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

function isLibFunction(value: unknown): value is LibFunction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec['name'] === 'string' && typeof rec['source'] === 'string' && typeof rec['updatedAt'] === 'string';
}

/**
 * A character's own function library (`sdk.lib`): functions it defines once and
 * calls as `lib.<name>(...)` in every later action, timer handler and event
 * handler. Stored in the character state scope under `lib.functions`, so it
 * survives sessions and restarts; the prelude that defines `lib` is cached per
 * character and rebuilt after every write.
 */
export class LibraryService {
  private readonly preludes = new Map<string, string>();

  constructor(
    private readonly state: Storage['state'],
    private readonly now: Clock,
  ) {}

  async define(target: LibraryTarget, name: string, fn: string, opts: { description?: string } = {}): Promise<LibFunctionInfo> {
    validateName(name);
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
    const description = typeof opts.description === 'string' ? opts.description.trim() : '';

    const functions = await this.read(target);
    if (!(name in functions) && Object.keys(functions).length >= LIB_MAX_FUNCTIONS) {
      throw new RpError('INVALID_ARGUMENT', `the library already holds ${LIB_MAX_FUNCTIONS} functions; remove one first`, { limit: LIB_MAX_FUNCTIONS });
    }
    const total = Object.values(functions).reduce((n, f) => n + (f.name === name ? 0 : f.bytes), 0) + bytes;
    if (total > LIB_MAX_TOTAL_BYTES) {
      throw new RpError('INVALID_ARGUMENT', `the library would be ${total} bytes; the limit is ${LIB_MAX_TOTAL_BYTES} bytes in total`, { bytes: total, limit: LIB_MAX_TOTAL_BYTES });
    }
    const entry: LibFunction = { name, source, bytes, updatedAt: this.now().toISOString() };
    if (description.length > 0) entry.description = description.slice(0, 200);
    functions[name] = entry;
    await this.write(target, functions);
    return info(entry);
  }

  async remove(target: LibraryTarget, name: string): Promise<boolean> {
    if (typeof name !== 'string' || name.length === 0) throw new RpError('INVALID_ARGUMENT', 'name must be a non-empty string');
    const functions = await this.read(target);
    if (!(name in functions)) return false;
    delete functions[name];
    await this.write(target, functions);
    return true;
  }

  /** The functions without their sources, in definition order. */
  async list(target: LibraryTarget): Promise<LibFunctionInfo[]> {
    return (await this.functions(target)).map(info);
  }

  /** The functions with their sources (for the prompt's `<library>` section). */
  async functions(target: LibraryTarget): Promise<LibFunction[]> {
    return Object.values(await this.read(target));
  }

  async source(target: LibraryTarget, name: string): Promise<string> {
    if (typeof name !== 'string' || name.length === 0) throw new RpError('INVALID_ARGUMENT', 'name must be a non-empty string');
    const f = (await this.read(target))[name];
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

  private async read(target: LibraryTarget): Promise<Record<string, LibFunction>> {
    const raw = await this.state.get(characterScope(target), LIB_STATE_KEY);
    const out: Record<string, LibFunction> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [name, value] of Object.entries(raw)) {
      if (isLibFunction(value) && LIB_NAME_PATTERN.test(name)) out[name] = { ...(value as LibFunction), name };
    }
    return out;
  }

  private async write(target: LibraryTarget, functions: Record<string, LibFunction>): Promise<void> {
    this.invalidate(target);
    if (Object.keys(functions).length === 0) await this.state.delete(characterScope(target), LIB_STATE_KEY);
    else await this.state.set(characterScope(target), LIB_STATE_KEY, functions as unknown as Json);
  }
}

function cacheKey(target: LibraryTarget): string {
  return `${target.packId}/${target.characterId}`;
}

function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) throw new RpError('INVALID_ARGUMENT', 'name must be a non-empty string');
  if (name.length > LIB_NAME_MAX_CHARS) throw new RpError('INVALID_ARGUMENT', `name must be at most ${LIB_NAME_MAX_CHARS} characters`, { limit: LIB_NAME_MAX_CHARS });
  if (!LIB_NAME_PATTERN.test(name)) throw new RpError('INVALID_ARGUMENT', 'name must be a JavaScript identifier (letters, digits, _ and $, not starting with a digit)');
  if (RESERVED_NAMES.has(name)) throw new RpError('INVALID_ARGUMENT', `"${name}" is a reserved word and cannot be a function name`);
}
