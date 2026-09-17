import { describe, expect, it } from 'vitest';
import { createStandardRegistry } from '@rp/sdk';
import { estimateMessageTokens, estimateTokens } from '@rp/llm';
import { loadPack } from '@rp/pack';
import type { ChatMessage, LoadedPack, Session } from '@rp/shared';
import { errorForModel, resultPayload } from './action-loop.js';
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
    sdkSelection: { modules: ['chat', 'state', 'pack', 'timers', 'media'] },
    session,
    transcript,
    state: { userName: 'Sam' },
    timers: [{ id: 't1', sessionId: 's1', characterRef: session.characterRef, kind: 'wake', fireAt: '2026-01-01T12:00:00.000Z', payload: { reason: 'x' }, createdAt: 't', label: 'L' }],
    userDisplayName: 'Sam',
    contextTokenBudget: 24_000,
    useTools: true,
    now: new Date('2026-01-01T11:00:00.000Z'),
    ...overrides,
  };
}

describe('PromptBuilder', () => {
  it('assembles the six sections in order with filtered SDK reference', async () => {
    const { system, messages, stats } = new PromptBuilder().build(await input([msg(1, 'user', 'hi')]));
    const order = ['engine_rules', 'persona', 'sdk_reference', 'memory', 'session'].map((tag) => system.search(new RegExp(`^<${tag}>$`, 'm')));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(system).toContain('You are Luna.');
    expect(system).toContain('run_action');
    expect(system).toContain('## Example dialogue');
    expect(system).not.toContain('<pack>'); // media is discovered through sdk.pack, not listed
    expect(system).not.toContain('characters/luna/avatar.png');
    expect(system).toContain('sdk.pack.findAssets');
    expect(system).toContain('Available modules: sdk.chat, sdk.state, sdk.pack, sdk.timers, sdk.media.');
    expect(system).toContain('## sdk.media — Media playback (pack)');
    expect(system).toContain('- showImage(asset: AssetRef | string, options?: ShowImageOptions): Promise<MediaHandle>');
    expect(system).not.toContain('interface MediaApi'); // abridged index, not the full d.ts
    expect(system).not.toContain('sdk.system —');
    expect(system).not.toContain('Not available'); // unavailable modules are omitted entirely
    expect(stats.sdkReferenceTokens).toBeLessThan(6000); // six modules with full TSDoc (params, examples)
    expect(stats.systemTokens).toBeLessThan(stats.budgetTokens / 2);
    expect(stats.droppedMessages).toBe(0);
    expect(system).toContain('"userName": "Sam"');
    expect(system).toContain('t1 fires at 2026-01-01T12:00:00.000Z (L)');
    expect(system).toContain('A rainy evening.');
    expect(system).toContain('2026-01-01T11:00:00.000Z');
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('includes the new modules when available and says nothing at all about the rest', async () => {
    const denied = new PromptBuilder().build(await input([], { sdkSelection: { modules: ['chat', 'state', 'pack', 'timers', 'display'] } })).system;
    expect(denied).toContain('## sdk.display');
    for (const id of ['wallpaper', 'browser', 'input', 'media']) {
      expect(denied).not.toContain(`## sdk.${id} —`);
      expect(denied).not.toMatch(new RegExp(`^Available modules: .*\\bsdk\\.${id}\\b`, 'm'));
    }
    expect(denied).not.toContain('Not available'); // no list of what the character cannot do
    expect(denied).not.toContain('are not available in this session');

    const available = new PromptBuilder().build(await input([], { sdkSelection: { modules: ['chat', 'state', 'pack', 'timers', 'display', 'wallpaper', 'browser', 'input'] } })).system;
    for (const id of ['display', 'wallpaper', 'browser', 'input']) expect(available).toContain(`## sdk.${id}`);
    expect(available).toContain('Available modules: sdk.chat, sdk.state, sdk.pack, sdk.timers, sdk.display, sdk.wallpaper, sdk.browser, sdk.input.');
    expect(available).not.toContain('Not available');
  });

  it('replaces summarised messages with <history_summary> and ignores a summary whose last message is gone', async () => {
    const transcript = [msg(1, 'user', 'oldest'), msg(2, 'assistant', 'old reply'), msg(3, 'user', 'recent'), msg(4, 'assistant', 'recent reply')];
    const summary = { text: 'They talked about the rain.', throughMessageId: 'm2', messageCount: 2, updatedAt: 't' };
    const { system, messages, stats } = new PromptBuilder().build(await input(transcript, { historySummary: summary }));
    expect(system).toContain('<history_summary>');
    expect(system).toContain('Earlier in this conversation (2 message(s), not shown in full below):\nThey talked about the rain.');
    expect(JSON.stringify(messages)).not.toContain('oldest');
    expect(JSON.stringify(messages)).toContain('recent');
    expect(stats).toMatchObject({ summarisedMessages: 2, summaryTokens: estimateTokens(summary.text) });

    // Marker no longer in the transcript (history cleared, message deleted): fall back to the whole thing.
    const stale = new PromptBuilder().build(await input(transcript, { historySummary: { ...summary, throughMessageId: 'gone' } }));
    expect(stale.system).not.toContain('<history_summary>');
    expect(JSON.stringify(stale.messages)).toContain('oldest');
    expect(stale.stats.summarisedMessages).toBe(0);
  });

  it('drops the action detail of older messages, keeping the most recent, without orphaning a tool result', async () => {
    const transcript = [actionMessage(1, 'first'), actionMessage(2, 'second'), actionMessage(3, 'third')];
    const kept = new PromptBuilder().build(await input(transcript, { keepActionDetailFor: 1 }));
    const parts = kept.messages.flatMap((m) => m.content);
    const uses = parts.filter((p) => p.type === 'tool_use');
    const results = parts.filter((p) => p.type === 'tool_result');
    expect(uses).toHaveLength(1); // only the newest action survives
    expect(results).toHaveLength(1);
    expect(results.every((r) => uses.some((u) => u.type === 'tool_use' && r.type === 'tool_result' && u.id === r.toolUseId))).toBe(true);
    expect(JSON.stringify(kept.messages)).toContain('first'); // the visible text of the older turns stays
    expect(kept.stats.trimmedActionMessages).toBe(2);

    const none = new PromptBuilder().build(await input(transcript, { keepActionDetailFor: 0 }));
    expect(none.messages.flatMap((m) => m.content).some((p) => p.type === 'tool_use' || p.type === 'tool_result')).toBe(false);
    expect(none.stats.trimmedActionMessages).toBe(3);

    const all = new PromptBuilder().build(await input(transcript));
    expect(all.messages.flatMap((m) => m.content).filter((p) => p.type === 'tool_use')).toHaveLength(3);
    expect(all.stats.trimmedActionMessages).toBe(0);
  });

  it('trims older action fences too when tool calling is off', async () => {
    const transcript = [actionMessage(1, 'first'), actionMessage(2, 'second')];
    const { messages } = new PromptBuilder().build(await input(transcript, { useTools: false, keepActionDetailFor: 1 }));
    const text = JSON.stringify(messages);
    expect(text).toContain('first');
    expect((text.match(/<action_result>/g) ?? []).length).toBe(1); // one result block, for the kept action
    expect((text.match(/return 1;/g) ?? []).length).toBe(1);
  });

  it('keeps the pack manifest and asset list out of the system prompt', async () => {
    const description = (await luna()).manifest.description ?? '';
    expect(description.length).toBeGreaterThan(0);
    const { system } = new PromptBuilder().build(await input([]));
    expect(system).not.toContain(description);
    expect(system).not.toContain('Description:');
    expect(system).not.toContain('Pack: Luna');
    expect(system).not.toContain('Assets (paths');
  });

  it('renders <state> and <memories> inside <memory>, with guidance in the engine rules', async () => {
    const empty = new PromptBuilder().build(await input([])).system;
    expect(empty).toContain('<memory>\n<state>\n{');
    expect(empty).toContain('<memories>\nNothing yet.\n</memories>');
    expect(empty).toContain('sdk.memory.remember');
    expect(empty).toContain('never list or recite them');

    const memories = [
      { id: 'm1', characterRef: session.characterRef, text: 'Their cat is Miso.', tags: ['pets', 'cat'], importance: 4, source: 'character' as const, createdAt: '2026-02-01T10:00:00.000Z', updatedAt: '2026-02-01T10:00:00.000Z', recallCount: 0 },
      { id: 'm2', characterRef: session.characterRef, text: 'They work nights.', tags: [], importance: 3, source: 'consolidation' as const, createdAt: '2026-02-02T10:00:00.000Z', updatedAt: '2026-02-02T10:00:00.000Z', recallCount: 0 },
    ];
    const withMemories = new PromptBuilder().build(await input([], { memories, sdkSelection: { modules: ['chat', 'state', 'pack', 'timers', 'memory'] } })).system;
    expect(withMemories).toContain('<memories>\nThings you remember (most important first):\n- (4/5, 2026-02-01) Their cat is Miso. [pets, cat]\n- (3/5, 2026-02-02) They work nights.\n</memories>');
    expect(withMemories).toContain('## sdk.memory —');
  });

  it('explains the action fence instead of the tool in fenced mode', async () => {
    const { system } = new PromptBuilder().build(await input([], { useTools: false }));
    expect(system).toContain('```action');
    expect(system).toContain('<action_result>');
  });

  it('caps the state JSON and ignores the size of the asset list', async () => {
    const pack = await luna();
    const assets = Array.from({ length: 250 }, (_, i) => ({ path: `media/images/${i}.png`, kind: 'image' as const, bytes: 1, mime: 'image/png' }));
    const big = { blob: 'x'.repeat(10_000) };
    const { system } = new PromptBuilder().build(await input([], { pack: { ...pack, assets }, state: big }));
    expect(system).not.toContain('media/images/249.png');
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

  it('replays action code without its comments, in both tool and fenced form', () => {
    const code = [
      '// purpose: show the photo',
      'const url = await sdk.pack.asset("beach.jpg"); // the one from summer',
      '/* the model thinking out loud, at length */',
      'await sdk.media.show({ url });',
    ].join('\n');
    const stripped = 'const url = await sdk.pack.asset("beach.jpg");\nawait sdk.media.show({ url });';
    const transcript = [msg(1, 'assistant', 'here', { actions: [{ id: 'a1', purpose: 'p', code, language: 'ts' as const, source: 'tool' as const, startedAt: 't' }] })];

    const [tooled] = transcriptToMessages(transcript, true);
    expect(tooled!.content[1]).toEqual({ type: 'tool_use', id: 'a1', name: 'run_action', input: { purpose: 'p', code: stripped } });

    const [fenced] = transcriptToMessages(transcript, false);
    expect(fenced!.content[0]).toEqual({ type: 'text', text: `here\n\n\`\`\`action\n// purpose: p\n${stripped}\n\`\`\`` });
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

describe('engine rules', () => {
  it('tells the character to use the sdk rather than describe using it', async () => {
    const { system } = new PromptBuilder().build(await input([msg(1, 'user', 'hi')]));
    const rules = system.slice(system.indexOf('<engine_rules>'), system.indexOf('</engine_rules>'));
    // The failure this guards against: a character that narrates an action it never ran.
    expect(rules).toContain('Never mime what you can actually do');
    expect(rules).toContain('*shows you the photo*');
    expect(rules).toMatch(/Reach for the sdk whenever/);
    // …without turning into a machine that acts for its own sake.
    expect(rules).toContain('Do not act for the sake of acting');
    expect(rules).toContain('one action per intention');
  });
});

describe('errorForModel', () => {
  /** What the sandbox produces for a failing action, already mapped to the model's own source. */
  const sandboxError = {
    code: 'SANDBOX_RUNTIME' as const,
    message: "TypeError: cannot read property 'deep' of undefined",
    stack: '    at pick (action.ts:3:3)\n    at <your code> (action.ts:5:8)',
    details: { name: 'TypeError', line: 3, column: 29, frame: "> 3 |   return list.find((x) => x.missing.deep);\n    |                             ^" },
  };

  it('hands the model the position, the quoted line and the stack, so it can fix and retry', () => {
    const out = errorForModel(sandboxError);
    expect(out).toMatchObject({
      code: 'SANDBOX_RUNTIME',
      message: sandboxError.message,
      line: 3,
      column: 29,
      stack: sandboxError.stack,
    });
    expect(out['frame']).toContain('> 3 |');
  });

  it('keeps working for errors that carry nothing to point at', () => {
    expect(errorForModel({ code: 'PERMISSION_DENIED', message: 'denied' })).toEqual({ code: 'PERMISSION_DENIED', message: 'denied' });
  });

  it('is the same shape live and in the replayed transcript', () => {
    const result = { ok: false, error: sandboxError, logs: [], calls: [], durationMs: 1 };
    const live = resultPayload(result);
    const replayed = transcriptToMessages(
      [msg(1, 'assistant', 'text', { actions: [{ id: 'a1', purpose: 'p', code: 'return 1;', language: 'ts' as const, source: 'fence' as const, startedAt: 't', result }] })],
      false,
    );
    const rendered = replayed.flatMap((m) => m.content).map((part) => ('text' in part ? part.text : '')).join('\n');
    expect(rendered).toContain('<action_result>');
    expect(rendered).toContain(JSON.stringify(live.error));
  });
});
