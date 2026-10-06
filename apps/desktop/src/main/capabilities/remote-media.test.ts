import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionContext, RemoteMediaLocation } from '@rp/shared';
import { RemoteMediaCache, extensionForMime, remoteCacheKey } from './remote-media.js';

const ctx: ActionContext = { packId: 'com.x.p', characterId: 'c', sessionId: 's', packRoot: '/', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined };

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-remote-media-'));
  dir = path.join(tmp, 'cache');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Served {
  body?: string;
  type?: string | null;
  status?: number;
  length?: number;
}

/** A cache whose source always points at `location`, over a fetch that answers with `served`. */
function make(location: RemoteMediaLocation, served: Served = {}, opts: { ref?: { kind: string; mime: string }; maxItemBytes?: number; cacheBytes?: number } = {}) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let gated = false;
  const cache = new RemoteMediaCache({
    dir,
    locate: async () => ({ location, ...(opts.ref ? { ref: opts.ref } : {}) }),
    logger,
    ...(opts.maxItemBytes !== undefined ? { maxItemBytes: opts.maxItemBytes } : {}),
    ...(opts.cacheBytes !== undefined ? { cacheBytes: opts.cacheBytes } : {}),
    fetch: (async (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url, headers: init.headers });
      if (gated) await gate;
      const headers: Record<string, string> = {};
      if (served.type !== null) headers['content-type'] = served.type ?? 'image/png';
      if (served.length !== undefined) headers['content-length'] = String(served.length);
      return new Response(served.body ?? 'png-bytes', { status: served.status ?? 200, headers });
    }) as unknown as typeof fetch,
  });
  return {
    cache,
    requests,
    hold: () => {
      gated = true;
    },
    release: () => release(),
  };
}

describe('extensionForMime', () => {
  it('names the usual extension of the media types the app knows, and nothing else', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/jpg')).toBe('jpg');
    expect(extensionForMime('IMAGE/PNG; charset=binary')).toBe('png');
    expect(extensionForMime('video/webm')).toBe('webm');
    expect(extensionForMime('audio/mpeg')).toBe('mp3');
    expect(extensionForMime('audio/x-wav')).toBe('wav');
    expect(extensionForMime('text/plain')).toBeUndefined();
    expect(extensionForMime('text/html')).toBeUndefined();
    expect(extensionForMime(null)).toBeUndefined();
  });
});

describe('RemoteMediaCache', () => {
  it('downloads with the source\'s headers, names the file by its type, and shares one download between callers', async () => {
    const { cache, requests, hold, release } = make({ url: 'https://api.example/items/42', headers: { authorization: 'Bearer k' } }, { type: 'image/webp' });
    hold();
    const both = Promise.all([cache.file('com.t.p/a/42', ctx), cache.file('com.t.p/a/42', ctx)]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(requests).toEqual([{ url: 'https://api.example/items/42', headers: { authorization: 'Bearer k' } }]);
    expect(path.basename(a.file)).toBe(`${remoteCacheKey('com.t.p/a/42')}.webp`);
    expect(a.url).toBe(`rp-asset://app.rpchat.remote/${path.basename(a.file)}`);
    expect(fs.readFileSync(a.file, 'utf8')).toBe('png-bytes');
    // Served from the cache from then on.
    await cache.file('com.t.p/a/42', ctx);
    expect(requests).toHaveLength(1);
  });

  it('prefers the type the search reported, then Content-Type, then the URL', async () => {
    const fromSearch = make({ url: 'https://x.example/f' }, { type: 'application/octet-stream' }, { ref: { kind: 'image', mime: 'image/gif' } });
    expect((await fromSearch.cache.file('com.t.p/a/1', ctx)).file.endsWith('.gif')).toBe(true);
    const fromUrl = make({ url: 'https://x.example/song.ogg?sig=abc' }, { type: null });
    expect((await fromUrl.cache.file('com.t.p/a/2', ctx)).file.endsWith('.ogg')).toBe(true);
    const placeholder = make({ url: 'https://x.example/f' }, { type: 'video/mp4' }, { ref: { kind: 'video', mime: 'video/*' } });
    expect((await placeholder.cache.file('com.t.p/a/3', ctx)).file.endsWith('.mp4')).toBe(true);
  });

  it('refuses what is not media, not the kind the search said, too large, or not there — leaving nothing behind', async () => {
    const html = make({ url: 'https://x.example/page' }, { type: 'text/html' });
    await expect(html.cache.file('com.t.p/a/1', ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: expect.stringMatching(/not a picture, video or sound/) });
    const wrongKind = make({ url: 'https://x.example/f' }, { type: 'audio/mpeg' }, { ref: { kind: 'image', mime: 'image/*' } });
    await expect(wrongKind.cache.file('com.t.p/a/2', ctx)).rejects.toThrow(/found as image but downloaded as audio/);
    const declared = make({ url: 'https://x.example/f' }, { length: 10_000 }, { maxItemBytes: 100 });
    await expect(declared.cache.file('com.t.p/a/3', ctx)).rejects.toThrow(/more than the/);
    const streamed = make({ url: 'https://x.example/f' }, { body: 'x'.repeat(500) }, { maxItemBytes: 100 });
    await expect(streamed.cache.file('com.t.p/a/4', ctx)).rejects.toThrow(/more than the/);
    const missing = make({ url: 'https://x.example/f' }, { status: 404 });
    await expect(missing.cache.file('com.t.p/a/5', ctx)).rejects.toThrow(/HTTP 404/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('copies a file the plugin fetched itself', async () => {
    const source = path.join(tmp, 'plugin-copy.jpeg');
    fs.writeFileSync(source, 'jpeg-bytes');
    const { cache, requests } = make({ file: source });
    const got = await cache.file('com.t.p/a/local', ctx);
    expect(got.file.endsWith('.jpeg')).toBe(true);
    fs.rmSync(source);
    expect(fs.readFileSync(got.file, 'utf8')).toBe('jpeg-bytes');
    expect(requests).toEqual([]);
    await expect(make({ file: path.join(tmp, 'nope.png') }).cache.file('com.t.p/a/gone', ctx)).rejects.toThrow(/not a file/);
  });

  it('keeps the cache under its cap, dropping the least recently shown first', async () => {
    const { cache } = make({ url: 'https://x.example/f' }, { body: 'x'.repeat(40) }, { cacheBytes: 100 });
    const first = await cache.file('com.t.p/a/1', ctx);
    const second = await cache.file('com.t.p/a/2', ctx);
    // Make the first the oldest by far, then show the second again so it is the freshest.
    fs.utimesSync(first.file, new Date(0), new Date(0));
    await cache.file('com.t.p/a/2', ctx);
    const third = await cache.file('com.t.p/a/3', ctx);
    expect(fs.existsSync(first.file)).toBe(false);
    expect(fs.existsSync(second.file)).toBe(true);
    expect(fs.existsSync(third.file)).toBe(true);
  });
});
