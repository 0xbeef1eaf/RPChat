import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleAssetRequest, parseAssetUrl, parseRange, resolveAssetUrl } from './asset-protocol.js';
import { decodeCommandHash, encodeCommandHash, rewriteAssetUrl } from './loopback.js';
import { HOME_ASSET_HOST_PREFIX, HomeAssetRoots, characterHomeDir } from './capabilities/files.js';

describe('parseAssetUrl', () => {
  it('accepts well-formed pack asset URLs and decodes segments', () => {
    expect(parseAssetUrl('rp-asset://com.example.luna/media/images/luna-smile.png')).toEqual({ packId: 'com.example.luna', relativePath: 'media/images/luna-smile.png' });
    expect(parseAssetUrl('rp-asset://com.example.luna/media/a%20b.png')).toEqual({ packId: 'com.example.luna', relativePath: 'media/a b.png' });
  });

  it('accepts the app\'s own hosts: editor projects and character homes', () => {
    expect(parseAssetUrl('rp-asset://editor-0123456789ab/media/x.png')).toEqual({ packId: 'editor-0123456789ab', relativePath: 'media/x.png' });
    expect(parseAssetUrl('rp-asset://home-0123456789ab/webcam/shot.png')).toEqual({ packId: 'home-0123456789ab', relativePath: 'webcam/shot.png' });
  });

  it('rejects traversal, absolute paths, bad pack ids and other schemes', () => {
    // The URL parser resolves a literal `..` inside the host's path space, so it can never leave the pack.
    expect(parseAssetUrl('rp-asset://com.example.luna/media/../etc/passwd')).toEqual({ packId: 'com.example.luna', relativePath: 'etc/passwd' });
    expect(parseAssetUrl('rp-asset://com.example.luna/media/%2e%2e/x.png')).toEqual({ packId: 'com.example.luna', relativePath: 'x.png' });
    for (const bad of [
      'rp-asset://com.example.luna//etc/passwd',
      'rp-asset://com.example.luna/',
      'rp-asset://Not_A_Pack/x.png',
      'rp-asset://nodots/x.png',
      'rp-asset://home-nope/x.png',
      'rp-asset://home-0123456789abcd/x.png',
      'rp-asset://com.example.luna/a%5Cb.png',
      'rp-asset://com.example.luna/a%00.png',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(parseAssetUrl(bad), bad).toBeUndefined();
    }
  });
});

describe('parseRange', () => {
  it('parses single byte ranges against the size', () => {
    expect(parseRange(null, 100)).toBeUndefined();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-1000', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-9,20-29', 100)).toBeUndefined();
    expect(parseRange('items=0-1', 100)).toBeUndefined();
    expect(parseRange('bytes=-', 100)).toBeUndefined();
  });
});

const req = (url: string, headers: Record<string, string> = {}, method = 'GET') => ({ url, method, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });

describe('handleAssetRequest', () => {
  let root: string;
  let outside: string;
  const packRootFor = (packId: string): string | undefined => (packId === 'com.test.pack' ? root : undefined);

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-asset-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-outside-'));
    fs.mkdirSync(path.join(root, 'media'));
    fs.writeFileSync(path.join(root, 'media', 'clip.mp4'), Buffer.from('0123456789abcdef'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try {
      fs.symlinkSync(outside, path.join(root, 'media', 'link'));
    } catch {
      /* symlinks unavailable */
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('serves whole files with the right content type and accepts ranges', async () => {
    const whole = await handleAssetRequest(req('rp-asset://com.test.pack/media/clip.mp4'), { packRootFor });
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('content-length')).toBe('16');
    expect(await whole.text()).toBe('0123456789abcdef');

    const part = await handleAssetRequest(req('rp-asset://com.test.pack/media/clip.mp4', { range: 'bytes=4-7' }), { packRootFor });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 4-7/16');
    expect(part.headers.get('content-length')).toBe('4');
    expect(await part.text()).toBe('4567');

    const tail = await handleAssetRequest(req('rp-asset://com.test.pack/media/clip.mp4', { range: 'bytes=-3' }), { packRootFor });
    expect(await tail.text()).toBe('def');

    const bad = await handleAssetRequest(req('rp-asset://com.test.pack/media/clip.mp4', { range: 'bytes=99-' }), { packRootFor });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */16');

    const head = await handleAssetRequest(req('rp-asset://com.test.pack/media/clip.mp4', {}, 'HEAD'), { packRootFor });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  it('refuses unknown packs, missing files, traversal, symlink escapes and other methods', async () => {
    expect((await handleAssetRequest(req('rp-asset://com.other.pack/media/clip.mp4'), { packRootFor })).status).toBe(404);
    expect((await handleAssetRequest(req('rp-asset://com.test.pack/media/nope.mp4'), { packRootFor })).status).toBe(404);
    expect((await handleAssetRequest(req('rp-asset://com.test.pack/../clip.mp4'), { packRootFor })).status).toBe(404);
    expect((await handleAssetRequest(req('rp-asset://com.test.pack/media'), { packRootFor })).status).toBe(404);
    expect((await handleAssetRequest(req('rp-asset://com.test.pack/media/clip.mp4', {}, 'POST'), { packRootFor })).status).toBe(405);
    if (fs.existsSync(path.join(root, 'media', 'link'))) {
      expect((await handleAssetRequest(req('rp-asset://com.test.pack/media/link/secret.txt'), { packRootFor })).status).toBe(403);
      expect(() => resolveAssetUrl('rp-asset://com.test.pack/media/link/secret.txt', { packRootFor })).toThrow(/symlink/);
    }
  });
});

describe('HomeAssetRoots', () => {
  it('serves a character home under a host of its own, once a media call has registered it', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-asset-'));
    try {
      const homes = new HomeAssetRoots(userData);
      const home = characterHomeDir(userData, 'com.test.pack/luna');
      fs.mkdirSync(path.join(home, 'webcam'), { recursive: true });
      fs.writeFileSync(path.join(home, 'webcam', 'shot.png'), 'image bytes');
      const packRootFor = (packId: string): string | undefined => homes.rootFor(packId);

      // Nothing is reachable before the home is registered, and registering is what minting the host does.
      const host = `${HOME_ASSET_HOST_PREFIX}${'0'.repeat(12)}`;
      expect((await handleAssetRequest(req(`rp-asset://${host}/webcam/shot.png`), { packRootFor })).status).toBe(404);

      const mine = homes.host('com.test.pack/luna');
      expect(mine).toMatch(new RegExp(`^${HOME_ASSET_HOST_PREFIX}[a-f0-9]{12}$`));
      expect(homes.host('com.test.pack/luna')).toBe(mine); // stable for the same character
      expect(homes.host('com.test.pack/mai')).not.toBe(mine); // and its own for another one
      const served = await handleAssetRequest(req(`rp-asset://${mine}/webcam/shot.png`), { packRootFor });
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/png');
      expect(await served.text()).toBe('image bytes');
      // The same guard as a pack root: nothing above the home is reachable.
      expect((await handleAssetRequest(req(`rp-asset://${mine}/../../other.png`), { packRootFor })).status).toBe(404);
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});

describe('loopback helpers', () => {
  it('rewrites rp-asset URLs and round-trips the command hash', () => {
    expect(rewriteAssetUrl('rp-asset://com.x.p/media/a%20b.png', 'http://127.0.0.1:5/t/tok')).toBe('http://127.0.0.1:5/t/tok/asset/com.x.p/media/a%20b.png');
    expect(rewriteAssetUrl('https://example.com/x', 'http://127.0.0.1:5/t/tok')).toBe('https://example.com/x');
    const cmd = { type: 'close', id: 'a' } as const;
    expect(decodeCommandHash(`#cmd=${encodeCommandHash(cmd)}`)).toEqual(cmd);
    expect(decodeCommandHash('#nope')).toBeUndefined();
  });
});
