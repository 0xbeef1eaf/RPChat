import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import type { ChatEvent, ChatMessage } from '@rp/shared';
import {
  ECHO_REF,
  LUNA_DIR,
  LUNA_ID,
  LUNA_REF,
  MINIMAL_DIR,
  MINIMAL_ID,
  RecordingHandler,
  createTestEngine,
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
    expect(minimal.requestedCapabilities).toEqual([]);
    expect(luna.packId).toBe(LUNA_ID);
    expect(luna.requestedCapabilities).toEqual(['media', 'ui']);
    expect(luna.root).toBe(path.join(t.packsDir, LUNA_ID, '1.0.0'));
    expect(luna.readme).toContain('# Luna');
    // grants default to "not granted" for every requested capability
    expect(luna.grants.map((g) => [g.module, g.granted])).toEqual([
      ['media', false],
      ['ui', false],
    ]);
    // files were copied, not referenced in place
    await expect(fs.stat(path.join(luna.root, 'pack.json'))).resolves.toBeTruthy();

    const characters = t.engine.packs.characters();
    expect(characters.map((c) => c.ref).sort()).toEqual([LUNA_REF, ECHO_REF].sort());
    const lunaChar = characters.find((c) => c.ref === LUNA_REF)!;
    expect(lunaChar.avatarUrl).toBe(`rp-asset://${LUNA_ID}/characters/luna/avatar.png`);

    expect((await t.engine.packs.list()).map((p) => p.packId).sort()).toEqual([LUNA_ID, MINIMAL_ID].sort());

    await t.engine.permissions.setGrant(LUNA_ID, 'media', true);
    expect(await t.engine.permissions.grantsFor(LUNA_ID)).toHaveLength(2);

    await t.engine.packs.uninstall(LUNA_ID);
    expect(await t.engine.permissions.grantsFor(LUNA_ID)).toEqual([]);
    expect(await t.storage.packs.get(LUNA_ID)).toBeUndefined();
    expect(t.engine.packs.characters().map((c) => c.ref)).toEqual([ECHO_REF]);
    await expect(fs.stat(path.join(t.packsDir, LUNA_ID))).rejects.toThrow();
    expect(() => t!.engine.packs.getLoaded(LUNA_ID)).toThrow(RpError);
  });

  it('re-installing the same pack keeps grants', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(LUNA_DIR);
    await t.engine.permissions.setGrant(LUNA_ID, 'media', true);
    const again = await t.engine.packs.install(LUNA_DIR);
    expect(again.grants.find((g) => g.module === 'media')?.granted).toBe(true);
    expect(await t.engine.packs.list()).toHaveLength(1);
  });

  it('rejects packs that request unknown capabilities', async () => {
    t = await createTestEngine();
    const dir = path.join(t.packsDir, 'src-bad');
    await fs.mkdir(path.join(dir, 'characters', 'x'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'pack.json'),
      JSON.stringify({ formatVersion: 1, id: 'com.example.bad', name: 'Bad', version: '1.0.0', characters: ['characters/x'], capabilities: ['teleport'] }),
    );
    await fs.writeFile(path.join(dir, 'characters', 'x', 'character.json'), JSON.stringify({ id: 'x', name: 'X', persona: 'persona.md' }));
    await fs.writeFile(path.join(dir, 'characters', 'x', 'persona.md'), 'You are X.');
    await expect(t.engine.packs.install(dir)).rejects.toMatchObject({ code: 'PACK_INVALID' });
    expect(await t.engine.packs.list()).toEqual([]);
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
        expect(surface).toEqual(expect.arrayContaining(['chat', 'log', 'state', 'pack', 'timers']));
        expect(surface).not.toContain('media'); // requested but not granted
        expect(surface).not.toContain('ui');
        expect(surface).not.toContain('system');
        await runner.call(request, 'chat', 'say', 'Hey. I am Luna.');
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
      ['chat', 'say', 'allowed'],
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
    expect(second.system).toContain('interface StateApi');
    expect(second.system).not.toContain('interface MediaApi');
    expect(second.system).toContain('`sdk.media`');
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

  it('lets onUserMessage skip the LLM', async () => {
    t = await createTestEngine({ script: [{ text: 'should not be used' }] });
    await t.engine.packs.install(LUNA_DIR);
    // give Luna an onUserMessage behaviour by patching the loaded pack in memory
    const pack = t.engine.packs.getLoaded(LUNA_ID);
    pack.characters[0]!.behaviourSources.onUserMessage = 'await sdk.chat.say("scripted: " + input.text); return { skipLlm: true };';
    t.runner.setHandler(async (request, runner) => {
      if (request.context.trigger.kind === 'behaviour' && request.context.trigger.hook === 'onUserMessage') {
        expect(request.code.startsWith('const input = {"text":"ping"}; ')).toBe(true);
        await runner.call(request, 'chat', 'say', 'scripted: ping');
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
  it('denies media without a grant, allows it with one, and normalises the asset argument', async () => {
    const media = new RecordingHandler('media', (method) => ({ id: 'm1', kind: 'image', asset: method }));
    t = await createTestEngine({ hostHandlers: [media] });
    await t.engine.packs.install(LUNA_DIR);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const context = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: t.engine.packs.getLoaded(LUNA_ID).root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } } as const;

    const denied = await t.engine.dispatcher.invoke({ callId: 'c1', module: 'media', method: 'showImage', args: ['images/luna-smile.png'], context });
    expect(denied).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(media.calls).toHaveLength(0);

    await t.engine.permissions.setGrant(LUNA_ID, 'media', true);
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

  it('prompts for prompt-level modules and remembers allow-session', async () => {
    const system = new RecordingHandler('system', 'opened');
    const decisions: Array<'allow-once' | 'allow-session' | 'deny'> = ['deny', 'allow-session'];
    t = await createTestEngine({ hostHandlers: [system], prompter: async () => decisions.shift() ?? 'deny' });
    await t.engine.packs.install(LUNA_DIR);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const context = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: '/x', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } } as const;
    const call = (n: number) => t!.engine.dispatcher.invoke({ callId: `s${n}`, module: 'system', method: 'openExternal', args: ['https://example.com'], context });

    // Not granted at all → denied without prompting.
    expect(await call(1)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(t.prompts).toHaveLength(0);

    await t.engine.permissions.setGrant(LUNA_ID, 'system', true);
    const emitted: unknown[] = [];
    t.engine.events.on('permission-request', (r) => emitted.push(r));

    expect(await call(2)).toMatchObject({ ok: false, error: { code: 'PERMISSION_PROMPT_REJECTED' } });
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toMatchObject({ call: { module: 'system', method: 'openExternal', args: ['https://example.com'] }, dangerous: true, context: { packId: LUNA_ID, sessionId: session.id } });
    expect(emitted).toHaveLength(1);

    expect(await call(3)).toEqual({ ok: true, value: 'opened' });
    expect(t.prompts).toHaveLength(2);
    // remembered for the session: no third prompt
    expect(await call(4)).toEqual({ ok: true, value: 'opened' });
    expect(t.prompts).toHaveLength(2);
    // a different session prompts again (and is denied because the decision list is exhausted)
    const other = { ...context, sessionId: 'other-session' };
    expect(await t.engine.dispatcher.invoke({ callId: 's5', module: 'system', method: 'openExternal', args: ['https://example.com'], context: other })).toMatchObject({ ok: false, error: { code: 'PERMISSION_PROMPT_REJECTED' } });
    expect(t.prompts).toHaveLength(3);
    expect(system.calls).toHaveLength(2);

    // The SDK surface handed to the runner includes granted prompt-level modules.
    expect((await t.engine.behaviours.surfaceFor(LUNA_ID)).modules.map((m) => m.id)).toContain('system');
    expect((await t.engine.behaviours.surfaceFor(LUNA_ID)).modules.map((m) => m.id)).not.toContain('media');
  });

  it('runs deferred onInstall hooks once all requested capabilities are granted', async () => {
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

    await t.engine.packs.install(src);
    expect(installs).toEqual([]);
    await t.engine.permissions.setGrant(LUNA_ID, 'media', true);
    expect(installs).toEqual([]);
    await t.engine.permissions.setGrant(LUNA_ID, 'ui', true);
    await new Promise((r) => setTimeout(r, 0));
    expect(installs).toEqual(['onInstall']);
    // not run twice
    await t.engine.permissions.setGrant(LUNA_ID, 'ui', true);
    await new Promise((r) => setTimeout(r, 0));
    expect(installs).toEqual(['onInstall']);
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
          await runner.call(request, 'chat', 'say', 'Stretch!');
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
