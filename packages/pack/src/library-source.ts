/**
 * What the files of a character's function library declare, read from their text:
 * for every export, whether it is a function, its parameter list and the summary of
 * its JSDoc. The pack loader asks esbuild which names a file exports (that is the
 * truth, re-exports included) and this scanner what each of them looks like, for
 * the prompt's `<library>` lines (`- lib.<name>(<params>) — <description>`).
 *
 * Textual only: nothing here parses TypeScript properly. What it cannot read is
 * reported as `unknown`, which still lands on `lib` — the scanner only decides how
 * a function is described, never whether the library builds.
 */

/** What a function expression looks like: `function …`, `(a, b) => …`, `<T>(a: T) => …` or `x => …`, optionally `async` and parenthesised. */
const FUNCTION_EXPRESSION_RE = /^\(?\s*(async\s+)?(function\b|<[^>]*>\s*\(|\([\s\S]*?\)\s*(:[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/;
/** Words that may stand in front of a declaration keyword in the same statement. */
const DECLARATION_MODIFIERS = new Set(['export', 'async', 'declare', 'abstract']);

/** How an export of a library file looks. */
export interface ExportShape {
  /**
   * `function`: a function declaration, or a `const` holding an arrow or function
   * expression. `value`: anything else declared in the file (a constant, a class,
   * an enum) — importable by the other files, not a `lib` function. `unknown`: the
   * scanner could not see the declaration (a re-export, say).
   */
  kind: 'function' | 'value' | 'unknown';
  /** The parameter list as written; '' when not a function or not readable. */
  params: string;
  /** The summary of the JSDoc in front of the declaration. */
  description?: string;
  /** The JSDoc carries `@internal`. */
  internal?: boolean;
}

/** A declaration at the top level of a file: where its statement starts and what it declares. */
interface Declaration {
  /** Start of the statement, before any `export` / `async` in front of the keyword. */
  start: number;
  kind: 'function' | 'value';
  /** The function's own text from its parameter list on (or its initialiser); '' for a value. */
  fn: string;
}

/**
 * Exported name → shape, for every export the scanner can read in `source`. A name
 * esbuild reports and this map lacks is `unknown`.
 */
export function scanExports(source: string): Map<string, ExportShape> {
  const declarations = topLevelDeclarations(source);
  const out = new Map<string, ExportShape>();
  const describe = (local: string): ExportShape => {
    const d = declarations.get(local);
    if (!d) return { kind: 'unknown', params: '' };
    const shape: ExportShape = { kind: d.kind, params: d.kind === 'function' ? functionParams(d.fn) : '' };
    const doc = jsDocBefore(source, d.start);
    if (doc !== undefined) {
      const summary = jsDocSummary(doc);
      if (summary.description !== undefined) shape.description = summary.description;
      if (summary.internal) shape.internal = true;
    }
    return shape;
  };

  walkCode(source, 0, ({ text, start, prevChar, depth }) => {
    if (text !== 'export' || depth !== 0 || prevChar === '.') return;
    const after = skipSpace(source, start + text.length);
    const word = identifierAt(source, after);
    if (source[after] === '{') {
      const close = source.indexOf('}', after);
      if (close < 0) return;
      const from = identifierAt(source, skipSpace(source, close + 1)) === 'from';
      for (const item of source.slice(after + 1, close).split(',')) {
        const m = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(stripComments(item));
        if (!m || /^\s*type\s/.test(item)) continue;
        const exported = m[2] ?? m[1]!;
        out.set(exported, from ? { kind: 'unknown', params: '' } : describe(m[1]!));
      }
      return;
    }
    if (word === 'default' || word === 'type' || word === 'interface' || word === '') return;
    // `export function f`, `export const f = …`, `export class C`: the declaration is the file's own.
    const declared = declarationAt(source, after);
    if (declared !== undefined) out.set(declared, describe(declared));
  });
  return out;
}

/** Whether `source` has an `export` statement at its top level (type-only ones included). */
export function hasExports(source: string): boolean {
  let found = false;
  walkCode(source, 0, ({ text, prevChar, depth }) => {
    if (text !== 'export' || depth !== 0 || prevChar === '.') return;
    found = true;
    return true;
  });
  return found;
}

/**
 * The name declared by the statement whose keyword sequence starts at `i`
 * (`async function f`, `const f`, `class C`, …), or undefined.
 */
function declarationAt(source: string, i: number): string | undefined {
  let at = i;
  for (;;) {
    const word = identifierAt(source, at);
    if (!DECLARATION_MODIFIERS.has(word)) break;
    at = skipSpace(source, at + word.length);
  }
  const keyword = identifierAt(source, at);
  if (!['function', 'const', 'let', 'var', 'class', 'enum'].includes(keyword)) return undefined;
  let nameAt = skipSpace(source, at + keyword.length);
  if (source[nameAt] === '*') nameAt = skipSpace(source, nameAt + 1);
  const name = identifierAt(source, nameAt);
  return name.length > 0 ? name : undefined;
}

/** Every declaration at the top level of `source`, by name (the first one wins). */
function topLevelDeclarations(source: string): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  walkCode(source, 0, ({ text, start, prevChar, depth }) => {
    if (depth !== 0 || prevChar === '.') return;
    if (!['function', 'const', 'let', 'var', 'class', 'enum'].includes(text)) return;
    let nameAt = skipSpace(source, start + text.length);
    if (source[nameAt] === '*') nameAt = skipSpace(source, nameAt + 1);
    const name = identifierAt(source, nameAt);
    if (name.length === 0 || out.has(name)) return;
    const statement = statementStart(source, start);
    const rest = nameAt + name.length;
    if (text === 'function') {
      out.set(name, { start: statement, kind: 'function', fn: source.slice(rest) });
    } else if (text === 'const' || text === 'let' || text === 'var') {
      const init = initialiserAt(source, rest);
      // Without a readable initialiser it is left to the run to say whether it is a function.
      if (init === undefined) return;
      const fn = source.slice(init);
      const isFunction = FUNCTION_EXPRESSION_RE.test(stripLeadingComments(fn));
      out.set(name, { start: statement, kind: isFunction ? 'function' : 'value', fn: isFunction ? fn : '' });
    } else {
      out.set(name, { start: statement, kind: 'value', fn: '' });
    }
  });
  return out;
}

/** Where the statement around the keyword at `keyword` starts: back over `export`, `async`, `declare`, … */
function statementStart(source: string, keyword: number): number {
  let start = keyword;
  for (;;) {
    let at = start;
    while (at > 0 && /\s/.test(source[at - 1]!)) at -= 1;
    let wordStart = at;
    while (wordStart > 0 && IDENT_CHAR.test(source[wordStart - 1]!)) wordStart -= 1;
    if (wordStart === at || !DECLARATION_MODIFIERS.has(source.slice(wordStart, at))) return start;
    start = wordStart;
  }
}

/**
 * Index of the initialiser of the declarator whose name ends at `i`: just past its `=`,
 * skipping a type annotation (`: Record<string, (a: string) => void>`), or undefined
 * when the declarator ends without one.
 */
function initialiserAt(source: string, i: number): number | undefined {
  let depth = 0;
  for (let at = i; at < source.length; at++) {
    const ch = source[at]!;
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === '>' && source[at - 1] !== '=') depth -= 1;
    else if (depth === 0 && (ch === ';' || ch === ',')) return undefined;
    else if (depth === 0 && ch === '=' && source[at + 1] !== '>' && source[at + 1] !== '=') return skipSpace(source, at + 1);
    if (depth < 0) return undefined;
  }
  return undefined;
}

/** The `/** … *\/` comment that ends right before `start` (only whitespace between), or undefined. */
function jsDocBefore(source: string, start: number): string | undefined {
  let end = start;
  while (end > 0 && /\s/.test(source[end - 1]!)) end -= 1;
  if (!source.slice(0, end).endsWith('*/')) return undefined;
  const open = source.lastIndexOf('/*', end - 2);
  if (open < 0 || source[open + 2] !== '*' || open + 3 > end - 2) return undefined;
  return source.slice(open + 3, end - 2);
}

/**
 * The description and `@internal` flag of a JSDoc body (what lies between `/**` and
 * `*\/`): the description is its first paragraph — up to a blank line or the first
 * tag other than a leading `@internal` — on one line.
 */
export function jsDocSummary(body: string): { description?: string; internal: boolean } {
  const raw = body.split('\n').map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd());
  const internal = raw.some((l) => /(^|\s)@internal\b/.test(l));
  // `@internal` is a modifier with no text of its own: `/** @internal Roll a die. */` describes the function.
  const lines = raw.map((l) => l.replace(/^\s*@internal\b\s*/, ''));
  const summary: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('@')) break;
    if (line.trim().length === 0) {
      if (summary.length > 0) break;
      continue;
    }
    summary.push(line.trim());
  }
  const description = summary.join(' ').replace(/\s+/g, ' ').trim();
  return description.length > 0 ? { description, internal } : { internal };
}

/**
 * Parameters of a function as text: what lies between the first `(` and its
 * matching `)`, whitespace collapsed (`async (mood: string) => …` gives
 * `mood: string`); a parenthesis-free arrow (`x => …`) gives its one parameter.
 * Comments in front of the function are skipped, so one holding a `(` or a `=>`
 * cannot pass itself off as the parameter list.
 */
export function functionParams(source: string): string {
  const text = stripLeadingComments(source).trim();
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

/**
 * `source` with the comments in front of it removed. Only the head is scanned,
 * where `//` and `/*` can only open a comment; comments further in are left
 * alone. A source that is nothing but comments gives an empty string.
 */
export function stripLeadingComments(source: string): string {
  return source.slice(skipSpace(source, 0));
}

/** `text` without its comments (for one short piece of an export list). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
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
