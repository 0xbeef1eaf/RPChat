/**
 * CRX3 packaging of the bundled browser extension, with no dependency beyond `fflate` and
 * `node:crypto` (docs/browser-extension.md "How the package is built").
 *
 * CRX3 layout:  "Cr24" | uint32le 3 | uint32le headerLen | CrxFileHeader (protobuf) | zip
 *   CrxFileHeader   { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000; }
 *   AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
 *   SignedData      { bytes crx_id = 1; }
 * The signature is RSA-PKCS1-v1_5/SHA-256 over
 *   "CRX3 SignedData\0" | uint32le len(signed_header_data) | signed_header_data | zip
 * and the extension id is the first 128 bits of SHA-256(SPKI DER) written with the letters a–p.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { zipSync } from 'fflate';

export const CRX_MAGIC = 'Cr24';
export const CRX_VERSION = 3;
/** Fixed timestamp for zip entries so the same files always produce the same bytes. */
const ZIP_MTIME = new Date('2000-01-01T00:00:00Z');

export interface ExtensionFile {
  /** Path inside the zip, `/`-separated, relative to the extension root. */
  path: string;
  data: Uint8Array;
}

// ---- protobuf (only what CRX3 needs) ----------------------------------------------------------

export function varint(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0) throw new Error(`varint needs a non-negative integer, got ${n}`);
  const bytes: number[] = [];
  let v = n;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

/** A length-delimited protobuf field (wire type 2). */
export function bytesField(fieldNumber: number, value: Uint8Array): Buffer {
  return Buffer.concat([varint(fieldNumber * 8 + 2), varint(value.length), Buffer.from(value)]);
}

export function uint32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

// ---- keys and ids -----------------------------------------------------------------------------

/** Chrome's extension id for a public key: SHA-256 of the SPKI DER, first 16 bytes, hex digits mapped onto a–p. */
export function extensionIdFromPublicKey(spkiDer: Uint8Array): string {
  const digest = createHash('sha256').update(spkiDer).digest('hex').slice(0, 32);
  return digest.replace(/[0-9a-f]/g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)));
}

export function extensionIdFromPrivateKeyPem(pem: string): string {
  return extensionIdFromPublicKey(spkiDerOf(pem));
}

/** SPKI DER of the public half of a PEM private key. */
export function spkiDerOf(privateKeyPem: string): Buffer {
  const pub = createPublicKey(createPrivateKey(privateKeyPem));
  return pub.export({ type: 'spki', format: 'der' }) as Buffer;
}

export function generateExtensionKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

/**
 * The per-user key, created on first use (`0600`; its contents are never logged). Chrome derives the
 * extension id from it, so keeping it stable keeps the policy's id stable.
 */
export async function loadOrCreateKey(file: string, logger?: Pick<Console, 'info'>): Promise<string> {
  try {
    const pem = await fs.readFile(file, 'utf8');
    createPrivateKey(pem); // throws when unreadable
    return pem;
  } catch {
    const pem = generateExtensionKeyPem();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, pem, { mode: 0o600 });
    logger?.info(`[browser] generated the extension signing key at ${file}`);
    return pem;
  }
}

// ---- zip + crx --------------------------------------------------------------------------------

/** Read an extension directory (recursively) into deterministic order; `manifest.json` must exist. */
export async function readExtensionDir(dir: string): Promise<ExtensionFile[]> {
  const out: ExtensionFile[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile()) out.push({ path: relPath, data: new Uint8Array(await fs.readFile(path.join(dir, relPath))) });
    }
  };
  await walk('');
  if (!out.some((f) => f.path === 'manifest.json')) throw new Error(`${dir} has no manifest.json`);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Deterministic zip (sorted names, fixed mtime) of the extension files. */
export function zipExtension(files: ExtensionFile[]): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }]> = {};
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) entries[f.path] = [f.data, { mtime: ZIP_MTIME, level: 6 }];
  return zipSync(entries, { mtime: ZIP_MTIME });
}

export interface PackedCrx {
  crx: Buffer;
  id: string;
  publicKey: Buffer;
}

/** Sign a zip into a CRX3 file with the given private key (PEM or KeyObject). */
export function packCrx3(zip: Uint8Array, privateKey: string | KeyObject): PackedCrx {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer;
  const id = extensionIdFromPublicKey(publicKey);
  const crxId = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const signedHeaderData = bytesField(1, crxId); // SignedData { crx_id = 1 }
  const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), uint32le(signedHeaderData.length), signedHeaderData, Buffer.from(zip)]);
  const signature = sign('sha256', payload, { key, padding: 1 /* RSA_PKCS1_PADDING */ });
  const proof = Buffer.concat([bytesField(1, publicKey), bytesField(2, signature)]); // AsymmetricKeyProof
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedHeaderData)]); // CrxFileHeader
  const crx = Buffer.concat([Buffer.from(CRX_MAGIC, 'latin1'), uint32le(CRX_VERSION), uint32le(header.length), header, Buffer.from(zip)]);
  return { crx, id, publicKey };
}

/** Parse the fixed part of a CRX3 file (for tests and diagnostics). */
export function parseCrxHeader(crx: Uint8Array): { magic: string; version: number; headerLength: number; zipOffset: number } {
  const b = Buffer.from(crx.buffer, crx.byteOffset, crx.byteLength);
  if (b.length < 12) throw new Error('not a CRX file (too short)');
  const magic = b.subarray(0, 4).toString('latin1');
  const version = b.readUInt32LE(4);
  const headerLength = b.readUInt32LE(8);
  return { magic, version, headerLength, zipOffset: 12 + headerLength };
}
