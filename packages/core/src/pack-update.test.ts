/**
 * What a pack update does to the conversation that is already open with its character
 * (`services/pack-update.ts`): the session follows the updated character, renamed id included.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ScheduledTimer, Session } from '@rp/shared';
import { FileStorage } from './storage/file.js';
import { LUNA_ID, LUNA_REF, createTestEngine, installLunaWith, makeTempDir } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

const RENAMED_REF = `${LUNA_ID}/selene`;

/** Luna again, with the patches an author would make and a new version, installed over the old one. */
async function updateLuna(t: TestEngine, patch: { version?: string; packName?: string; characterName?: string; characterId?: string }): Promise<void> {
  await installLunaWith(t.engine, t.packsDir, {
    patchManifest: (m) => {
      m.version = patch.version ?? '2.0.0';
      if (patch.packName !== undefined) m.name = patch.packName;
    },
    patchCharacter: (d) => {
      if (patch.characterName !== undefined) d.name = patch.characterName;
      if (patch.characterId !== undefined) d.id = patch.characterId;
    },
  });
}

describe('a pack installed over the version a session is talking to', () => {
  let t: TestEngine | undefined;

  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });

  it('re-renders the title the app generated, and leaves the one the user wrote', async () => {
    t = await createTestEngine();
    await installLunaWith(t.engine, t.packsDir);
    const generated = await t.engine.sessions.create({ characterRef: LUNA_REF });
    expect(generated.title).toBe('Luna (Luna)');

    await updateLuna(t, { packName: 'Luna Deluxe', characterName: 'Selene' });
    expect((await t.engine.sessions.require(generated.id)).title).toBe('Selene (Luna Deluxe)');

    await t.engine.sessions.update({ ...(await t.engine.sessions.require(generated.id)), title: 'the long night' } as Session);
    await updateLuna(t, { version: '3.0.0', packName: 'Luna Deluxe', characterName: 'Selene II' });
    expect((await t.engine.sessions.require(generated.id)).title).toBe('the long night');
  });

  it('keeps talking to the character whose id the update renamed, and carries its data over', async () => {
    t = await createTestEngine();
    await installLunaWith(t.engine, t.packsDir);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    await t.engine.chat.send(session.id, 'hi');

    const memory = await t.engine.memories.add(LUNA_REF, 'drinks jasmine tea at night');
    await t.storage.state.set(`char:${LUNA_REF}`, 'diary', ['a good day']);
    const timer: ScheduledTimer = {
      id: 'timer-1',
      sessionId: session.id,
      characterRef: LUNA_REF,
      kind: 'wake',
      fireAt: new Date(Date.now() + 3_600_000).toISOString(),
      payload: 'check in',
      createdAt: new Date().toISOString(),
    };
    await t.engine.timers.schedule(timer);
    await t.storage.subscriptions.upsert({
      id: 'sub-1',
      sessionId: session.id,
      characterRef: LUNA_REF,
      event: 'idle',
      code: 'await sdk.chat.say("still here?")',
      createdAt: new Date().toISOString(),
      fired: 0,
    });

    await updateLuna(t, { characterId: 'selene' });

    expect((await t.engine.sessions.require(session.id)).characterRef).toBe(RENAMED_REF);
    expect((await t.engine.memories.list(RENAMED_REF)).map((m) => m.id)).toEqual([memory.id]);
    expect(await t.engine.memories.list(LUNA_REF)).toEqual([]);
    expect(await t.storage.state.get(`char:${RENAMED_REF}`, 'diary')).toEqual(['a good day']);
    expect(await t.storage.state.all(`char:${LUNA_REF}`)).toEqual({});
    expect((await t.engine.timers.list({ characterRef: RENAMED_REF })).map((x) => x.id)).toEqual(['timer-1']);
    expect((await t.storage.subscriptions.list(session.id)).map((s) => s.characterRef)).toEqual([RENAMED_REF]);

    // The point of all of it: the conversation goes on instead of failing with NOT_FOUND.
    await t.engine.chat.send(session.id, 'are you still you?');
    expect(t.provider.requests.at(-1)?.system).toContain('You are Luna');
    expect((await t.engine.sessions.messages(session.id)).map((m) => m.role)).toContain('assistant');
  });

  it('leaves a session alone when the pack is uninstalled, or when the update changes nothing about it', async () => {
    t = await createTestEngine();
    await installLunaWith(t.engine, t.packsDir);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });

    await updateLuna(t, { version: '1.5.0' });
    const same = await t.engine.sessions.require(session.id);
    expect(same.characterRef).toBe(LUNA_REF);
    expect(same.updatedAt).toBe(session.updatedAt);

    await t.engine.packs.uninstall(LUNA_ID);
    expect(await t.engine.sessions.require(session.id)).toEqual(same);
  });

  // `FileStorage` keeps one memories file and one embeddings file per character ref, so a rename
  // has to write the new files and take the old ones away — `MemoryStorage` cannot show that.
  it('moves the memories of a renamed character between their files on disk', async () => {
    t = await createTestEngine({ storage: new FileStorage(await makeTempDir('rp-core-data-')) });
    await installLunaWith(t.engine, t.packsDir);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const memory = await t.engine.memories.add(LUNA_REF, 'keeps the curtains open');

    await updateLuna(t, { characterId: 'selene' });

    expect((await t.engine.sessions.require(session.id)).characterRef).toBe(RENAMED_REF);
    expect((await t.engine.memories.list(RENAMED_REF)).map((m) => m.text)).toEqual(['keeps the curtains open']);
    expect(await t.engine.memories.list(LUNA_REF)).toEqual([]);
    expect(await t.storage.memories.get(memory.id)).toMatchObject({ characterRef: RENAMED_REF });
  });

  it('a pack installed over the sessions an uninstall left behind picks them up again', async () => {
    t = await createTestEngine();
    await installLunaWith(t.engine, t.packsDir);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    await t.engine.packs.uninstall(LUNA_ID);

    await updateLuna(t, { characterId: 'selene', characterName: 'Selene' });
    const back = await t.engine.sessions.require(session.id);
    expect(back.characterRef).toBe(RENAMED_REF);
    // Nothing is known about the version that was there, so the title it generated stays as it is.
    expect(back.title).toBe('Luna (Luna)');
    await t.engine.chat.send(session.id, 'welcome back');
    expect((await t.engine.sessions.messages(session.id)).length).toBeGreaterThan(1);
  });
});
