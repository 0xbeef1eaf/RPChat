import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeRunHandler } from './fake-runner.js';
import { RpError } from '@rp/shared';
import type { ChatEvent, ChatMessage, ContentPart } from '@rp/shared';
import { ACTION_LIMIT_NOTICE, ACTION_REPAIR_NOTICE } from './action-loop.js';
import {
  ECHO_REF,
  LUNA_DIR,
  LUNA_ID,
  LUNA_REF,
  MINIMAL_DIR,
  MINIMAL_ID,
  RecordingHandler,
  createTestEngine,
  createTestRegistryWithProbe,
  installLunaWith,
  runAction,
} from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe('PackService', () => {
  it('installs the example packs, lists characters and cleans up on uninstall', async () => {
    t = await createTestEngine();
    const minimal = await t.engine.packs.install(MINIMAL_DIR);
    const luna = await t.engine.packs.install(LUNA_DIR);

    expect(minimal.packId).toBe(MINIMAL_ID);
    expect(luna.packId).toBe(LUNA_ID);
    expect(luna.root).toBe(path.join(t.packsDir, LUNA_ID, '1.0.0'));
    expect(luna.readme).toContain('# Luna');
    // permissions are app-wide: the view carries no per-pack grant or request state
    expect(luna).not.toHaveProperty('grants');
    expect(luna).not.toHaveProperty('requestedCapabilities');
    expect(luna).not.toHaveProperty('effectiveCapabilities');
    // files were copied, not referenced in place
    await expect(fs.stat(path.join(luna.root, 'pack.json'))).resolves.toBeTruthy();

    const characters = t.engine.packs.characters();
    expect(characters.map((c) => c.ref).sort()).toEqual([LUNA_REF, ECHO_REF].sort());
    const lunaChar = characters.find((c) => c.ref === LUNA_REF)!;
    expect(lunaChar.avatarUrl).toBe(`rp-asset://${LUNA_ID}/characters/luna/avatar.png`);

    expect((await t.engine.packs.list()).map((p) => p.packId).sort()).toEqual([LUNA_ID, MINIMAL_ID].sort());

    await t.engine.packs.uninstall(LUNA_ID);
    expect(await t.storage.packs.get(LUNA_ID)).toBeUndefined();
    expect(t.engine.packs.characters().map((c) => c.ref)).toEqual([ECHO_REF]);
    await expect(fs.stat(path.join(t.packsDir, LUNA_ID))).rejects.toThrow();
    expect(() => t!.engine.packs.getLoaded(LUNA_ID)).toThrow(RpError);
  });

  it('re-installing the same pack replaces it and keeps the app-wide policy untouched', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(LUNA_DIR);
    await t.engine.settings.update({ permissions: { functionAllow: { ui: false } } });
    await t.engine.packs.install(LUNA_DIR);
    expect(await t.engine.packs.list()).toHaveLength(1);
    expect((await t.engine.settings.get()).permissions.functionAllow).toEqual({ ui: false });
    // A module-level entry denies each of the module's functions in turn.
    expect(Object.keys((await t.engine.permissions.effective(LUNA_ID)).denied)).toEqual(expect.arrayContaining(['ui.notify', 'ui.ask']));
    expect(Object.keys((await t.engine.permissions.effective(LUNA_ID)).denied).every((k) => k.startsWith('ui.'))).toBe(true);
  });

  it('installs packs whose legacy "capabilities" key names modules this app does not know (the key is ignored)', async () => {
    t = await createTestEngine();
    const dir = path.join(t.packsDir, 'src-legacy');
    await fs.mkdir(path.join(dir, 'characters', 'x'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'pack.json'),
      JSON.stringify({ formatVersion: 1, id: 'com.example.legacy', name: 'Legacy', version: '1.0.0', characters: ['characters/x'], capabilities: ['teleport'] }),
    );
    await fs.writeFile(path.join(dir, 'characters', 'x', 'character.json'), JSON.stringify({ id: 'x', name: 'X', persona: 'persona.md' }));
    await fs.writeFile(path.join(dir, 'characters', 'x', 'persona.md'), 'You are X.');
    const view = await t.engine.packs.install(dir);
    expect(view.packId).toBe('com.example.legacy');
    expect('capabilities' in view.manifest).toBe(false);
    expect((await t.engine.packs.list()).map((p) => p.packId)).toEqual(['com.example.legacy']);
  });

  it('reloads installed packs on start', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const { storage, packsDir } = t;
    await t.engine.stop();
    t = await createTestEngine({ storage, packsDir });
    expect(t.engine.packs.characters().map((c) => c.ref)).toEqual([ECHO_REF]);
  });
});

describe('SessionService', () => {
  it('creates a session with the greeting and runs onSessionStart', async () => {
    const hooks: string[] = [];
    t = await createTestEngine({
      runnerHandler: async (request, runner) => {
        if (request.context.trigger.kind !== 'behaviour') return;
        hooks.push(request.context.trigger.hook);
        expect(request.code.startsWith('const input = null; ')).toBe(true);
        expect(request.code).toContain("sdk.state.set('sessions'");
        const surface = request.surface.modules.map((m) => m.id);
        expect(surface).toEqual(expect.arrayContaining(['chat', 'state', 'pack', 'timers']));
        expect(surface).toEqual(expect.arrayContaining(['media', 'ui', 'system'])); // every module is on unless switched off under Settings → Permissions
        await runner.call(request, 'chat', 'emote', 'Hey. I am Luna.');
        await runner.call(request, 'state', 'set', 'sessions', 1);
        return { sessions: 1 };
      },
    });
    await t.engine.packs.install(LUNA_DIR);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });

    expect(hooks).toEqual(['onSessionStart']);
    expect(session.title).toBe('Luna (Luna)');
    expect(session.messageCount).toBe(2);
    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.map((m) => [m.role, m.origin, m.content])).toEqual([
      ['assistant', 'greeting', "Hey, you made it. Pull up a chair. How's your day been treating you?"],
      ['assistant', 'behaviour', 'Hey. I am Luna.'],
    ]);
    expect(t.eventTypes(session.id)).toEqual(['message-added', 'message-added']);
    expect(await t.storage.state.get(`char:${LUNA_REF}`, 'sessions')).toBe(1);

    const audit = await t.engine.audit.list({ sessionId: session.id });
    expect(audit.map((a) => [a.module, a.method, a.outcome])).toEqual([
      ['chat', 'emote', 'allowed'],
      ['state', 'set', 'allowed'],
    ]);
  });

  it('removes messages, session state and timers with the session', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF, title: 'Echo test' });
    expect(session.title).toBe('Echo test');
    await t.storage.state.set(`session:${session.id}`, 'k', 1);
    await t.engine.timers.schedule({
      id: 'tm1',
      sessionId: session.id,
      characterRef: ECHO_REF,
      kind: 'wake',
      fireAt: '2030-01-01T00:00:00.000Z',
      payload: null,
      createdAt: t.clock.now().toISOString(),
    });
    await t.engine.sessions.remove(session.id);
    expect(await t.engine.sessions.get(session.id)).toBeUndefined();
    expect(await t.engine.sessions.messages(session.id)).toEqual([]);
    expect(await t.storage.state.keys(`session:${session.id}`)).toEqual([]);
    expect(await t.engine.timers.list()).toEqual([]);
  });

  it('refuses to create a session for an unknown character', async () => {
    t = await createTestEngine();
    await expect(t.engine.sessions.create({ characterRef: 'com.example.nope/x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ChatService turns', () => {
  it('runs a full tool-calling turn and persists the action result', async () => {
    t = await createTestEngine({
      script: [
        { text: 'Let me check.', toolCalls: [runAction('return await sdk.state.get("mood");', 'read mood', 'tu_1')] },
        { text: 'You seem happy!' },
      ],
      runnerHandler: async (request, runner) => {
        expect(request.context.trigger.kind).toBe('llm');
        expect(request.limits?.timeoutMs).toBe(10_000);
        const mood = await runner.call(request, 'state', 'get', 'mood');
        return { ok: true, returnValue: mood, logs: [{ level: 'info', message: 'looked up mood', at: 'now' }] };
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    await t.engine.settings.update({ permissions: { functionAllow: { media: false } } });
    await t.storage.state.set(`char:${ECHO_REF}`, 'mood', 'happy');
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    t.events.length = 0;

    await t.engine.chat.send(session.id, 'how do I seem?');

    expect(t.eventTypes()).toEqual([
      'message-added', // user message
      'turn-started',
      'message-added', // empty assistant message
      'text-delta',
      'text-delta',
      'action-started',
      'action-finished',
      'text-delta',
      'text-delta',
      'message-updated',
      'turn-finished',
    ]);

    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const reply = messages[1] as ChatMessage;
    expect(reply.content).toBe('Let me check.\n\nYou seem happy!');
    expect(reply.actions).toHaveLength(1);
    const action = reply.actions![0]!;
    expect(action.source).toBe('tool');
    expect(action.purpose).toBe('read mood');
    expect(action.result?.ok).toBe(true);
    expect(action.result?.returnValue).toBe('happy');
    expect(action.result?.calls.map((c) => `${c.module}.${c.method}`)).toEqual(['state.get']);
    expect(reply.usage?.inputTokens).toBeGreaterThan(0);
    expect(reply.error).toBeUndefined();

    // Second provider request carried the tool_use / tool_result pair.
    expect(t.provider.requests).toHaveLength(2);
    const second = t.provider.requests[1]!;
    expect(second.tools?.[0]?.name).toBe('run_action');
    const tail = second.messages.slice(-2);
    expect(tail[0]!.role).toBe('assistant');
    expect(tail[0]!.content.some((p) => p.type === 'tool_use' && p.id === 'tu_1')).toBe(true);
    expect(tail[1]!.role).toBe('user');
    const result = tail[1]!.content[0]!;
    expect(result.type).toBe('tool_result');
    if (result.type === 'tool_result') {
      expect(result.toolUseId).toBe('tu_1');
      expect(JSON.parse(result.content)).toEqual({ ok: true, returnValue: 'happy', logs: ['info: looked up mood'] });
    }
    // The system prompt carries the persona and the filtered SDK reference.
    expect(second.system).toContain('You are Echo');
    expect(second.system).toContain('<sdk_reference>');
    expect(second.system).toContain('## sdk.state —');
    expect(second.system).toContain('## sdk.ui —'); // on by default: nothing to request or grant
    expect(second.system).not.toContain('## sdk.media —'); // switched off under Settings → Permissions
    expect(second.system).not.toContain('## Not available'); // switched-off modules are not described at all
    expect(second.system).toContain('"mood": "happy"');
    expect(second.messages[0]!.role).toBe('user');
    expect(second.messages[0]!.content[0]).toEqual({ type: 'text', text: 'how do I seem?' });
  });

  it('falls back to fenced actions when the provider has no tool support', async () => {
    t = await createTestEngine({
      supportsTools: false,
      script: [
        { text: 'One sec.\n\n```action\n// purpose: count\nreturn 42;\n```\n' },
        { text: 'It is 42.' },
      ],
      runnerHandler: async (request) => {
        expect(request.code).toBe('return 42;');
        return 42;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'count please');

    expect(t.provider.requests[0]!.tools).toBeUndefined();
    expect(t.provider.requests[0]!.system).toContain('```action');
    const second = t.provider.requests[1]!;
    const tail = second.messages.slice(-2);
    expect(tail[0]!.content[0]).toEqual({ type: 'text', text: 'One sec.\n\n```action\n// purpose: count\nreturn 42;\n```\n' });
    expect(tail[1]!.content[0]).toEqual({ type: 'text', text: '<action_result>{"ok":true,"returnValue":42}</action_result>' });

    const reply = (await t.engine.sessions.messages(session.id)).at(-1)!;
    expect(reply.content).toBe('One sec.\n\nIt is 42.');
    expect(reply.actions?.[0]).toMatchObject({ source: 'fenced', purpose: 'count', code: 'return 42;' });
    expect(reply.actions?.[0]?.result?.returnValue).toBe(42);
  });

  it('stops after maxActionRounds and asks for a text-only reply', async () => {
    t = await createTestEngine({
      respond: (request) => (request.tools ? { toolCalls: [runAction('return 1;')] } : { text: 'Done.' }),
      runnerHandler: async () => 1,
    });
    await t.engine.settings.update({ maxActionRounds: 2 });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'loop');

    expect(t.provider.requests).toHaveLength(3);
    const last = t.provider.requests[2]!;
    expect(last.tools).toBeUndefined();
    expect(last.messages.at(-1)!.content[0]).toEqual({ type: 'text', text: '[system] action limit reached, reply with text only' });
    const reply = (await t.engine.sessions.messages(session.id)).at(-1)!;
    expect(reply.actions).toHaveLength(2);
    expect(reply.content).toBe('Done.');
  });

  it('gives a fixable failure one more round, with the failure and how to fix it', async () => {
    let attempt = 0;
    t = await createTestEngine({
      respond: (request) => (request.tools ? { toolCalls: [runAction(attempt === 0 ? 'return oops;' : 'return 7;')] } : { text: 'Seven.' }),
      runnerHandler: () => {
        attempt += 1;
        if (attempt > 1) return 7;
        return {
          ok: false,
          error: { code: 'SANDBOX_RUNTIME', message: 'ReferenceError: oops is not defined', details: { line: 1, column: 8, frame: '> 1 | return oops;' } },
        };
      },
    });
    // One round only: without a repair round the model would never get to run the fix.
    await t.engine.settings.update({ maxActionRounds: 1, maxActionRepairs: 1 });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'count please');

    expect(t.provider.requests).toHaveLength(3);
    // The repair round is a round like any other: the tool is still on the table.
    expect(t.provider.requests[1]!.tools).toBeDefined();
    // Every request holds the same growing conversation, so pick the failed round out of it.
    const failed = t.provider.requests[2]!.messages.find((m) => m.content.some((p) => p.type === 'tool_result' && p.isError === true))!;
    const toolResult = failed.content.find((p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result')!;
    const payload = JSON.parse(toolResult.content) as { error: Record<string, unknown> };
    expect(payload.error).toMatchObject({ code: 'SANDBOX_RUNTIME', message: 'ReferenceError: oops is not defined', line: 1, column: 8 });
    expect(payload.error['fix']).toContain('action.ts coordinates');
    // …and the results carry the failure back with the round it bought.
    expect(failed.content.at(-1)).toEqual({ type: 'text', text: ACTION_REPAIR_NOTICE });

    const reply = (await t.engine.sessions.messages(session.id)).at(-1)!;
    expect(reply.actions).toHaveLength(2);
    expect(reply.actions![0]!.result?.ok).toBe(false);
    expect(reply.actions![1]!.result?.returnValue).toBe(7);
    expect(reply.content).toBe('Seven.');
  });

  it('folds the repair notice into the action result in fenced mode', async () => {
    let attempt = 0;
    t = await createTestEngine({
      supportsTools: false,
      script: [
        { text: 'One sec.\n\n```action\nreturn oops;\n```\n' },
        { text: '```action\nreturn 7;\n```\n' },
        { text: 'Seven.' },
      ],
      runnerHandler: () => {
        attempt += 1;
        if (attempt > 1) return 7;
        return { ok: false, error: { code: 'SANDBOX_RUNTIME', message: 'ReferenceError: oops is not defined' } };
      },
    });
    await t.engine.settings.update({ maxActionRounds: 1, maxActionRepairs: 1 });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'count please');

    expect(t.provider.requests).toHaveLength(3);
    const results = t.provider.requests[2]!.messages
      .flatMap((m) => m.content)
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text' && p.text.startsWith('<action_result>'));
    // One part, not an `<action_result>` with a second text part beside it.
    expect(results[0]!.text).toContain('"ok":false');
    expect(results[0]!.text.endsWith(ACTION_REPAIR_NOTICE)).toBe(true);
    expect(results[1]!.text).toContain('"returnValue":7');
    expect((await t.engine.sessions.messages(session.id)).at(-1)!.content).toBe('One sec.\n\nSeven.');
  });

  it('buys no extra round for a failure rewriting the code cannot fix', async () => {
    t = await createTestEngine({
      respond: (request) => (request.tools ? { toolCalls: [runAction('await sdk.media.showImage("a.png");')] } : { text: 'I cannot show you that.' }),
      runnerHandler: () => ({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'media is switched off under Settings → Permissions' },
      }),
    });
    await t.engine.settings.update({ maxActionRounds: 1, maxActionRepairs: 2 });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'show me');

    expect(t.provider.requests).toHaveLength(2);
    const last = t.provider.requests[1]!;
    expect(last.tools).toBeUndefined();
    expect(last.messages.at(-1)!.content[0]).toEqual({ type: 'text', text: ACTION_LIMIT_NOTICE });
    const reply = (await t.engine.sessions.messages(session.id)).at(-1)!;
    expect(reply.actions).toHaveLength(1);
    expect(reply.content).toBe('I cannot show you that.');
  });

  it('lets onUserMessage skip the LLM', async () => {
    t = await createTestEngine({ script: [{ text: 'should not be used' }] });
    await t.engine.packs.install(LUNA_DIR);
    // give Luna an onUserMessage behaviour by patching the loaded pack in memory
    const pack = t.engine.packs.getLoaded(LUNA_ID);
    pack.characters[0]!.behaviourSources.onUserMessage = 'await sdk.chat.emote("scripted: " + input.text); return { skipLlm: true };';
    t.runner.setHandler(async (request, runner) => {
      if (request.context.trigger.kind === 'behaviour' && request.context.trigger.hook === 'onUserMessage') {
        expect(request.code.startsWith('const input = {"text":"ping"}; ')).toBe(true);
        await runner.call(request, 'chat', 'emote', 'scripted: ping');
        return { skipLlm: true };
      }
      return undefined;
    });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    await t.engine.chat.send(session.id, 'ping');
    expect(t.provider.requests).toHaveLength(0);
    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', origin: 'behaviour', content: 'scripted: ping' });
  });

  it('abort keeps the partial text and finishes the turn', async () => {
    t = await createTestEngine({
      script: [{ text: 'slow reply', delayMs: 200 }],
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const sending = t.engine.chat.send(session.id, 'hi');
    await new Promise((r) => setTimeout(r, 20));
    await t.engine.chat.abort(session.id);
    await sending;
    const types = t.eventTypes(session.id);
    expect(types.at(-1)).toBe('turn-finished');
    expect(types).not.toContain('error');
    const reply = (await t.engine.sessions.messages(session.id)).at(-1)!;
    expect(reply.role).toBe('assistant');
    expect(reply.error).toBeUndefined();
  });

  it('isRunning tells a turn in flight from a finished one', async () => {
    t = await createTestEngine({
      script: [{ text: 'slow reply', delayMs: 200 }],
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    // This is what the app's `allowStopGeneration` restriction reads to tell a plain retry or
    // reset from one that would cut a reply short.
    expect(t.engine.chat.isRunning(session.id)).toBe(false);
    const sending = t.engine.chat.send(session.id, 'hi');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.engine.chat.isRunning(session.id)).toBe(true);
    expect(t.engine.chat.isRunning('some-other-session')).toBe(false);
    await sending;
    expect(t.engine.chat.isRunning(session.id)).toBe(false);
  });

  it('fails with NOT_FOUND after the pack was uninstalled', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.packs.uninstall(MINIMAL_ID);
    await expect(t.engine.chat.send(session.id, 'hello?')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await t.engine.sessions.get(session.id)).toBeDefined();
  });

  it('serialises concurrent sends on one session', async () => {
    t = await createTestEngine({ respond: (req) => ({ text: `reply ${req.messages.length}` }) });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await Promise.all([t.engine.chat.send(session.id, 'a'), t.engine.chat.send(session.id, 'b')]);
    const roles = (await t.engine.sessions.messages(session.id)).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    const starts = t.events.filter((e): e is Extract<ChatEvent, { type: 'turn-started' }> => e.type === 'turn-started');
    expect(starts).toHaveLength(2);
  });
});

describe('permissions', () => {
  it('denies media when switched off under Settings → Permissions, allows it otherwise, and normalises the asset argument', async () => {
    const media = new RecordingHandler('media', (method) => ({ id: 'm1', kind: 'image', asset: method }));
    t = await createTestEngine({ hostHandlers: [media] });
    await t.engine.packs.install(LUNA_DIR);
    await t.engine.settings.update({ permissions: { functionAllow: { media: false } } });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const context = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: t.engine.packs.getLoaded(LUNA_ID).root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } } as const;

    const denied = await t.engine.dispatcher.invoke({ callId: 'c1', module: 'media', method: 'showImage', args: ['images/luna-smile.png'], context });
    expect(denied).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', details: { reason: 'switched off under Settings → Permissions' } } });
    expect(media.calls).toHaveLength(0);

    await t.engine.settings.update({ permissions: { functionAllow: { media: true } } });
    const allowed = await t.engine.dispatcher.invoke({ callId: 'c2', module: 'media', method: 'showImage', args: ['images/luna-smile.png', { durationMs: 5 }], context });
    expect(allowed).toMatchObject({ ok: true, value: { id: 'm1' } });
    expect(media.calls).toHaveLength(1);
    expect(media.calls[0]!.args).toEqual(['media/images/luna-smile.png', { durationMs: 5 }]);

    // AssetRef objects and pack-root-relative paths are accepted too; wrong kinds are rejected.
    const viaRef = await t.engine.dispatcher.invoke({ callId: 'c3', module: 'media', method: 'showImage', args: [{ path: 'media/images/luna-wave.png', kind: 'image', mime: 'image/png', bytes: 1 }], context });
    expect(viaRef.ok).toBe(true);
    expect(media.calls[1]!.args[0]).toBe('media/images/luna-wave.png');
    const wrongKind = await t.engine.dispatcher.invoke({ callId: 'c4', module: 'media', method: 'playAudio', args: ['images/luna-wave.png'], context });
    expect(wrongKind).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    const missing = await t.engine.dispatcher.invoke({ callId: 'c5', module: 'media', method: 'showImage', args: ['images/nope.png'], context });
    expect(missing).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const escape = await t.engine.dispatcher.invoke({ callId: 'c6', module: 'media', method: 'showImage', args: ['../../etc/passwd'], context });
    expect(escape).toMatchObject({ ok: false, error: { code: 'PATH_ESCAPE' } });
    const unknown = await t.engine.dispatcher.invoke({ callId: 'c7', module: 'media', method: 'teleport', args: [], context });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });

    const audit = await t.engine.audit.list({ sessionId: session.id });
    expect(audit.map((a) => [a.method, a.outcome])).toEqual([
      ['showImage', 'denied'],
      ['showImage', 'allowed'],
      ['showImage', 'allowed'],
      ['playAudio', 'failed'],
      ['showImage', 'failed'],
      ['showImage', 'failed'],
      ['teleport', 'denied'],
    ]);
    expect(audit[0]!.error?.code).toBe('PERMISSION_DENIED');
    expect(audit[1]!.args).toEqual(['media/images/luna-smile.png', { durationMs: 5 }]);
    expect(audit[1]!.characterRef).toBe(LUNA_REF);
  });

  it('prompts for third-party prompt-level modules and remembers allow-session', async () => {
    const system = new RecordingHandler('probe', 'opened');
    const decisions: Array<'allow-once' | 'allow-session' | 'deny'> = ['deny', 'allow-session'];
    t = await createTestEngine({ hostHandlers: [system], registry: createTestRegistryWithProbe(), prompter: async () => decisions.shift() ?? 'deny' });
    await installLunaWith(t.engine, t.packsDir);
    await t.engine.settings.update({ permissions: { functionAllow: { probe: false } } });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const context = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: '/x', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } } as const;
    const call = (n: number) => t!.engine.dispatcher.invoke({ callId: `s${n}`, module: 'probe', method: 'ping', args: ['https://example.com'], context });

    // Switched off under Settings → Permissions → denied without prompting.
    expect(await call(1)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(t.prompts).toHaveLength(0);

    await t.engine.settings.update({ permissions: { functionAllow: { probe: true } } });
    const emitted: unknown[] = [];
    t.engine.events.on('permission-request', (r) => emitted.push(r));

    expect(await call(2)).toMatchObject({ ok: false, error: { code: 'PERMISSION_PROMPT_REJECTED' } });
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toMatchObject({ call: { module: 'probe', method: 'ping', args: ['https://example.com'] }, dangerous: true, context: { packId: LUNA_ID, sessionId: session.id } });
    expect(emitted).toHaveLength(1);

    expect(await call(3)).toEqual({ ok: true, value: 'opened' });
    expect(t.prompts).toHaveLength(2);
    // remembered for the session: no third prompt
    expect(await call(4)).toEqual({ ok: true, value: 'opened' });
    expect(t.prompts).toHaveLength(2);
    // a different session prompts again (and is denied because the decision list is exhausted)
    const other = { ...context, sessionId: 'other-session' };
    expect(await t.engine.dispatcher.invoke({ callId: 's5', module: 'probe', method: 'ping', args: ['https://example.com'], context: other })).toMatchObject({ ok: false, error: { code: 'PERMISSION_PROMPT_REJECTED' } });
    expect(t.prompts).toHaveLength(3);
    expect(system.calls).toHaveLength(2);

    // The SDK surface handed to the runner includes prompt-level modules that are switched on.
    expect((await t.engine.behaviours.surfaceFor(LUNA_ID)).modules.map((m) => m.id)).toContain('probe');
    await t.engine.settings.update({ permissions: { functionAllow: { probe: true, media: false } } });
    expect((await t.engine.behaviours.surfaceFor(LUNA_ID)).modules.map((m) => m.id)).not.toContain('media');
  });

  it('routes display (trusted), wallpaper/browser/input (pack) through the permission levels', async () => {
    const rec = (id: string) => new RecordingHandler(id, `${id}-ok`);
    const handlers = [rec('display'), rec('wallpaper'), rec('browser'), rec('input')];
    t = await createTestEngine({ hostHandlers: handlers, prompter: async () => 'allow-once' });
    await installLunaWith(t.engine, t.packsDir);
    // `settings.update` replaces `functionAllow`, so every module of interest is set explicitly each time.
    const off = (modules: string[]) =>
      t!.engine.settings.update({ permissions: { functionAllow: Object.fromEntries(['wallpaper', 'browser', 'input'].map((m) => [m, !modules.includes(m)])) } });
    await off(['wallpaper', 'browser', 'input']);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const luna = t.engine.packs.getLoaded(LUNA_ID);
    const context = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: luna.root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } } as const;
    const call = (n: string, module: string, method: string, args: import('@rp/shared').Json[] = []) => t!.engine.dispatcher.invoke({ callId: n, module, method, args, context });

    // trusted: never subject to the policy, on the surface always
    expect(await call('d1', 'display', 'monitors')).toEqual({ ok: true, value: 'display-ok' });
    expect((await t.engine.behaviours.surfaceFor(LUNA_ID)).modules.map((m) => m.id)).toContain('display');

    // pack-level: denied while switched off under Settings → Permissions
    expect(await call('w1', 'wallpaper', 'set', ['images/luna-smile.png'])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await call('b1', 'browser', 'open', ['https://example.com'])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await off(['input']);
    expect(await call('w2', 'wallpaper', 'set', ['images/luna-smile.png'])).toEqual({ ok: true, value: 'wallpaper-ok' });
    expect(handlers[1]!.calls[0]!.args).toEqual(['media/images/luna-smile.png']);
    expect(await call('b2', 'browser', 'open', ['https://example.com'])).toEqual({ ok: true, value: 'browser-ok' });
    expect(t.prompts).toHaveLength(0);

    // input is pack-level too: switch on, then no per-call confirmation
    expect(await call('i1', 'input', 'lock', [5000])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await off([]);
    expect(await call('i2', 'input', 'lock', [5000])).toEqual({ ok: true, value: 'input-ok' });
    expect(await call('i3', 'input', 'status')).toEqual({ ok: true, value: 'input-ok' });
    expect(t.prompts).toHaveLength(0);

    const surface = (await t.engine.behaviours.surfaceFor(LUNA_ID)).modules.map((m) => m.id);
    expect(surface).toEqual(expect.arrayContaining(['display', 'wallpaper', 'browser', 'input', 'media', 'system'])); // everything is on
  });

  it('runs the onInstall hook right at install, once, whatever the policy says', async () => {
    const installs: string[] = [];
    t = await createTestEngine({
      runnerHandler: async (request) => {
        if (request.context.trigger.kind === 'behaviour') installs.push(request.context.trigger.hook);
      },
    });
    // Copy luna to a temp dir and add an onInstall script.
    const src = path.join(t.packsDir, 'src-luna');
    await fs.cp(LUNA_DIR, src, { recursive: true });
    const charDir = path.join(src, 'characters', 'luna');
    await fs.writeFile(path.join(charDir, 'scripts', 'on-install.ts'), 'return 1;');
    const def = JSON.parse(await fs.readFile(path.join(charDir, 'character.json'), 'utf8'));
    def.behaviours.onInstall = 'scripts/on-install.ts';
    await fs.writeFile(path.join(charDir, 'character.json'), JSON.stringify(def));

    // a switched-off module does not hold the hook back: permissions are app-wide, nothing is pending
    await t.engine.settings.update({ permissions: { functionAllow: { ui: false } } });
    await t.engine.packs.install(src);
    expect(installs).toEqual(['onInstall']);
    // policy changes never re-run it
    await t.engine.settings.update({ permissions: { functionAllow: { ui: true } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(installs).toEqual(['onInstall']);
    // re-installing runs it again (it is a fresh install of that version)
    await t.engine.packs.install(src);
    expect(installs).toEqual(['onInstall', 'onInstall']);
  });

  it('runs an onInstall hook an earlier version left pending behind per-pack grants, once, on start', async () => {
    const installs: string[] = [];
    const runnerHandler: FakeRunHandler = async (request) => {
      if (request.context.trigger.kind === 'behaviour') installs.push(request.context.trigger.hook);
    };
    t = await createTestEngine({ runnerHandler });
    const src = path.join(t.packsDir, 'src-luna-pending');
    await fs.cp(LUNA_DIR, src, { recursive: true });
    const charDir = path.join(src, 'characters', 'luna');
    await fs.writeFile(path.join(charDir, 'scripts', 'on-install.ts'), 'return 1;');
    const def = JSON.parse(await fs.readFile(path.join(charDir, 'character.json'), 'utf8'));
    def.behaviours.onInstall = 'scripts/on-install.ts';
    await fs.writeFile(path.join(charDir, 'character.json'), JSON.stringify(def));
    await t.engine.packs.install(src);
    expect(installs).toEqual(['onInstall']);
    // simulate the old deferred marker left on disk by a previous version
    await t.storage.state.set(`pack:${LUNA_ID}`, 'onInstallPending', true);
    const { storage, packsDir } = t;
    await t.engine.stop();
    t = await createTestEngine({ storage, packsDir, runnerHandler });
    expect(installs).toEqual(['onInstall', 'onInstall']);
    expect(await storage.state.keys(`pack:${LUNA_ID}`)).toEqual([]);
    await t.engine.stop();
    t = await createTestEngine({ storage, packsDir, runnerHandler });
    expect(installs).toEqual(['onInstall', 'onInstall']);
  });
});

describe('memories', () => {
  const consolidationReply = (facts: string[]) => ({ text: '```json\n' + JSON.stringify(facts.map((text) => ({ text, tags: ['fact'], importance: 3 }))) + '\n```' });

  it('consolidates every N assistant turns after turn-finished and on session removal, and exposes engine.memories', async () => {
    let consolidations = 0;
    const FACTS = ['Their cat is called Miso.', 'They work night shifts as a nurse.', 'They grew up by the sea in Cornwall.'];
    t = await createTestEngine({
      respond: (request) => {
        if (request.tools === undefined && request.system.startsWith('You maintain the long-term memory')) {
          consolidations += 1;
          return consolidationReply([FACTS[consolidations - 1] ?? `Extra fact ${consolidations}.`]);
        }
        return { text: `reply ${request.messages.length}` };
      },
    });
    await t.engine.settings.update({ memory: { enabled: true, consolidateEveryTurns: 4, maxEntriesPerCharacter: 500, promptBudgetTokens: 1500 } });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    // explicit consolidation (IpcApi.memories.consolidate) once ≥ 4 fresh messages exist
    await t.engine.chat.send(session.id, 'I am a nurse');
    await t.engine.chat.send(session.id, 'and I have a cat');
    expect(consolidations).toBe(0);
    const explicit = await t.engine.memories.consolidate(session.id);
    expect(explicit.map((m) => [m.text, m.source, m.sessionId])).toEqual([[FACTS[0], 'consolidation', session.id]]);
    expect(consolidations).toBe(1);

    // automatic: the 4th assistant turn triggers a pass after turn-finished (fire-and-forget)
    await t.engine.chat.send(session.id, 'c');
    await t.engine.chat.send(session.id, 'd');
    await t.engine.memories.idle();
    expect(consolidations).toBe(2);
    const types = t.events.map((e) => e.type);
    expect(types.lastIndexOf('memory-added')).toBeGreaterThan(types.lastIndexOf('turn-finished'));
    expect((await t.engine.memories.list(ECHO_REF)).map((m) => m.text).sort()).toEqual([FACTS[0], FACTS[1]].sort());

    // the next turn sees the memories in its prompt
    await t.engine.chat.send(session.id, 'what do you remember?');
    const last = t.provider.requests.filter((r) => r.tools !== undefined).at(-1)!;
    expect(last.system).toContain(`- (3/5, 2026-01-01) ${FACTS[0]} [fact]`);
    expect(last.system).toContain(FACTS[1]);

    // IpcApi.memories surface: add (source user) / update / remove
    const mine = await t.engine.memories.add(ECHO_REF, 'User-written note', { tags: ['Note'], importance: 5 });
    expect(mine).toMatchObject({ source: 'user', tags: ['note'], importance: 5 });
    const edited = await t.engine.memories.update({ ...mine, text: 'Edited note' });
    expect(edited.text).toBe('Edited note');
    expect((await t.engine.memories.list(ECHO_REF)).find((m) => m.id === mine.id)?.text).toBe('Edited note');
    expect(await t.engine.memories.remove(mine.id)).toBe(true);

    // too few fresh messages since the marker → explicit call is a no-op without a provider call
    expect(await t.engine.memories.consolidate(session.id)).toEqual([]);
    expect(consolidations).toBe(2);

    // removal runs a final pass (4 fresh messages by now) before deleting the session
    await t.engine.chat.send(session.id, 'one last thing');
    expect(consolidations).toBe(2);
    await t.engine.sessions.remove(session.id);
    expect(consolidations).toBe(3);
    expect((await t.engine.memories.list(ECHO_REF)).map((m) => m.text).sort()).toEqual([...FACTS].sort());
    expect(await t.engine.sessions.get(session.id)).toBeUndefined();
  });

  it('does nothing when memory is disabled', async () => {
    let consolidations = 0;
    t = await createTestEngine({
      respond: (request) => {
        if (request.tools === undefined) {
          consolidations += 1;
          return consolidationReply(['x']);
        }
        return { text: 'ok' };
      },
    });
    await t.engine.settings.update({ memory: { enabled: false, consolidateEveryTurns: 1, maxEntriesPerCharacter: 500, promptBudgetTokens: 1500 } });
    await t.engine.packs.install(MINIMAL_DIR);
    await t.engine.memories.add(ECHO_REF, 'hidden fact');
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'a');
    await t.engine.chat.send(session.id, 'b');
    await t.engine.memories.idle();
    expect(consolidations).toBe(0);
    expect(t.provider.requests.at(-1)!.system).toContain('<memories>\nNothing yet.');
  });
});

describe('timers', () => {
  it('fires due timers into onTimer behaviours and re-arms from the script', async () => {
    const runs: string[] = [];
    t = await createTestEngine({
      runnerHandler: async (request, runner) => {
        const trig = request.context.trigger;
        if (trig.kind === 'behaviour' && trig.hook === 'onSessionStart') {
          await runner.call(request, 'timers', 'schedule', 60_000, { reason: 'stretch' }, { label: 'Stretch break' });
          return;
        }
        if (trig.kind === 'timer') {
          runs.push(request.code);
          await runner.call(request, 'chat', 'emote', 'Stretch!');
          await runner.call(request, 'timers', 'schedule', 120_000, { reason: 'stretch' }, { label: 'Stretch break' });
          return;
        }
        return undefined;
      },
    });
    await t.engine.packs.install(LUNA_DIR);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });

    let timers = await t.engine.timers.list({ sessionId: session.id });
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ label: 'Stretch break', payload: { reason: 'stretch' }, fireAt: '2026-01-01T12:01:00.000Z' });

    expect(await t.engine.timers.fireDue()).toBe(0);
    t.clock.advance(60_000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.startsWith(`const input = {"timer":{"id":"${timers[0]!.id}","payload":{"reason":"stretch"},"label":"Stretch break"}}; `)).toBe(true);
    expect((await t.engine.sessions.messages(session.id)).at(-1)).toMatchObject({ role: 'assistant', origin: 'timer', content: 'Stretch!' });
    // the old timer is gone, the re-armed one is pending
    timers = await t.engine.timers.list({ sessionId: session.id });
    expect(timers).toHaveLength(1);
    expect(timers[0]!.fireAt).toBe('2026-01-01T12:03:00.000Z');
    expect(t.provider.requests).toHaveLength(0);
  });

  it('wakes the LLM with a system message when there is no onTimer behaviour', async () => {
    t = await createTestEngine({ script: [{ text: 'Time to drink water!' }] });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.timers.schedule({
      id: 'w1',
      sessionId: session.id,
      characterRef: ECHO_REF,
      kind: 'wake',
      fireAt: new Date(t.clock.now().getTime() + 5_000).toISOString(),
      payload: { reason: 'water' },
      createdAt: t.clock.now().toISOString(),
      label: 'Water',
    });
    expect(await t.engine.timers.fireDue()).toBe(0);
    t.clock.advance(5_000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['system', '[timer fired] Water {"reason":"water"}'],
      ['assistant', 'Time to drink water!'],
    ]);
    expect(messages[1]!.origin).toBe('timer');
    const request = t.provider.requests[0]!;
    expect(request.messages.at(-1)!.content[0]).toEqual({ type: 'text', text: '[system] [timer fired] Water {"reason":"water"}' });
  });

  it('drops timers whose session is gone and arms real timeouts on start', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    await t.engine.timers.schedule({
      id: 'orphan',
      sessionId: 'missing',
      characterRef: ECHO_REF,
      kind: 'wake',
      fireAt: '2000-01-01T00:00:00.000Z',
      payload: null,
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    const { storage, packsDir } = t;
    await t.engine.stop();
    t = await createTestEngine({ storage, packsDir });
    await t.engine.timers.idle();
    expect(await t.engine.timers.list()).toEqual([]);
  });
});

describe('history editing', () => {
  it('removes one message or clears the session, emits events and keeps session state', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'ok' }) });
    await t.engine.packs.install(LUNA_DIR);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    await t.engine.chat.send(session.id, 'first');
    await t.engine.chat.send(session.id, 'second');
    await t.engine.storage.state.set(`session:${session.id}`, 'scratch', 1);
    const before = await t.engine.sessions.messages(session.id);
    expect(before.length).toBeGreaterThanOrEqual(4);
    const events: string[] = [];
    t.engine.events.on('chat', (e) => events.push(e.type));

    const victim = before.find((m) => m.role === 'user' && m.content === 'first')!;
    await t.engine.chat.removeMessage(session.id, victim.id);
    const after = await t.engine.sessions.messages(session.id);
    expect(after.some((m) => m.id === victim.id)).toBe(false);
    expect(after.length).toBe(before.length - 1);
    expect(events).toContain('message-removed');
    expect((await t.engine.sessions.get(session.id))?.messageCount).toBe(after.length);
    await t.engine.chat.removeMessage(session.id, 'does-not-exist'); // ignored

    await t.engine.chat.clearMessages(session.id);
    expect(await t.engine.sessions.messages(session.id)).toEqual([]);
    expect(events).toContain('messages-cleared');
    const cleared = await t.engine.sessions.get(session.id);
    expect(cleared?.messageCount).toBe(0);
    expect(cleared?.lastMessagePreview).toBeUndefined();
    expect(await t.engine.storage.state.get(`session:${session.id}`, 'scratch')).toBe(1); // state survives
    await expect(t.engine.chat.clearMessages('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Chatting again works on the empty history.
    await t.engine.chat.send(session.id, 'third');
    expect((await t.engine.sessions.messages(session.id)).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('keeps one session per character and resets session state without touching messages', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'ok' }) });
    await t.engine.packs.install(LUNA_DIR);
    const first = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const again = await t.engine.sessions.create({ characterRef: LUNA_REF, title: 'ignored' });
    expect(again.id).toBe(first.id);
    expect((await t.engine.sessions.list()).filter((s) => s.characterRef === LUNA_REF)).toHaveLength(1);
    expect((await t.engine.sessions.messages(first.id)).filter((m) => m.origin === 'greeting')).toHaveLength(1); // no second greeting
    expect(await t.engine.sessions.forCharacter(LUNA_REF)).toMatchObject({ id: first.id });

    await t.engine.chat.send(first.id, 'hello');
    const scope = `session:${first.id}`;
    await t.engine.storage.state.set(scope, 'scratch', 42);
    // The character scope is the one that outlives a session, the same way memories do.
    const charScope = `char:${LUNA_ID}/luna`;
    await t.engine.storage.state.set(charScope, 'remembered', 'her name for me');
    await t.engine.memories.add(LUNA_REF, 'we met on a Tuesday');
    await t.engine.timers.schedule({ id: 'tm-reset', sessionId: first.id, characterRef: LUNA_REF, kind: 'wake', fireAt: '2030-01-01T00:00:00.000Z', payload: null, createdAt: t.clock.now().toISOString() });
    expect(await t.engine.timers.list({ sessionId: first.id })).toHaveLength(1);
    const before = (await t.engine.sessions.messages(first.id)).length;
    const events: string[] = [];
    t.engine.events.on('chat', (e) => events.push(e.type));

    await t.engine.chat.resetState(first.id);
    expect(await t.engine.storage.state.get(scope, 'scratch')).toBeUndefined();
    // Only the session scope goes: what the character keeps about the user persists, like memories.
    expect(await t.engine.storage.state.get(charScope, 'remembered')).toBe('her name for me');
    expect((await t.engine.memories.list(LUNA_REF)).map((m) => m.text)).toContain('we met on a Tuesday');
    expect(await t.engine.timers.list({ sessionId: first.id })).toHaveLength(0);
    expect((await t.engine.sessions.messages(first.id)).length).toBe(before); // messages untouched
    expect(events).toEqual(expect.arrayContaining(['status', 'session-reset']));
    await expect(t.engine.chat.resetState('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ChatService.retry', () => {
  it('drops the last reply and answers the same message again', async () => {
    t = await createTestEngine({ script: [{ text: 'First answer.' }, { text: 'Second answer.' }] });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'say something');
    expect((await t.engine.sessions.messages(session.id)).at(-1)?.content).toBe('First answer.');

    t.events.length = 0;
    await t.engine.chat.retry(session.id);

    const after = await t.engine.sessions.messages(session.id);
    expect(after.at(-1)?.content).toBe('Second answer.');
    // The discarded reply is gone and the user's message was not re-sent.
    expect(after.some((m) => m.content === 'First answer.')).toBe(false);
    expect(after.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['say something']);
    expect(t.events.some((e) => e.type === 'message-removed')).toBe(true);
  });

  it('runs the turn again when the last one left no reply', async () => {
    let calls = 0;
    t = await createTestEngine({
      respond: () => {
        calls += 1;
        if (calls === 1) throw new Error('provider exploded');
        return { text: 'Sorry, here I am.' };
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'hello?').catch(() => undefined);

    await t.engine.chat.retry(session.id);

    const after = await t.engine.sessions.messages(session.id);
    expect(after.at(-1)?.content).toBe('Sorry, here I am.');
    expect(after.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('refuses when the character has said everything there is', async () => {
    t = await createTestEngine({ script: [{ text: 'unused' }] });
    await t.engine.packs.install(LUNA_DIR);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    // Only the pack's greeting so far: there is no message for the character to answer.
    expect((await t.engine.sessions.messages(session.id)).every((m) => m.role === 'assistant')).toBe(true);
    await expect(t.engine.chat.retry(session.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('trailingReply', () => {
  it('is the run of assistant messages at the end, and nothing before it', async () => {
    const { trailingReply } = await import('./services/chat.js');
    const m = (id: string, role: ChatMessage['role']): ChatMessage => ({ id, sessionId: 's', role, content: id, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(trailingReply([m('greeting', 'assistant'), m('u1', 'user'), m('say', 'assistant'), m('reply', 'assistant')]).map((x) => x.id)).toEqual(['say', 'reply']);
    expect(trailingReply([m('u1', 'user')])).toEqual([]);
    expect(trailingReply([])).toEqual([]);
    // A whole transcript of assistant messages has no input left to answer.
    expect(trailingReply([m('greeting', 'assistant')]).map((x) => x.id)).toEqual(['greeting']);
  });
});
