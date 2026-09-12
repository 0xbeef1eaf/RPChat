/**
 * Turning an isolate failure into something the model can act on
 * (docs/spec/sandbox.md §3.1): QuickJS reports frames against the wrapped,
 * transpiled `action.js`, which is not the code the model wrote. Every frame is
 * mapped back through the source map, wrapper frames are dropped, and the
 * failing line is quoted with a caret so the fix is visible without guessing.
 *
 * Pure: the runner passes the raw stack and the model's own source in.
 */
import type { Position, SourceMapper } from './sourcemap.js';
import { ENTRY_FUNCTION_NAME } from './transpile.js';

/** Name the mapped stack uses for the code the model wrote. */
export const ACTION_FILE = 'action.ts';
/** Frame name for the model's top level (its code is wrapped in a function). */
export const TOP_LEVEL_FRAME = '<your code>';
/** File name used for frames inside the prelude (the character's function library). */
export const LIBRARY_FILE = 'library';

const FRAME_RE = /^\s*at\s+(?<fn>.*?)\s*\((?<file>[^()]*?):(?<line>\d+):(?<column>\d+)\)\s*$/;
const NATIVE_FRAME_RE = /^\s*at\s+(?<fn>.*?)\s*\((?<where>native)\)\s*$/;
const MAX_FRAMES = 10;
/** Longest source line quoted in a code frame before it is cut. */
const MAX_FRAME_LINE_CHARS = 160;

export interface MappedStack {
  /** Frames in the model's own coordinates, one per line; empty when nothing mapped. */
  stack: string;
  /** Where the failure happened in the model's source, when a frame mapped to it. */
  at?: Position;
}

/**
 * Rewrite a QuickJS stack so every frame points at the model's source. Frames
 * inside the sandbox's own wrappers (`bootstrap.js`, the `<eval>` shim, and
 * anything mapping past `sourceLines`) are dropped: noise the model cannot act on.
 * A frame inside the prelude (a library function) is kept as
 * `at lib.<name> (library:<line>:<col>)` — the name QuickJS gives the function,
 * which is the property it was defined under — but never becomes `at`, so the
 * code frame stays in the code the model just wrote.
 */
export function mapStack(stack: string | undefined, mapper: SourceMapper | undefined, sourceLines?: number): MappedStack {
  if (!stack) return { stack: '' };
  const out: string[] = [];
  let at: Position | undefined;
  for (const line of stack.split('\n')) {
    if (out.length >= MAX_FRAMES) break;
    const native = NATIVE_FRAME_RE.exec(line);
    if (native) {
      out.push(`    at ${native.groups?.['fn'] ?? '<anonymous>'} (native)`);
      continue;
    }
    const frame = FRAME_RE.exec(line);
    if (!frame?.groups) continue;
    const file = frame.groups['file'] ?? '';
    if (!file.startsWith('action.')) continue; // bootstrap.js and friends
    const generatedLine = Number(frame.groups['line']);
    const generatedColumn = Number(frame.groups['column']);
    const position = mapper?.originalPositionFor(generatedLine, generatedColumn);
    if (!position) continue;
    const fn = frame.groups['fn'] ?? '<anonymous>';
    if (position.library) {
      const name = /^[A-Za-z_$][\w$]*$/.test(fn) && fn !== ENTRY_FUNCTION_NAME ? `lib.${fn}` : LIBRARY_FILE;
      out.push(`    at ${name} (${LIBRARY_FILE}:${position.line}:${position.column})`);
      continue;
    }
    // A line past the end of the model's code: the wrapper, not its code.
    if (sourceLines !== undefined && position.line > sourceLines) continue;
    const name = fn === ENTRY_FUNCTION_NAME || fn === '<eval>' ? TOP_LEVEL_FRAME : fn;
    out.push(`    at ${name} (${ACTION_FILE}:${position.line}:${position.column})`);
    at ??= position;
  }
  return at ? { stack: out.join('\n'), at } : { stack: out.join('\n') };
}

/**
 * The failing line with its neighbours and a caret, e.g.
 *
 * ```
 *   2 | function pick(list) {
 * > 3 |   return list.find((x) => x.missing.deep);
 *     |                                 ^
 *   4 | }
 * ```
 */
export function codeFrame(source: string, at: Position, contextLines = 2): string | undefined {
  const lines = source.split('\n');
  if (at.line < 1 || at.line > lines.length) return undefined;
  const first = Math.max(1, at.line - contextLines);
  const last = Math.min(lines.length, at.line + contextLines);
  const gutter = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n += 1) {
    const text = clip(lines[n - 1] ?? '');
    const marker = n === at.line ? '>' : ' ';
    out.push(`${marker} ${String(n).padStart(gutter)} | ${text}`);
    if (n === at.line && at.column >= 1 && at.column <= MAX_FRAME_LINE_CHARS) {
      out.push(`  ${' '.repeat(gutter)} | ${' '.repeat(at.column - 1)}^`);
    }
  }
  return out.join('\n');
}

function clip(text: string): string {
  return text.length > MAX_FRAME_LINE_CHARS ? `${text.slice(0, MAX_FRAME_LINE_CHARS)}…` : text;
}
