/**
 * The file format `sdk.crypto` reads and writes, and the primitives around it. Pure — no
 * filesystem, no key storage — so it is trivial to test and share between the live app and
 * `decrypt-all` (`manager.ts` is where a path turns into bytes turns into a written file).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { RpError } from '@rp/shared';

/** `RPCE` + format version 1: a file this module wrote is never mistaken for plain content. */
const MAGIC = Buffer.from([0x52, 0x50, 0x43, 0x45, 0x01]);
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A key id longer than this cannot happen (`crypto_keys.rs` ids are 16 hex chars) but the
 * length-prefixed format needs a cap regardless of who generated the id. */
const MAX_KEY_ID_BYTES = 255;
export const ALGORITHM = 'aes-256-gcm';
export const KEY_BYTES = 32;

export interface EncryptedContainer {
  keyId: string;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/** md5 of `data`, hex — not for security, only what the encryption log records as a checksum. */
export function md5Hex(data: Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

/** Whether `data` starts with this module's container header (used to skip a file that is already plaintext, or already encrypted, without trying to parse the rest). */
export function isEncryptedContainer(data: Buffer): boolean {
  return data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}

/** AES-256-GCM-encrypt `plaintext` under `key`, tagging the result with `keyId` so `decrypt` can find the right key later without being told which one. */
export function encryptBuffer(plaintext: Buffer, key: Buffer, keyId: string): Buffer {
  if (key.length !== KEY_BYTES) throw new RpError('INTERNAL', `encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  const keyIdBytes = Buffer.from(keyId, 'utf8');
  if (keyIdBytes.length === 0 || keyIdBytes.length > MAX_KEY_ID_BYTES) throw new RpError('INTERNAL', `key id must be 1-${MAX_KEY_ID_BYTES} bytes, got ${keyIdBytes.length}`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([keyIdBytes.length]), keyIdBytes, iv, authTag, ciphertext]);
}

/** Parse a container written by `encryptBuffer` without decrypting it, so a caller can look up `keyId` before it needs the key. Throws `INVALID_ARGUMENT` for anything else. */
export function parseContainer(data: Buffer): EncryptedContainer {
  if (!isEncryptedContainer(data)) throw new RpError('INVALID_ARGUMENT', 'not a file this module encrypted');
  let offset = MAGIC.length;
  const keyIdLen = data[offset];
  offset += 1;
  if (keyIdLen === undefined || keyIdLen === 0 || data.length < offset + keyIdLen + IV_BYTES + TAG_BYTES) {
    throw new RpError('INVALID_ARGUMENT', 'truncated or corrupt encrypted file');
  }
  const keyId = data.subarray(offset, offset + keyIdLen).toString('utf8');
  offset += keyIdLen;
  const iv = data.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const authTag = data.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ciphertext = data.subarray(offset);
  return { keyId, iv, authTag, ciphertext };
}

/** Decrypt a container already resolved to its `key` (the caller looked `container.keyId` up). Throws `CAPABILITY_FAILED` when the tag does not verify (wrong key, or the file was tampered with). */
export function decryptContainer(container: EncryptedContainer, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new RpError('INTERNAL', `decryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  const decipher = createDecipheriv(ALGORITHM, key, container.iv);
  decipher.setAuthTag(container.authTag);
  try {
    return Buffer.concat([decipher.update(container.ciphertext), decipher.final()]);
  } catch (err) {
    throw new RpError('CAPABILITY_FAILED', 'the file could not be decrypted with its recorded key (wrong key, or the file was modified since)', undefined, { cause: err });
  }
}
