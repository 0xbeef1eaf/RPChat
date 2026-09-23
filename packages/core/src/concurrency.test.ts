import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, Json } from '@rp/shared';
import { ECHO_REF, MINIMAL_DIR, MINIMAL_ID, createTestEngine, runAction } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';
import { TimerService } from './services/timers.js';
import { MemoryStorage } from './storage/memory.js';

const silentLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

let t: TestEngine | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

function ctxFor(sessionId: string): ActionContext {
  return {
    packId: MINIMAL_ID,
    characterId: 'echo',
    sessionId,
    packRoot: t!.engine.packs.getLoaded(MINIMAL_ID).root,
    trigger: { kind: 'llm', actionId: 'a', messageId: 'm' },
  };
}

const invoke = (context: ActionContext, module: string, method: string, ...args: Json[]) =>
  t!.engine.dispatcher.invoke({ callId: `${module}.${method}`, module, method, args, context });

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

describe('background code runs alongside the character', () => {
  it('runs a code timer while a turn is still in flight', async () => {
    const turnAction = gate();
    const ran: string[] = [];
    t = await createTestEngine({
      script: [{ text: 'thinking', toolCalls: [runAction('return 1;')] }, { text: 'done' }],
      runnerHandler: async (request) => {
        ran.push(request.context.trigger.kind);
        // The turn's own action parks here; the timer that fires meanwhile must not queue behind it.
        if (request.context.trigger.kind === 'llm') await turnAction.wait;
        return undefined;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    expect((await invoke(ctxFor(session.id), 'timers', 'runLater', 5000, 'return "tick";')).ok).toBe(true);

    const turn = t.engine.chat.send(session.id, 'hello');
    await until(() => ran.includes('llm'), 'the turn to reach its action');

    t.clock.advance(5000);
    const fired = t.engine.timers.fireDue();
    await until(() => ran.includes('timer'), 'the code timer to run');
    expect(ran).toContain('timer'); // ...while the turn is still parked in its action

    turnAction.open();
    await turn;
    expect(await fired).toBe(1);
  });

  it('does not report the session as busy while only background code is running', async () => {
    const timerRun = gate();
    let running = false;
    t = await createTestEngine({
      runnerHandler: async (request) => {
        if (request.context.trigger.kind !== 'timer') return undefined;
        running = true;
        await timerRun.wait;
        running = false;
        return undefined;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    expect((await invoke(ctxFor(session.id), 'timers', 'runLater', 5000, 'return "tick";')).ok).toBe(true);

    t.clock.advance(5000);
    const fired = t.engine.timers.fireDue();
    await until(() => running, 'the code timer to start');
    expect(t.engine.chat.isBusy(session.id)).toBe(false);
    timerRun.open();
    await fired;
  });

  it('fires timers of different sessions at the same time', async () => {
    // Through TimerService directly: `fireDue` is the deterministic helper and awaits each timer
    // in turn, so it cannot show this. `start()` takes the path a real overdue timer takes.
    const storage = new MemoryStorage();
    const now = (): Date => new Date();
    const at = new Date(Date.now() - 1000).toISOString();
    for (const id of ['t-a', 't-b']) {
      await storage.timers.upsert({
        id,
        sessionId: `session-${id}`,
        characterRef: ECHO_REF,
        kind: 'code',
        fireAt: at,
        payload: null,
        createdAt: at,
        code: 'return 1;',
      });
    }
    const held = gate();
    let inside = 0;
    let peak = 0;
    const timers = new TimerService(storage, now, silentLogger);
    timers.setFireHandler(async () => {
      inside++;
      peak = Math.max(peak, inside);
      await held.wait;
      inside--;
    });
    await timers.start();
    try {
      await until(() => peak === 2, 'both timers to be running');
    } finally {
      held.open();
      await timers.stop();
    }
  });

  it('never lets a repeating code timer overlap itself', async () => {
    let inside = 0;
    let peak = 0;
    let runs = 0;
    t = await createTestEngine({
      runnerHandler: async (request) => {
        if (request.context.trigger.kind !== 'timer') return undefined;
        inside++;
        peak = Math.max(peak, inside);
        runs++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        inside--;
        return undefined;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    expect(
      (await invoke(ctxFor(session.id), 'timers', 'runLater', 5000, 'return "tick";', { repeatEveryMs: 60_000, maxRuns: 3 })).ok,
    ).toBe(true);

    for (let i = 0; i < 3; i++) {
      t.clock.advance(60_000);
      await t.engine.timers.fireDue();
    }
    await t.engine.chat.idle(session.id);
    expect(runs).toBe(3);
    expect(peak).toBe(1);
  });

  it('keeps what background code said when the reply is retried', async () => {
    t = await createTestEngine({
      script: [{ text: 'first reply' }, { text: 'second reply' }],
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'hello');

    // A timer spoke after the reply landed; its message belongs to no turn.
    await t.engine.dispatcher.invoke({
      callId: 'chat.emote',
      module: 'chat',
      method: 'emote',
      args: ['the kettle is boiling'],
      context: { ...ctxFor(session.id), trigger: { kind: 'timer', timerId: 'tid' } },
    });

    await t.engine.chat.retry(session.id);
    const transcript = await t.engine.sessions.messages(session.id);
    const said = transcript.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(said).toContain('the kettle is boiling');
    expect(said).toContain('second reply');
    expect(said).not.toContain('first reply');
  });
});
