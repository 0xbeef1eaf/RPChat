import { describe, expect, it } from 'vitest';
import type { LlmMessage } from '@rp/shared';
import { estimateMessageTokens, estimateTokens, groupToolPairs, windowMessages } from './tokens.js';

const user = (text: string): LlmMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): LlmMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolUse = (id: string, text = ''): LlmMessage => ({
  role: 'assistant',
  content: [
    ...(text ? [{ type: 'text' as const, text }] : []),
    { type: 'tool_use', id, name: 'run_action', input: { purpose: 'p', code: 'return 1;' } },
  ],
});
const toolResult = (id: string, text = ''): LlmMessage => ({
  role: 'user',
  content: [
    { type: 'tool_result', toolUseId: id, content: '{"ok":true}' },
    ...(text ? [{ type: 'text' as const, text }] : []),
  ],
});

describe('estimateTokens', () => {
  it('is ~chars/4, rounded up, and 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });

  it('counts tool_use input as JSON text', () => {
    const big = { purpose: 'p', code: 'x'.repeat(400) };
    const msg: LlmMessage = { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'run_action', input: big }] };
    expect(estimateMessageTokens(msg)).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(big)));
    expect(estimateMessageTokens(user(''))).toBeGreaterThan(0); // per-message overhead
  });
});

describe('groupToolPairs', () => {
  it('glues a tool_use message to its tool_result reply', () => {
    const groups = groupToolPairs([user('a'), toolUse('1'), toolResult('1'), assistant('b')]);
    expect(groups.map((g) => g.length)).toEqual([1, 2, 1]);
  });

  it('does not glue a user message that does not reference the tool ids', () => {
    const groups = groupToolPairs([toolUse('1'), user('unrelated')]);
    expect(groups.map((g) => g.length)).toEqual([1, 1]);
  });
});

describe('windowMessages', () => {
  it('returns everything when within budget', () => {
    const msgs = [user('hello'), assistant('hi'), user('how are you')];
    expect(windowMessages(msgs, 10_000)).toEqual(msgs);
  });

  it('drops oldest first and always keeps the last message', () => {
    const msgs = [user('a'.repeat(400)), assistant('b'.repeat(400)), user('c'.repeat(400))];
    expect(windowMessages(msgs, 150)).toEqual([msgs[2]]);
    expect(windowMessages(msgs, 1)).toEqual([msgs[2]]);
    expect(windowMessages(msgs, 250)).toEqual([msgs[1], msgs[2]]);
    expect(windowMessages([], 100)).toEqual([]);
  });

  it('never splits a tool_use/tool_result pair', () => {
    const msgs = [user('x'.repeat(400)), toolUse('1', 'y'.repeat(200)), toolResult('1'), assistant('done')];
    const pairCost = estimateMessageTokens(msgs[1]!) + estimateMessageTokens(msgs[2]!);
    const lastCost = estimateMessageTokens(msgs[3]!);
    // Enough for the last message and the tool_result alone, but not the whole pair.
    const tight = lastCost + estimateMessageTokens(msgs[2]!) + 1;
    expect(tight).toBeLessThan(lastCost + pairCost);
    expect(windowMessages(msgs, tight)).toEqual([msgs[3]]);
    // Enough for the pair too.
    expect(windowMessages(msgs, lastCost + pairCost)).toEqual([msgs[1], msgs[2], msgs[3]]);
  });

  it('keeps the pair when the last message is the tool_result', () => {
    const msgs = [user('x'.repeat(400)), toolUse('1', 'y'.repeat(400)), toolResult('1')];
    expect(windowMessages(msgs, 1)).toEqual([msgs[1], msgs[2]]);
  });

  it('keeps multi-round tool loops intact per round', () => {
    const msgs = [user('q'), toolUse('1'), toolResult('1'), toolUse('2'), toolResult('2', 'follow-up'), assistant('end')];
    const cost = (ms: LlmMessage[]): number => ms.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const budget = cost([msgs[3]!, msgs[4]!, msgs[5]!]);
    expect(windowMessages(msgs, budget)).toEqual([msgs[3], msgs[4], msgs[5]]);
  });
});
