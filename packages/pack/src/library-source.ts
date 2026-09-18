/**
 * What a library function's source may look like (`characters/<id>/lib/<name>.ts`,
 * and the `fn` of `lib.register`), and how it becomes the value the prelude puts
 * on the `lib` object.
 *
 * Two shapes, both holding exactly one function for the character to call:
 *
 * - **a bare function expression** — the original format, the whole file is the
 *   function (`async (mood: string) => { … }`);
 * - **a module** — helpers, constants and types of the file's own, with exactly
 *   one `export`: the function the character calls. Everything else in the file
 *   is private to it, so a long function can be broken up without spending a
 *   library name (and a `<library>` line) on each piece.
 *
 * The file is kept verbatim: the module's statements reach the prelude as the
 * author wrote them, with its `export` marker rewritten away and a `return` added
 * (`libraryValueExpression`).
 */
import { transformSync } from 'esbuild';
import type { Message } from 'esbuild';

/** `return await (<fn>)(input);` — how the sandbox serialises a function argument (docs/spec/sandbox.md §4). */
const HANDLER_WRAPPER_RE = /^return await \(([\s\S]*)\)\(input\);$/;
/** What a function expression looks like: `function …`, `(a, b) => …` or `x => …`, optionally `async` and parenthesised. */
const FUNCTION_EXPRESSION_RE = /^\(?\s*(async\s+)?(function\b|\([\s\S]*?\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
/** Local name a `export default <expression>` is given in the prelude (a declaration keeps its own name). */
const DEFAULT_LOCAL = '__rp_default';
/** The forms a library module may export, for the messages that list them. */
const EXPORT_FORMS = '`export default <function>`, `export const <name> = <function>` or `export function <name>() {…}`';
/** What to do with a source that is good code but more than one function. */
const MORE_THAN_ONE = `the source is more than one statement: export the function to call (${EXPORT_FORMS}) and leave the rest of the file as its helpers`;

/**
 * The function expression behind what `lib.register` received: a function
 * argument arrives as the action body that calls it (see the sandbox
 * bootstrap); a string is taken as the source itself.
 */
export function unwrapFunctionSource(raw: string): string {
  const text = raw.trim();
  const wrapped = HANDLER_WRAPPER_RE.exec(text);
  return (wrapped ? wrapped[1]! : text).trim();
}

/**
 * `source` with the comments in front of the function removed, so a `// note`
 * line above it does not stand in for the `async` behind it. Only the head is
 * scanned, where `//` and `/*` can only open a comment; comments further in
 * (inside the parameter list, in the body) are left alone. A source that is
 * nothing but comments gives an empty string.
 */
export function stripLeadingComments(source: string): string {
  let i = 0;
  for (;;) {
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      if (end < 0) return '';
      i = end + 1;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return '';
      i = end + 2;
    } else {
      return source.slice(i);
    }
  }
}

/* ------------------------------------------------------------- the shapes */

/** A library file that is a module: its statements, and the name its one export ends up under. */
export interface LibraryModule {
  /** The file with its `export` keywords rewritten away — statements to run before the function is handed over. */
  body: string;
  /** The name the exported function has in `body` once that rewrite is done. */
  returns: string;
}

/** A library source that holds one function, and how it is written. */
export interface LibraryFunctionShape {
  /** The exported function itself: the whole source when it is a bare expression. */
  fn: string;
  /** Set when the source is a module (helpers plus one export); absent for a bare function expression. */
  module?: LibraryModule;
}

/** Why a source cannot be a library function, and whether it was read as a module. */
interface ShapeProblem {
  problem: string;
  module: boolean;
}

/**
 * The shape of `source`, or the reason it has none. Textual only — no parser
 * runs here, so the prelude can be rebuilt cheaply; {@link functionSourceProblem}
 * is what puts the source through esbuild.
 */
export function libraryFunctionShape(source: string): LibraryFunctionShape | ShapeProblem {
  const text = source.trim();
  const keywords = moduleKeywords(text);
  if (keywords.imports.length > 0) {
    return { module: true, problem: 'a library function cannot `import` anything: keep what it needs in the same file, or reach for it through `sdk` and `lib`' };
  }
  if (keywords.exports.length === 0) return { fn: text };

  const drop: Array<{ start: number; end: number; text: string }> = [];
  let exported: { returns: string; fn: string } | undefined;
  for (const start of keywords.exports) {
    const after = skipSpace(text, start + 'export'.length);
    const word = identifierAt(text, after);
    // `export type X = …` / `export interface X {}` are erased with the types; they are not the function.
    if (word === 'type' || word === 'interface') {
      drop.push({ start, end: after, text: '' });
      continue;
    }
    if (exported !== undefined) {
      return { module: true, problem: 'the file exports more than one thing: export only the function the character calls, and leave its helpers unexported' };
    }
    const declared = word === 'default' ? defaultExport(text, after) : namedExport(text, after, word);
    if ('problem' in declared) return declared;
    drop.push({ start, end: declared.from, text: declared.replacement });
    exported = { returns: declared.returns, fn: sliceStatement(text, declared.fnFrom) };
  }
  if (exported === undefined) {
    return { module: true, problem: `the file exports no function: mark the one the character calls with ${EXPORT_FORMS}` };
  }
  if (!FUNCTION_EXPRESSION_RE.test(stripLeadingComments(exported.fn))) {
    return { module: true, problem: 'the export must be a function (an arrow function or `function`), not a call or a value' };
  }
  return { fn: exported.fn, module: { body: applyRewrites(text, drop), returns: exported.returns } };
}

/** How one `export` is rewritten: `[start, from)` becomes `replacement`, and the function itself starts at `fnFrom`. */
interface ExportedFunction {
  from: number;
  fnFrom: number;
  replacement: string;
  returns: string;
}

/** `export default …`: a named function declaration keeps its name, anything else is bound to {@link DEFAULT_LOCAL}. */
function defaultExport(text: string, after: number): ExportedFunction | ShapeProblem {
  const from = skipSpace(text, after + 'default'.length);
  const declaration = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text.slice(from));
  // `export default function cheer() {}` binds `cheer` in the file too, so keep it a declaration.
  if (declaration) return { from, fnFrom: from, replacement: '', returns: declaration[1]! };
  return { from, fnFrom: from, replacement: `var ${DEFAULT_LOCAL} = `, returns: DEFAULT_LOCAL };
}

/** `export function f() {}` / `export const f = …`: the `export` keyword goes, the declaration stays. */
function namedExport(text: string, after: number, word: string): ExportedFunction | ShapeProblem {
  const rest = text.slice(after);
  if (word === 'function' || word === 'async') {
    const declaration = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(rest);
    if (declaration) return { from: after, fnFrom: after, replacement: '', returns: declaration[1]! };
  }
  if (word === 'const' || word === 'let' || word === 'var') {
    // The function is what stands after the `=`; the declaration around it is the file's, not the character's.
    const declaration = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(rest);
    if (declaration) return { from: after, fnFrom: skipSpace(text, after + declaration[0]!.length), replacement: '', returns: declaration[1]! };
  }
  return { module: true, problem: `this export is not a function the character can call; write ${EXPORT_FORMS}` };
}

/** `text` with each rewrite applied (they are found left to right and never overlap). */
function applyRewrites(text: string, rewrites: Array<{ start: number; end: number; text: string }>): string {
  let out = '';
  let at = 0;
  for (const r of rewrites) {
    out += text.slice(at, r.start) + r.text;
    at = r.end;
  }
  return out + text.slice(at);
}

/* -------------------------------------------------------------- the checks */

/**
 * Check that `source` holds exactly one function for the character to call,
 * using esbuild as the parser (character code is never evaluated on the host).
 * Returns the problem, or undefined when the source is fine.
 */
export function functionSourceProblem(source: string): string | undefined {
  const text = source.trim();
  if (text.length === 0) return 'fn must be a function';
  const shape = libraryFunctionShape(text);
  if ('problem' in shape) return shape.problem;
  if (shape.module !== undefined) return moduleParseProblem(text) ?? preludeProblem(shape.module);
  return expressionProblem(text);
}

/**
 * The rewritten module, compiled the way the prelude will run it: inside a
 * function, where a top-level `await` and anything else that only a module may
 * do are errors. It is also what keeps the textual rewrite honest — an `export`
 * the scanner missed, or a statement it cut through, does not parse here.
 *
 * The wrapper opens on the body's own first line, so the line numbers esbuild
 * reports are still the file's.
 */
function preludeProblem(module: LibraryModule): string | undefined {
  try {
    transformSync(`(() => {${module.body}\n;return ${module.returns};\n})`, { loader: 'ts', target: 'es2020', logLevel: 'silent', legalComments: 'none' });
  } catch (err) {
    return `the file cannot run as a library function: ${esbuildMessage(err)}`;
  }
  return undefined;
}

/** A module file: esbuild parses it as one, so its own line numbers are what a syntax error names. */
function moduleParseProblem(source: string): string | undefined {
  try {
    transformSync(source, { loader: 'ts', target: 'es2020', logLevel: 'silent', legalComments: 'none' });
  } catch (err) {
    return `the file does not parse: ${esbuildMessage(err)}`;
  }
  return undefined;
}

/** A bare function expression: it must be one expression, and a function. */
function expressionProblem(source: string): string | undefined {
  let normalised: string;
  try {
    // `minifyWhitespace` drops every comment: esbuild otherwise hoists the ones in front of the
    // function to the top of its output, where they would hide the function from the shape check below.
    normalised = transformSync(`(${source})`, { loader: 'ts', target: 'es2020', logLevel: 'silent', legalComments: 'none', minifyWhitespace: true }).code.trim();
  } catch (err) {
    // Several statements with no export — helpers around a function, say — is the other format written
    // without its `export`, so say that rather than pointing at the parenthesis the check put in front.
    // A source that is nothing but comments parses as a module too, and is not that case.
    const code = stripLeadingComments(source).trim().length > 0;
    return code && moduleParseProblem(source) === undefined ? MORE_THAN_ONE : `fn does not parse: ${esbuildMessage(err)}`;
  }
  // esbuild ends every statement with `;`. One expression re-wrapped in parentheses still parses;
  // a source that closed our parenthesis and smuggled in more statements no longer does.
  const expression = normalised.endsWith(';') ? normalised.slice(0, -1) : normalised;
  try {
    transformSync(`(${expression})`, { loader: 'js', target: 'es2020', logLevel: 'silent', legalComments: 'none' });
  } catch {
    if (moduleParseProblem(source) === undefined) return MORE_THAN_ONE;
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

/* ------------------------------------------------------- what the run sees */

/**
 * The value the prelude puts on the `lib` object for this source: the function
 * expression in parentheses, or — for a module — an arrow that runs the file's
 * statements once and hands back the exported function. Nothing in that arrow
 * is named `lib`, so no binding of the run is shadowed (and none is renamed by
 * the transpiler, which used to travel into stored handler sources).
 *
 * A source that has no shape at all is passed through in parentheses: the
 * loader and `lib.register` refuse those long before a prelude is built.
 */
export function libraryValueExpression(source: string): string {
  const shape = libraryFunctionShape(source);
  if ('problem' in shape || shape.module === undefined) return `(${source.trim()})`;
  return `(() => {\n${shape.module.body}\n;return ${shape.module.returns};\n})()`;
}

/**
 * Whether `source` is written as a module — helpers of its own plus one export —
 * rather than as a bare function expression. True for a module that does not hold
 * up as one, so a file can be reported against the format it was written in.
 */
export function isLibraryModule(source: string): boolean {
  const shape = libraryFunctionShape(source);
  return 'problem' in shape ? shape.module : shape.module !== undefined;
}

/**
 * The exported function's own source — for a module, the file without its
 * helpers, which is the part a signature is read from (`functionParams`) and
 * the part the sandbox reports as `String(lib.<name>)`.
 */
export function exportedFunctionSource(source: string): string {
  const shape = libraryFunctionShape(source);
  return 'problem' in shape ? source.trim() : shape.fn;
}

/* ------------------------------------------------------------- the scanner */

/** Characters that may appear in an identifier. */
const IDENT_CHAR = /[A-Za-z0-9_$]/;
/** After one of these, a `/` opens a regular expression rather than dividing. */
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** The punctuation `walkCode` reports alongside identifiers. */
const PUNCTUATION = '()[]{};';

/** One piece of real code: an identifier, or one of {@link PUNCTUATION}. */
interface CodeToken {
  text: string;
  start: number;
  /** The last significant character before it (`.` in `a.export`, '' at the very start). */
  prevChar: string;
  /** Bracket depth of the region it sits in; the two halves of a pair report the same depth. */
  depth: number;
}

/**
 * Walk `source` from `from`, calling `visit` for every identifier and every
 * bracket or `;` that is real code: comments, strings and regular expressions
 * are skipped, and a template literal is skipped but for the code inside its
 * `${…}` parts. `visit` returning true ends the walk.
 */
function walkCode(source: string, from: number, visit: (token: CodeToken) => boolean | void): void {
  /** Innermost last: a code region counting its brackets, or a template waiting for its backtick. */
  const modes: Array<{ template: boolean; depth: number }> = [{ template: false, depth: 0 }];
  let prevChar = '';
  let prevWord = '';
  let i = from;
  while (i < source.length) {
    const mode = modes[modes.length - 1]!;
    const ch = source[i]!;
    if (mode.template) {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        modes.pop();
        prevChar = '`';
        prevWord = '';
        i += 1;
      } else if (ch === '$' && source[i + 1] === '{') {
        modes.push({ template: false, depth: 0 });
        prevChar = '{';
        prevWord = '';
        i += 2;
      } else i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      prevChar = ch;
      prevWord = '';
      continue;
    }
    if (ch === '`') {
      modes.push({ template: true, depth: 0 });
      i += 1;
      continue;
    }
    if (ch === '/' && opensRegex(prevChar, prevWord)) {
      i = skipRegex(source, i);
      prevChar = '/';
      prevWord = '';
      continue;
    }
    if (IDENT_CHAR.test(ch)) {
      let end = i + 1;
      while (end < source.length && IDENT_CHAR.test(source[end]!)) end += 1;
      const word = source.slice(i, end);
      if (visit({ text: word, start: i, prevChar, depth: mode.depth }) === true) return;
      prevChar = source[end - 1]!;
      prevWord = word;
      i = end;
      continue;
    }
    if (PUNCTUATION.includes(ch)) {
      // `}` either closes a bracket of this region or ends the `${…}` that opened it.
      if (ch === '}' && mode.depth === 0 && modes.length > 1) {
        modes.pop();
        prevChar = '`';
        prevWord = '';
        i += 1;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') mode.depth -= 1;
      if (visit({ text: ch, start: i, prevChar, depth: mode.depth }) === true) return;
      if (ch === '(' || ch === '[' || ch === '{') mode.depth += 1;
    }
    if (!/\s/.test(ch)) {
      prevChar = ch;
      prevWord = '';
    }
    i += 1;
  }
}

/**
 * Where the `export` and `import` keywords are in `source`. Both are only valid
 * at the top level of a module, so an occurrence the scanner reports is the real
 * thing and not, say, a property name (`a.export`, `{ export: 1 }`) — while
 * comments, strings, template literals and regular expressions are skipped,
 * since the word is ordinary text in there.
 *
 * A miss is not silent: the rewritten body goes through esbuild before the
 * source is accepted (`preludeProblem`), and an `export` left in it is a syntax
 * error there.
 */
function moduleKeywords(source: string): { exports: number[]; imports: number[] } {
  const exports: number[] = [];
  const imports: number[] = [];
  walkCode(source, 0, ({ text, start, prevChar }) => {
    if (text !== 'export' && text !== 'import') return;
    if (prevChar === '.') return;
    // `{ export: 1 }` is a property name; `import(…)` and `import.meta` are expressions, not the statement.
    const next = source[skipSpace(source, start + text.length)] ?? '';
    if (next === ':' || (text === 'import' && (next === '(' || next === '.'))) return;
    (text === 'export' ? exports : imports).push(start);
  });
  return { exports, imports };
}

/**
 * The statement that starts at `from`, as text: up to the first `;` outside
 * brackets, strings and comments, or the end of the source. Only the head of
 * what this returns is ever read (is it a function, what are its parameters),
 * so a statement that ends without a `;` and is followed by another simply
 * brings it along.
 */
function sliceStatement(source: string, from: number): string {
  let end = source.length;
  walkCode(source, from, ({ text, start, depth }) => {
    if (text !== ';' || depth > 0) return;
    end = start;
    return true;
  });
  return source.slice(from, end).trim();
}

/** Whether a `/` here opens a regular expression: it does unless a value just ended. */
function opensRegex(prevChar: string, prevWord: string): boolean {
  if (prevWord.length > 0) return BEFORE_REGEX.has(prevWord);
  if (prevChar === '') return true;
  return !(IDENT_CHAR.test(prevChar) || prevChar === ')' || prevChar === ']' || prevChar === '}' || prevChar === '"' || prevChar === "'" || prevChar === '`');
}

/** Index just past the string that opens at `i` with `quote`. */
function skipQuoted(source: string, i: number, quote: string): number {
  let at = i + 1;
  while (at < source.length) {
    const ch = source[at]!;
    if (ch === '\\') at += 2;
    else if (ch === quote) return at + 1;
    else at += 1;
  }
  return source.length;
}

/** Index just past the regular expression that opens at `i` (its flags included). */
function skipRegex(source: string, i: number): number {
  let at = i + 1;
  let inClass = false;
  while (at < source.length) {
    const ch = source[at]!;
    if (ch === '\\') at += 2;
    else if (ch === '\n') return at;
    else if (ch === '[') {
      inClass = true;
      at += 1;
    } else if (ch === ']') {
      inClass = false;
      at += 1;
    } else if (ch === '/' && !inClass) {
      at += 1;
      while (at < source.length && IDENT_CHAR.test(source[at]!)) at += 1;
      return at;
    } else at += 1;
  }
  return source.length;
}

/** Index of the first character at or after `i` that is not whitespace or a comment. */
function skipSpace(source: string, i: number): number {
  let at = i;
  for (;;) {
    while (at < source.length && /\s/.test(source[at]!)) at += 1;
    if (source.startsWith('//', at)) {
      const end = source.indexOf('\n', at + 2);
      if (end < 0) return source.length;
      at = end + 1;
    } else if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2);
      if (end < 0) return source.length;
      at = end + 2;
    } else return at;
  }
}

/** The identifier at `i`, or '' when what stands there is not one. */
function identifierAt(source: string, i: number): string {
  if (i >= source.length || /[0-9]/.test(source[i]!) || !IDENT_CHAR.test(source[i]!)) return '';
  let end = i + 1;
  while (end < source.length && IDENT_CHAR.test(source[end]!)) end += 1;
  return source.slice(i, end);
}
