/**
 * The authoring side: generating the signing key, handing out the Remote Link and signing each new
 * version of the policy. The bytes it produces have to be exactly what `native/rpchatd/src/chain.rs`
 * verifies, so the canonical form and the hash linking are pinned here as well as there.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPublicKey, createHash, verify as verifyBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PolicyFile } from '@rp/shared';
import { ChainAuthor, linkHash, linkMessage, packMessage, rawPublicKey } from './chain-author.js';
import type { SafeStorageLike } from './chain-author.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A keyring that works, and one that does not — both paths store a key. */
function keyring(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    // A stand-in for the OS keyring: reversible, and obviously not the plaintext.
    encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buf) => Buffer.from(buf.toString('utf8'), 'base64').toString('utf8'),
  };
}

async function author(available = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-author-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    author: new ChainAuthor({
      dir,
      safeStorage: keyring(available),
      logger: { info: () => {}, warn: () => {} },
      now: () => new Date('2026-09-16T09:00:00Z'),
    }),
  };
}

const POLICY: PolicyFile = { version: 1, managedBy: 'Acme IT' };

/** Verify a base64 Ed25519 signature the way the daemon does, from the raw public key. */
function verifyRaw(publicKeyB64: string, signature: string, message: Buffer): boolean {
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyB64, 'base64').toString('base64url') },
    format: 'jwk',
  });
  return verifyBytes(null, message, key, Buffer.from(signature, 'base64'));
}

describe('ChainAuthor', () => {
  it('generates a key, keeps it out of plain sight and reports the public half', async () => {
    const { author: a, dir } = await author(true);
    expect(await a.status()).toMatchObject({ hasKey: false, links: 0, seq: 0 });
    const status = await a.createKey();
    expect(status.hasKey).toBe(true);
    expect(status.keyring).toBe(true);
    expect(Buffer.from(status.publicKey!, 'base64')).toHaveLength(32);
    // The stored file is not the PEM, and it is not world-readable.
    const raw = await fs.readFile(path.join(dir, 'key.bin'), 'utf8');
    expect(raw).not.toContain('PRIVATE KEY');
    expect((await fs.stat(path.join(dir, 'key.bin'))).mode & 0o777).toBe(0o600);
    // Generating again would orphan every machine already following the chain, so it is refused.
    await expect(a.createKey()).rejects.toThrow(/already exists/);
    expect((await a.createKey(true)).publicKey).not.toBe(status.publicKey);
  });

  it('falls back to a 0600 file when there is no keyring, and says so', async () => {
    const { author: a, dir } = await author(false);
    const status = await a.createKey();
    expect(status.keyring).toBe(false);
    const raw = await fs.readFile(path.join(dir, 'key.bin'), 'utf8');
    expect(raw).toContain('PRIVATE KEY');
    // It still round-trips, which is the point of storing it at all.
    expect(await a.exportKey()).toContain('PRIVATE KEY');
  });

  it('imports and exports a key, so a chain survives moving between machines', async () => {
    const first = await author();
    await first.author.createKey();
    const pem = await first.author.exportKey();
    const second = await author();
    const status = await second.author.importKey(pem);
    expect(status.publicKey).toBe((await first.author.status()).publicKey);
    await expect(second.author.importKey('not a key')).rejects.toThrow(/not a private key/);
  });

  it('signs a Remote Link with the key it carries', async () => {
    const { author: a } = await author();
    const status = await a.createKey();
    // A link needs somewhere to point at.
    await expect(a.remoteLink()).rejects.toThrow(/address/);
    await a.configure({ url: 'https://policies.example.com/chain.json', managedBy: 'Acme IT', keyId: 'acme-2026', mode: 'chain', intervalMinutes: 30 });
    const { blob, link } = await a.remoteLink();

    const decoded = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as typeof link;
    expect(decoded.url).toBe('https://policies.example.com/chain.json');
    expect(decoded.key).toBe(status.publicKey);
    expect(decoded.mode).toBe('chain');
    expect(decoded.managedBy).toBe('Acme IT');
    // Self-signed: the signature covers the blob minus the signature itself.
    expect(verifyRaw(status.publicKey!, decoded.signature.value, linkMessage(decoded))).toBe(true);
    // And an edited blob no longer verifies, which is what makes pasting one safe.
    const edited = { ...decoded, url: 'https://evil.example.com/chain.json' };
    expect(verifyRaw(status.publicKey!, decoded.signature.value, linkMessage(edited))).toBe(false);

    await expect(a.configure({ url: 'http://policies.example.com/chain.json' })).rejects.toThrow(/https/);
  });

  it('builds a chain where each link commits to the one before it', async () => {
    const { author: a } = await author();
    const status = await a.createKey();
    await a.configure({ url: 'https://policies.example.com/chain.json' });

    const first = await a.appendLink({ policy: POLICY });
    expect(first.link.seq).toBe(1);
    expect(first.link.prev).toBe('');
    expect(first.status.seq).toBe(1);
    expect(first.status.head).toBe(linkHash(first.link));

    const second = await a.appendLink({ policy: { ...POLICY, managedBy: 'Acme IT, later' } });
    expect(second.link.seq).toBe(2);
    expect(second.link.prev).toBe(linkHash(first.link));

    // Every link verifies under the published key.
    const chain = await a.publishedChain();
    expect(chain.links).toHaveLength(2);
    for (const link of chain.links) {
      expect(verifyRaw(status.publicKey!, link.signature.value, linkMessage(link))).toBe(true);
    }

    // An empty link does nothing and is refused rather than silently published.
    await expect(a.appendLink({})).rejects.toThrow(/has to do something/);

    // The undo drops the tail, for a version signed by mistake.
    expect((await a.dropLastLink()).seq).toBe(1);
    expect((await a.publishedChain()).links).toHaveLength(1);
  });

  it('signs a link that rotates the key, and one that unseals', async () => {
    const { author: a } = await author();
    await a.createKey();
    await a.configure({ url: 'https://policies.example.com/chain.json' });
    await a.appendLink({ policy: POLICY });

    const successor = await author();
    const next = (await successor.author.createKey()).publicKey!;
    const rotation = await a.appendLink({ policy: POLICY, rotateTo: next });
    expect(rotation.link.nextKey).toBe(next);

    const release = await a.appendLink({ unseal: true });
    expect(release.link.unseal).toBe(true);
    // A release carries no policy: what the chain last set stays in force.
    expect(release.link.policy).toBeUndefined();
  });

  it('signs a pack over its id, version and bytes together', async () => {
    const { author: a } = await author();
    const status = await a.createKey();
    const sha256 = createHash('sha256').update('a pack file').digest('hex');
    const signature = await a.signPack({ id: 'luna', version: '1.2.0', sha256 });
    expect(verifyRaw(status.publicKey!, signature, Buffer.from(packMessage('luna', '1.2.0', sha256), 'utf8'))).toBe(true);
    // Re-labelling the same bytes as another pack, or another version, breaks it.
    expect(verifyRaw(status.publicKey!, signature, Buffer.from(packMessage('other', '1.2.0', sha256), 'utf8'))).toBe(false);
    expect(verifyRaw(status.publicKey!, signature, Buffer.from(packMessage('luna', '1.3.0', sha256), 'utf8'))).toBe(false);
    await expect(a.signPack({ id: 'luna', sha256: 'nope' })).rejects.toThrow(/64 hex/);
  });

  it('needs a key before it will sign anything', async () => {
    const { author: a } = await author();
    await a.configure({ url: 'https://policies.example.com/chain.json' });
    await expect(a.remoteLink()).rejects.toThrow(/signing key/);
    await expect(a.appendLink({ policy: POLICY })).rejects.toThrow(/signing key/);
    await expect(a.signPack({ id: 'luna', sha256: 'a'.repeat(64) })).rejects.toThrow(/signing key/);
    await expect(a.exportKey()).rejects.toThrow(/no signing key/);
  });

  it('forgets the key and the chain when asked', async () => {
    const { author: a, dir } = await author();
    await a.createKey();
    await a.configure({ url: 'https://policies.example.com/chain.json' });
    await a.appendLink({ policy: POLICY });
    const status = await a.forget();
    expect(status).toMatchObject({ hasKey: false, links: 0, seq: 0 });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  /**
   * The cross-language contract, pinned on both sides: `the_canonical_form_does_not_depend_on_key_order`
   * and the link hashing in `native/rpchatd/src/chain.rs` must agree with these bytes, or an
   * administrator's chain would verify here and be refused on every machine.
   */
  /**
   * The same key, link, hash and signature as `a_link_signed_by_the_app_verifies_here` in
   * `native/rpchatd/src/chain.rs`. Pinned on both sides: if either canonicalisation drifts, a
   * chain would verify for the administrator who signed it and be refused on every machine.
   */
  it('signs a link exactly as the daemon verifies it', async () => {
    const { author: a } = await author();
    // The Ed25519 key whose seed is 32 bytes of 0x01.
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 1)]);
    const { createPrivateKey } = await import('node:crypto');
    const status = await a.importKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }).toString());
    expect(status.publicKey).toBe('iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=');

    await a.configure({ url: 'https://policies.example.com/chain.json' });
    const { link } = await a.appendLink({ policy: { version: 1, managedBy: 'Acme IT' } });
    // `issuedAt` is part of what is signed, so the pinned vector is over the link without it —
    // what matters is that the same bytes produce the same signature on both sides.
    const pinned = { seq: 1, prev: '', policy: { version: 1, managedBy: 'Acme IT' } };
    expect(linkHash(pinned)).toBe('c0b2270f827b16d302b19afec2713a349c4d4ec02814e6fbbc6fcb3cbd7795e6');
    const { sign: signBytes, createPrivateKey: key } = await import('node:crypto');
    expect(signBytes(null, linkMessage(pinned), key(await a.exportKey())).toString('base64')).toBe(
      '9WbRZ75BlBq3uuVzxGROCsK6UuB95mTnoepPKnQ+BwGV+Myw1yS80VJuiE7iX7Yl9LxhhvGQym50Xlexg+8iAw==',
    );
    // And the link the author actually produced verifies under the same key.
    expect(verifyRaw(status.publicKey!, link.signature.value, linkMessage(link))).toBe(true);
  });

  it('produces the canonical bytes the daemon hashes and verifies', () => {
    const link = { seq: 1, prev: '', policy: { version: 1, managedBy: 'x' } };
    const reordered = { policy: { managedBy: 'x', version: 1 }, prev: '', seq: 1 };
    expect(linkMessage(link).toString('utf8')).toBe('rpchat-chain/v1\n{"policy":{"managedBy":"x","version":1},"prev":"","seq":1}');
    expect(linkMessage(reordered)).toEqual(linkMessage(link));
    expect(linkHash(link)).toBe(createHash('sha256').update('{"policy":{"managedBy":"x","version":1},"prev":"","seq":1}', 'utf8').digest('hex'));
    // The signature member is never part of what is signed or hashed.
    expect(linkMessage({ ...link, signature: { alg: 'ed25519', value: 'x' } })).toEqual(linkMessage(link));
    expect(packMessage('luna', '1.2.0', 'AABB')).toBe('rpchat-pack/v1\nluna\n1.2.0\naabb');
    expect(packMessage('luna', undefined, 'aabb')).toBe('rpchat-pack/v1\nluna\n\naabb');
  });

  it('exports the public key in the 32-byte form a machine pins', async () => {
    const { author: a } = await author();
    const status = await a.createKey();
    const pem = await a.exportKey();
    expect(rawPublicKey(createPublicKey(pem))).toBe(status.publicKey);
    expect(() => rawPublicKey(createPublicKey({ key: { kty: 'oct', k: 'AAAA' }, format: 'jwk' } as never))).toThrow();
  });

  it('logs rather than throws when the keyring disappears between writes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-author-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    let available = true;
    const warn = vi.fn();
    const a = new ChainAuthor({
      dir,
      safeStorage: { ...keyring(true), isEncryptionAvailable: () => available },
      logger: { info: () => {}, warn },
    });
    await a.createKey();
    available = false;
    // A key written through the keyring cannot be read without it, and says exactly that.
    await expect(a.exportKey()).rejects.toThrow(/OS keyring, which is not available/);
    expect((await a.status()).hasKey).toBe(false);
  });
});
