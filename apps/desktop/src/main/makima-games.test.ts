/**
 * The Makima pack's mini games, run through the real QuickJS sandbox: each starter is called as
 * `lib.<game>(…)` with the pack's library as the prelude, against a fake host that plays the
 * `state`, `events`, `pack`, `media`, `chat`, `avatar`, `wallpaper` and `llm` modules and the real
 * `WidgetsHandler` (fake display backend), so the widget HTML that would reach the screen — with
 * `{{asset:…}}` placeholders substituted — is what is asserted. Host events are then fed back the
 * way core would: a matching subscription's handler runs in a fresh run with `input`.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionContext, CapabilityCall, CapabilityResult, HostEvent, Json, LoadedPack, MediaCommand, MonitorInfo, SdkSurface } from '@rp/shared';
import { RpError } from '@rp/shared';
import { loadPack } from '@rp/pack';
import { createStandardRegistry, describeSurface } from '@rp/sdk';
import { buildPrelude, findAssets, matchesFilter, resolvePackAsset, showableAssets, toAssetRef } from '@rp/core';
import { QuickJsRunner } from '@rp/sandbox';
import type { DisplayBackend, OverlayHandle, OverlaySpec } from './display/backend.js';
import { WidgetsHandler } from './capabilities/widgets.js';

const MAKIMA_DIR = fileURLToPath(new URL('../../../../examples/packs/makima/', import.meta.url));
const MONITOR: MonitorInfo = { id: 'm0', name: 'Main', index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1, hasCursor: true };
const CARD_URL = /rp-asset:\/\/com\.example\.makima\/media\/images\/cards\/[a-z-]+\.png/g;

interface Sub {
  id: string;
  event: string;
  code: string;
  filter?: Record<string, Json>;
  input?: Json;
  label?: string;
  once?: boolean;
  fired: number;
}

class FakeHandle implements OverlayHandle {
  readonly sent: MediaCommand[] = [];
  closed = false;
  constructor(readonly id: string) {}
  async update(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  async send(command: MediaCommand): Promise<void> {
    this.sent.push(command);
  }
  on(): () => void {
    return () => undefined;
  }
}

/** The host side of one character: what the games talk to. */
class FakeHost {
  readonly session = new Map<string, Json>();
  readonly subs: Sub[] = [];
  readonly calls: string[] = [];
  readonly media: Array<{ id: string; asset: string; options: Record<string, Json>; open: boolean }> = [];
  readonly widgetSpecs: OverlaySpec[] = [];
  readonly widgetHandles: FakeHandle[] = [];
  readonly widgets: WidgetsHandler;
  private seq = 0;

  constructor(readonly pack: LoadedPack) {
    const backend: DisplayBackend = {
      name: 'fake',
      info: () => ({ name: 'fake', platform: 'linux', windowSystem: 'x11', supports: { layers: ['top'], opacity: true, clickThrough: true, monitorSelection: true, exactPosition: true } }),
      monitors: async () => [MONITOR],
      createOverlay: async (spec) => {
        this.widgetSpecs.push(spec);
        const h = new FakeHandle(spec.id);
        this.widgetHandles.push(h);
        return h;
      },
      closeAll: async () => undefined,
      dispose: async () => undefined,
    };
    this.widgets = new WidgetsHandler({ backend: () => backend, emit: () => undefined, defaultLayer: async () => 'top', packs: { getLoaded: () => pack } });
  }

  /** Every HTML a widget currently shows or was updated to, newest last. */
  widgetHtml(): string[] {
    const out: string[] = [];
    this.widgetSpecs.forEach((spec, i) => {
      out.push(spec.widget!.html);
      for (const c of this.widgetHandles[i]!.sent) if (c.type === 'widget-update' && c.html) out.push(c.html);
    });
    return out;
  }

  openMedia(): Array<{ id: string; asset: string }> {
    return this.media.filter((m) => m.open).map((m) => ({ id: m.id, asset: m.asset }));
  }

  async invoke(call: CapabilityCall): Promise<CapabilityResult> {
    const { module, method, args } = call;
    this.calls.push(`${module}.${method}`);
    try {
      return { ok: true, value: (await this.handle(module, method, args, call.context)) as Json };
    } catch (err) {
      return { ok: false, error: RpError.from(err, 'CAPABILITY_FAILED').toJSON() };
    }
  }

  private async handle(module: string, method: string, args: Json[], context: ActionContext): Promise<unknown> {
    const key = `${module}.${method}`;
    switch (key) {
      case 'state.session.get':
        return this.session.get(String(args[0]));
      case 'state.session.set':
        this.session.set(String(args[0]), args[1] as Json);
        return;
      case 'state.session.delete':
        this.session.delete(String(args[0]));
        return;
      case 'events.on': {
        const opts = (args[2] ?? {}) as Record<string, Json>;
        const sub: Sub = { id: `sub-${++this.seq}`, event: String(args[0]), code: String(args[1]), fired: 0 };
        if (opts['filter']) sub.filter = opts['filter'] as Record<string, Json>;
        if (opts['input'] !== undefined) sub.input = opts['input'];
        if (typeof opts['label'] === 'string') sub.label = opts['label'];
        if (opts['once'] === true) sub.once = true;
        this.subs.push(sub);
        return { id: sub.id, event: sub.event, label: sub.label, once: sub.once ?? false, fired: 0 };
      }
      case 'events.off': {
        const i = this.subs.findIndex((s) => s.id === args[0]);
        if (i >= 0) this.subs.splice(i, 1);
        return i >= 0;
      }
      case 'events.list':
        return this.subs.map((s) => ({ id: s.id, event: s.event, label: s.label, once: s.once ?? false, fired: s.fired }));
      case 'pack.findAssets':
        return findAssets(showableAssets(this.pack.assets), (args[0] ?? {}) as Record<string, never>);
      case 'pack.listAssets': {
        const prefix = typeof args[0] === 'string' ? args[0] : '';
        return showableAssets(this.pack.assets)
          .filter((a) => a.path.startsWith(prefix) && (!args[1] || a.kind === args[1]))
          .map(toAssetRef);
      }
      case 'pack.asset':
        return resolvePackAsset(this.pack, String(args[0]));
      case 'media.showImage': {
        const ref = resolvePackAsset(this.pack, typeof args[0] === 'string' ? args[0] : String((args[0] as { path: string }).path));
        const item = { id: `media-${++this.seq}`, asset: ref.path, options: (args[1] ?? {}) as Record<string, Json>, open: true };
        this.media.push(item);
        return { id: item.id, kind: 'image', asset: item.asset };
      }
      case 'media.close':
        for (const m of this.media) if (m.id === (typeof args[0] === 'string' ? args[0] : (args[0] as { id: string }).id)) m.open = false;
        return;
      case 'media.closeAll':
        for (const m of this.media) m.open = false;
        return;
      case 'media.list':
        return this.openMedia().map((m) => ({ ...m, kind: 'image' }));
      case 'widgets.show':
      case 'widgets.update':
      case 'widgets.close':
      case 'widgets.closeAll':
      case 'widgets.list':
        return this.widgets.invoke(method, args, context);
      case 'chat.emote':
      case 'avatar.set':
      case 'wallpaper.set':
      case 'llm.wake':
      case 'log.debug':
      case 'log.info':
      case 'log.warn':
      case 'log.error':
        return null;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `fake host: no ${key}`);
    }
  }

  /** Subscriptions a host event would reach (name + filter, as core's EventService matches them). */
  matching(event: HostEvent): Sub[] {
    return this.subs.filter((s) => s.event === event.name && matchesFilter(event.name, event.data, s.filter));
  }
}

let runner: QuickJsRunner;
let pack: LoadedPack;
let prelude: string;
let surface: SdkSurface;

beforeAll(async () => {
  runner = new QuickJsRunner();
  pack = await loadPack(MAKIMA_DIR);
  const library = pack.characters[0]!.library;
  // a test-only loss/win recorder next to the shipped functions: what the hooks receive is asserted precisely
  const recorder = { source: 'async (info) => { await sdk.state.session.set("recorded", [...(((await sdk.state.session.get("recorded")) as any[]) ?? []), info]); return "recorded"; }', bytes: 1, updatedAt: 't' };
  prelude = buildPrelude([...Object.entries(library).map(([name, e]) => ({ name, source: e.source, bytes: e.bytes, updatedAt: e.updatedAt })), { name: 'record', ...recorder }]);
  surface = describeSurface(createStandardRegistry());
});
afterAll(async () => {
  await runner.dispose();
});

function makeHost(): FakeHost {
  return new FakeHost(pack);
}

const context = (host: FakeHost, trigger: ActionContext['trigger'] = { kind: 'llm', actionId: 'a', messageId: 'm' }): ActionContext => ({
  packId: pack.manifest.id,
  characterId: 'makima',
  sessionId: 'session-1',
  packRoot: host.pack.root,
  trigger,
});

async function run(host: FakeHost, code: string): Promise<unknown> {
  const result = await runner.run({ code, language: 'ts', prelude, context: context(host), surface, invoker: host });
  if (!result.ok) throw new Error(`run failed: ${result.error?.message}\n${result.error?.stack ?? ''}\n${result.logs.map((l) => l.args.join(' ')).join('\n')}`);
  return result.returnValue;
}

/** Deliver a host event the way core does: every matching subscription runs its handler with `input`. */
async function fire(host: FakeHost, name: HostEvent['name'], data: Json): Promise<unknown[]> {
  const event: HostEvent = { name, data, at: new Date().toISOString() };
  const out: unknown[] = [];
  for (const sub of host.matching(event)) {
    const input = { ...((sub.input as Record<string, Json> | undefined) ?? {}), event: name, data };
    const result = await runner.run({
      code: `const input = ${JSON.stringify(input)};\n${sub.code}`,
      language: 'ts',
      prelude,
      context: context(host, { kind: 'event', subscriptionId: sub.id, event: name }),
      surface,
      invoker: host,
    });
    if (!result.ok) throw new Error(`handler ${sub.label ?? sub.id} failed: ${result.error?.message}\n${result.error?.stack ?? ''}`);
    sub.fired += 1;
    out.push(result.returnValue);
  }
  return out;
}

const widgetMessage = (host: FakeHost, widgetId: string, message: Json) => fire(host, 'widget-message', { widgetId, message, characterRef: 'com.example.makima/makima' });
const game = (host: FakeHost) => host.session.get('game') as Record<string, Json> | undefined;
const recorded = (host: FakeHost) => (host.session.get('recorded') as Array<Record<string, Json>> | undefined) ?? [];
const labels = (host: FakeHost) => host.subs.map((s) => s.label).sort();
const punishCalls = (host: FakeHost) => host.calls.filter((c) => c === 'chat.emote' || c === 'llm.wake' || c === 'wallpaper.set' || c === 'avatar.set');

describe('Makima mini games (real sandbox)', () => {
  it('memoryGame: shows card faces as pack images; every wrong pair calls the loss function, running out reshuffles, matching all wins', async () => {
    const host = makeHost();
    const started = await run(host, 'return await lib.memoryGame({ onLose: "punish", onWin: "record", pairs: 6, maxMistakes: 1, timeLimitS: 30 });');
    expect(started).toEqual({ started: 'memory', attempt: 1, pairs: 6, maxMistakes: 1, timeLimitS: 30 });
    const html = host.widgetHtml().at(-1)!;
    expect(html).not.toContain('{{asset:');
    expect(html.match(CARD_URL)?.length).toBeGreaterThan(0);
    expect((html.match(/<div class="c" data-k="\d+">/g) ?? []).length).toBe(12); // six pairs
    expect(new Set(html.match(/rp-asset:\/\/[^"]+/g)).size).toBe(6);
    expect(html).toMatch(/rp-asset:\/\/com\.example\.makima\/media\/images\/cards\//);
    expect(labels(host)).toEqual(['game:memory']);
    expect(game(host)).toMatchObject({ game: 'memory', starter: 'memoryGame', onLose: 'punish', onWin: 'record', attempt: 1, mistakes: 0, widgetId: 'game-memory' });

    // a wrong pair: the loss function runs (Makima changes expression and wallpaper, then wakes to react), the game goes on
    const before = punishCalls(host).length;
    await widgetMessage(host, 'game-memory', { event: 'mistake', mistakes: 1, moves: 3, over: false });
    expect(punishCalls(host).length - before).toBe(3);
    expect(host.calls.filter((c) => c === 'llm.wake')).toHaveLength(1);
    expect(game(host)).toMatchObject({ attempt: 1, mistakes: 1 });
    expect(host.widgetHandles[0]!.closed).toBe(false);
    expect(host.widgetHtml()).toHaveLength(1); // no reshuffle for a plain mistake

    // one wrong pair too many: loss function again, then a fresh deck on attempt 2 with the same subscription
    await widgetMessage(host, 'game-memory', { event: 'mistake', mistakes: 2, moves: 5, over: true });
    expect(host.calls.filter((c) => c === 'llm.wake')).toHaveLength(2);
    expect(game(host)).toMatchObject({ game: 'memory', attempt: 2, mistakes: 2, maxMistakes: 1 });
    expect(host.widgetHtml()).toHaveLength(2);
    expect(host.widgetHandles[0]!.sent.at(-1)).toMatchObject({ type: 'widget-update', title: 'Memory — attempt 2' });
    expect(labels(host)).toEqual(['game:memory']);
    // the timer running out does the same
    await widgetMessage(host, 'game-memory', { event: 'lost', reason: 'timeout', mistakes: 0, moves: 1 });
    expect(game(host)).toMatchObject({ attempt: 3, mistakes: 3 });
    expect(host.calls.filter((c) => c === 'llm.wake')).toHaveLength(3);
    expect(host.widgetHandles).toHaveLength(1);

    // winning ends it: onWin gets the report, widget closed, subscriptions and state gone
    await widgetMessage(host, 'game-memory', { event: 'won', moves: 9, seconds: 21 });
    expect(recorded(host)).toEqual([{ game: 'memory', result: 'win', attempt: 3, mistakes: 3, moves: 9, seconds: 21 }]);
    expect(game(host)).toBeUndefined();
    expect(host.subs).toEqual([]);
    expect(host.widgetHandles[0]!.closed).toBe(true);
  });

  it('gameLost reports which game, what happened, the mistake count and the attempt to the loss function', async () => {
    const host = makeHost();
    await run(host, 'await lib.memoryGame({ onLose: "record", pairs: 3 });');
    await widgetMessage(host, 'game-memory', { event: 'mistake', mistakes: 1, moves: 1, over: false });
    await widgetMessage(host, 'game-memory', { event: 'lost', reason: 'timeout', mistakes: 1, moves: 4 });
    await widgetMessage(host, 'game-memory', { event: 'mistake', mistakes: 1, moves: 2, over: false });
    expect(recorded(host)).toEqual([
      { game: 'memory', event: 'mistake', roundMistakes: 1, moves: 1, attempt: 1, mistakes: 1 },
      { game: 'memory', event: 'lost', reason: 'timeout', roundMistakes: 1, moves: 4, attempt: 1, mistakes: 2 },
      { game: 'memory', event: 'mistake', roundMistakes: 1, moves: 2, attempt: 2, mistakes: 3 },
    ]);
    expect(game(host)).toMatchObject({ attempt: 2, mistakes: 3 });
    // quitGame puts it away without calling anything
    expect(await run(host, 'return await lib.quitGame();')).toMatchObject({ game: 'memory', attempt: 2 });
    expect(game(host)).toBeUndefined();
    expect(host.subs).toEqual([]);
    expect(recorded(host)).toHaveLength(3);
    expect(await run(host, 'return await lib.quitGame();')).toBeNull();
  });

  it('simonSays: flashes the sequence in a widget, spawns clickable images, a wrong click restarts with a new sequence, the right order wins', async () => {
    const host = makeHost();
    expect(await run(host, 'return await lib.simonSays({ onLose: "record", onWin: "record", length: 3, images: 4 });')).toEqual({ started: 'simon', attempt: 1, length: 3, images: 4, flashMs: 700 });
    const html = host.widgetHtml().at(-1)!;
    expect((html.match(CARD_URL) ?? []).length).toBe(3);
    expect(labels(host)).toEqual(['game:simon-click', 'game:simon-closed', 'game:simon-shown']);
    const first = game(host)!;
    expect((first['sequence'] as string[]).length).toBe(3);
    expect((first['pool'] as string[]).length).toBe(4);

    // the widget finished flashing: the widget goes, the pool appears as images that close on click
    await widgetMessage(host, 'game-simon', { event: 'shown' });
    expect(host.widgetHandles[0]!.closed).toBe(true);
    expect(host.openMedia()).toHaveLength(4);
    expect(host.media.every((m) => m.options['closeOnClick'] === true)).toBe(true);
    const shown = game(host)!['shown'] as Record<string, string>;
    expect(Object.keys(shown).sort()).toEqual(host.openMedia().map((m) => m.id).sort());
    const idOf = (asset: string) => Object.entries(shown).find(([, a]) => a === asset)![0];
    const sequence = first['sequence'] as string[];
    const wrong = (first['pool'] as string[]).find((p) => p !== sequence[0])!;

    // wrong first click: loss function, all media closed, a fresh sequence on attempt 2, no duplicate subscriptions
    await fire(host, 'media-clicked', { mediaId: idOf(wrong), asset: wrong, packId: pack.manifest.id, kind: 'image' });
    expect(recorded(host)).toEqual([{ game: 'simon', event: 'mistake', expected: sequence[0], clicked: wrong, progress: 0, attempt: 1, mistakes: 1 }]);
    expect(host.openMedia()).toEqual([]);
    expect(game(host)).toMatchObject({ game: 'simon', attempt: 2, mistakes: 1, shown: null, progress: 0 });
    expect(labels(host)).toEqual(['game:simon-click', 'game:simon-closed', 'game:simon-shown']);
    expect(host.widgetHandles).toHaveLength(2);
    // the close-by-click of that image arrives afterwards and is ignored (already consumed)
    await fire(host, 'media-closed', { mediaId: idOf(wrong), asset: wrong, packId: pack.manifest.id, kind: 'image', reason: 'click' });
    expect(recorded(host)).toHaveLength(1);

    // second attempt, clicked in order (through the media-closed fallback for one of them)
    await widgetMessage(host, 'game-simon', { event: 'shown' });
    const second = game(host)!;
    const seq2 = second['sequence'] as string[];
    const shown2 = second['shown'] as Record<string, string>;
    const id2 = (asset: string) => Object.entries(shown2).find(([, a]) => a === asset)![0];
    await fire(host, 'media-clicked', { mediaId: id2(seq2[0]!), asset: seq2[0], packId: pack.manifest.id, kind: 'image' });
    expect(game(host)).toMatchObject({ progress: 1 });
    await fire(host, 'media-closed', { mediaId: id2(seq2[1]!), asset: seq2[1], packId: pack.manifest.id, kind: 'image', reason: 'click' });
    expect(game(host)).toMatchObject({ progress: 2 });
    await fire(host, 'media-clicked', { mediaId: id2(seq2[1]!), asset: seq2[1], packId: pack.manifest.id, kind: 'image' }); // duplicate report: ignored
    expect(game(host)).toMatchObject({ progress: 2 });
    await fire(host, 'media-clicked', { mediaId: id2(seq2[2]!), asset: seq2[2], packId: pack.manifest.id, kind: 'image' });
    expect(recorded(host).at(-1)).toEqual({ game: 'simon', result: 'win', attempt: 2, mistakes: 1, length: 3 });
    expect(game(host)).toBeUndefined();
    expect(host.subs).toEqual([]);
    expect(host.openMedia()).toEqual([]);
  });

  it('whackAMole: pops timed images that close on click; a timeout calls the loss function and pops the next, too many restart, enough hits win', async () => {
    const host = makeHost();
    const started = (await run(host, 'return await lib.whackAMole({ onLose: "record", onWin: "record", rounds: 2, showMs: 900, maxMisses: 1 });')) as Record<string, Json>;
    expect(started).toMatchObject({ started: 'mole', attempt: 1, rounds: 2, showMs: 900, maxMisses: 1, first: { round: 1 } });
    expect(host.openMedia()).toHaveLength(1);
    expect(host.media[0]!.options).toMatchObject({ durationMs: 900, closeOnClick: true });
    expect(labels(host)).toEqual(['game:mole-hit', 'game:mole-miss']);
    const current = () => game(host)!['current'] as string;
    const asset = () => host.media.find((m) => m.id === current())!.asset;

    // missed: loss function, next mole
    let id = current();
    await fire(host, 'media-closed', { mediaId: id, asset: asset(), packId: pack.manifest.id, kind: 'image', reason: 'timeout' });
    expect(recorded(host)).toEqual([{ game: 'mole', event: 'miss', round: 1, hits: 0, misses: 1, attempt: 1, mistakes: 1 }]);
    expect(host.media).toHaveLength(2);
    expect(current()).not.toBe(id);
    // an api close (or a stale one) is not a miss
    await fire(host, 'media-closed', { mediaId: id, asset: asset(), packId: pack.manifest.id, kind: 'image', reason: 'api' });
    expect(recorded(host)).toHaveLength(1);
    // hit: next mole, no loss call
    id = current();
    await fire(host, 'media-clicked', { mediaId: id, asset: asset(), packId: pack.manifest.id, kind: 'image' });
    expect(game(host)).toMatchObject({ hits: 1, misses: 1, round: 3 });
    expect(recorded(host)).toHaveLength(1);
    // second miss exceeds maxMisses: loss function with event "lost", round one again on attempt 2
    await fire(host, 'media-closed', { mediaId: current(), asset: asset(), packId: pack.manifest.id, kind: 'image', reason: 'timeout' });
    expect(recorded(host).at(-1)).toEqual({ game: 'mole', event: 'lost', round: 3, hits: 1, misses: 2, attempt: 1, mistakes: 2 });
    expect(game(host)).toMatchObject({ attempt: 2, mistakes: 2, hits: 0, misses: 0, round: 1 });
    expect(host.openMedia()).toHaveLength(1);
    expect(labels(host)).toEqual(['game:mole-hit', 'game:mole-miss']);
    // two hits win
    await fire(host, 'media-clicked', { mediaId: current(), asset: asset(), packId: pack.manifest.id, kind: 'image' });
    await fire(host, 'media-clicked', { mediaId: current(), asset: asset(), packId: pack.manifest.id, kind: 'image' });
    expect(recorded(host).at(-1)).toEqual({ game: 'mole', result: 'win', attempt: 2, mistakes: 2, hits: 2, misses: 0 });
    expect(game(host)).toBeUndefined();
    expect(host.openMedia()).toEqual([]);
  });

  it('writeLines: every wrong keystroke calls the loss function while the game keeps running; the last clean line wins', async () => {
    const host = makeHost();
    expect(await run(host, 'return await lib.writeLines({ onLose: "record", onWin: "record", line: "I will not <b>ignore</b> her", count: 3 });')).toMatchObject({ started: 'lines', count: 3 });
    const html = host.widgetHtml().at(-1)!;
    expect(html).toContain('I will not &lt;b&gt;ignore&lt;/b&gt; her'); // escaped for the page …
    expect(html).toContain('const LINE="I will not <b>ignore</b> her"'); // … and the raw text for the checker
    await widgetMessage(host, 'game-lines', { event: 'mistake', typed: 'I wilk', at: 5, line: 1, mistakes: 1 });
    await widgetMessage(host, 'game-lines', { event: 'mistake', typed: 'I wll', at: 3, line: 2, mistakes: 2 });
    expect(recorded(host)).toEqual([
      { game: 'lines', event: 'mistake', typed: 'I wilk', at: 5, line: 1, roundMistakes: 1, attempt: 1, mistakes: 1 },
      { game: 'lines', event: 'mistake', typed: 'I wll', at: 3, line: 2, roundMistakes: 2, attempt: 1, mistakes: 2 },
    ]);
    expect(game(host)).toMatchObject({ game: 'lines', attempt: 1, mistakes: 2 });
    expect(host.widgetHtml()).toHaveLength(1);
    await widgetMessage(host, 'game-lines', { event: 'won', mistakes: 2 });
    expect(recorded(host).at(-1)).toEqual({ game: 'lines', result: 'win', attempt: 1, mistakes: 2, lines: 3 });
    expect(game(host)).toBeUndefined();
  });

  it('reactionTest and slidingPuzzle: mistakes call the loss function (the puzzle reshuffles), wins end the game', async () => {
    const host = makeHost();
    expect(await run(host, 'return await lib.reactionTest({ onLose: "record", onWin: "record", rounds: 2, thresholdMs: 400 });')).toEqual({ started: 'reaction', attempt: 1, rounds: 2, thresholdMs: 400 });
    await widgetMessage(host, 'game-reaction', { event: 'mistake', reason: 'early', ms: 0, round: 1, mistakes: 1 });
    await widgetMessage(host, 'game-reaction', { event: 'mistake', reason: 'slow', ms: 612, round: 1, mistakes: 2 });
    expect(recorded(host)).toEqual([
      { game: 'reaction', event: 'mistake', reason: 'early', ms: 0, round: 1, roundMistakes: 1, attempt: 1, mistakes: 1 },
      { game: 'reaction', event: 'mistake', reason: 'slow', ms: 612, round: 1, roundMistakes: 2, attempt: 1, mistakes: 2 },
    ]);
    await widgetMessage(host, 'game-reaction', { event: 'won', times: [210, 190], mistakes: 2 });
    expect(recorded(host).at(-1)).toEqual({ game: 'reaction', result: 'win', attempt: 1, mistakes: 2, times: [210, 190] });
    expect(game(host)).toBeUndefined();

    // the puzzle: one image sliced by CSS, placeholder resolved; a different game while another was running would have been put away
    const puzzle = (await run(host, 'return await lib.slidingPuzzle({ onLose: "record", onWin: "record", size: 4, moveLimit: 20 });')) as Record<string, Json>;
    expect(puzzle).toMatchObject({ started: 'puzzle', attempt: 1, size: 4, moveLimit: 20, image: expect.stringMatching(/^media\/images\/wallpapers\/[a-z-]+\.png$/) });
    const html = host.widgetHtml().at(-1)!;
    expect(html).toContain(`background-image:url(rp-asset://com.example.makima/${String(puzzle['image'])})`);
    expect(html).not.toContain('{{asset:');
    expect(labels(host)).toEqual(['game:puzzle']);
    await widgetMessage(host, 'game-puzzle', { event: 'lost', reason: 'moves', moves: 21 });
    expect(recorded(host).at(-1)).toEqual({ game: 'puzzle', event: 'lost', reason: 'moves', moves: 21, attempt: 1, mistakes: 1 });
    expect(game(host)).toMatchObject({ game: 'puzzle', attempt: 2, mistakes: 1 });
    expect(host.widgetHtml().filter((h) => h.includes('background-image:url(rp-asset://com.example.makima/media/images/wallpapers/'))).toHaveLength(2);
    await widgetMessage(host, 'game-puzzle', { event: 'won', moves: 14 });
    expect(recorded(host).at(-1)).toEqual({ game: 'puzzle', result: 'win', attempt: 2, mistakes: 1, moves: 14 });
    expect(game(host)).toBeUndefined();
    expect(host.subs).toEqual([]);
  });

  it('a starter refuses a placeholder-free run of a game that lacks images, and a missing puzzle image fails before anything is shown', async () => {
    const host = makeHost();
    await expect(run(host, 'return await lib.slidingPuzzle({ onLose: "record", image: "media/images/nope.png" });')).rejects.toThrow(/does not exist/);
    expect(host.widgetSpecs).toHaveLength(0);
    expect(game(host)).toBeUndefined();
  });

  it('starting a game while another runs puts the old one away without callbacks; every starter documents the loss function it calls', async () => {
    const host = makeHost();
    await run(host, 'await lib.memoryGame({ onLose: "record" });');
    await run(host, 'await lib.reactionTest({ onLose: "record" });');
    expect(host.widgetHandles[0]!.closed).toBe(true);
    expect(labels(host)).toEqual(['game:reaction']);
    expect(game(host)).toMatchObject({ game: 'reaction', attempt: 1 });
    expect(recorded(host)).toEqual([]);
    for (const name of ['memoryGame', 'simonSays', 'writeLines', 'whackAMole', 'reactionTest', 'slidingPuzzle']) {
      expect(pack.characters[0]!.library[name]!.description, name).toMatch(/lib\[onLose\]\(\{ game: "[a-z]+", event: "[a-z]+"/);
    }
  });
});
