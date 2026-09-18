/**
 * The character's function library on disk (the `lib` global, `sdk.lib`): one file
 * per function, `characters/<id>/lib/<name>.ts`, holding an optional first-line
 * `// <description>` comment followed by the function the character calls — a bare
 * function expression, or a module with helpers of its own and exactly one export
 * (`library-source.ts`) — verbatim as `lib.register` received it. Pack authors ship
 * functions here; what a character registers itself is written here too
 * (docs/spec/pack.md "Function library").
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CharacterLibraryEntry } from '@rp/shared';
import {
  LIB_DIR_NAME,
  LIB_INTERNAL_MARKER,
  LIB_FILE_EXTENSION,
  LIB_MAX_FUNCTIONS,
  LIB_MAX_TOTAL_BYTES,
  LIB_NAME_MAX_CHARS,
  LIB_NAME_PATTERN,
  RpError,
} from '@rp/shared';
import { functionSourceProblem, isLibraryModule } from './library-source.js';
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

/**
 * Members of the `lib` object itself (`lib.register(...)` / `lib.unregister(...)`,
 * added by the sandbox bootstrap): a saved function cannot take one of those names,
 * or it would be unreachable behind the method.
 */
export const LIB_STATIC_NAMES: ReadonlySet<string> = new Set(['register', 'unregister']);

/** Why `name` cannot name a library function, or undefined when it can. */
export function libraryNameProblem(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return 'name must be a non-empty string';
  if (name.length > LIB_NAME_MAX_CHARS) return `name must be at most ${LIB_NAME_MAX_CHARS} characters`;
  if (!LIB_NAME_PATTERN.test(name)) return 'name must be a JavaScript identifier (letters, digits, _ and $, not starting with a digit)';
  if (LIB_RESERVED_NAMES.has(name)) return `"${name}" is a reserved word and cannot be a function name`;
  if (LIB_STATIC_NAMES.has(name)) return `"${name}" is a method of the library itself (lib.${name}); choose another name`;
  return undefined;
}

/* ------------------------------------------------------------ file format */

/** Character-relative path of a library file: `lib/<name>.ts`. */
export function libraryFilePath(name: string): string {
  return `${LIB_DIR_NAME}/${name}${LIB_FILE_EXTENSION}`;
}

/**
 * Split a library file into its description and the function source (the rest,
 * trimmed). The first line, when it is a `//` comment, is the description; when
 * it opens with `@internal` the function is the author's helper and the rest of
 * that line is its description (docs/spec/pack.md "Function library").
 */
export function parseLibraryFile(text: string): { source: string; description?: string; internal?: boolean } {
  const normalised = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const firstBreak = normalised.indexOf('\n');
  const firstLine = (firstBreak < 0 ? normalised : normalised.slice(0, firstBreak)).trim();
  if (firstLine.startsWith('//')) {
    let description = firstLine.slice(2).trim();
    let internal = false;
    if (description === LIB_INTERNAL_MARKER || description.startsWith(`${LIB_INTERNAL_MARKER} `)) {
      internal = true;
      description = description.slice(LIB_INTERNAL_MARKER.length).trim();
    }
    const rest = firstBreak < 0 ? '' : normalised.slice(firstBreak + 1);
    const out: { source: string; description?: string; internal?: boolean } = { source: rest.trim() };
    if (description.length > 0) out.description = description;
    if (internal) out.internal = true;
    return out;
  }
  return { source: normalised.trim() };
}

/**
 * Render a library file: the first line `// <description>` (when given, prefixed
 * with `@internal` for an author's helper), then the function source, newline-terminated.
 */
export function formatLibraryFile(source: string, description?: string, internal = false): string {
  const body = source.trim();
  const text = description !== undefined ? description.trim().replace(/\s*\n\s*/g, ' ') : '';
  const comment = internal ? `${LIB_INTERNAL_MARKER}${text.length > 0 ? ` ${text}` : ''}` : text;
  const head = comment.length > 0 ? `// ${comment}\n` : '';
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
  /** From a `// @internal` first line, so the editor shows a broken helper as one. */
  internal?: boolean;
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
   * from it without re-parsing, which keeps a rescan after every `lib.register` cheap.
   */
  previous?: Record<string, CharacterLibraryEntry>;
}

/**
 * Reads `<charDir>/lib/*.ts` under `rootAbs`. Only regular `.ts` files count;
 * anything else in the folder (a README, sub-folders, dotfiles) is ignored.
 * A file whose stem is not a valid name or whose body is not a single
 * function expression lands in `skipped` with the reason; the caps
 * (`LIB_MAX_FUNCTIONS`, `LIB_MAX_TOTAL_BYTES`) are reported in `problems`.
 * A single file has no size cap of its own.
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
    const known = options.previous?.[name];
    const problem = known !== undefined && known.source === parsed.source ? undefined : functionSourceProblem(parsed.source);
    if (problem !== undefined) {
      const shape = isLibraryModule(parsed.source) ? 'not one exported function' : 'not a single function expression';
      const skipped: LibraryFileProblem = { file, name, message: `${shape}: ${problem}`, source: parsed.source };
      if (parsed.description !== undefined) skipped.description = parsed.description;
      if (parsed.internal === true) skipped.internal = true;
      out.skipped.push(skipped);
      continue;
    }
    total += bytes;
    const entry: CharacterLibraryEntry = { source: parsed.source, bytes, file, updatedAt: st.mtime.toISOString() };
    if (parsed.description !== undefined) entry.description = parsed.description;
    if (parsed.internal === true) entry.internal = true;
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
export async function writeLibraryFunction(root: string, charDir: string, name: string, source: string, description?: string, internal = false): Promise<string> {
  const rootAbs = path.resolve(root);
  const nameProblem = libraryNameProblem(name);
  if (nameProblem !== undefined) throw new RpError('INVALID_ARGUMENT', nameProblem, { name });
  const n = normalizeRelativePath(charDir);
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe character directory "${charDir}": ${n.reason}`, { path: charDir });
  const rel = joinRelative(n.path, libraryFilePath(name));
  const abs = resolveAssetPath(rootAbs, rel);
  await writeFileAtomic(abs, formatLibraryFile(source, description, internal));
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
