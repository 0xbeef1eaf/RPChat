/**
 * A pending question outlives the code that asked it, so the bookkeeping around it has to be
 * exact: the window it is asked in must be closed however the question ends, and closing the
 * chat window must not answer questions that are being asked somewhere else.
 */
import { describe, expect, it, vi } from 'vitest';
import { PendingPrompts } from './prompts.js';

describe('PendingPrompts', () => {
  it('tells the caller which prompt settled, however it settled', async () => {
    const settled: string[] = [];
    const prompts = new PendingPrompts<string>({ fallback: 'no', onSettled: (id) => settled.push(id) });

    const answered = prompts.ask('a', () => true);
    expect(prompts.respond('a', 'yes')).toBe(true);
    expect(await answered).toBe('yes');

    // Undeliverable: resolved with the fallback there and then, and still reported.
    expect(await prompts.ask('b', () => false)).toBe('no');

    const pending = prompts.ask('c', () => true);
    prompts.rejectAll();
    expect(await pending).toBe('no');

    expect(settled).toEqual(['a', 'b', 'c']);
    expect(prompts.size).toBe(0);
  });

  it('treats a deliver() that threw as undeliverable', async () => {
    const prompts = new PendingPrompts<string>({ fallback: 'no' });
    expect(
      await prompts.ask('a', () => {
        throw new Error('no window');
      }),
    ).toBe('no');
  });

  it('answers the timeout with the fallback', async () => {
    vi.useFakeTimers();
    try {
      const settled: string[] = [];
      const prompts = new PendingPrompts<string>({ fallback: 'no', timeoutMs: 1000, onSettled: (id) => settled.push(id) });
      const pending = prompts.ask('a', () => true);
      vi.advanceTimersByTime(1001);
      expect(await pending).toBe('no');
      expect(settled).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects only the prompts a filter accepts', async () => {
    const prompts = new PendingPrompts<string>({ fallback: 'no' });
    const inMain = prompts.ask('in-main', () => true);
    const ownWindow = prompts.ask('own-window', () => true);

    // What the main window closing does: everything except the questions with a window of their own.
    prompts.rejectAll((id) => id !== 'own-window');

    expect(await inMain).toBe('no');
    expect(prompts.has('own-window')).toBe(true);
    expect(prompts.respond('own-window', 'yes')).toBe(true);
    expect(await ownWindow).toBe('yes');
  });
});
