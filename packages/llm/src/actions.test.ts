import { describe, expect, it } from 'vitest';
import { RUN_ACTION_TOOL_NAME } from '@rp/shared';
import { RUN_ACTION_TOOL, extractFencedActions, stripFencedActions } from './actions.js';

describe('RUN_ACTION_TOOL', () => {
  it('matches the shared tool name and schema shape', () => {
    expect(RUN_ACTION_TOOL.name).toBe(RUN_ACTION_TOOL_NAME);
    expect(RUN_ACTION_TOOL.inputSchema.type).toBe('object');
    expect(RUN_ACTION_TOOL.inputSchema.required).toEqual(['purpose', 'code']);
    const props = RUN_ACTION_TOOL.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['code', 'purpose']);
    expect(RUN_ACTION_TOOL.description).toMatch(/sdk/);
  });
});

describe('extractFencedActions', () => {
  it('finds a single block with a purpose line and reports offsets', () => {
    const text = 'Sure!\n```action\n// purpose: show a picture\nawait sdk.media.showImage("a.png");\nreturn 1;\n```\nDone.';
    const [a, ...rest] = extractFencedActions(text);
    expect(rest).toEqual([]);
    expect(a).toBeDefined();
    expect(a!.purpose).toBe('show a picture');
    expect(a!.code).toBe('await sdk.media.showImage("a.png");\nreturn 1;');
    expect(text.slice(a!.start, a!.end)).toBe('```action\n// purpose: show a picture\nawait sdk.media.showImage("a.png");\nreturn 1;\n```');
  });

  it('handles multiple blocks and the alternative info strings', () => {
    const text = [
      '```action',
      'return 1;',
      '```',
      'middle',
      '```action ts',
      'return 2;',
      '```',
      '```ts action',
      'return 3;',
      '```',
      '```typescript',
      'return "not an action";',
      '```',
    ].join('\n');
    const found = extractFencedActions(text);
    expect(found.map((f) => f.code)).toEqual(['return 1;', 'return 2;', 'return 3;']);
    expect(found.every((f) => f.purpose === undefined)).toBe(true);
  });

  it('ignores backticks inside strings and template literals', () => {
    const text = [
      '```action',
      'const s = `hello ${name}`;',
      'const t = "```";',
      'await sdk.chat.say(s + t); // ``` inline',
      '```',
    ].join('\n');
    const found = extractFencedActions(text);
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe(['const s = `hello ${name}`;', 'const t = "```";', 'await sdk.chat.say(s + t); // ``` inline'].join('\n'));
  });

  it('supports longer fences wrapping code that contains a triple-backtick line', () => {
    const text = '````action\nconst md = `\n```\ncode\n```\n`;\nreturn md;\n````';
    const found = extractFencedActions(text);
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe('const md = `\n```\ncode\n```\n`;\nreturn md;');
  });

  it('ignores unclosed blocks and honours a custom tag', () => {
    expect(extractFencedActions('```action\nreturn 1;')).toEqual([]);
    expect(extractFencedActions('```run\nreturn 1;\n```', 'run')).toHaveLength(1);
    expect(extractFencedActions('```run\nreturn 1;\n```')).toEqual([]);
  });

  it('tolerates CRLF line endings and case-insensitive purpose', () => {
    const text = 'x\r\n```action\r\n// Purpose: Wave\r\nreturn 1;\r\n```\r\ny';
    const found = extractFencedActions(text);
    expect(found).toHaveLength(1);
    expect(found[0]!.purpose).toBe('Wave');
    expect(found[0]!.code).toBe('return 1;');
  });
});

describe('stripFencedActions', () => {
  it('removes the blocks and tidies whitespace', () => {
    const text = 'Hello!\n\n```action\nreturn 1;\n```\n\nBye.\n```action\nreturn 2;\n```';
    expect(stripFencedActions(text)).toBe('Hello!\n\nBye.');
  });

  it('returns the text unchanged when there are no blocks', () => {
    expect(stripFencedActions('plain text')).toBe('plain text');
  });
});
