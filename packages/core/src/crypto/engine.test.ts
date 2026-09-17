import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import { KEY_BYTES, decryptContainer, encryptBuffer, isEncryptedContainer, md5Hex, parseContainer } from './engine.js';

describe('engine', () => {
  it('round-trips plaintext through encrypt/decrypt with the right key', () => {
    const key = randomBytes(KEY_BYTES);
    const plaintext = Buffer.from('hello, this is a diary entry', 'utf8');
    const container = encryptBuffer(plaintext, key, 'key-1');
    expect(isEncryptedContainer(container)).toBe(true);
    expect(isEncryptedContainer(plaintext)).toBe(false);
    const parsed = parseContainer(container);
    expect(parsed.keyId).toBe('key-1');
    expect(decryptContainer(parsed, key)).toEqual(plaintext);
  });

  it('round-trips an empty file', () => {
    const key = randomBytes(KEY_BYTES);
    const container = encryptBuffer(Buffer.alloc(0), key, 'k');
    expect(decryptContainer(parseContainer(container), key)).toEqual(Buffer.alloc(0));
  });

  it('refuses to decrypt under the wrong key', () => {
    const key = randomBytes(KEY_BYTES);
    const wrong = randomBytes(KEY_BYTES);
    const container = encryptBuffer(Buffer.from('secret'), key, 'k');
    expect(() => decryptContainer(parseContainer(container), wrong)).toThrow(RpError);
  });

  it('detects a modified ciphertext (authenticated encryption)', () => {
    const key = randomBytes(KEY_BYTES);
    const container = encryptBuffer(Buffer.from('secret'), key, 'k');
    container[container.length - 1] = (container[container.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptContainer(parseContainer(container), key)).toThrow(RpError);
  });

  it('parseContainer rejects plain files and truncated containers', () => {
    expect(() => parseContainer(Buffer.from('just some text'))).toThrow(/not a file this module encrypted/);
    const key = randomBytes(KEY_BYTES);
    const container = encryptBuffer(Buffer.from('x'), key, 'k');
    expect(() => parseContainer(container.subarray(0, 6))).toThrow(/truncated/);
  });

  it('encryptBuffer rejects the wrong key size', () => {
    expect(() => encryptBuffer(Buffer.from('x'), randomBytes(16), 'k')).toThrow(RpError);
  });

  it('md5Hex matches a known vector', () => {
    expect(md5Hex(Buffer.from(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(Buffer.from('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});
