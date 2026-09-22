/**
 * The promises a script drops on the floor.
 *
 * A script is the body of an async function, and the run is over the moment that function
 * returns: the sandbox stops pumping the isolate and disposes every host call still queued
 * (packages/sandbox/src/runner.ts). So a promise nobody awaits does not merely finish late — it
 * never happens, the run still reports success, and the only trace is the `console.log` written
 * before the call. That failure is invisible at runtime, so the editors say it while it is typed.
 *
 * This is a scanner over the token stream, not a type-aware lint: it looks only at statements
 * whose value is thrown away, which is the one place a dropped promise can hide. Anything a
 * script keeps — assigns to a name, returns, passes on — is left alone, because from here there
 * is no telling whether it is awaited later.
 */

/** Which shape of dropped promise was found; the editors use it for nothing but tests do. */
export type FloatingPromiseKind = 'sdk-call' | 'then-chain' | 'async-callback' | 'local-async-call';

/** One place a promise is discarded. All positions are 1-based, over the source as given. */
export interface FloatingPromise {
  kind: FloatingPromiseKind;
  message: string;
  line: number;
  column: number;
  /** End of the statement; often several lines below `line` (a callback with a body). */
  endLine: number;
  endColumn: number;
}

/** The globals whose every method returns a promise: the SDK and the character's own library. */
const ASYNC_GLOBALS = new Set(['sdk', 'lib']);

/** Members that continue a promise chain instead of awaiting it. */
const CHAIN_MEMBERS = new Set(['then', 'catch', 'finally']);

/**
 * Words that make a statement something other than a bare expression. A statement headed by one
 * of these either uses its value (`return`, `await`, `const`) or is a construct whose inner
 * blocks are scanned on their own, so it is never reported as a whole.
 */
const STATEMENT_HEADS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'finally', 'for', 'function', 'if', 'import', 'interface', 'let', 'new', 'return',
  'switch', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

/** Statement heads whose body can be a bare statement, with no braces of its own. */
const CONTROL_HEADS = new Set(['if', 'else', 'for', 'while', 'do', 'try']);

/** Assignment operators: the statement hands its value to a name we cannot follow from here. */
const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

/** After one of these a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER_WORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield',
]);

/** Punctuation that cannot precede a regular expression (it ends a value instead). */
const REGEX_BLOCKING_PUNCT = new Set([')', ']', '}', '++', '--']);

/** Longest first, so `>>>=` is not read as `>>` then `>=`. */
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '>>>',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
];

type TokenKind = 'word' | 'punct' | 'string' | 'template' | 'number' | 'regex';

interface Token {
  kind: TokenKind;
  /** The source text for words, punctuation and numbers; `''` for the literals we only skip. */
  value: string;
  line: number;
  column: number;
  endLine: number;
  /** Exclusive: the column after the token's last character. */
  endColumn: number;
  newlineBefore: boolean;
}

/**
 * Every discarded promise in a script (a hook body, a library function, a Sandbox snippet).
 * Never throws: source that does not parse is source the author is still typing, and the
 * compiler already has something to say about it.
 */
export function findFloatingPromises(source: string): FloatingPromise[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  const tokens = tokenize(source);
  const asyncLocals = localAsyncFunctions(tokens);
  const found: FloatingPromise[] = [];
  for (const statement of statements(tokens)) {
    const problem = inspect(statement, asyncLocals);
    if (problem) found.push(problem);
  }
  return found;
}

// ---- the rules ----------------------------------------------------------------------

/** What a statement whose value is thrown away leaves pending, if anything. */
function inspect(statement: Token[], asyncLocals: ReadonlySet<string>): FloatingPromise | undefined {
  const head = statement[0];
  if (!head || head.kind !== 'word') return undefined;
  // A body without braces belongs to the same statement as its `if (…)` / `else` / `for (…)`:
  // look past the head (and its condition) so `if (stale) sdk.memory.forget(id)` is still seen.
  if (CONTROL_HEADS.has(head.value)) {
    const body = statement.slice(head.value === 'else' || head.value === 'do' || head.value === 'try' ? 1 : afterCondition(statement));
    return body.length > 0 && body.length < statement.length ? inspect(body, asyncLocals) : undefined;
  }
  if (STATEMENT_HEADS.has(head.value)) return undefined;
  // `x = foo()`, `obj.p += bar()`: the value goes somewhere this scanner cannot follow.
  if (statement.some((t, i) => i > 0 && t.kind === 'punct' && ASSIGNMENTS.has(t.value) && depthAt(statement, i) === 0)) return undefined;
  if (!statement.some((t, i) => i > 0 && t.value === '(' && depthAt(statement, i) === 0)) return undefined;

  const where = span(statement);
  if (ASYNC_GLOBALS.has(head.value)) {
    return { kind: 'sdk-call', message: `\`${callee(statement)}\` is never awaited: when this function returns the run is over, and a call still in flight is dropped — it may never happen at all. Add \`await\`.`, ...where };
  }
  if (statement.some((t, i) => i > 0 && t.kind === 'word' && CHAIN_MEMBERS.has(t.value) && statement[i - 1]?.value === '.' && statement[i + 1]?.value === '(' && depthAt(statement, i) === 0)) {
    return { kind: 'then-chain', message: 'A `.then()` chain does not hold the run open: when this function returns, a callback that has not run yet never will. `await` the promise instead.', ...where };
  }
  if (statement.some((t) => t.kind === 'word' && t.value === 'async')) {
    return { kind: 'async-callback', message: 'The promises this `async` callback makes are never awaited, so the calls inside it can be dropped when the run ends. Await them — `await Promise.all(...)` for a `map`, or a `for ... of` loop.', ...where };
  }
  if (asyncLocals.has(head.value)) {
    return { kind: 'local-async-call', message: `\`${callee(statement)}\` is an async function and its promise is never awaited: the run can end before the call finishes. Add \`await\`.`, ...where };
  }
  return undefined;
}

/** Index of the token after `if (…)` / `while (…)` / `for (…)`: where its body starts. */
function afterCondition(statement: Token[]): number {
  if (statement[1]?.value !== '(') return statement.length;
  let depth = 0;
  for (let i = 1; i < statement.length; i++) {
    const value = statement[i]!.value;
    if (statement[i]!.kind !== 'punct') continue;
    if (value === '(') depth++;
    else if (value === ')' && --depth === 0) return i + 1;
  }
  return statement.length;
}

/** `sdk.messaging.send(…)` — the callee as written, up to and including its first argument list. */
function callee(statement: Token[]): string {
  const parts: string[] = [];
  for (const token of statement) {
    if (token.value === '(') break;
    parts.push(token.kind === 'word' || token.kind === 'number' ? token.value : token.value || '…');
  }
  return `${parts.join('')}(…)`;
}

function span(statement: Token[]): Pick<FloatingPromise, 'line' | 'column' | 'endLine' | 'endColumn'> {
  const first = statement[0]!;
  const last = statement[statement.length - 1]!;
  return { line: first.line, column: first.column, endLine: last.endLine, endColumn: last.endColumn };
}

/** Bracket depth of token `i` within its statement (the token itself not counted when it opens). */
function depthAt(statement: Token[], index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const value = statement[i]!.value;
    if (statement[i]!.kind !== 'punct') continue;
    if (value === '(' || value === '[' || value === '{') depth++;
    else if (value === ')' || value === ']' || value === '}') depth--;
  }
  return depth;
}

/**
 * Names bound in this file to an async function (`async function poll()`, `const poll = async
 * () =>`). A call to one of them is a promise like any other; the character's own library
 * functions arrive through `lib`, which is covered by `ASYNC_GLOBALS`.
 */
function localAsyncFunctions(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'word' || token.value !== 'async') continue;
    const next = tokens[i + 1];
    if (!next) continue;
    // async function poll() {}
    if (next.kind === 'word' && next.value === 'function' && tokens[i + 2]?.kind === 'word') {
      names.add(tokens[i + 2]!.value);
      continue;
    }
    // const poll = async () => {} / async function () {}
    if (tokens[i - 1]?.value === '=' && tokens[i - 2]?.kind === 'word' && tokens[i - 3]?.kind === 'word' && ['const', 'let', 'var'].includes(tokens[i - 3]!.value)) {
      names.add(tokens[i - 2]!.value);
    }
  }
  return names;
}

// ---- statements ---------------------------------------------------------------------

interface Frame {
  /** A block holds statements; an object literal, an argument list or an index does not. */
  block: boolean;
  start: number;
}

/**
 * Split the token stream into the statements of every block, top level and nested alike.
 * Semicolons are optional in these scripts, so a statement also ends where the next line starts
 * something that cannot continue the current expression — the same call JavaScript itself makes.
 */
function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  const stack: Frame[] = [{ block: true, start: -1 }];
  const emit = (frame: Frame, end: number): void => {
    if (frame.start >= 0 && end >= frame.start) out.push(tokens.slice(frame.start, end + 1));
    frame.start = -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const frame = stack[stack.length - 1]!;
    if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) {
      if (frame.block && frame.start < 0) frame.start = i;
      stack.push({ block: token.value === '{' && opensBlock(tokens, i), start: -1 });
      continue;
    }
    if (token.kind === 'punct' && (token.value === ')' || token.value === ']' || token.value === '}')) {
      if (stack.length > 1) {
        const closing = stack.pop()!;
        emit(closing, i - 1);
        // A block that closes ends the statement it belonged to: `if (a) { … }`, `() => { … }`.
        const parent = stack[stack.length - 1]!;
        if (closing.block && parent.block) emit(parent, i);
      }
      continue;
    }
    if (!frame.block) continue;
    if (token.kind === 'punct' && token.value === ';') {
      emit(frame, i - 1);
      continue;
    }
    if (frame.start < 0) {
      frame.start = i;
      continue;
    }
    if (startsNewLine(tokens, i)) {
      emit(frame, i - 1);
      frame.start = i;
    }
  }
  emit(stack[0]!, tokens.length - 1);
  return out.filter((statement) => statement.length > 0);
}

/** Whether the `{` at `index` opens a block rather than an object literal or a destructuring. */
function opensBlock(tokens: Token[], index: number): boolean {
  const prev = tokens[index - 1];
  if (!prev) return true;
  if (prev.kind === 'punct') return [';', '{', '}', ')', '=>'].includes(prev.value);
  if (prev.kind === 'word') return ['do', 'else', 'try', 'finally'].includes(prev.value);
  return false;
}

/**
 * Automatic semicolon insertion, near enough: a new line whose first token cannot continue the
 * expression above it starts a statement of its own.
 */
function startsNewLine(tokens: Token[], index: number): boolean {
  const token = tokens[index]!;
  if (!token.newlineBefore) return false;
  const prev = tokens[index - 1]!;
  // An operator or an open bracket at the end of a line: the expression carries on below.
  if (prev.kind === 'punct' && !REGEX_BLOCKING_PUNCT.has(prev.value)) return false;
  if (token.kind === 'punct') return !CONTINUES_EXPRESSION.has(token.value) && token.value !== '(' && token.value !== '[';
  if (token.kind === 'template') return false;
  if (token.kind === 'word') return !['instanceof', 'in', 'of', 'as'].includes(token.value);
  return true;
}

/** Punctuation that, at the start of a line, continues the expression above rather than starting one. */
const CONTINUES_EXPRESSION = new Set([
  '.', '?.', ',', ':', '?', '=>', '+', '-', '*', '/', '%', '**', '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
  '&&', '||', '??', '&', '|', '^', '<<', '>>', '>>>', ')', ']', '}',
  ...ASSIGNMENTS,
]);

// ---- tokens -------------------------------------------------------------------------

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let newlineBefore = false;

  /** Move to `to`, counting the lines crossed on the way. */
  const advance = (to: number): void => {
    for (let at = i; at < to && at < source.length; at++) {
      if (source[at] === '\n') {
        line++;
        lineStart = at + 1;
      }
    }
    i = to;
  };
  const push = (kind: TokenKind, value: string, startLine: number, startColumn: number): void => {
    tokens.push({ kind, value, line: startLine, column: startColumn, endLine: line, endColumn: i - lineStart + 1, newlineBefore });
    newlineBefore = false;
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\n') {
      line++;
      i++;
      lineStart = i;
      newlineBefore = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      advance(end < 0 ? source.length : end + 2);
      continue;
    }

    const start = i;
    const startLine = line;
    const startColumn = i - lineStart + 1;

    if (ch === '"' || ch === "'") {
      advance(skipString(source, i));
      push('string', '', startLine, startColumn);
      continue;
    }
    if (ch === '`') {
      advance(skipTemplate(source, i));
      push('template', '', startLine, startColumn);
      continue;
    }
    if (isWordStart(ch)) {
      while (i < source.length && isWordPart(source[i]!)) i++;
      push('word', source.slice(start, i), startLine, startColumn);
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      while (i < source.length && /[0-9a-zA-Z_.]/.test(source[i]!)) i++;
      push('number', source.slice(start, i), startLine, startColumn);
      continue;
    }
    if (ch === '/' && regexAllowed(tokens)) {
      advance(skipRegex(source, i));
      push('regex', '', startLine, startColumn);
      continue;
    }
    const punctuator = PUNCTUATORS.find((p) => source.startsWith(p, i)) ?? ch;
    i += punctuator.length;
    push('punct', punctuator, startLine, startColumn);
  }
  return tokens;
}

function regexAllowed(tokens: Token[]): boolean {
  const prev = tokens[tokens.length - 1];
  if (!prev) return true;
  if (prev.kind === 'punct') return !REGEX_BLOCKING_PUNCT.has(prev.value);
  if (prev.kind === 'word') return REGEX_AFTER_WORDS.has(prev.value);
  return false;
}

/** Index after the closing quote of the string starting at `i`. */
function skipString(source: string, i: number): number {
  const quote = source[i]!;
  for (let at = i + 1; at < source.length; at++) {
    const ch = source[at]!;
    if (ch === '\\') {
      at++;
      continue;
    }
    if (ch === quote) return at + 1;
    if (ch === '\n') return at; // unterminated: the compiler will say so
  }
  return source.length;
}

/** Index after the closing backtick, `${…}` substitutions (and templates inside them) included. */
function skipTemplate(source: string, i: number): number {
  for (let at = i + 1; at < source.length; at++) {
    const ch = source[at]!;
    if (ch === '\\') {
      at++;
      continue;
    }
    if (ch === '`') return at + 1;
    if (ch === '$' && source[at + 1] === '{') at = skipBraces(source, at + 1) - 1;
  }
  return source.length;
}

/** Index after the `}` matching the `{` at `i`, skipping strings and nested templates. */
function skipBraces(source: string, i: number): number {
  let depth = 0;
  for (let at = i; at < source.length; at++) {
    const ch = source[at]!;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return at + 1;
    } else if (ch === '`') at = skipTemplate(source, at) - 1;
    else if (ch === '"' || ch === "'") at = skipString(source, at) - 1;
  }
  return source.length;
}

/** Index after the closing `/` of a regular expression (its flags included). */
function skipRegex(source: string, i: number): number {
  let inClass = false;
  for (let at = i + 1; at < source.length; at++) {
    const ch = source[at]!;
    if (ch === '\\') {
      at++;
      continue;
    }
    if (ch === '\n') return at;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let end = at + 1;
      while (end < source.length && isWordPart(source[end]!)) end++;
      return end;
    }
  }
  return source.length;
}

function isWordStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isWordPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
