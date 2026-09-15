/**
 * Comments in action code are notes the model writes to itself while composing a call. It never
 * reads them back, but every later turn replays the call and pays for them again, so they are
 * dropped on the way to the provider. What the user sees and what the sandbox ran — the stored
 * `ActionRecord.code` — keeps them.
 */

/** Words after which a `/` opens a regular expression instead of dividing. */
const REGEX_MAY_FOLLOW = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Characters no preceding token can fuse with, so a comment before one leaves no space behind. */
const CLOSING = /[,;)\]}]/;

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/** End of the string literal opening at `start`, or -1 if it never closes on its line. */
function endOfString(code: string, start: number): number {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i]!;
    if (c === '\\') i += 1;
    else if (c === quote) return i + 1;
    else if (c === '\n') return -1;
  }
  return -1;
}

/** End of the regex literal (flags included) opening at `start`, or -1 if it is really a division. */
function endOfRegex(code: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i]!;
    if (c === '\\') i += 1;
    else if (c === '\n') return -1;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '/') {
      let end = i + 1;
      while (end < code.length && isWordChar(code[end]!)) end += 1;
      return end;
    }
  }
  return -1;
}

/**
 * Whether a `/` here opens a regex, judged by the token before it: after a value (identifier,
 * literal, closing bracket) it divides, after an operator or one of `REGEX_MAY_FOLLOW` it opens a
 * regex. This is the usual lexer heuristic and it is right on everything short of `if (a) /re/`.
 */
function regexMayFollow(prev: string, word: string): boolean {
  if (prev === '') return true;
  if (word !== '') return REGEX_MAY_FOLLOW.has(word);
  return prev !== ')' && prev !== ']' && prev !== '`' && prev !== '"' && prev !== "'";
}

/**
 * `[start, end)` of every comment in `code`, or `null` when it does not scan as JavaScript — an
 * unterminated string, template or block comment means we lost the thread and must not rewrite.
 */
function commentRanges(code: string): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = [];
  /** Brace depth each enclosing `${` was opened at; non-empty means we are inside one. */
  const interpolations: number[] = [];
  let inTemplate = false;
  let depth = 0;
  let prev = '';
  let word = '';
  let i = 0;

  while (i < code.length) {
    const c = code[i]!;

    if (inTemplate) {
      if (c === '\\') i += 2;
      else if (c === '`') {
        inTemplate = false;
        prev = '`';
        word = '';
        i += 1;
      } else if (c === '$' && code[i + 1] === '{') {
        interpolations.push(depth);
        inTemplate = false;
        prev = '';
        word = '';
        i += 2;
      } else i += 1;
      continue;
    }

    if (c === '/' && code[i + 1] === '/') {
      let end = i + 2;
      while (end < code.length && code[end] !== '\n') end += 1;
      ranges.push([i, end]);
      i = end;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      if (close < 0) return null;
      ranges.push([i, close + 2]);
      i = close + 2;
      continue;
    }
    if (c === '/') {
      const end = regexMayFollow(prev, word) ? endOfRegex(code, i) : -1;
      i = end > 0 ? end : i + 1;
      prev = '/';
      word = '';
      continue;
    }
    if (c === '"' || c === "'") {
      const end = endOfString(code, i);
      if (end < 0) return null;
      i = end;
      prev = c;
      word = '';
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      i += 1;
      continue;
    }
    if (c === '}' && interpolations.length > 0 && depth === interpolations[interpolations.length - 1]) {
      interpolations.pop();
      inTemplate = true;
      i += 1;
      continue;
    }
    if (c === '{' || c === '}') depth += c === '{' ? 1 : -1;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (isWordChar(c)) {
      let end = i;
      while (end < code.length && isWordChar(code[end]!)) end += 1;
      word = code.slice(i, end);
      prev = code[end - 1]!;
      i = end;
      continue;
    }
    prev = c;
    word = '';
    i += 1;
  }

  return inTemplate || interpolations.length > 0 ? null : ranges;
}

/**
 * Remove `//` and block comments from JavaScript/TypeScript, leaving every other byte alone.
 * A comment that had its line to itself takes the line with it; one that trailed code takes the
 * whitespace in front of it. Code that does not scan (or that is nothing but comments) comes back
 * unchanged, so a mis-scan can never turn a stored action into nonsense.
 */
export function stripCodeComments(code: string): string {
  const ranges = commentRanges(code);
  if (ranges === null || ranges.length === 0) return code;

  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += code.slice(cursor, start);
    const lineStart = out.lastIndexOf('\n') + 1;
    const aloneBefore = out.slice(lineStart).trim() === '';

    let after = end;
    while (after < code.length && (code[after] === ' ' || code[after] === '\t' || code[after] === '\r')) after += 1;
    const aloneAfter = after >= code.length || code[after] === '\n';
    cursor = after;

    if (aloneBefore && aloneAfter) {
      out = out.slice(0, lineStart);
      if (code[cursor] === '\n') cursor += 1;
      // The comment stood between two blank lines: leave one, not both.
      if (out === '' || out.endsWith('\n\n')) {
        for (let nl = code.indexOf('\n', cursor); nl >= 0; nl = code.indexOf('\n', cursor)) {
          if (code.slice(cursor, nl).trim() !== '') break;
          cursor = nl + 1;
        }
      }
    } else if (aloneAfter) {
      out = out.replace(/[ \t\r]+$/, '');
    } else if (!aloneBefore) {
      // Code on both sides: leave a space, so the tokens around it stay apart.
      out = out.replace(/[ \t]+$/, '');
      if (!CLOSING.test(code[cursor] ?? '')) out += ' ';
    }
  }
  out += code.slice(cursor);

  const stripped = out.replace(/[ \t\r\n]+$/, '');
  return stripped.trim() === '' ? code : stripped;
}
