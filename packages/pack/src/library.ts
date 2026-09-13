/**
 * The character's function library on disk (`sdk.lib`): one file per function,
 * `characters/<id>/lib/<name>.ts`, holding an optional first-line `// <description>`
 * comment followed by exactly one function expression, verbatim as
 * `sdk.lib.define` received it. Pack authors ship functions here; what a
 * character defines itself is written here too (docs/spec/pack.md "Function library").
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import type { Message } from 'esbuild';
import type { CharacterLibraryEntry } from '@rp/shared';
import {
  LIB_DIR_NAME,
  LIB_FILE_EXTENSION,
  LIB_MAX_FUNCTIONS,
  LIB_MAX_SOURCE_BYTES,
  LIB_MAX_TOTAL_BYTES,
  LIB_NAME_MAX_CHARS,
  LIB_NAME_PATTERN,
  RpError,
} from '@rp/shared';
import { joinRelative, normalizeRelativePath, resolveAssetPath } from './paths.js';
import { writeFileAtomic } from './write-file.js';

/**
 * Names that are JavaScript reserved words, or that would not behave as a plain
 * property of the `lib` object literal (`__proto__` sets the prototype).
 */
export const LIB_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
  'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'arguments', 'eval', '__proto__',
]);

/** Why `name` cannot name a library function, or undefined when it can. */
export function libraryNameProblem(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return 'name must be a non-empty string';
  if (name.length > LIB_NAME_MAX_CHARS) return `name must be at most ${LIB_NAME_MAX_CHARS} characters`;
  if (!LIB_NAME_PATTERN.test(name)) return 'name must be a JavaScript identifier (letters, digits, _ and $, not starting with a digit)';
  if (LIB_RESERVED_NAMES.has(name)) return `"${name}" is a reserved word and cannot be a function name`;
  return undefined;
}

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

/* ------------------------------------------------------------ file format */

/** Character-relative path of a library file: `lib/<name>.ts`. */
export function libraryFilePath(name: string): string {
  return `${LIB_DIR_NAME}/${name}${LIB_FILE_EXTENSION}`;
}

/**
 * Split a library file into its description (the first line when it is a `//`
 * comment) and the function source (the rest, trimmed).
 */
export function parseLibraryFile(text: string): { source: string; description?: string } {
  const normalised = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const firstBreak = normalised.indexOf('\n');
  const firstLine = (firstBreak < 0 ? normalised : normalised.slice(0, firstBreak)).trim();
  if (firstLine.startsWith('//')) {
    const description = firstLine.slice(2).trim();
    const rest = firstBreak < 0 ? '' : normalised.slice(firstBreak + 1);
    const out: { source: string; description?: string } = { source: rest.trim() };
    if (description.length > 0) out.description = description;
    return out;
  }
  return { source: normalised.trim() };
}

/** Render a library file: `// <description>` (when given) then the function source, newline-terminated. */
export function formatLibraryFile(source: string, description?: string): string {
  const body = source.trim();
  const head = description !== undefined && description.trim().length > 0 ? `// ${description.trim().replace(/\s*\n\s*/g, ' ')}\n` : '';
  return `${head}${body}\n`;
}

/* ---------------------------------------------------------------- reading */

/** A library file the loader could not use, with what it holds so an editor can show it. */
export interface LibraryFileProblem {
  /** Path relative to the pack root. */
  file: string;
  /** File stem (what the name would be). */
  name: string;
  message: string;
  source?: string;
  description?: string;
}

export interface CharacterLibraryScan {
  /** Usable functions, sorted by name. */
  library: Record<string, CharacterLibraryEntry>;
  /** Files skipped with the reason: the pack still loads, the function is left out. */
  skipped: LibraryFileProblem[];
  /** Cap violations (too many files, one too large, all together too large): the pack does not load. */
  problems: string[];
}

export interface ReadLibraryOptions {
  /**
   * The previous scan of the same folder. A file whose source text is unchanged is taken
   * from it without re-parsing, which keeps a rescan after every `sdk.lib.define` cheap.
   */
  previous?: Record<string, CharacterLibraryEntry>;
}

/**
 * Reads `<charDir>/lib/*.ts` under `rootAbs`. Only regular `.ts` files count;
 * anything else in the folder (a README, sub-folders, dotfiles) is ignored.
 * A file whose stem is not a valid name or whose body is not a single
 * function expression lands in `skipped` with the reason; the size caps
 * (`LIB_MAX_FUNCTIONS`, `LIB_MAX_SOURCE_BYTES`, `LIB_MAX_TOTAL_BYTES`) are
 * reported in `problems`.
 */
export async function readCharacterLibrary(rootAbs: string, charDir: string, options: ReadLibraryOptions = {}): Promise<CharacterLibraryScan> {
  const out: CharacterLibraryScan = { library: {}, skipped: [], problems: [] };
  const n = normalizeRelativePath(charDir);
  if (!n.ok) return out;
  const libRel = joinRelative(n.path, LIB_DIR_NAME);
  let libAbs: string;
  try {
    libAbs = resolveAssetPath(rootAbs, libRel);
  } catch {
    return out;
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(libAbs, { withFileTypes: true });
  } catch {
    return out; // no lib/ folder: an empty library
  }
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.endsWith(LIB_FILE_EXTENSION))
    .map((e) => e.name)
    .sort();
  if (files.length > LIB_MAX_FUNCTIONS) {
    out.problems.push(`${libRel}: ${files.length} functions (max ${LIB_MAX_FUNCTIONS})`);
  }
  let total = 0;
  for (const fileName of files) {
    const name = fileName.slice(0, -LIB_FILE_EXTENSION.length);
    const file = `${libRel}/${fileName}`;
    const abs = path.join(libAbs, fileName);
    const nameProblem = libraryNameProblem(name);
    if (nameProblem !== undefined) {
      out.skipped.push({ file, name, message: `file name is not a valid function name: ${nameProblem}` });
      continue;
    }
    let text: string;
    let st: import('node:fs').Stats;
    try {
      [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
    } catch (err) {
      out.skipped.push({ file, name, message: `cannot read file (${(err as Error).message})` });
      continue;
    }
    const parsed = parseLibraryFile(text);
    const bytes = Buffer.byteLength(parsed.source, 'utf8');
    if (bytes > LIB_MAX_SOURCE_BYTES) {
      out.problems.push(`${file}: ${bytes} bytes (max ${LIB_MAX_SOURCE_BYTES} bytes per function)`);
    }
    const known = options.previous?.[name];
    const problem = known !== undefined && known.source === parsed.source ? undefined : functionSourceProblem(parsed.source);
    if (problem !== undefined) {
      const skipped: LibraryFileProblem = { file, name, message: `not a single function expression: ${problem}`, source: parsed.source };
      if (parsed.description !== undefined) skipped.description = parsed.description;
      out.skipped.push(skipped);
      continue;
    }
    total += bytes;
    const entry: CharacterLibraryEntry = { source: parsed.source, bytes, file, updatedAt: st.mtime.toISOString() };
    if (parsed.description !== undefined) entry.description = parsed.description;
    out.library[name] = entry;
  }
  if (total > LIB_MAX_TOTAL_BYTES) {
    out.problems.push(`${libRel}: ${total} bytes in total (max ${LIB_MAX_TOTAL_BYTES} bytes)`);
  }
  return out;
}

/* ---------------------------------------------------------------- writing */

/**
 * Writes `<charDir>/lib/<name>.ts` atomically (temp file + rename). Validates
 * the name; the source is written as given (callers validate it with
 * {@link functionSourceProblem} when a broken file must not land on disk).
 * Returns the file path relative to the pack root.
 */
export async function writeLibraryFunction(root: string, charDir: string, name: string, source: string, description?: string): Promise<string> {
  const rootAbs = path.resolve(root);
  const nameProblem = libraryNameProblem(name);
  if (nameProblem !== undefined) throw new RpError('INVALID_ARGUMENT', nameProblem, { name });
  const n = normalizeRelativePath(charDir);
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe character directory "${charDir}": ${n.reason}`, { path: charDir });
  const rel = joinRelative(n.path, libraryFilePath(name));
  const abs = resolveAssetPath(rootAbs, rel);
  await writeFileAtomic(abs, formatLibraryFile(source, description));
  return rel;
}

/** Deletes `<charDir>/lib/<name>.ts`. Returns whether the file existed. */
export async function removeLibraryFunction(root: string, charDir: string, name: string): Promise<boolean> {
  const rootAbs = path.resolve(root);
  const nameProblem = libraryNameProblem(name);
  if (nameProblem !== undefined) throw new RpError('INVALID_ARGUMENT', nameProblem, { name });
  const n = normalizeRelativePath(charDir);
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe character directory "${charDir}": ${n.reason}`, { path: charDir });
  const abs = resolveAssetPath(rootAbs, joinRelative(n.path, libraryFilePath(name)));
  try {
    await fs.rm(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
