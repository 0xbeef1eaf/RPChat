/**
 * The character's function library on disk (the `lib` global, `sdk.lib`): the
 * folder `characters/<id>/lib/`, a small TypeScript project the pack author writes
 * (docs/spec/pack.md "Function library").
 *
 * Every `.ts` file in it, sub-folders included, is a module. What a file exports
 * is public: each export lands on `lib` under its own name, documented by its JSDoc
 * (the summary is its `<library>` line, `@internal` hides it from the character).
 * What a file does not export is private to it. Files import each other with
 * relative paths; nothing outside the folder can be imported — `sdk` and `lib` are
 * globals of the run.
 *
 * Loading bundles the folder with esbuild into one expression evaluating to the
 * object of every export, which the host puts in front of each run (`code`).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { build } from 'esbuild';
import type { Message, Metafile, Plugin } from 'esbuild';
import type { CharacterLibrary, LibFunction, LibraryProblem } from '@rp/shared';
import { LIB_DIR_NAME, LIB_FILE_EXTENSION, LIB_MAX_FUNCTIONS, LIB_MAX_TOTAL_BYTES, LIB_NAME_MAX_CHARS, LIB_NAME_PATTERN, RpError } from '@rp/shared';
import { hasExports, scanExports } from './library-source.js';
import { joinRelative, normalizeRelativePath, resolveAssetPath } from './paths.js';
import { writeFileAtomic } from './write-file.js';

/**
 * Names that are JavaScript reserved words, or that would not behave as a plain
 * property of the `lib` object (`__proto__` sets the prototype).
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

/* ------------------------------------------------------------------ paths */

/** Character-relative path of a library file: `lib/<path>`. */
export function libraryFilePath(libPath: string): string {
  return `${LIB_DIR_NAME}/${libPath}`;
}

/** Whether `name` is a library file: a `.ts` file that is not a declaration file. */
function isLibraryFileName(name: string): boolean {
  return name.endsWith(LIB_FILE_EXTENSION) && !name.endsWith('.d.ts');
}

/**
 * `libPath` (relative to `lib/`) in canonical form, or why it cannot be a library file:
 * it must stay inside the folder, end in `.ts` (not `.d.ts`) and have no hidden segment.
 */
export function normalizeLibraryPath(libPath: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof libPath !== 'string') return { ok: false, reason: 'path must be a string' };
  const n = normalizeRelativePath(libPath.trim());
  if (!n.ok) return n;
  if (n.path.split('/').some((seg) => seg.startsWith('.'))) return { ok: false, reason: 'path segments may not start with "."' };
  if (!isLibraryFileName(n.path)) return { ok: false, reason: `a library file ends in ${LIB_FILE_EXTENSION} (and is not a .d.ts)` };
  return n;
}

/* ---------------------------------------------------------------- reading */

export interface CharacterLibraryScan {
  library: CharacterLibrary;
  /**
   * Advisory ceilings exceeded (too many functions, too many bytes in total).
   * The pack still loads, installs and exports; the caller surfaces these as
   * `warning:` lines so the cost stays visible. What is wrong with the code is
   * in `library.problems`, not here.
   */
  warnings: string[];
}

export interface ReadLibraryOptions {
  /**
   * The previous scan of the same folder. When no file changed it is reused as is,
   * which keeps a rescan cheap.
   */
  previous?: CharacterLibrary;
}

/**
 * Reads `<charDir>/lib/**\/*.ts` under `rootAbs` and builds the library. Only
 * regular `.ts` files count (`.d.ts`, dotfiles, hidden folders and symlinks are
 * ignored); a missing folder is an empty library.
 */
export async function readCharacterLibrary(rootAbs: string, charDir: string, options: ReadLibraryOptions = {}): Promise<CharacterLibraryScan> {
  const n = normalizeRelativePath(charDir);
  if (!n.ok) return { library: emptyLibrary(), warnings: [] };
  const libRel = joinRelative(n.path, LIB_DIR_NAME);
  let libAbs: string;
  try {
    libAbs = resolveAssetPath(rootAbs, libRel);
  } catch {
    return { library: emptyLibrary(), warnings: [] };
  }
  const sources: Record<string, string> = {};
  const problems: LibraryProblem[] = [];
  for (const rel of await listLibraryFiles(libAbs)) {
    try {
      sources[rel] = (await fs.readFile(path.join(libAbs, ...rel.split('/')), 'utf8')).replace(/^﻿/, '');
    } catch (err) {
      problems.push({ file: `${libRel}/${rel}`, message: `cannot read the file (${(err as Error).message})` });
    }
  }
  return buildCharacterLibrary(sources, libRel, { ...options, problems });
}

/** Paths relative to `libAbs` of every library file under it, sorted; [] when the folder is missing. */
async function listLibraryFiles(libAbs: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dirAbs: string, prefix: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) await walk(path.join(dirAbs, e.name), `${prefix}${e.name}/`);
      else if (e.isFile() && isLibraryFileName(e.name)) out.push(`${prefix}${e.name}`);
    }
  };
  await walk(libAbs, '');
  return out.sort();
}

/** Virtual root the files are bundled under, and the entry that re-exports the public names. */
const VIRTUAL_LIB = '/lib/';
const VIRTUAL_ENTRY = '/__rp_library_entry__.js';
const NAMESPACE = 'rp-lib';
/** The bundle's global: what the iife assigns the exports object to. */
const GLOBAL_NAME = '__rp_library';

/**
 * Build a library from its files (`sources`: path relative to the `lib/` folder →
 * text). `libRel` is the folder's pack-relative path, which every reported file is
 * given against. A build error (a syntax error, an import that does not resolve)
 * leaves the library without functions; a problem with one export (a default
 * export, a name already taken by another file) only leaves that export out.
 */
export async function buildCharacterLibrary(
  sources: Record<string, string>,
  libRel: string,
  options: ReadLibraryOptions & { problems?: LibraryProblem[] } = {},
): Promise<CharacterLibraryScan> {
  const paths = Object.keys(sources).sort();
  const files: Record<string, string> = {};
  for (const p of paths) files[`${libRel}/${p}`] = sources[p]!;
  const warnings = sizeWarnings(libRel, files);
  const readProblems = options.problems ?? [];

  const previous = options.previous;
  if (previous !== undefined && readProblems.length === 0 && sameFiles(previous.files, files)) {
    return { library: previous, warnings: [...warnings, ...countWarnings(libRel, previous.functions)] };
  }
  if (paths.length === 0) return { library: { ...emptyLibrary(), problems: readProblems }, warnings };

  const toPackPath = (virtualPath: string): string => {
    const bare = virtualPath.startsWith(`${NAMESPACE}:`) ? virtualPath.slice(NAMESPACE.length + 1) : virtualPath;
    return bare.startsWith(VIRTUAL_LIB) ? `${libRel}/${bare.slice(VIRTUAL_LIB.length)}` : libRel;
  };
  const failed = (messages: Message[]): CharacterLibraryScan => ({
    library: { files, functions: {}, code: '', problems: [...readProblems, ...messages.map((m) => toProblem(m, toPackPath, libRel))] },
    warnings,
  });

  // Pass 1: every file as an entry of its own, for the names each one exports (re-exports resolved).
  const virtualFiles = new Map(paths.map((p) => [`${VIRTUAL_LIB}${p}`, sources[p]!]));
  let metafile: Metafile;
  try {
    const result = await build({ ...BUILD_OPTIONS, entryPoints: [...virtualFiles.keys()], format: 'esm', outdir: '/out', metafile: true, plugins: [virtualLibrary(virtualFiles)] });
    metafile = result.metafile!;
  } catch (err) {
    return failed(buildErrors(err));
  }

  const problems: LibraryProblem[] = [...readProblems];
  const imported = new Set<string>();
  for (const input of Object.values(metafile.inputs)) for (const imp of input.imports) imported.add(toPackPath(imp.path));
  const functions: Record<string, LibFunction> = {};
  const owner = new Map<string, string>();
  const byFile = new Map<string, string[]>();
  for (const output of Object.values(metafile.outputs)) {
    if (output.entryPoint === undefined) continue;
    const virtualPath = output.entryPoint.startsWith(`${NAMESPACE}:`) ? output.entryPoint.slice(NAMESPACE.length + 1) : output.entryPoint;
    const file = toPackPath(virtualPath);
    const source = virtualFiles.get(virtualPath) ?? '';
    const shapes = scanExports(source);
    if (output.exports.length === 0 && !hasExports(source) && !imported.has(file)) {
      problems.push({ file, message: 'this file exports nothing and no other file imports it, so it adds nothing to lib: `export` the functions the character calls (`export async function name(…) {…}`)' });
    }
    for (const name of [...output.exports].sort()) {
      if (name === 'default') {
        problems.push({ file, message: '`export default` has no name to call it by: export the function under its name instead (`export async function name(…) {…}`)' });
        continue;
      }
      const nameProblem = libraryNameProblem(name);
      if (nameProblem !== undefined) {
        problems.push({ file, message: `lib.${name} cannot be a library name: ${nameProblem}` });
        continue;
      }
      const first = owner.get(name);
      if (first !== undefined) {
        problems.push({ file, message: `lib.${name} is already exported by ${first}: a name is exported by one file only (import it from there instead of re-exporting it)` });
        continue;
      }
      owner.set(name, file);
      byFile.set(virtualPath, [...(byFile.get(virtualPath) ?? []), name]);
      const shape = shapes.get(name) ?? { kind: 'unknown', params: '' };
      // A constant or a class is still on `lib` (and importable), but it is not a function to list.
      if (shape.kind === 'value') continue;
      const fn: LibFunction = { name, file, params: shape.params };
      if (shape.description !== undefined) fn.description = shape.description;
      if (shape.internal === true) fn.internal = true;
      functions[name] = fn;
    }
  }

  const sorted: Record<string, LibFunction> = {};
  for (const name of Object.keys(functions).sort()) sorted[name] = functions[name]!;
  // Nothing exported: nothing for a run to reach, so no code to put in front of it.
  if (byFile.size === 0) return { library: { files, functions: sorted, code: '', problems }, warnings };

  // Pass 2: one bundle whose entry re-exports every public name, as an expression.
  const entry = [...byFile].map(([virtualPath, names]) => `export { ${names.join(', ')} } from ${JSON.stringify(virtualPath)};`).join('\n');
  virtualFiles.set(VIRTUAL_ENTRY, entry);
  let code: string;
  try {
    const result = await build({ ...BUILD_OPTIONS, entryPoints: [VIRTUAL_ENTRY], format: 'iife', globalName: GLOBAL_NAME, write: false, plugins: [virtualLibrary(virtualFiles)] });
    code = `(() => {\n${result.outputFiles[0]!.text}return ${GLOBAL_NAME};\n})()`;
  } catch (err) {
    return failed(buildErrors(err));
  }

  return { library: { files, functions: sorted, code, problems }, warnings: [...warnings, ...countWarnings(libRel, sorted)] };
}

const BUILD_OPTIONS = {
  bundle: true,
  write: false,
  platform: 'neutral',
  target: 'es2020',
  logLevel: 'silent',
  legalComments: 'none',
  charset: 'utf8',
  tsconfigRaw: {},
} as const;

/**
 * Resolve and load only the files of the library: an import is a relative path from
 * one library file to another (`./dice`, `./dice.ts`, `../games/index`); anything else
 * is refused with the reason.
 */
function virtualLibrary(files: Map<string, string>): Plugin {
  return {
    name: 'rp-library',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point' || args.importer === VIRTUAL_ENTRY) return { path: args.path, namespace: NAMESPACE };
        if (!args.path.startsWith('./') && !args.path.startsWith('../')) {
          return { errors: [{ text: `cannot import "${args.path}": a library file can only import other files of the library, by a relative path ("./${args.path}"); \`sdk\` and \`lib\` are globals, not imports` }] };
        }
        const resolved = path.posix.join(path.posix.dirname(args.importer), args.path);
        const stem = resolved.replace(/\.(js|ts)$/, '');
        for (const candidate of [`${stem}.ts`, `${resolved}/index.ts`, `${stem}/index.ts`]) {
          if (candidate.startsWith(VIRTUAL_LIB) && files.has(candidate)) return { path: candidate, namespace: NAMESPACE };
        }
        const outside = !resolved.startsWith(VIRTUAL_LIB);
        return { errors: [{ text: outside ? `cannot import "${args.path}": it is outside the lib folder` : `cannot import "${args.path}": there is no such file in the lib folder` }] };
      });
      b.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
        const contents = files.get(args.path);
        if (contents === undefined) return { errors: [{ text: `no such library file: ${args.path}` }] };
        return { contents, loader: args.path === VIRTUAL_ENTRY ? 'js' : 'ts', resolveDir: path.posix.dirname(args.path) };
      });
    },
  };
}

function buildErrors(err: unknown): Message[] {
  const errors = (err as { errors?: Message[] } | undefined)?.errors;
  if (errors && errors.length > 0) return errors;
  return [{ id: '', pluginName: '', text: err instanceof Error ? err.message : String(err), location: null, notes: [], detail: undefined }];
}

/** An esbuild message as a problem of the file it points at (the folder itself when it points at none). */
function toProblem(m: Message, toPackPath: (virtualPath: string) => string, libRel: string): LibraryProblem {
  const loc = m.location;
  if (!loc || loc.file.length === 0 || loc.file.endsWith(VIRTUAL_ENTRY)) return { file: libRel, message: m.text };
  return { file: toPackPath(loc.file), line: loc.line, column: loc.column + 1, message: m.text };
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => b[k] === a[k]);
}

function sizeWarnings(libRel: string, files: Record<string, string>): string[] {
  let total = 0;
  for (const text of Object.values(files)) total += Buffer.byteLength(text, 'utf8');
  return total > LIB_MAX_TOTAL_BYTES ? [`${libRel}: ${total} bytes in total (over the advisory ${LIB_MAX_TOTAL_BYTES} bytes); the whole library is evaluated on every run`] : [];
}

function countWarnings(libRel: string, functions: Record<string, LibFunction>): string[] {
  const listed = Object.values(functions).filter((f) => f.internal !== true).length;
  return listed > LIB_MAX_FUNCTIONS ? [`${libRel}: ${listed} public functions (over the advisory ${LIB_MAX_FUNCTIONS}); each one adds a <library> line to every prompt`] : [];
}

function emptyLibrary(): CharacterLibrary {
  return { files: {}, functions: {}, code: '', problems: [] };
}

/* ---------------------------------------------------------------- writing */

/** The absolute path of `<charDir>/lib/<libPath>` under `root`, checked. */
function libraryFileAbs(root: string, charDir: string, libPath: string): string {
  const p = normalizeLibraryPath(libPath);
  if (!p.ok) throw new RpError('INVALID_ARGUMENT', `Invalid library file "${String(libPath)}": ${p.reason}`, { path: libPath });
  const n = normalizeRelativePath(charDir);
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe character directory "${charDir}": ${n.reason}`, { path: charDir });
  return resolveAssetPath(path.resolve(root), joinRelative(n.path, libraryFilePath(p.path)));
}

/**
 * Writes `<charDir>/lib/<libPath>` atomically (temp file + rename), creating its
 * folders. The source is written as given: a broken file is reported by the next
 * read, in `library.problems`. Returns the file path relative to the pack root.
 */
export async function writeLibraryFile(root: string, charDir: string, libPath: string, source: string): Promise<string> {
  const abs = libraryFileAbs(root, charDir, libPath);
  const text = source.endsWith('\n') ? source : `${source}\n`;
  await writeFileAtomic(abs, text);
  return path.relative(path.resolve(root), abs).split(path.sep).join('/');
}

/** Deletes `<charDir>/lib/<libPath>`. Returns whether the file existed. */
export async function removeLibraryFile(root: string, charDir: string, libPath: string): Promise<boolean> {
  const abs = libraryFileAbs(root, charDir, libPath);
  try {
    await fs.rm(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
