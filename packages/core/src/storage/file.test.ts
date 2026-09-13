import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry, ChatMessage, MemoryEntry, Session } from '@rp/shared';
import { makeTempDir } from '../test/helpers.js';
import { FileStorage, LEGACY_GRANTS_FILE } from './file.js';

let dir: string;

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs)));
    else out.push(path.relative(dir, abs));
  }
  return out.sort();
}

function audit(i: number, sessionId = 's1'): AuditEntry {
  return { id: `a${i}`, at: new Date(i).toISOString(), sessionId, characterRef: 'p/c', module: 'state', method: 'get', args: [i], outcome: 'allowed' };
}

describe('FileStorage', () => {
  it('round-trips every aggregate and re-reads it from disk', async () => {
    dir = await makeTempDir();
    const a = new FileStorage(dir);

    const settings = await a.settings.get();
    expect(settings.maxActionRounds).toBe(4);
    expect(settings.runLimits.timeoutMs).toBe(10_000);
    await a.settings.set({ ...settings, userDisplayName: 'Ada' });

    await a.packs.upsert({ packId: 'p', version: '1.0.0', name: 'P', root: '/r', installedAt: 't', characterIds: ['c'] });
    const session: Session = { id: 's1', characterRef: 'p/c', title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0 };
    await a.sessions.upsert(session);
    const m1: ChatMessage = { id: 'm1', sessionId: 's1', role: 'user', content: 'hi', createdAt: 't' };
    const m2: ChatMessage = { id: 'm2', sessionId: 's1', role: 'assistant', content: '', createdAt: 't' };
    await a.messages.append(m1);
    await a.messages.append(m2);
    await a.messages.update({ ...m2, content: 'hello' });
    await a.state.set('char:p/c', 'k', { nested: [1, 2] });
    await a.state.set('session:s1', 'k', 1);
    await a.timers.upsert({ id: 't1', sessionId: 's1', characterRef: 'p/c', kind: 'wake', fireAt: 'f', payload: null, createdAt: 't' });
    await a.audit.append(audit(1));
    await a.audit.append(audit(2, 's2'));
    const mem = (id: string, characterRef: string): MemoryEntry => ({ id, characterRef, text: `t-${id}`, tags: [], importance: 3, source: 'user', createdAt: 't', updatedAt: 't', recallCount: 0 });
    await a.memories.upsert(mem('me1', 'p/c'));
    await a.memories.upsert(mem('me2', 'p/c'));
    await a.memories.upsert(mem('me3', 'q/d'));
    await a.memories.upsert({ ...mem('me2', 'p/c'), text: 'edited' });
    await a.close();

    const b = new FileStorage(dir);
    expect((await b.settings.get()).userDisplayName).toBe('Ada');
    expect((await b.packs.get('p'))?.name).toBe('P');
    expect((await b.sessions.get('s1'))?.title).toBe('T');
    expect((await b.messages.list('s1')).map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(await b.state.get('char:p/c', 'k')).toEqual({ nested: [1, 2] });
    expect(await b.state.all('session:s1')).toEqual({ k: 1 });
    expect(await b.timers.list()).toHaveLength(1);
    expect((await b.audit.list()).map((e) => e.id)).toEqual(['a1', 'a2']);
    expect((await b.audit.list({ sessionId: 's2' })).map((e) => e.id)).toEqual(['a2']);
    expect((await b.audit.list({ limit: 1 })).map((e) => e.id)).toEqual(['a2']);
    expect((await b.memories.list('p/c')).map((m) => [m.id, m.text])).toEqual([['me1', 't-me1'], ['me2', 'edited']]);
    expect((await b.memories.get('me3'))?.characterRef).toBe('q/d');
    expect(await b.memories.get('nope')).toBeUndefined();
    await b.memories.remove('me1');
    expect((await b.memories.list('p/c')).map((m) => m.id)).toEqual(['me2']);
    await b.memories.removeForCharacter('q/d');
    expect(await b.memories.list('q/d')).toEqual([]);

    await b.messages.remove('s1', m1.id);
    expect((await b.messages.list('s1')).map((m) => m.content)).toEqual(['hello']);
    await b.messages.remove('s1', 'missing'); // no-op
    await b.messages.removeForSession('s1');
    await b.state.clear('session:s1');
    await b.sessions.remove('s1');
    await b.packs.remove('p');
    await b.timers.remove('t1');
    await b.close();
    const c = new FileStorage(dir);
    expect(await c.messages.list('s1')).toEqual([]);
    expect(await c.state.keys('session:s1')).toEqual([]);
    expect(await c.sessions.list()).toEqual([]);
    expect(await c.packs.list()).toEqual([]);
    expect(await c.timers.list()).toEqual([]);
    expect((await c.memories.list('p/c')).map((m) => m.id)).toEqual(['me2']);
    expect(await c.memories.get('me3')).toBeUndefined();
  });

  it('writes atomically and leaves no temp files, even with concurrent writes', async () => {
    dir = await makeTempDir();
    const s = new FileStorage(dir);
    await Promise.all(Array.from({ length: 25 }, (_, i) => s.sessions.upsert({ id: `s${i}`, characterRef: 'p/c', title: `${i}`, createdAt: 't', updatedAt: 't', messageCount: 0 })));
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.state.set('scope', `k${i}`, i)));
    await s.close();
    const files = await listFiles(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('sessions.json');
    expect(files).toContain(path.join('state', 'scope.json'));
    const fresh = new FileStorage(dir);
    expect((await fresh.sessions.list()).length).toBe(25);
    expect((await fresh.state.keys('scope')).length).toBe(10);
  });

  it('caps the audit log', async () => {
    dir = await makeTempDir();
    const s = new FileStorage(dir, { auditCap: 10 });
    for (let i = 1; i <= 25; i++) await s.audit.append(audit(i));
    const entries = await s.audit.list();
    expect(entries.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `a${i + 16}`));
    await s.close();
    const text = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(10);
    const reopened = new FileStorage(dir, { auditCap: 10 });
    expect((await reopened.audit.list()).map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it('survives a corrupt audit line and reports corrupt JSON aggregates', async () => {
    dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'audit.jsonl'), `${JSON.stringify(audit(1))}\n{broken\n${JSON.stringify(audit(2))}\n`);
    await fs.writeFile(path.join(dir, 'packs.json'), '{not json');
    const s = new FileStorage(dir);
    expect((await s.audit.list()).map((e) => e.id)).toEqual(['a1', 'a2']);
    await expect(s.packs.list()).rejects.toMatchObject({ code: 'STORAGE' });
  });

  it('ignores and removes a grants file left by a version with per-pack grants', async () => {
    dir = await makeTempDir();
    await fs.writeFile(path.join(dir, LEGACY_GRANTS_FILE), JSON.stringify([{ packId: 'p', module: 'media', granted: true, grantedAt: 't' }]));
    const a = new FileStorage(dir);
    expect(await a.packs.list()).toEqual([]);
    expect(a).not.toHaveProperty('grants');
    await a.settings.set(await a.settings.get());
    await a.close();
    expect(await listFiles(dir)).not.toContain(LEGACY_GRANTS_FILE);
  });
});
