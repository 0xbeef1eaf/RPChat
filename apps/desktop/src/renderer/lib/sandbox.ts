/** Pure helpers behind the Sandbox tab (editor keystrokes, the `input` field, the remembered snippet). */
import type { Json, SerializedError } from '@rp/shared';

export const DEFAULT_SNIPPET = `// Runs as the selected character, exactly like one of its actions.
const images = await sdk.pack.findAssets({ kind: "image", limit: 3 });
console.log("found", images.length, "image(s)");
return images.map((a) => a.path);
`;

export const INDENT = '  ';

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * What Tab does in the editor: with no selection it inserts two spaces at the caret; with a
 * selection it indents every line the selection touches. `outdent` (Shift+Tab) removes up to
 * two leading spaces from those lines instead. The returned selection keeps covering the same text.
 */
export function indentSelection(value: string, selectionStart: number, selectionEnd: number, outdent = false): TextEdit {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.min(value.length, Math.max(selectionStart, selectionEnd));
  if (!outdent && start === end) {
    return { value: `${value.slice(0, start)}${INDENT}${value.slice(end)}`, selectionStart: start + INDENT.length, selectionEnd: start + INDENT.length };
  }
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const afterEnd = value.indexOf('\n', end === start ? end : end - 1);
  const lineEnd = afterEnd === -1 ? value.length : afterEnd;
  const block = value.slice(lineStart, lineEnd);
  let firstDelta = 0;
  let totalDelta = 0;
  const lines = block.split('\n').map((line, i) => {
    let next: string;
    if (outdent) {
      const removed = line.startsWith(INDENT) ? INDENT.length : line.startsWith(' ') ? 1 : 0;
      next = line.slice(removed);
      if (i === 0) firstDelta = -removed;
      totalDelta -= removed;
    } else {
      next = `${INDENT}${line}`;
      if (i === 0) firstDelta = INDENT.length;
      totalDelta += INDENT.length;
    }
    return next;
  });
  const nextValue = `${value.slice(0, lineStart)}${lines.join('\n')}${value.slice(lineEnd)}`;
  const nextStart = Math.max(lineStart, start + firstDelta);
  const nextEnd = Math.max(nextStart, end + totalDelta);
  return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
}

/** Enter keeps the current line's indentation on the new line. */
export function newlineKeepingIndent(value: string, selectionStart: number, selectionEnd: number): TextEdit {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const indent = /^[ \t]*/.exec(value.slice(lineStart, start))?.[0] ?? '';
  const inserted = `\n${indent}`;
  const caret = start + inserted.length;
  return { value: `${value.slice(0, start)}${inserted}${value.slice(end)}`, selectionStart: caret, selectionEnd: caret };
}

export function lineCount(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export type ParsedInput = { ok: true; value: Json | undefined } | { ok: false; error: string };

/** The optional `input` field: blank means no input (`null` in the script); otherwise it must be JSON. */
export function parseInputJson(text: string): ParsedInput {
  if (text.trim().length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SNIPPET_PREFIX = 'rp.sandbox.snippet:';
const INPUT_PREFIX = 'rp.sandbox.input:';
export const LAST_CHARACTER_KEY = 'rp.sandbox.character';

function storage(explicit?: StorageLike): StorageLike | undefined {
  if (explicit) return explicit;
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
}

/** The snippet last typed for a character, or the default when there is none (or storage is unavailable). */
export function loadSnippet(characterRef: string, store?: StorageLike): string {
  try {
    return storage(store)?.getItem(`${SNIPPET_PREFIX}${characterRef}`) ?? DEFAULT_SNIPPET;
  } catch {
    return DEFAULT_SNIPPET;
  }
}

export function saveSnippet(characterRef: string, code: string, store?: StorageLike): void {
  try {
    storage(store)?.setItem(`${SNIPPET_PREFIX}${characterRef}`, code);
  } catch {
    // private mode / quota: the snippet just is not remembered
  }
}

export function loadInput(characterRef: string, store?: StorageLike): string {
  try {
    return storage(store)?.getItem(`${INPUT_PREFIX}${characterRef}`) ?? '';
  } catch {
    return '';
  }
}

export function saveInput(characterRef: string, text: string, store?: StorageLike): void {
  try {
    storage(store)?.setItem(`${INPUT_PREFIX}${characterRef}`, text);
  } catch {
    // ignored
  }
}

export function loadLastCharacter(store?: StorageLike): string | null {
  try {
    return storage(store)?.getItem(LAST_CHARACTER_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveLastCharacter(characterRef: string, store?: StorageLike): void {
  try {
    storage(store)?.setItem(LAST_CHARACTER_KEY, characterRef);
  } catch {
    // ignored
  }
}

/** Where a sandbox error points in the user's own source, when the runner mapped it. */
export interface ErrorLocation {
  line?: number;
  column?: number;
  frame?: string;
}

export function errorLocation(error: SerializedError | undefined): ErrorLocation {
  const d = error?.details;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
  const rec = d as Record<string, unknown>;
  const out: ErrorLocation = {};
  if (typeof rec['line'] === 'number') out.line = rec['line'];
  if (typeof rec['column'] === 'number') out.column = rec['column'];
  if (typeof rec['frame'] === 'string') out.frame = rec['frame'];
  return out;
}
