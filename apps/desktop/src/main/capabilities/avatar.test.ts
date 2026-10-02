import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, LoadedPack, MediaCommand, MonitorInfo } from '@rp/shared';
import type { DisplayBackend, OverlayEvent, OverlayEventListener, OverlayHandle, OverlaySpec } from '../display/backend.js';
import { AVATAR_STATE_FILENAME, AvatarFileStore } from './avatar-store.js';
import { AvatarHandler, parseAvatarRecords, recordShowOptions } from './avatar.js';
import type { AvatarRecord, AvatarStore } from './avatar.js';

const MONITORS: MonitorInfo[] = [
  { id: 'm0', name: 'Main', index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1, hasCursor: true },
  { id: 'm1', name: 'Side', index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 720, scale: 1, hasCursor: false },
];

class FakeHandle implements OverlayHandle {
  readonly sent: MediaCommand[] = [];
  readonly listeners = new Map<OverlayEvent, Set<OverlayEventListener>>();
  closed = false;
  constructor(readonly id: string) {}
  async update(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  async send(command: MediaCommand): Promise<void> {
    this.sent.push(command);
  }
  on(event: OverlayEvent, listener: OverlayEventListener): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }
  fire(event: OverlayEvent): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l();
  }
}

function fakeBackend(): DisplayBackend & { specs: OverlaySpec[]; handles: FakeHandle[]; fail?: string } {
  const specs: OverlaySpec[] = [];
  const handles: FakeHandle[] = [];
  const backend: DisplayBackend & { specs: OverlaySpec[]; handles: FakeHandle[]; fail?: string } = {
    name: 'fake',
    specs,
    handles,
    info: () => ({ name: 'fake', platform: 'linux', windowSystem: 'x11', supports: { layers: ['top'], opacity: true, clickThrough: true, monitorSelection: true, exactPosition: true } }),
    monitors: async () => MONITORS,
    createOverlay: async (spec) => {
      if (backend.fail) throw new Error(backend.fail);
      specs.push(spec);
      const h = new FakeHandle(spec.id);
      handles.push(h);
      return h;
    },
    closeAll: async () => undefined,
    dispose: async () => undefined,
  };
  return backend;
}

const PACK = {
  root: '/nonexistent/packs/com.x.luna',
  manifest: { id: 'com.x.luna', mediaRoot: 'media' },
  characters: [
    {
      dir: 'characters/luna',
      definition: { id: 'luna', name: 'Luna', persona: 'persona.md', avatar: 'avatar.png', avatarSet: { expressions: { neutral: 'faces/neutral.png', happy: 'faces/happy.png' }, size: 300 } },
      personaText: '',
      behaviourSources: {},
      avatarPath: 'characters/luna/avatar.png',
    },
  ],
} as unknown as LoadedPack;

const REF = 'com.x.luna/luna';
const ctx: ActionContext = { packId: 'com.x.luna', characterId: 'luna', sessionId: 's', packRoot: PACK.root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };

/** An `AvatarStore` in memory that counts its writes (they are fire-and-forget, so tests await it). */
function memoryStore(initial: AvatarRecord[] = []): AvatarStore & { records: AvatarRecord[]; settled(): Promise<void> } {
  let records = initial;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    get records() {
      return records;
    },
    load: async () => records,
    save: (next) => {
      const done = Promise.resolve().then(() => {
        records = next;
      });
      queue = queue.then(() => done);
      return done;
    },
    settled: async () => {
      await queue;
      await queue;
    },
  };
}

function make(store?: AvatarStore, pack: LoadedPack = PACK) {
  const backend = fakeBackend();
  const warnings: string[] = [];
  const handler = new AvatarHandler({
    backend: () => backend,
    packs: {
      getLoaded: (packId) => {
        if (packId !== (pack.manifest as { id: string }).id) throw new Error(`Pack "${packId}" is not installed`);
        return pack;
      },
    },
    emit: () => undefined,
    logger: { warn: (m: string) => warnings.push(m), debug: () => undefined },
    ...(store ? { store } : {}),
  });
  return { backend, handler, warnings };
}

describe('parseAvatarRecords', () => {
  it('reads a stored file and skips anything that names no character', () => {
    const raw = {
      avatars: [
        { packId: 'com.x.luna', characterId: 'luna', expression: 'happy', size: 320, lookAtCursor: true, overlay: { layer: 'overlay', opacity: 0.8, clickThrough: true, monitorId: 'm1', x: 40, y: 50, position: 'top-left' } },
        { packId: 'com.x.luna' },
        { characterId: 'luna' },
        { packId: '', characterId: 'luna' },
        null,
        'nope',
      ],
    };
    expect(parseAvatarRecords(raw)).toEqual([
      {
        packId: 'com.x.luna',
        characterId: 'luna',
        expression: 'happy',
        size: 320,
        lookAtCursor: true,
        overlay: { layer: 'overlay', opacity: 0.8, clickThrough: true, monitorId: 'm1', x: 40, y: 50, position: 'top-left' },
      },
    ]);
  });

  it('accepts a bare array, fills in what is missing and ignores anything else', () => {
    expect(parseAvatarRecords([{ packId: 'p', characterId: 'c' }])).toEqual([
      { packId: 'p', characterId: 'c', expression: '', size: 240, lookAtCursor: false, overlay: { layer: 'top', opacity: 1, clickThrough: false } },
    ]);
    expect(parseAvatarRecords({ avatars: 'no' })).toEqual([]);
    expect(parseAvatarRecords(null)).toEqual([]);
  });
});

describe('recordShowOptions', () => {
  it('asks for the monitor the avatar was on, and passes an exact 1 px offset past the fraction range', () => {
    const record: AvatarRecord = { packId: 'p', characterId: 'c', expression: 'happy', size: 300, lookAtCursor: true, overlay: { layer: 'top', opacity: 0.5, clickThrough: true, monitorId: 'm1', x: 1, y: 0, position: 'top-left' } };
    expect(recordShowOptions(record)).toEqual({ expression: 'happy', size: 300, lookAtCursor: true, layer: 'top', opacity: 0.5, clickThrough: true, monitor: 'm1', position: 'top-left', x: 1.001, y: 0 });
  });

  it('falls back to the primary monitor when none was remembered', () => {
    expect(recordShowOptions({ packId: 'p', characterId: 'c', expression: '', size: 240, lookAtCursor: false, overlay: { layer: 'top', opacity: 1, clickThrough: false } })).toMatchObject({ monitor: 'primary' });
  });
});

describe('AvatarHandler: remembering what is on screen', () => {
  it('writes a record when the avatar is shown and changed, and drops it on hide', async () => {
    const store = memoryStore();
    const { handler } = make(store);
    await handler.show(REF, ctx, { expression: 'happy', monitor: 1, position: 'top-left', size: 320 });
    await store.settled();
    expect(store.records).toEqual([
      {
        packId: 'com.x.luna',
        characterId: 'luna',
        expression: 'happy',
        size: 320,
        lookAtCursor: false,
        overlay: { layer: 'top', opacity: 1, clickThrough: false, monitorId: 'm1', position: 'top-left' },
      },
    ]);

    await handler.set(REF, { expression: 'neutral', size: 200, lookAtCursor: true, opacity: 0.4 });
    await store.settled();
    expect(store.records[0]).toMatchObject({ expression: 'neutral', size: 200, lookAtCursor: true, overlay: { opacity: 0.4 } });

    await handler.moveTo(REF, { monitor: 0, x: 120, y: 60 }, {});
    await store.settled();
    expect(store.records[0]?.overlay).toMatchObject({ monitorId: 'm0', x: 120, y: 60 });

    await handler.hide(REF);
    await store.settled();
    expect(store.records).toEqual([]);
  });

  it('leaves the record in place when the app closes down, and restore() puts the avatar back where it was', async () => {
    const store = memoryStore();
    const first = make(store);
    await first.handler.show(REF, ctx, { expression: 'happy', monitor: 1, position: 'top-left', size: 320, clickThrough: true });
    await store.settled();
    await first.handler.dispose();
    await store.settled();
    expect(first.backend.handles[0]?.closed).toBe(true);
    expect(store.records).toHaveLength(1);

    const next = make(store);
    const shown = await next.handler.restore();
    expect(shown).toEqual([
      {
        visible: true,
        expression: 'happy',
        size: 320,
        lookAtCursor: false,
        overlay: { layer: 'top', opacity: 1, clickThrough: true, monitorId: 'm1', position: 'top-left' },
      },
    ]);
    expect(next.backend.specs[0]?.avatar?.imageUrl).toContain('faces/happy.png');
    expect(await next.handler.invoke('state', [], ctx)).toMatchObject({ visible: true, expression: 'happy' });
    await store.settled();
    expect(store.records).toHaveLength(1);
  });

  it('forgets a record whose pack is no longer installed', async () => {
    const store = memoryStore([{ packId: 'com.x.gone', characterId: 'ghost', expression: '', size: 240, lookAtCursor: false, overlay: { layer: 'top', opacity: 1, clickThrough: false } }]);
    const { handler, backend, warnings } = make(store);
    expect(await handler.restore()).toEqual([]);
    expect(backend.specs).toEqual([]);
    expect(warnings.join('\n')).toContain('com.x.gone/ghost cannot be shown again');
    await store.settled();
    expect(store.records).toEqual([]);
  });

  it('forgets a record the backend will not show', async () => {
    const store = memoryStore([{ packId: 'com.x.luna', characterId: 'luna', expression: 'happy', size: 240, lookAtCursor: false, overlay: { layer: 'top', opacity: 1, clickThrough: false } }]);
    const { handler, backend } = make(store);
    backend.fail = 'no display';
    expect(await handler.restore()).toEqual([]);
    await store.settled();
    expect(store.records).toEqual([]);
  });

  it('does nothing without a store, and leaves a live avatar alone on a second restore', async () => {
    const plain = make();
    await plain.handler.show(REF, ctx, {});
    expect(await plain.handler.restore()).toEqual([]);

    const store = memoryStore();
    const { handler, backend } = make(store);
    await handler.show(REF, ctx, {});
    await store.settled();
    expect(await handler.restore()).toEqual([]);
    expect(backend.specs).toHaveLength(1);
  });

  it('forgets an avatar whose overlay window went away on its own', async () => {
    const store = memoryStore();
    const { handler, backend } = make(store);
    await handler.show(REF, ctx, {});
    await store.settled();
    backend.handles[0]?.fire('closed');
    await store.settled();
    expect(store.records).toEqual([]);
  });
});

describe('AvatarFileStore', () => {
  const dirs: string[] = [];
  const tmpFile = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-avatars-'));
    dirs.push(dir);
    return path.join(dir, 'data', AVATAR_STATE_FILENAME);
  };

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips the records through a file it creates, and answers nothing for a missing or damaged one', async () => {
    const file = await tmpFile();
    const store = new AvatarFileStore(file);
    expect(await store.load()).toEqual([]);

    const records: AvatarRecord[] = [{ packId: 'com.x.luna', characterId: 'luna', expression: 'happy', size: 300, lookAtCursor: true, overlay: { layer: 'top', opacity: 1, clickThrough: false, monitorId: 'm0', x: 10, y: 20, position: 'bottom-right' } }];
    await store.save(records);
    expect(await store.load()).toEqual(records);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ avatars: records });

    await fs.writeFile(file, '{ not json', 'utf8');
    expect(await store.load()).toEqual([]);
  });

  it('serialises concurrent writes, leaving the last one on disk and no temporary files behind', async () => {
    const file = await tmpFile();
    const store = new AvatarFileStore(file);
    const record = (expression: string): AvatarRecord => ({ packId: 'p', characterId: 'c', expression, size: 240, lookAtCursor: false, overlay: { layer: 'top', opacity: 1, clickThrough: false } });
    await Promise.all([store.save([record('a')]), store.save([record('b')]), store.save([record('c')])]);
    expect(await store.load()).toEqual([record('c')]);
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
