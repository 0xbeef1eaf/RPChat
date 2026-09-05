import { ACTION_FENCE_TAG, RUN_ACTION_TOOL_NAME } from '@rp/shared';
import type { ToolDefinition } from '@rp/shared';

/** A code block the model asked to run, extracted from assistant text (fallback mode). */
export interface FencedAction {
  code: string;
  purpose?: string;
  /** Offset of the opening fence in the source text. */
  start: number;
  /** Offset just past the closing fence in the source text. */
  end: number;
}

/** The tool exposed to providers that support native tool calling. */
export const RUN_ACTION_TOOL: ToolDefinition = {
  name: RUN_ACTION_TOOL_NAME,
  description: [
    'Run TypeScript on the host to act in the world (show media, schedule timers, remember things, notify the user, ...).',
    '`code` is the body of an async function: the `sdk` object and `console` are in scope, `await` is allowed,',
    'and `return <json>` sends a value back to you. Only the documented `sdk` modules are available; there is no',
    'network, filesystem or `require`. The result (return value, logs, errors) is returned to you as the tool result.',
    'Keep code short, one action per intention, never loop forever.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      purpose: {
        type: 'string',
        description: 'One short sentence saying what this action is for (shown to the user).',
      },
      code: {
        type: 'string',
        description: 'TypeScript body of an async function using the `sdk` object.',
      },
    },
    required: ['purpose', 'code'],
    additionalProperties: false,
  },
};

const OPEN_FENCE = /^[ \t]{0,3}(`{3,})[ \t]*([^`\r\n]*?)[ \t]*\r?$/;
const CLOSE_FENCE = /^[ \t]{0,3}(`{3,})[ \t]*\r?$/;
const PURPOSE_LINE = /^[ \t]*\/\/[ \t]*purpose[ \t]*:[ \t]*(.*?)[ \t]*\r?$/i;

function infoHasTag(info: string, tag: string): boolean {
  const wanted = tag.toLowerCase();
  return info
    .toLowerCase()
    .split(/[\s,;]+/)
    .some((word) => word === wanted);
}

/** Split the code body into an optional `// purpose: ...` header and the remaining code. */
function splitPurpose(raw: string): { code: string; purpose?: string } {
  const lines = raw.split('\n');
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first += 1;
  const header = first < lines.length ? PURPOSE_LINE.exec(lines[first]!) : null;
  if (header) {
    const purpose = header[1] ?? '';
    const code = lines.slice(first + 1).join('\n').trim();
    return purpose ? { code, purpose } : { code };
  }
  return { code: lines.slice(first).join('\n').trim() };
}

/**
 * Find fenced code blocks whose info string names `tag` (default `action`), e.g.
 * ```` ```action ````, ```` ```action ts ```` or ```` ```ts action ````.
 * The closing fence must be a line of its own with at least as many backticks as
 * the opening one, so backticks inside strings do not end a block early.
 * Unclosed blocks are ignored. A first-line `// purpose: ...` comment becomes
 * `purpose` and is removed from `code`.
 */
export function extractFencedActions(text: string, tag: string = ACTION_FENCE_TAG): FencedAction[] {
  const results: FencedAction[] = [];
  const lines = text.split('\n');
  let i = 0;
  let pos = 0; // offset of lines[i] in text
  while (i < lines.length) {
    const line = lines[i]!;
    const open = OPEN_FENCE.exec(line);
    if (open && infoHasTag(open[2] ?? '', tag)) {
      const fenceLen = open[1]!.length;
      const codeStart = pos + line.length + 1;
      let j = i + 1;
      let p = codeStart;
      let closed = false;
      while (j < lines.length) {
        const close = CLOSE_FENCE.exec(lines[j]!);
        if (close && close[1]!.length >= fenceLen) {
          closed = true;
          break;
        }
        p += lines[j]!.length + 1;
        j += 1;
      }
      if (closed) {
        const raw = text.slice(Math.min(codeStart, p), p);
        const { code, purpose } = splitPurpose(raw);
        const end = p + lines[j]!.length;
        results.push(purpose === undefined ? { code, start: pos, end } : { code, purpose, start: pos, end });
        pos = end + 1;
        i = j + 1;
        continue;
      }
    }
    pos += line.length + 1;
    i += 1;
  }
  return results;
}

/** Remove the action blocks found by {@link extractFencedActions}, tidying the surrounding whitespace. */
export function stripFencedActions(text: string, tag: string = ACTION_FENCE_TAG): string {
  const blocks = extractFencedActions(text, tag);
  if (blocks.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    out += text.slice(cursor, block.start);
    cursor = block.end;
    if (text[cursor] === '\r') cursor += 1;
    if (text[cursor] === '\n') cursor += 1;
  }
  out += text.slice(cursor);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
