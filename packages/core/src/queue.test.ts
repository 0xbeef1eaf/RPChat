/**
 * Messages the user sends while the character is still answering. They wait in the engine's
 * queue, the next turn takes the whole batch, and until it does the user can take one back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '@rp/shared';
import { ECHO_REF, MINIMAL_DIR, MINIMAL_ID, createTestEngine, runAction } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

/** A promise plus the handle to settle it, for holding a run open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function until(ready: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const turnStarts = (engine: TestEngine): ChatEvent[] => engine.events.filter((e) => e.type === 'turn-started');
const queueSizes = (engine: TestEngine): number[] =>
  engine.events.filter((e): e is Extract<ChatEvent, { type: 'queue-changed' }> => e.type === 'queue-changed').map((e) => e.queued.length);

describe('queued messages', () => {
  it('answers everything sent during a reply in a single next turn', async () => {
    const turnAction = gate();
    let parked = false;
    t = await createTestEngine({
      // The first turn spends its action parked on the gate, so the reply is still in flight
      // while the next two messages arrive; the third script entry is the batch's own reply.
      script: [{ text: 'one moment', toolCalls: [runAction('return 1;')] }, { text: 'done' }, { text: 'answering you both' }],
      runnerHandler: async (request) => {
        if (request.context.trigger.kind === 'llm') {
          parked = true;
          await turnAction.wait;
        }
        return undefined;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    const first = t.engine.chat.send(session.id, 'are you there');
    await until(() => parked, 'the first turn to park in its action');
    const second = t.engine.chat.send(session.id, 'hello?');
    const third = t.engine.chat.send(session.id, 'and one more thing');
    await until(() => t.engine.chat.queued(session.id).length === 2, 'both messages to be queued');
    expect(t.engine.chat.queued(session.id).map((m) => m.text)).toEqual(['hello?', 'and one more thing']);

    turnAction.open();
    await Promise.all([first, second, third]);

    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['are you there', 'hello?', 'and one more thing']);
    // One reply covering both queued messages, not one turn each.
    expect(messages.at(-1)!.content).toBe('answering you both');
    expect(turnStarts(t)).toHaveLength(2);
    expect(t.engine.chat.queued(session.id)).toEqual([]);
    // Queued, taken by the turn; queued, queued, taken by the next one.
    expect(queueSizes(t)).toEqual([1, 0, 1, 2, 0]);
  });

  it('takes a queued message back before any turn has said it', async () => {
    const turnAction = gate();
    let parked = false;
    t = await createTestEngine({
      script: [{ text: 'one moment', toolCalls: [runAction('return 1;')] }, { text: 'done' }],
      runnerHandler: async (request) => {
        if (request.context.trigger.kind === 'llm') {
          parked = true;
          await turnAction.wait;
        }
        return undefined;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    const first = t.engine.chat.send(session.id, 'are you there');
    await until(() => parked, 'the first turn to park in its action');
    const regretted = t.engine.chat.send(session.id, 'never mind');
    await until(() => t.engine.chat.queued(session.id).length === 1, 'the message to be queued');

    const entry = t.engine.chat.queued(session.id)[0]!;
    expect(await t.engine.chat.unqueue(session.id, entry.id)).toBe(true);
    // Gone: a second attempt, and one for a message that was never queued, both say so.
    expect(await t.engine.chat.unqueue(session.id, entry.id)).toBe(false);
    expect(t.engine.chat.queued(session.id)).toEqual([]);

    turnAction.open();
    // The `send` that queued it resolves as well: the user took it back, which is not a failure.
    await Promise.all([first, regretted]);

    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.map((m) => m.content)).not.toContain('never mind');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(turnStarts(t)).toHaveLength(1);
  });

  it('drops the queue when the history it was meant for is cleared', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'said before the clear');

    // `runExclusive` is the Sandbox tab's path and holds the session's turn queue, so the message
    // below queues without a reply having to be in flight (and without a turn to abort).
    const held = gate();
    const holding = t.engine.chat.runExclusive(session.id, () => held.wait);
    const dropped = t.engine.chat.send(session.id, 'never said');
    await until(() => t.engine.chat.queued(session.id).length === 1, 'the message to be queued');

    const clearing = t.engine.chat.clearMessages(session.id);
    await until(() => t.engine.chat.queued(session.id).length === 0, 'the queue to be dropped');
    held.open();
    await Promise.all([holding, clearing, dropped]);

    expect(await t.engine.sessions.messages(session.id)).toEqual([]);
    // Only the first message's turn ever ran: the dropped one never became a reply.
    expect(turnStarts(t)).toHaveLength(1);
  });

  it('skips the batch reply only when every message in it asked to', async () => {
    t = await createTestEngine({ script: [{ text: 'a reply is still owed' }] });
    await t.engine.packs.install(MINIMAL_DIR);
    // Give echo an onUserMessage behaviour by patching the loaded pack in memory.
    t.engine.packs.getLoaded(MINIMAL_ID).characters[0]!.behaviourSources.onUserMessage = 'return { skipLlm: input.text === "handled by the script" };';
    t.runner.setHandler(async (request) => {
      if (request.context.trigger.kind !== 'behaviour') return undefined;
      // Matched on the hook's input, not on its source — which quotes the same words.
      return { skipLlm: request.code.includes('{"text":"handled by the script"}') };
    });
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    const held = gate();
    const holding = t.engine.chat.runExclusive(session.id, () => held.wait);
    const scripted = t.engine.chat.send(session.id, 'handled by the script');
    const spoken = t.engine.chat.send(session.id, 'but this one wants an answer');
    await until(() => t.engine.chat.queued(session.id).length === 2, 'both messages to be queued');
    held.open();
    await Promise.all([holding, scripted, spoken]);

    expect(t.provider.requests).toHaveLength(1);
    expect((await t.engine.sessions.messages(session.id)).at(-1)).toMatchObject({ role: 'assistant', content: 'a reply is still owed' });
  });

  it('forgets a deleted session’s queue instead of failing the sender', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    const held = gate();
    const holding = t.engine.chat.runExclusive(session.id, () => held.wait);
    const orphaned = t.engine.chat.send(session.id, 'into the void');
    await until(() => t.engine.chat.queued(session.id).length === 1, 'the message to be queued');

    const removing = t.engine.sessions.remove(session.id);
    await until(() => t.engine.chat.queued(session.id).length === 0, 'the queue to be forgotten');
    held.open();
    await Promise.all([holding, removing, orphaned]);
    expect(await t.engine.sessions.get(session.id)).toBeUndefined();
  });
});
