import { describe, expect, it } from 'vitest';
import { createStandardRegistry } from '@rp/sdk';
import { estimateMessageTokens, estimateTokens } from '@rp/llm';
import { loadPack } from '@rp/pack';
import type { ChatMessage, LoadedPack, Session } from '@rp/shared';
import { PromptBuilder, transcriptToMessages } from './prompt.js';
import type { PromptInput } from './prompt.js';
import { LUNA_DIR } from './test/helpers.js';

const session: Session = { id: 's1', characterRef: 'com.example.luna/luna', title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0, scenario: 'A rainy evening.' };

let lunaPack: LoadedPack | undefined;
async function luna(): Promise<LoadedPack> {
  lunaPack ??= await loadPack(LUNA_DIR);
  return lunaPack;
}

function msg(i: number, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m${i}`, sessionId: 's1', role, content, createdAt: new Date(i).toISOString(), ...extra };
}

function actionMessage(i: number, text: string, ok = true): ChatMessage {
  return msg(i, 'assistant', text, {
    actions: [
      {
        id: `act${i}`,
        purpose: 'p',
        code: 'return 1;',
        language: 'ts',
        source: 'tool',
        startedAt: 't',
        result: { ok, returnValue: ok ? 1 : null, logs: [{ level: 'info', message: 'hi', at: 't' }], calls: [], durationMs: 1, ...(ok ? {} : { error: { code: 'SANDBOX_RUNTIME', message: 'boom' } }) },
      },
    ],
  });
}

async function input(transcript: ChatMessage[], overrides: Partial<PromptInput> = {}): Promise<PromptInput> {
  const pack = await luna();
  return {
    pack,
    character: pack.characters[0]!,
    registry: createStandardRegistry(),
    allowedModules: ['chat', 'log', 'state', 'pack', 'timers', 'media'],
    deniedModules: ['ui', 'system'],
    session,
    transcript,
    state: { userName: 'Sam' },
    timers: [{ id: 't1', sessionId: 's1', characterRef: session.characterRef, fireAt: '2026-01-01T12:00:00.000Z', payload: { reason: 'x' }, createdAt: 't', label: 'L' }],
    userDisplayName: 'Sam',
    contextTokenBudget: 24_000,
    useTools: true,
    now: new Date('2026-01-01T11:00:00.000Z'),
    ...overrides,
  };
}

describe('PromptBuilder', () => {
  it('assembles the six sections in order with filtered SDK reference', async () => {
    const { system, messages } = new PromptBuilder().build(await input([msg(1, 'user', 'hi')]));
    const order = ['engine_rules', 'persona', 'pack', 'sdk_reference', 'memory', 'session'].map((tag) => system.search(new RegExp(`^<${tag}>$`, 'm')));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(system).toContain('You are Luna.');
    expect(system).toContain('run_action');
    expect(system).toContain('## Example dialogue');
    expect(system).toContain('- image: characters/luna/avatar.png, media/images/luna-smile.png, media/images/luna-wave.png');
    expect(system).toContain('- audio: media/audio/chime.wav');
    expect(system).toContain('Granted sdk modules: chat, log, state, pack, timers, media');
    expect(system).toContain('interface MediaApi');
    expect(system).not.toContain('interface SystemApi');
    expect(system).toContain('`sdk.ui`, `sdk.system`');
    expect(system).toContain('"userName": "Sam"');
    expect(system).toContain('t1 fires at 2026-01-01T12:00:00.000Z (L)');
    expect(system).toContain('A rainy evening.');
    expect(system).toContain('2026-01-01T11:00:00.000Z');
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('explains the action fence instead of the tool in fenced mode', async () => {
    const { system } = new PromptBuilder().build(await input([], { useTools: false }));
    expect(system).toContain('```action');
    expect(system).toContain('<action_result>');
  });

  it('caps the asset list and the state JSON', async () => {
    const pack = await luna();
    const assets = Array.from({ length: 250 }, (_, i) => ({ path: `media/images/${i}.png`, kind: 'image' as const, bytes: 1, mime: 'image/png' }));
    const big = { blob: 'x'.repeat(10_000) };
    const { system } = new PromptBuilder().build(await input([], { pack: { ...pack, assets }, state: big }));
    expect(system).toContain('… and 50 more');
    expect(system).toContain('(truncated');
    expect(system.length).toBeLessThan(40_000);
  });

  it('expands actions to tool pairs, merges same-role text and prefixes system messages', () => {
    const transcript = [
      msg(1, 'assistant', 'Hey!', { origin: 'greeting' }),
      msg(2, 'assistant', 'waves', { kind: 'emote' }),
      msg(3, 'user', 'hi'),
      actionMessage(4, 'looking...'),
      msg(5, 'assistant', 'One moment', { origin: 'behaviour' }),
      msg(6, 'system', '[timer fired] {"x":1}'),
      msg(7, 'assistant', '', { actions: [] }),
      actionMessage(8, 'again', false),
    ];
    const out = transcriptToMessages(transcript, true);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(out[0]!.content).toEqual([
      { type: 'text', text: 'Hey!' },
      { type: 'text', text: '*waves*' },
    ]);
    expect(out[2]!.content).toEqual([
      { type: 'text', text: 'looking...' },
      { type: 'tool_use', id: 'act4', name: 'run_action', input: { purpose: 'p', code: 'return 1;' } },
    ]);
    expect(out[3]!.content[0]).toEqual({ type: 'tool_result', toolUseId: 'act4', content: JSON.stringify({ ok: true, returnValue: 1, logs: ['info: hi'] }), isError: false });
    expect(out[4]!.content).toEqual([{ type: 'text', text: 'One moment' }]);
    expect(out[5]!.content).toEqual([{ type: 'text', text: '[system] [timer fired] {"x":1}' }]);
    const failed = out[7]!.content[0]!;
    expect(failed.type).toBe('tool_result');
    if (failed.type === 'tool_result') {
      expect(failed.isError).toBe(true);
      expect(JSON.parse(failed.content).error.code).toBe('SANDBOX_RUNTIME');
    }

    const fenced = transcriptToMessages(transcript.slice(2, 4), false);
    expect(fenced).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'looking...\n\n```action\n// purpose: p\nreturn 1;\n```' }] },
      { role: 'user', content: [{ type: 'text', text: '<action_result>{"ok":true,"returnValue":1,"logs":["info: hi"]}</action_result>' }] },
    ]);
  });

  it('windows a long transcript under the budget and keeps tool pairs intact', async () => {
    const transcript: ChatMessage[] = [];
    for (let i = 0; i < 400; i++) {
      transcript.push(msg(i * 2, 'user', `question ${i} ` + 'word '.repeat(60)));
      transcript.push(i % 3 === 0 ? actionMessage(i * 2 + 1, 'answer ' + 'blah '.repeat(60)) : msg(i * 2 + 1, 'assistant', 'answer ' + 'blah '.repeat(60)));
    }
    const budget = 6000;
    const { system, messages } = new PromptBuilder().build(await input(transcript, { contextTokenBudget: budget }));
    const used = messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
    expect(messages.length).toBeGreaterThan(4);
    expect(messages.length).toBeLessThan(transcript.length);
    expect(used).toBeLessThanOrEqual(Math.max(1024, budget - estimateTokens(system)));
    // every tool_use has its tool_result right after it, and no orphan tool_result exists
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      const uses = m.content.filter((p) => p.type === 'tool_use');
      if (uses.length > 0) {
        const next = messages[i + 1];
        expect(next?.role).toBe('user');
        expect(next?.content.some((p) => p.type === 'tool_result')).toBe(true);
      }
      if (m.content.some((p) => p.type === 'tool_result')) {
        expect(messages[i - 1]?.content.some((p) => p.type === 'tool_use')).toBe(true);
      }
    }
    // the newest pair is always kept (last transcript entry is an action message → tool_result reply)
    expect(messages.at(-1)!.role).toBe('user');
    expect(messages.at(-1)!.content[0]!.type).toBe('tool_result');
  });
});
