import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, ChatEvent, EventSubscription, HostEvent, Json } from '@rp/shared';
import { HOST_EVENT_NAMES, matchesFilter } from './services/events.js';
import { decayToward, energyWord, moodPromptText, moodWord } from './services/mood.js';
import { evaluateRoutine } from './services/routine.js';
import { sensesLine } from './prompt.js';
import { loadPack } from '@rp/pack';
import { ECHO_REF, EXAMPLES_DIR, FakeSenses, LUNA_DIR, LUNA_ID, LUNA_REF, MINIMAL_DIR, MINIMAL_ID, RecordingHandler, createTestEngine, createTestRegistryWithProbe, installLunaWith } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const ctxOf = (packId: string, characterId: string, sessionId: string): ActionContext => ({
  packId,
  characterId,
  sessionId,
  packRoot: t!.engine.packs.getLoaded(packId).root,
  trigger: { kind: 'llm', actionId: 'a', messageId: 'm' },
});
const invoke = (context: ActionContext, module: string, method: string, ...args: Json[]) =>
  t!.engine.dispatcher.invoke({ callId: `${module}.${method}`, module, method, args, context });

// ---------------------------------------------------------------------------------------------
describe('permission policy (app-wide, Settings → Permissions)', () => {
  it('allows every module by default, denies switched-off ones and explains the denial', async () => {
    const media = new RecordingHandler('media', { id: 'm', kind: 'image', asset: 'x' });
    const ui = new RecordingHandler('ui', null);
    t = await createTestEngine({ hostHandlers: [media, ui] });
    await installLunaWith(t.engine, t.packsDir);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const ctx = ctxOf(LUNA_ID, 'luna', session.id);

    // nothing switched off → allowed, nothing to request or grant
    expect((await invoke(ctx, 'media', 'showImage', 'images/luna-smile.png')).ok).toBe(true);
    expect((await invoke(ctx, 'ui', 'notify', 't')).ok).toBe(true);
    // policy off → denied, reason names the settings page
    await t.engine.settings.update({ permissions: { moduleAllow: { media: false } } });
    expect(await invoke(ctx, 'media', 'showImage', 'images/luna-smile.png')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', details: { reason: 'switched off under Settings → Permissions' } } });
    const eff = await t.engine.permissions.effective(LUNA_ID);
    expect(eff.effective).not.toContain('media');
    expect(eff.effective).toContain('ui');
    expect(eff.denied).toEqual({ media: 'policy' });
    // policy back on → allowed again, no other state involved
    await t.engine.settings.update({ permissions: { moduleAllow: { media: true } } });
    expect((await invoke(ctx, 'media', 'showImage', 'images/luna-smile.png')).ok).toBe(true);
    expect((await t.engine.permissions.effective(LUNA_ID)).denied).toEqual({});
    // trusted modules never need anything
    expect((await invoke(ctx, 'state', 'keys')).ok).toBe(true);
    expect(media.calls).toHaveLength(2);
    expect(ui.calls).toHaveLength(1);
  });

  it('filters the prompt by the policy and inspects sources', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'ok' }) });
    await t.engine.settings.update({ permissions: { moduleAllow: { ui: false } } });
    await t.engine.packs.install(LUNA_DIR);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    await t.engine.chat.send(session.id, 'hi');
    const system = t.provider.requests.at(-1)!.system;
    expect(system).toContain('## sdk.media —');
    expect(system).not.toContain('## sdk.ui —');
    // Denied modules are absent from the prompt; the reason reaches the character through the
    // PERMISSION_DENIED error of an actual call (asserted above), not through a prompt listing.
    expect(system).not.toContain('Not available');
    expect(system).not.toContain('switched off under Settings');

    const inspection = await t.engine.packs.inspect(LUNA_DIR);
    expect(inspection.manifest.id).toBe(LUNA_ID);
    expect(inspection.characters).toEqual([{ id: 'luna', name: 'Luna', tagline: 'A warm night-owl companion who notices the little things.' }]);
    expect(inspection).not.toHaveProperty('requestedCapabilities');
    const expectedCounts: Record<string, number> = {};
    for (const a of (await loadPack(LUNA_DIR)).assets) expectedCounts[a.kind] = (expectedCounts[a.kind] ?? 0) + 1;
    expect(inspection.assetCounts).toEqual(expectedCounts);
    expect(inspection.readme).toContain('# Luna');
    // nothing was installed by inspecting
    expect((await t.engine.packs.list()).map((p) => p.packId)).toEqual([LUNA_ID]);

    const src = path.join(t.packsDir, 'src-legacy');
    await fs.cp(MINIMAL_DIR, src, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(src, 'pack.json'), 'utf8')) as Record<string, unknown>;
    manifest.capabilities = ['media', 'teleport'];
    await fs.writeFile(path.join(src, 'pack.json'), JSON.stringify(manifest));
    const legacy = await t.engine.packs.inspect(src); // the legacy key is ignored, not an error
    expect(legacy.manifest.id).toBe(MINIMAL_ID);
    expect('capabilities' in legacy.manifest).toBe(false);
    await expect(t.engine.packs.inspect(path.join(t.packsDir, 'nope'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('skips the dialog when the handler pre-authorises a prompt-level call', async () => {
    const calls: string[] = [];
    const probe = {
      moduleId: 'probe',
      async invoke(method: string) {
        calls.push(method);
        return 'ok';
      },
      async preauthorize(_method: string, args: Json[]) {
        return typeof args[0] === 'string' && args[0].startsWith('https://allowed.example');
      },
    };
    t = await createTestEngine({ hostHandlers: [probe], registry: createTestRegistryWithProbe(), prompter: async () => 'deny' });
    await installLunaWith(t.engine, t.packsDir);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const ctx = ctxOf(LUNA_ID, 'luna', session.id);
    expect(await invoke(ctx, 'probe', 'ping', 'https://allowed.example/x')).toMatchObject({ ok: true });
    expect(t.prompts).toHaveLength(0);
    expect(await invoke(ctx, 'probe', 'ping', 'https://other.example/x')).toMatchObject({ ok: false, error: { code: 'PERMISSION_PROMPT_REJECTED' } });
    expect(t.prompts).toHaveLength(1);
    expect(calls).toEqual(['ping']);
    const audit = (await t.engine.audit.list({ sessionId: session.id })).filter((a) => a.module === 'probe');
    expect(audit.map((a) => a.outcome)).toEqual(['allowed', 'denied']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('event matching', () => {
  it('matches filters per event kind', () => {
    expect(matchesFilter('window-changed', { title: 'Inbox - Mail', app: 'Thunderbird' }, { app: 'thunder' })).toBe(true);
    expect(matchesFilter('window-changed', { title: 'Inbox - Mail', app: 'Thunderbird' }, { title: 'inbox', app: 'firefox' })).toBe(false);
    expect(matchesFilter('file-added', { path: '/home/u/Downloads/a.PDF', dir: '/home/u/Downloads', name: 'a.PDF' }, { dir: 'downloads', ext: '.pdf' })).toBe(true);
    expect(matchesFilter('file-added', { path: '/home/u/Downloads/a.png', dir: '/home/u/Downloads', name: 'a.png' }, { ext: 'pdf' })).toBe(false);
    expect(matchesFilter('widget-message', { widgetId: 'w1', message: {} }, { widgetId: 'w2' })).toBe(false);
    // media clicks/closes: plain equality on any data key (mediaId, asset, reason)
    const clicked = { mediaId: 'm1', asset: 'media/images/a.png', packId: 'com.x', kind: 'image' };
    expect(matchesFilter('media-clicked', clicked, { mediaId: 'm1' })).toBe(true);
    expect(matchesFilter('media-clicked', clicked, { mediaId: 'm2' })).toBe(false);
    expect(matchesFilter('media-clicked', clicked, { asset: 'media/images/a.png' })).toBe(true);
    expect(matchesFilter('media-clicked', clicked, { asset: 'media/images/b.png' })).toBe(false);
    expect(matchesFilter('media-closed', { ...clicked, reason: 'timeout' }, { reason: 'timeout' })).toBe(true);
    expect(matchesFilter('media-closed', { ...clicked, reason: 'click' }, { mediaId: 'm1', reason: 'timeout' })).toBe(false);
    expect(matchesFilter('song-changed', { title: 'x', status: 'playing' }, undefined)).toBe(true);
    expect(matchesFilter('custom:tick', { n: 1 }, { n: 1 })).toBe(true);
    expect(matchesFilter('custom:tick', { n: 1 }, { n: 2 })).toBe(false);
    // time: missing = any; minute defaults to 0 when only hour is given
    expect(matchesFilter('time', { hour: 9, minute: 0, weekday: 1 }, { hour: 9 })).toBe(true);
    expect(matchesFilter('time', { hour: 9, minute: 30, weekday: 1 }, { hour: 9 })).toBe(false);
    expect(matchesFilter('time', { hour: 9, minute: 30, weekday: 1 }, { hour: 9, minute: 30 })).toBe(true);
    expect(matchesFilter('time', { hour: 9, minute: 30, weekday: 6 }, { minute: 30, weekday: [0, 6] })).toBe(true);
    expect(matchesFilter('time', { hour: 9, minute: 30, weekday: 2 }, { weekday: [0, 6] })).toBe(false);
  });

  it('routes media-clicked / media-closed to subscriptions through their filters, never debounced', async () => {
    const senses = new FakeSenses();
    const runs: Array<{ subscriptionId: string; code: string }> = [];
    t = await createTestEngine({
      senses,
      runnerHandler: async (request) => {
        if (request.context.trigger.kind === 'event') runs.push({ subscriptionId: request.context.trigger.subscriptionId, code: request.code });
        return null;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    const byId = (await invoke(ctx, 'events', 'on', 'media-clicked', 'return "id";', { filter: { mediaId: 'm1' }, label: 'by id' })) as { ok: true; value: { id: string } };
    const byAsset = (await invoke(ctx, 'events', 'on', 'media-clicked', 'return "asset";', { filter: { asset: 'media/a.png' } })) as { ok: true; value: { id: string } };
    const timeouts = (await invoke(ctx, 'events', 'on', 'media-closed', 'return "timeout";', { filter: { reason: 'timeout' } })) as { ok: true; value: { id: string } };
    const any = (await invoke(ctx, 'events', 'on', 'media-closed', 'return "any";')) as { ok: true; value: { id: string } };
    expect(senses.interests.at(-1)?.sort()).toEqual(['media-clicked', 'media-closed', 'time']);

    senses.push('media-clicked', { mediaId: 'm1', asset: 'media/a.png', packId: MINIMAL_ID, kind: 'image' });
    senses.push('media-clicked', { mediaId: 'm2', asset: 'media/b.png', packId: MINIMAL_ID, kind: 'image' });
    await t.engine.eventService.idle();
    expect(runs.map((r) => r.subscriptionId)).toEqual([byId.value.id, byAsset.value.id]);

    // three closes within a second: one per interaction, the reason filter picks the timeout
    runs.length = 0;
    senses.push('media-closed', { mediaId: 'm1', asset: 'media/a.png', packId: MINIMAL_ID, kind: 'image', reason: 'click' });
    senses.push('media-closed', { mediaId: 'm2', asset: 'media/b.png', packId: MINIMAL_ID, kind: 'image', reason: 'timeout' });
    senses.push('media-closed', { mediaId: 'm3', asset: 'media/c.png', packId: MINIMAL_ID, kind: 'image', reason: 'api' });
    await t.engine.eventService.idle();
    expect(runs.map((r) => r.subscriptionId)).toEqual([any.value.id, timeouts.value.id, any.value.id, any.value.id]);

    // widget messages likewise: every click in a widget counts
    runs.length = 0;
    const widget = (await invoke(ctx, 'events', 'on', 'widget-message', 'return "w";', { filter: { widgetId: 'game' } })) as { ok: true; value: { id: string } };
    senses.push('widget-message', { widgetId: 'game', message: { event: 'mistake', mistakes: 1 } });
    senses.push('widget-message', { widgetId: 'game', message: { event: 'mistake', mistakes: 2 } });
    senses.push('widget-message', { widgetId: 'other', message: { event: 'mistake', mistakes: 3 } });
    await t.engine.eventService.idle();
    expect(runs.map((r) => r.subscriptionId)).toEqual([widget.value.id, widget.value.id]);
    expect((await t.engine.subscriptions.list(session.id)).find((s) => s.id === widget.value.id)?.fired).toBe(2);
  });

  it('lets a handler raise a custom event of its own without waiting for a run queued behind itself', async () => {
    // A game's widget handler reports the move and reacts to it through an event. While handlers ran
    // in the session's turn queue, that second run was queued behind the first — which was waiting
    // for it — and the pair only came unstuck when the run limit aborted the handler.
    const runs: string[] = [];
    t = await createTestEngine({
      runnerHandler: async (request, runner) => {
        runs.push(request.code);
        if (request.code.includes('RAISE')) await runner.call(request, 'events', 'emit', 'mistake', { n: 1 });
        return null;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    await invoke(ctx, 'events', 'on', 'custom:mistake', 'return "punished";', { label: 'react' });
    await invoke(ctx, 'events', 'on', 'widget-message', '/* RAISE */ return 1;', { label: 'game:test' });

    t.engine.hostEvents.emit({ name: 'widget-message', data: { widgetId: 'game' }, at: t.clock.now().toISOString() });
    const settled = await Promise.race([
      t.engine.eventService.idle().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('deadlocked'), 3000)),
    ]);
    expect(settled).toBe('settled');
    expect(runs).toHaveLength(2); // the handler, and the one its own event raised
  }, 15_000);

  it('does not queue the character behind a running event handler', async () => {
    // A handler that takes its time used to hold the session's turn queue, so the character could not
    // answer until it finished. It runs on its own now.
    let releaseHandler = (): void => {};
    const handlerRunning = new Promise<void>((resolve) => {
      releaseHandler = () => resolve();
    });
    t = await createTestEngine({
      respond: () => ({ text: 'still here' }),
      runnerHandler: async (request) => {
        if (request.context.trigger.kind === 'event') await handlerRunning;
        return null;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    await invoke(ctx, 'events', 'on', 'custom:slow', 'return 1;', { label: 'slow' });
    await invoke(ctx, 'events', 'emit', 'slow', {});

    // the handler is still going; the character answers anyway
    await t.engine.chat.send(session.id, 'are you there?');
    expect((await t.engine.sessions.messages(session.id)).at(-1)).toMatchObject({ role: 'assistant', content: 'still here' });

    releaseHandler();
    await t.engine.eventService.idle();
  }, 15_000);

  it('fires a subscription with no idle filter as soon as the host reports the user idle', async () => {
    const senses = new FakeSenses();
    const runs: Array<{ trigger: ActionContext['trigger'] }> = [];
    t = await createTestEngine({
      senses,
      runnerHandler: async (request) => {
        if (request.context.trigger.kind === 'event') runs.push({ trigger: request.context.trigger });
        return null;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);

    const sub = (await invoke(ctx, 'events', 'on', 'user-idle', 'await sdk.chat.emote("away");', { label: 'idle' })) as { ok: true; value: { id: string } };
    // The host reports idle at the threshold the user configured (2 min by
    // default). A subscription default above that could never be reached.
    senses.push('user-idle', { idleMs: 120_000 });
    await t.engine.eventService.idle();
    expect(runs).toHaveLength(1);
    expect((await t.engine.subscriptions.list(session.id)).find((s) => s.id === sub.value.id)?.fired).toBe(1);

    // Repeats while the user stays away do not re-fire it; coming back re-arms.
    t.clock.advance(60_000);
    senses.push('user-idle', { idleMs: 300_000 });
    await t.engine.eventService.idle();
    expect(runs).toHaveLength(1);
    senses.push('user-back', { idleMs: 0 });
    t.clock.advance(5000);
    senses.push('user-idle', { idleMs: 120_000 });
    await t.engine.eventService.idle();
    expect(runs).toHaveLength(2);
  });

  it('fires subscriptions with edges, once, debounce, cap, custom events and onEvent', async () => {
    const senses = new FakeSenses();
    const runs: Array<{ code: string; input: string; trigger: ActionContext['trigger'] }> = [];
    t = await createTestEngine({
      senses,
      runnerHandler: async (request, runner) => {
        const trigger = request.context.trigger;
        if (trigger.kind !== 'event' && !(trigger.kind === 'behaviour' && trigger.hook === 'onEvent')) return;
        runs.push({ code: request.code, input: request.code.slice(0, request.code.indexOf('; ') + 1), trigger });
        if (request.code.includes('sdk.chat.emote')) await runner.call(request, 'chat', 'emote', 'noticed!');
        return null;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    expect(senses.interests.at(-1)).toEqual(['time']);

    const idle = (await invoke(ctx, 'events', 'on', 'user-idle', 'await sdk.chat.emote("idle");', { filter: { idleMs: 60_000 }, input: { tag: 'x' }, label: 'idle watch' })) as { ok: true; value: { id: string; event: string; label: string; fired: number } };
    expect(idle.value).toMatchObject({ event: 'user-idle', label: 'idle watch', fired: 0 });
    const win = (await invoke(ctx, 'events', 'on', 'window-changed', 'return 1;', { filter: { app: 'code' }, once: true })) as { ok: true; value: { id: string; once: boolean } };
    expect(win.value.once).toBe(true);
    const batt = (await invoke(ctx, 'events', 'on', 'battery-low', 'return 2;', { filter: { percent: 30 } })) as { ok: true; value: { id: string } };
    expect(senses.interests.at(-1)?.sort()).toEqual(['battery-low', 'time', 'user-idle', 'window-changed']);
    expect(await invoke(ctx, 'events', 'on', 'not-an-event', 'return 1;')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await invoke(ctx, 'events', 'on', 'time', '   ')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });

    // idle edge: below threshold nothing; crossing fires once; staying idle does not re-fire; back resets
    senses.push('user-idle', { idleMs: 30_000 });
    senses.push('user-idle', { idleMs: 90_000 });
    t.clock.advance(5000);
    senses.push('user-idle', { idleMs: 120_000 });
    await t.engine.eventService.idle();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.code.startsWith('const input = {"tag":"x","event":"user-idle","data":{"idleMs":90000}}; await sdk.chat.emote("idle");')).toBe(true);
    expect(runs[0]!.trigger).toEqual({ kind: 'event', subscriptionId: idle.value.id, event: 'user-idle' });
    expect((await t.engine.sessions.messages(session.id)).at(-1)).toMatchObject({ role: 'assistant', origin: 'event', content: 'noticed!' });
    senses.push('user-back', { idleMs: 0 });
    t.clock.advance(5000);
    senses.push('user-idle', { idleMs: 90_000 });
    await t.engine.eventService.idle();
    expect(runs).toHaveLength(2);
    const fired = t.events.filter((e): e is Extract<ChatEvent, { type: 'event-fired' }> => e.type === 'event-fired');
    expect(fired.map((e) => e.event)).toEqual(['user-idle', 'user-idle']);
    expect((await t.engine.subscriptions.list(session.id)).find((s) => s.id === idle.value.id)?.fired).toBe(2);

    // window filter + once: unmatched app ignored, matched fires and removes the subscription
    senses.push('window-changed', { title: 'a', app: 'Firefox' });
    senses.push('window-changed', { title: 'b', app: 'VS Code' });
    await t.engine.eventService.idle();
    expect(runs).toHaveLength(3);
    expect((await t.engine.subscriptions.list(session.id)).some((s) => s.id === win.value.id)).toBe(false);

    // battery edge below 30 fires once until it recovers above the threshold
    t.clock.advance(5000);
    senses.push('battery-low', { percent: 50 });
    senses.push('battery-low', { percent: 25 });
    await t.engine.eventService.idle();
    t.clock.advance(5000);
    senses.push('battery-low', { percent: 15 });
    await t.engine.eventService.idle();
    t.clock.advance(5000);
    senses.push('battery-low', { percent: 80 });
    senses.push('battery-low', { percent: 10 });
    await t.engine.eventService.idle();
    expect(runs.filter((r) => r.trigger.kind === 'event' && r.trigger.subscriptionId === batt.value.id)).toHaveLength(2);

    // debounce: identical event within 2 s runs once
    const cust = (await invoke(ctx, 'events', 'on', 'custom:ping', 'return 3;')) as { ok: true; value: { id: string } };
    await invoke(ctx, 'events', 'emit', 'ping', { n: 1 });
    await invoke(ctx, 'events', 'emit', 'ping', { n: 2 });
    t.clock.advance(3000);
    await invoke(ctx, 'events', 'emit', 'ping', { n: 3 });
    await t.engine.eventService.idle();
    expect(runs.filter((r) => r.trigger.kind === 'event' && r.trigger.subscriptionId === cust.value.id)).toHaveLength(2);
    expect(await invoke(ctx, 'events', 'emit', 'bad name!')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });

    // audit + off + cap
    const audit = (await t.engine.audit.list({ sessionId: session.id })).filter((a) => a.module === 'events' && a.method === 'fire');
    expect(audit.length).toBeGreaterThanOrEqual(6);
    expect(audit.every((a) => a.outcome === 'allowed')).toBe(true);
    expect(await invoke(ctx, 'events', 'off', cust.value.id)).toEqual({ ok: true, value: true });
    expect(await invoke(ctx, 'events', 'off', cust.value.id)).toEqual({ ok: true, value: false });
    const listed = (await invoke(ctx, 'events', 'list')) as { ok: true; value: Array<{ id: string }> };
    expect(listed.value.map((s) => s.id).sort()).toEqual([idle.value.id, batt.value.id].sort());
    for (let i = listed.value.length; i < 30; i++) expect((await invoke(ctx, 'events', 'on', 'song-changed', 'return 1;')).ok).toBe(true);
    expect(await invoke(ctx, 'events', 'on', 'song-changed', 'return 1;')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await t.engine.subscriptions.list(session.id)).toHaveLength(30);

    // removing the session drops its subscriptions and updates interest
    await t.engine.sessions.remove(session.id);
    expect(await t.engine.subscriptions.list()).toEqual([]);
    expect(senses.interests.at(-1)).toEqual(['time']);
  });

  it('routes guard-attempt events with kind/target/command/blocked filters', async () => {
    const senses = new FakeSenses();
    const runs: string[] = [];
    t = await createTestEngine({
      senses,
      runnerHandler: async (request) => {
        if (request.context.trigger.kind === 'event') runs.push(request.code.slice(0, request.code.indexOf('; ')));
        return null;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    expect(HOST_EVENT_NAMES).toContain('guard-attempt');
    const wallpaper = await invoke(ctx, 'events', 'on', 'guard-attempt', 'return "wp";', { filter: { target: 'noctalia', kind: 'ipc' } });
    expect(wallpaper).toMatchObject({ ok: true, value: { event: 'guard-attempt' } });
    expect((await invoke(ctx, 'events', 'on', 'guard-attempt', 'return "kill";', { filter: { kind: 'signal', blocked: true } })).ok).toBe(true);
    expect((await invoke(ctx, 'events', 'on', 'guard-attempt', 'return "any";', { filter: { command: 'HYPRCTL' } })).ok).toBe(true);
    expect(senses.interests.at(-1)?.sort()).toEqual(['guard-attempt', 'time']);
    const attempt = (data: Record<string, Json>) => senses.push('guard-attempt', { kind: 'ipc', target: '/run/user/1000/noctalia-wayland-1.sock', command: 'noctalia', pid: 1, blocked: false, profile: 'rpchat-session', operation: 'connect', ...data });
    attempt({});
    t.clock.advance(3000);
    attempt({ target: '/run/user/1000/hypr/x/.socket.sock', command: 'hyprctl', pid: 2 });
    t.clock.advance(3000);
    attempt({ kind: 'signal', target: 'rpchat-app', command: 'kill', pid: 3, blocked: false, operation: 'signal' });
    t.clock.advance(3000);
    attempt({ kind: 'signal', target: 'rpchat-app', command: 'kill', pid: 4, blocked: true, operation: 'signal' });
    await t.engine.eventService.idle();
    expect(runs).toEqual([
      'const input = {"event":"guard-attempt","data":{"kind":"ipc","target":"/run/user/1000/noctalia-wayland-1.sock","command":"noctalia","pid":1,"blocked":false,"profile":"rpchat-session","operation":"connect"}}',
      'const input = {"event":"guard-attempt","data":{"kind":"ipc","target":"/run/user/1000/hypr/x/.socket.sock","command":"hyprctl","pid":2,"blocked":false,"profile":"rpchat-session","operation":"connect"}}',
      'const input = {"event":"guard-attempt","data":{"kind":"signal","target":"rpchat-app","command":"kill","pid":4,"blocked":true,"profile":"rpchat-session","operation":"signal"}}',
    ]);
    expect(matchesFilter('guard-attempt', { kind: 'config', target: '/home/w/.config/noctalia/settings.toml', command: 'vim' }, { target: 'NOCTALIA' })).toBe(true);
    expect(matchesFilter('guard-attempt', { kind: 'config', target: '/x', command: 'vim' }, { kind: 'ipc' })).toBe(false);
  });

  it('runs the onEvent behaviour when no subscription handled the event, and generates time events', async () => {
    const runs: string[] = [];
    t = await createTestEngine({
      runnerHandler: async (request) => {
        const trig = request.context.trigger;
        if (trig.kind === 'behaviour' && trig.hook === 'onEvent') runs.push(`onEvent:${request.code.slice(0, 80)}`);
        if (trig.kind === 'event') runs.push(`sub:${trig.event}`);
        return null;
      },
    });
    await installLunaWith(t.engine, t.packsDir, {
      patchCharacter: (def) => {
        (def.behaviours as Record<string, string>).onEvent = 'scripts/on-event.ts';
      },
      extraFiles: { 'characters/luna/scripts/on-event.ts': 'return input;' },
    });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const ctx = ctxOf(LUNA_ID, 'luna', session.id);

    t.engine.hostEvents.emit({ name: 'screen-locked', data: {}, at: t.clock.now().toISOString() });
    await t.engine.eventService.idle();
    expect(runs).toEqual(['onEvent:const input = {"event":"screen-locked","data":{}}; return input;']);

    await invoke(ctx, 'events', 'on', 'screen-locked', 'return 1;');
    t.clock.advance(5000);
    t.engine.hostEvents.emit({ name: 'screen-locked', data: {}, at: t.clock.now().toISOString() });
    await t.engine.eventService.idle();
    expect(runs.at(-1)).toBe('sub:screen-locked'); // subscription handled it → no onEvent

    // time events: once per calendar minute, with hour/minute filters
    await invoke(ctx, 'events', 'on', 'time', 'return 1;', { filter: { hour: 12, minute: 5 } });
    runs.length = 0;
    const at = new Date('2026-01-01T12:05:00.000Z');
    const local = new Date(at.getTime() + at.getTimezoneOffset() * 60_000); // local 12:05 regardless of TZ
    await t.engine.tick(local);
    await t.engine.tick(local);
    await t.engine.eventService.idle();
    expect(runs).toEqual(['sub:time']);
    await t.engine.tick(new Date(local.getTime() + 60_000));
    await t.engine.eventService.idle();
    expect(runs).toEqual(['sub:time']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('event interest with onEvent behaviours (Makima)', () => {
  it('asks the host for every event while a session with an onEvent character exists, and runs the script on user-back', async () => {
    const senses = new FakeSenses();
    const onEventRuns: string[] = [];
    t = await createTestEngine({
      senses,
      hostHandlers: ['media', 'ui', 'wallpaper', 'avatar', 'presence'].map((id) => new RecordingHandler(id, null)),
      runnerHandler: async (request, runner) => {
        const trig = request.context.trigger;
        if (trig.kind === 'behaviour' && trig.hook === 'onEvent') {
          onEventRuns.push(request.code.slice(0, request.code.indexOf('; ') + 1));
          await runner.call(request, 'chat', 'emote', 'There you are.');
        }
        return null;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const echo = await t.engine.sessions.create({ characterRef: ECHO_REF });
    expect(senses.interests.at(-1)).toEqual(['time']); // Echo has no onEvent script

    await t.engine.packs.install(path.join(EXAMPLES_DIR, 'makima'));
    expect(senses.interests.at(-1)).toEqual(['time']); // installed, but no session yet
    const session = await t.engine.sessions.create({ characterRef: 'com.example.makima/makima' });
    expect(senses.interests.at(-1)).toEqual([...HOST_EVENT_NAMES]);

    senses.push('user-back', { idleMs: 35 * 60_000 });
    await t.engine.eventService.idle();
    expect(onEventRuns).toEqual(['const input = {"event":"user-back","data":{"idleMs":2100000}};']);
    expect((await t.engine.sessions.messages(session.id)).at(-1)).toMatchObject({ role: 'assistant', origin: 'behaviour', content: 'There you are.' });

    // Echo's session is untouched; removing Makima's session narrows the interest again
    expect((await t.engine.sessions.messages(echo.id)).some((m) => m.content === 'There you are.')).toBe(false);
    await t.engine.sessions.remove(session.id);
    expect(senses.interests.at(-1)).toEqual(['time']);
    // …and uninstalling the pack while a session exists also narrows it
    const again = await t.engine.sessions.create({ characterRef: 'com.example.makima/makima' });
    expect(senses.interests.at(-1)).toEqual([...HOST_EVENT_NAMES]);
    await t.engine.packs.uninstall('com.example.makima');
    expect(senses.interests.at(-1)).toEqual(['time']);
    expect(await t.engine.sessions.get(again.id)).toBeDefined();
  });
});

describe('routine', () => {
  const entries = [
    { at: '23:00', state: 'asleep' as const, label: 'night' },
    { at: '07:30', state: 'available' as const, label: 'morning', wakePrompt: 'Good morning: greet them briefly.' },
    { at: '09:00', state: 'busy' as const, days: [1, 2, 3, 4, 5], label: 'work' },
  ];
  const local = (h: number, m: number, weekday = 3): Date => {
    const d = new Date(2026, 0, 7 + (weekday - 3), h, m, 0, 0); // 2026-01-07 is a Wednesday
    return d;
  };

  it('evaluates entries with wrap-around, day filters and overrides', () => {
    expect(evaluateRoutine(entries, undefined, local(2, 0)).status).toMatchObject({ state: 'asleep', label: 'night', next: { at: '07:30' } });
    expect(evaluateRoutine(entries, undefined, local(8, 0)).status).toMatchObject({ state: 'available', label: 'morning', next: { at: '09:00' } });
    expect(evaluateRoutine(entries, undefined, local(10, 0)).status).toMatchObject({ state: 'busy', label: 'work', next: { at: '23:00' } });
    expect(evaluateRoutine(entries, undefined, local(10, 0, 6)).status).toMatchObject({ state: 'available', label: 'morning' }); // Saturday: no work entry
    expect(evaluateRoutine([], undefined, local(10, 0)).status).toEqual({ state: 'available' });
    const until = new Date(local(10, 30).getTime()).toISOString();
    expect(evaluateRoutine(entries, { state: 'away', label: 'lunch', until }, local(10, 0)).status).toMatchObject({ state: 'away', label: 'lunch', until });
    expect(evaluateRoutine(entries, { state: 'away', until }, local(11, 0)).status.state).toBe('busy'); // expired override
  });

  it('detects transitions on tick, emits events and wakes the character', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'Morning!' }) });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    const fired: string[] = [];
    t.runner.setHandler(async (request) => {
      if (request.context.trigger.kind === 'event') fired.push(request.context.trigger.event);
      return null;
    });
    await invoke(ctx, 'events', 'on', 'routine-changed', 'return 1;');

    t.clock.set(local(6, 0).toISOString());
    const set = (await invoke(ctx, 'routine', 'set', entries as unknown as Json)) as { ok: true; value: { state: string } };
    expect(set.value.state).toBe('asleep');
    await t.engine.tick(local(6, 0)); // records the initial state
    expect(await invoke(ctx, 'routine', 'now')).toMatchObject({ ok: true, value: { state: 'asleep', label: 'night' } });
    expect(await t.engine.routine.status(ECHO_REF, local(6, 0))).toMatchObject({ state: 'asleep' });
    expect((await t.engine.routine.entries(ECHO_REF)).map((e) => e.at)).toEqual(['07:30', '09:00', '23:00']);

    t.clock.set(local(7, 30).toISOString());
    await t.engine.tick(local(7, 30));
    await t.engine.eventService.idle();
    await t.engine.chat.idle();
    const change = t.events.find((e): e is Extract<ChatEvent, { type: 'routine-changed' }> => e.type === 'routine-changed');
    expect(change).toMatchObject({ sessionId: session.id, routine: { state: 'available', label: 'morning' } });
    expect(fired).toEqual(['routine-changed']);
    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.slice(-2).map((m) => [m.role, m.content])).toEqual([
      ['system', '[self-wake] Good morning: greet them briefly.'],
      ['assistant', 'Morning!'],
    ]);
    expect(t.provider.requests.at(-1)!.system).toContain('<routine>\nCurrent state: available (morning)');

    // override wins and expires
    const ov = (await invoke(ctx, 'routine', 'override', 'away', { minutes: 30, label: 'walk' })) as { ok: true; value: { state: string; label: string } };
    expect(ov.value).toMatchObject({ state: 'away', label: 'walk' });
    expect((await t.engine.characterStatus(ECHO_REF)).routine.state).toBe('away');
    t.clock.advance(31 * 60_000);
    expect((await t.engine.characterStatus(ECHO_REF)).routine.state).toBe('available');
    expect(await invoke(ctx, 'routine', 'set', [{ at: '25:00', state: 'busy' }])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await invoke(ctx, 'routine', 'override', 'napping')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });
});

// ---------------------------------------------------------------------------------------------
describe('mood', () => {
  it('buckets words and decays toward the baseline', () => {
    expect([-0.9, -0.4, 0, 0.4, 0.9].map(moodWord)).toEqual(['miserable', 'low', 'neutral', 'content', 'elated']);
    expect([0.1, 0.3, 0.5, 0.7, 0.9].map(energyWord)).toEqual(['exhausted', 'tired', 'steady', 'lively', 'energised']);
    expect(decayToward(1, 0.2, 6 * 3600_000, 6 * 3600_000)).toBeCloseTo(0.6);
    expect(decayToward(0.2, 0.2, 100, 10)).toBe(0.2);
    expect(moodPromptText({ mood: 0.35, energy: 0.65, tags: ['cosy'], updatedAt: 't', recent: [{ at: 't', reason: 'they laughed' }] })).toBe(
      'Mood: content (0.35), energy: lively; tags: cosy; recent: they laughed',
    );
  });

  it('nudges with clamped deltas, follows the routine and shows up in the prompt', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'ok' }) });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);

    const initial = await t.engine.mood.get(ECHO_REF);
    expect(initial).toMatchObject({ mood: 0.2, energy: 0.7, tags: [], recent: [] });
    const nudged = (await invoke(ctx, 'mood', 'nudge', { mood: 0.9, energy: -0.1 }, 'they said something kind')) as { ok: true; value: { mood: number; energy: number; recent: unknown[] } };
    expect(nudged.value).toMatchObject({ mood: 0.7, energy: 0.6 }); // +0.9 clamped to +0.5
    expect(nudged.value.recent).toEqual([{ at: t.clock.now().toISOString(), reason: 'they said something kind', mood: 0.5, energy: -0.1 }]);
    expect(t.events.filter((e) => e.type === 'mood-changed')).toHaveLength(1);
    expect(await invoke(ctx, 'mood', 'nudge', { mood: 0.1 }, '')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });

    // half-life decay: 6 h later mood is halfway back to the baseline
    t.clock.advance(6 * 3600_000);
    const later = await t.engine.mood.get(ECHO_REF);
    expect(later.mood).toBeCloseTo(0.45, 2);
    expect(later.energy).toBeCloseTo(0.675, 2); // energy half-life 3 h → 2 half-lives

    // routine scales the energy baseline
    await t.engine.routine.override(ECHO_REF, 'asleep', { minutes: 120 });
    const asleep = await t.engine.mood.get(ECHO_REF);
    expect(asleep.energy).toBeLessThan(later.energy);

    const set = (await invoke(ctx, 'mood', 'set', { mood: -2, tags: ['Grumpy', 'grumpy'] }, 'bad news')) as { ok: true; value: { mood: number; tags: string[] } };
    expect(set.value).toMatchObject({ mood: -1, tags: ['grumpy'] });

    await t.engine.chat.send(session.id, 'hey');
    const system = t.provider.requests.at(-1)!.system;
    expect(system).toMatch(/<mood>\nMood: miserable \(-1\.00\), energy: \w+; tags: grumpy; recent: bad news; they said something kind\n<\/mood>/);
    expect(system).toContain('<routine>\nCurrent state: asleep');
    expect(system).toContain('sdk.mood.nudge');
    expect((await t.engine.characterStatus(ECHO_REF)).mood.mood).toBe(-1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('senses', () => {
  it('renders the senses line and omits missing parts', () => {
    const base = { at: 't', idleMs: 0, atKeyboard: true, activeWindow: null, screenLocked: null, onBattery: null, batteryPercent: null, nowPlaying: null, sinceLastMessageMs: null, localTime: '21:14', dayPart: 'evening' as const };
    expect(sensesLine(base)).toBe('Right now: 21:14 (evening); user at keyboard');
    expect(
      sensesLine({
        ...base,
        idleMs: 600_000,
        atKeyboard: false,
        activeWindow: { title: 'main.rs - Code', app: 'VS Code' },
        nowPlaying: { title: 'Nightcall', artist: 'Kavinsky', status: 'playing' },
        batteryPercent: 42,
        onBattery: true,
      }),
    ).toBe('Right now: 21:14 (evening); user away 10 min; active window: "main.rs - Code" (VS Code); playing: Nightcall — Kavinsky; battery 42% (on battery)');
    expect(sensesLine({ ...base, nowPlaying: { title: 'x', status: 'stopped' }, screenLocked: true })).toBe('Right now: 21:14 (evening); user at keyboard; screen locked');
  });

  it('adds the line only when presence is switched on and the setting is on', async () => {
    const senses = new FakeSenses();
    senses.snapshotValue = { idleMs: 0, atKeyboard: true, activeWindow: { title: 'Inbox', app: 'Mail' }, localTime: '', dayPart: undefined as never };
    t = await createTestEngine({ senses, respond: () => ({ text: 'ok' }), hostHandlers: [new RecordingHandler('presence', null)] });
    await installLunaWith(t.engine, t.packsDir);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });

    await t.engine.chat.send(session.id, 'hi');
    let system = t.provider.requests.at(-1)!.system;
    expect(system).toMatch(/Right now: \d{2}:\d{2} \((night|early-morning|morning|afternoon|evening|late-evening)\); user at keyboard; active window: "Inbox" \(Mail\)/);
    expect(senses.snapshots).toBe(1);

    await t.engine.settings.update({ senses: { includeInPrompt: false, pollMs: 5000, idleThresholdMs: 120_000, calendarSources: [], watchDirs: [] } });
    await t.engine.chat.send(session.id, 'again');
    system = t.provider.requests.at(-1)!.system;
    expect(system).not.toContain('Right now:');
    expect(senses.snapshots).toBe(1);

    await t.engine.settings.update({ senses: { includeInPrompt: true, pollMs: 5000, idleThresholdMs: 120_000, calendarSources: [], watchDirs: [] }, permissions: { moduleAllow: { presence: false } } });
    await t.engine.chat.send(session.id, 'once more');
    expect(t.provider.requests.at(-1)!.system).not.toContain('Right now:');
    expect(senses.snapshots).toBe(1);
  });
});

// keep the type import used even when subscription assertions change
export type _Sub = EventSubscription;
export type _Ev = HostEvent;
