import { describe, expect, it } from 'vitest';
import type { ActionRecord, ChatMessage, ModelExchange, PermissionRequest, Session } from '@rp/shared';
import {
  MAX_EXCHANGES,
  applyChatEvent,
  clearExchanges,
  dequeuePermissionRequest,
  enqueuePermissionRequest,
  pushToast,
  removeSession,
  setMessages,
  setSessions,
  upsertSession,
} from './reducers';
import { initialState, runtimeFor, type AppState } from './state';

const S = 'session-1';

function msg(id: string, content = '', extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, sessionId: S, role: 'assistant', content, createdAt: '2026-01-01T00:00:00Z', ...extra };
}

function session(id: string, updatedAt: string): Session {
  return {
    id,
    characterRef: 'com.example.pack/luna',
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
  };
}

function loaded(): AppState {
  return setMessages(initialState(), S, [msg('m1', 'hello')]);
}

describe('applyChatEvent', () => {
  it('tracks turn start/finish and clears errors on a new turn', () => {
    let s = initialState();
    s = applyChatEvent(s, { type: 'error', sessionId: S, error: { code: 'INTERNAL', message: 'boom' } });
    expect(runtimeFor(s, S).error?.message).toBe('boom');
    s = applyChatEvent(s, { type: 'turn-started', sessionId: S, turnId: 't1' });
    expect(runtimeFor(s, S)).toEqual({ turnId: 't1', status: null, error: null, eventMarkers: [], eventsVersion: 0, exchanges: [] });
    s = applyChatEvent(s, { type: 'turn-finished', sessionId: S, turnId: 't1' });
    expect(runtimeFor(s, S).turnId).toBeNull();
  });

  it('error ends the running turn', () => {
    let s = applyChatEvent(initialState(), { type: 'turn-started', sessionId: S, turnId: 't1' });
    s = applyChatEvent(s, { type: 'error', sessionId: S, error: { code: 'LLM_PROVIDER', message: '401' } });
    expect(runtimeFor(s, S).turnId).toBeNull();
    expect(runtimeFor(s, S).error?.code).toBe('LLM_PROVIDER');
  });

  it('sets and clears the status line', () => {
    let s = applyChatEvent(initialState(), { type: 'status', sessionId: S, text: 'thinking…' });
    expect(runtimeFor(s, S).status).toBe('thinking…');
    s = applyChatEvent(s, { type: 'status', sessionId: S, text: null });
    expect(runtimeFor(s, S).status).toBeNull();
  });

  it('ignores message events for sessions that are not loaded', () => {
    const s = initialState();
    const next = applyChatEvent(s, { type: 'message-added', sessionId: 'other', message: msg('x') });
    expect(next).toBe(s);
    expect(next.messages['other']).toBeUndefined();
  });

  it('appends new messages and de-duplicates by id', () => {
    let s = loaded();
    s = applyChatEvent(s, { type: 'message-added', sessionId: S, message: msg('m2', 'a') });
    s = applyChatEvent(s, { type: 'message-added', sessionId: S, message: msg('m2', 'b') });
    expect(s.messages[S]?.map((m) => [m.id, m.content])).toEqual([
      ['m1', 'hello'],
      ['m2', 'b'],
    ]);
  });

  it('drops removed messages and empties the list on clear', () => {
    let s = loaded();
    s = applyChatEvent(s, { type: 'message-added', sessionId: S, message: msg('m2', 'a') });
    s = applyChatEvent(s, { type: 'message-removed', sessionId: S, messageId: 'm1' });
    expect(s.messages[S]?.map((m) => m.id)).toEqual(['m2']);
    s = applyChatEvent(s, { type: 'messages-cleared', sessionId: S });
    expect(s.messages[S]).toEqual([]);
    expect(applyChatEvent(initialState(), { type: 'messages-cleared', sessionId: 'other' }).messages['other']).toEqual([]);
  });

  it('session-reset clears the status, error and markers and bumps the events version', () => {
    let s = loaded();
    s = applyChatEvent(s, { type: 'status', sessionId: S, text: 'thinking' });
    s = applyChatEvent(s, { type: 'event-fired', sessionId: S, subscriptionId: 'sub', event: 'user-back' });
    const version = s.runtime[S]!.eventsVersion;
    s = applyChatEvent(s, { type: 'session-reset', sessionId: S });
    expect(s.runtime[S]).toMatchObject({ status: null, error: null, eventMarkers: [], eventsVersion: version + 1 });
    expect(applyChatEvent(initialState(), { type: 'session-reset', sessionId: 'other' })).toEqual(initialState());
  });

  it('concatenates text deltas onto the right message', () => {
    let s = loaded();
    s = applyChatEvent(s, { type: 'message-added', sessionId: S, message: msg('m2', '') });
    s = applyChatEvent(s, { type: 'text-delta', sessionId: S, messageId: 'm2', delta: 'Hel' });
    s = applyChatEvent(s, { type: 'text-delta', sessionId: S, messageId: 'm2', delta: 'lo' });
    expect(s.messages[S]?.[1]?.content).toBe('Hello');
    expect(s.messages[S]?.[0]?.content).toBe('hello');
    // unknown message id: no-op
    const same = applyChatEvent(s, { type: 'text-delta', sessionId: S, messageId: 'nope', delta: 'x' });
    expect(same).toBe(s);
  });

  it('message-updated replaces the message', () => {
    let s = loaded();
    s = applyChatEvent(s, { type: 'message-updated', sessionId: S, message: msg('m1', 'final', { usage: { inputTokens: 1, outputTokens: 2 } }) });
    expect(s.messages[S]?.[0]?.content).toBe('final');
    expect(s.messages[S]?.[0]?.usage?.outputTokens).toBe(2);
  });

  it('action-started adds and action-finished replaces the action record', () => {
    const started: ActionRecord = { id: 'a1', purpose: 'show pic', code: 'return 1', language: 'ts', source: 'tool', startedAt: 'now' };
    const finished: ActionRecord = {
      ...started,
      result: { ok: true, returnValue: 1, logs: [], calls: [], durationMs: 12 },
    };
    let s = loaded();
    s = applyChatEvent(s, { type: 'action-started', sessionId: S, messageId: 'm1', action: started });
    expect(s.messages[S]?.[0]?.actions).toEqual([started]);
    s = applyChatEvent(s, { type: 'action-started', sessionId: S, messageId: 'm1', action: { ...started, id: 'a2' } });
    s = applyChatEvent(s, { type: 'action-finished', sessionId: S, messageId: 'm1', action: finished });
    expect(s.messages[S]?.[0]?.actions?.map((a) => [a.id, a.result?.ok])).toEqual([
      ['a1', true],
      ['a2', undefined],
    ]);
  });

  it('memory-added bumps memoryVersion and leaves messages alone', () => {
    const s = loaded();
    const next = applyChatEvent(s, {
      type: 'memory-added',
      sessionId: S,
      memory: { id: 'mem1', characterRef: 'p/c', text: 'likes tea', tags: [], importance: 3, source: 'character', createdAt: 'now', updatedAt: 'now', recallCount: 0 },
    });
    expect(next.memoryVersion).toBe(s.memoryVersion + 1);
    expect(next.messages).toBe(s.messages);
  });

  it('model-exchange appends to the session runtime (capped), messages-cleared and clearExchanges empty it', () => {
    const exchange = (id: string): ModelExchange => ({
      id,
      sessionId: S,
      kind: 'turn',
      round: 0,
      startedAt: '2026-01-01T00:00:00Z',
      request: { provider: 'Mock', model: 'm', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      response: { message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' },
    });
    // tracked even before the session's messages are loaded
    let s = initialState();
    for (let i = 0; i < MAX_EXCHANGES + 5; i += 1) s = applyChatEvent(s, { type: 'model-exchange', sessionId: S, exchange: exchange(`x${i}`) });
    const kept = runtimeFor(s, S).exchanges;
    expect(kept).toHaveLength(MAX_EXCHANGES);
    expect(kept[0]?.id).toBe('x5');
    expect(kept.at(-1)?.id).toBe(`x${MAX_EXCHANGES + 4}`);
    expect(s.messages[S]).toBeUndefined();

    const other = applyChatEvent(s, { type: 'model-exchange', sessionId: 'other', exchange: { ...exchange('o1'), sessionId: 'other' } });
    expect(runtimeFor(other, S).exchanges).toBe(kept);
    expect(runtimeFor(other, 'other').exchanges.map((x) => x.id)).toEqual(['o1']);

    expect(clearExchanges(s, 'unknown')).toBe(s);
    expect(runtimeFor(clearExchanges(s, S), S).exchanges).toEqual([]);
    expect(runtimeFor(applyChatEvent(s, { type: 'messages-cleared', sessionId: S }), S).exchanges).toEqual([]);
  });

  it('event-fired appends an inline marker and bumps eventsVersion', () => {
    let s = loaded();
    s = applyChatEvent(s, { type: 'event-fired', sessionId: S, subscriptionId: 'sub1', event: 'user-idle' });
    s = applyChatEvent(s, { type: 'event-fired', sessionId: S, subscriptionId: 'sub2', event: 'time' });
    expect(runtimeFor(s, S).eventMarkers.map((m) => m.event)).toEqual(['user-idle', 'time']);
    expect(runtimeFor(s, S).eventsVersion).toBe(2);
    for (let i = 0; i < 40; i++) s = applyChatEvent(s, { type: 'event-fired', sessionId: S, subscriptionId: 'x', event: 'time' });
    expect(runtimeFor(s, S).eventMarkers.length).toBeLessThanOrEqual(30);
  });

  it('mood/routine changes bump the character status version of the session owner', () => {
    let s = setSessions(loaded(), [session(S, '2026-01-01T00:00:00Z')]);
    s = applyChatEvent(s, { type: 'mood-changed', sessionId: S, mood: { mood: 0.4, energy: 0.6, tags: [], updatedAt: 'now', recent: [] } });
    s = applyChatEvent(s, { type: 'routine-changed', sessionId: S, routine: { state: 'busy' } });
    expect(s.characterStatusVersion['com.example.pack/luna']).toBe(2);
    expect(applyChatEvent(s, { type: 'mood-changed', sessionId: 'unknown', mood: { mood: 0, energy: 0, tags: [], updatedAt: 'now', recent: [] } })).toBe(s);
  });

  it('does not mutate the previous state', () => {
    const s = loaded();
    const before = JSON.stringify(s);
    applyChatEvent(s, { type: 'text-delta', sessionId: S, messageId: 'm1', delta: '!' });
    applyChatEvent(s, { type: 'turn-started', sessionId: S, turnId: 't' });
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('sessions', () => {
  it('setSessions sorts newest first and drops a vanished active session', () => {
    let s: AppState = { ...initialState(), activeSessionId: 'gone' };
    s = setSessions(s, [session('old', '2026-01-01T00:00:00Z'), session('new', '2026-02-01T00:00:00Z')]);
    expect(s.sessions.map((x) => x.id)).toEqual(['new', 'old']);
    expect(s.activeSessionId).toBeNull();
  });

  it('upsertSession replaces by id and re-sorts', () => {
    let s = setSessions(initialState(), [session('a', '2026-01-01T00:00:00Z'), session('b', '2026-01-02T00:00:00Z')]);
    s = upsertSession(s, { ...session('a', '2026-03-01T00:00:00Z'), title: 'renamed' });
    expect(s.sessions.map((x) => x.id)).toEqual(['a', 'b']);
    expect(s.sessions[0]?.title).toBe('renamed');
  });

  it('removeSession drops messages, runtime and the active pointer', () => {
    let s = setSessions(loaded(), [session(S, '2026-01-01T00:00:00Z')]);
    s = { ...s, activeSessionId: S };
    s = applyChatEvent(s, { type: 'status', sessionId: S, text: 'x' });
    s = removeSession(s, S);
    expect(s.sessions).toEqual([]);
    expect(s.messages[S]).toBeUndefined();
    expect(s.runtime[S]).toBeUndefined();
    expect(s.activeSessionId).toBeNull();
  });
});

describe('queues', () => {
  const req = (id: string): PermissionRequest => ({
    requestId: id,
    call: { callId: 'c', module: 'system', method: 'exec', args: ['ls'] },
    context: { packId: 'p', characterId: 'c', sessionId: S },
    description: 'run a command',
    dangerous: true,
  });

  it('permission requests are FIFO and de-duplicated', () => {
    let s = enqueuePermissionRequest(initialState(), req('r1'));
    s = enqueuePermissionRequest(s, req('r2'));
    s = enqueuePermissionRequest(s, req('r1'));
    expect(s.permissionRequests.map((r) => r.requestId)).toEqual(['r1', 'r2']);
    s = dequeuePermissionRequest(s, 'r1');
    expect(s.permissionRequests.map((r) => r.requestId)).toEqual(['r2']);
  });

  it('toasts are capped', () => {
    let s = initialState();
    for (let i = 0; i < 10; i++) s = pushToast(s, { id: `t${i}`, kind: 'info', text: String(i) });
    expect(s.toasts.length).toBeLessThanOrEqual(4);
    expect(s.toasts.at(-1)?.id).toBe('t9');
  });
});

describe('mergeRows', () => {
  it('hides self-wake notes and keeps other system messages', async () => {
    const { mergeRows, isWakeNote } = await import('../components/chat/MessageList');
    const { SELF_WAKE_PREFIX } = await import('@rp/shared');
    const wake = { ...msg('w', `${SELF_WAKE_PREFIX}check on them`), role: 'system' as const, origin: 'timer' as const };
    const sys = { ...msg('s', 'pack updated'), role: 'system' as const };
    const reply = { ...msg('r', 'Hey, thinking of you.'), role: 'assistant' as const, origin: 'timer' as const };
    expect(isWakeNote(wake)).toBe(true);
    expect(isWakeNote(sys)).toBe(false);
    expect(mergeRows([wake, sys, reply], []).map((row) => (row.kind === 'message' ? row.message.id : row.marker.id))).toEqual(['s', 'r']);
  });
});
