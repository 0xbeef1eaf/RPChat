import { createHash, createPublicKey, createVerify } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CRX_MAGIC,
  CRX_VERSION,
  bytesField,
  extensionIdFromPrivateKeyPem,
  extensionIdFromPublicKey,
  generateExtensionKeyPem,
  loadOrCreateKey,
  packCrx3,
  parseCrxHeader,
  readExtensionDir,
  spkiDerOf,
  uint32le,
  varint,
  zipExtension,
} from './crx.js';

/**
 * A fixed 2048-bit test key so the id derivation is pinned: the expected id below was computed
 * once with `extensionIdFromPublicKey` (SHA-256 of the SPKI DER, first 128 bits, hex → a–p) and
 * must never change, or every user's policy would point at a different extension.
 */
const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDHUHjSJ16Pvq3O
6wE8iKqgnSDwvJj+wK2pH7vLlh4TxJUpQbiOY/EK7P5hK6WQvfqhmQF5ofBMTzR0
LKq2l92HjoqwTgHuXRi248fwtR0pSJm0WdMi2Xovsybh3m4vJ/9bu9+o9dWqyAZ/
m68sarPkp+cDEpXJwdpYPLj8YydgzFnNzjhaaEu1qNz8kzg2jfLQyUr1dkLxRMxN
NhYUwnhaC1Vz1TpEh8GjIyIVOyTVRcbUeM8gev/G4TJmWbyw/VN9icEf7YeDuVzJ
qavZiEnull9F2emNSzsCdcCAt1mMs+2ewz23VimMBngFgdKm1+SL3JIn1yGWgzv/
byIHC9ntAgMBAAECggEAFti8VLiTEA6XHUQWYvI2fs0sGLRBpFgBQATlcad+QJ1U
zMMeDOJbX7l9SjWm15HTUCE6CE99/D1LAbMaCW6cg9ycvKtgcMqGmfY/tbGJC3Gp
PsFaIKFFroCOaS8mOa0PyhvdviAZ0yb1Cb0WhhSgFMqDQjin51XbeahSOwoBmkh2
bLjdD47B3MIRe4OkfBFwSS5ocxwli/XDMCHyU+f8196/YiEF/oelcFUH6yo3D7bN
gCuTwYin8u/KSYdJsBI49966E5ujuZAt5siwaLG1V/3ampu9sJUYFkCi3i+LMe7+
JmouIupDoO/gPr6mF4PftbEZvTcL6svwITG3PbiqEQKBgQDyICy+a1g8HynXabNz
oOtqec4NKS3yMZZto4H5I6wBui5rOwD8y4oGK0nJzcWMAcalqMTMcuaKjq582jf2
kDijy3s27ip466J1pakXRjX3Pif65xG6qXV4KHN99eB43eOndrypRiooXRsTfjT6
qvzAdHqGwqN9gm5wHl+JmOBwvQKBgQDSvEhpxnLHMqalWkROO+2Tm1w0d/ZnhqrL
i23yz0n69iCiuzJF9MYEMM59tx5rJ+29Bp++yqJWK+40lix75zJ3WE59B2vtFI+5
+v7GtSx6fC70BqU1lXAreawSyd54996kuZx+iz6kxCvI5nLauLLYUUDa70QlpahQ
CU/Z4PAY8QKBgFCtMdt9DxhxVdLGEJpNm0OONH8kIoAZz8LWgX9PSIgGzmLCdVDG
TUZC9EI+wz0kdllKg9CP1IuEgVVurMkGQykoqvShpRtHgIls2ou7xE2Os2mhxsGI
p3CTIfBtlg8P+EQbhz9r9q4eX+A95E9F3BQQe6cdgbZXWI8ZP8IsY1SNAoGBAL87
vTq/q0i43iEPWQzltSJNyc6TTjeELVmonY3KLghfch46YdS52zfSUpAirKfxA/yV
FkG9ALPSCcgOvy9xDorex9sN8RKjpgnPi4QmxMYiCznHDgUiJzhMoaorJof/5zr0
dN8g3SgIHPOirHdvRFyo34HNvrmrKqH20U+WoEsBAoGAGUNTBCaca8IjNwb/dG2q
+5S4OuNW/Lakg4G5/rj29wZ/tNV85tmPDtArhDumesO91E7NFlRfVTdFIYf7HJlV
+WpMRRQ+1P3L59I3Ppw33IMzS+vRiV1Q2PgRv0vtpsOJ+aIk8yVAe2uC+ame2CGj
beZKZATBFYWEkL1ArnTR+7Y=
-----END PRIVATE KEY-----
`;
const TEST_KEY_ID = 'fcogpkfgnnalkjhakbcefpnjfkmcdggd';

describe('protobuf helpers', () => {
  it('varint encodes like protobuf', () => {
    expect([...varint(0)]).toEqual([0]);
    expect([...varint(1)]).toEqual([1]);
    expect([...varint(127)]).toEqual([127]);
    expect([...varint(128)]).toEqual([0x80, 0x01]);
    expect([...varint(300)]).toEqual([0xac, 0x02]);
    expect([...varint(80002)]).toEqual([0x82, 0xf1, 0x04]); // tag of field 10000, wire type 2
    expect(() => varint(-1)).toThrow();
  });
  it('bytesField writes tag, length, payload', () => {
    expect([...bytesField(1, Buffer.from([9, 8]))]).toEqual([0x0a, 2, 9, 8]);
    expect([...bytesField(2, Buffer.alloc(0))]).toEqual([0x12, 0]);
    expect([...bytesField(10000, Buffer.from([1]))]).toEqual([0x82, 0xf1, 0x04, 1, 1]);
  });
  it('uint32le', () => {
    expect([...uint32le(3)]).toEqual([3, 0, 0, 0]);
    expect([...uint32le(0x01020304)]).toEqual([4, 3, 2, 1]);
  });
});

describe('extension id', () => {
  it('derives the pinned id from the test key', () => {
    expect(extensionIdFromPrivateKeyPem(TEST_KEY_PEM)).toBe(TEST_KEY_ID);
    // The algorithm, spelled out: sha256(spki) → first 16 bytes → hex digits as letters a–p.
    const hex = createHash('sha256').update(spkiDerOf(TEST_KEY_PEM)).digest('hex').slice(0, 32);
    const manual = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    expect(manual).toBe(TEST_KEY_ID);
  });
  it('is 32 letters a–p for any key and differs between keys', () => {
    const a = extensionIdFromPrivateKeyPem(generateExtensionKeyPem());
    const b = extensionIdFromPrivateKeyPem(generateExtensionKeyPem());
    expect(a).toMatch(/^[a-p]{32}$/);
    expect(b).toMatch(/^[a-p]{32}$/);
    expect(a).not.toBe(b);
  });
  it('extensionIdFromPublicKey accepts raw SPKI bytes', () => {
    expect(extensionIdFromPublicKey(spkiDerOf(TEST_KEY_PEM))).toBe(TEST_KEY_ID);
  });
});

describe('packCrx3', () => {
  const files = [
    { path: 'manifest.json', data: new TextEncoder().encode('{"manifest_version":3,"name":"t","version":"1.2.3"}') },
    { path: 'background.js', data: new TextEncoder().encode('console.log(1)') },
    { path: 'sub/page.html', data: new TextEncoder().encode('<p>hi</p>') },
  ];

  it('zips deterministically', () => {
    const a = zipExtension(files);
    const b = zipExtension([...files].reverse());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const unzipped = unzipSync(a);
    expect(Object.keys(unzipped).sort()).toEqual(['background.js', 'manifest.json', 'sub/page.html']);
    expect(new TextDecoder().decode(unzipped['sub/page.html'])).toBe('<p>hi</p>');
  });

  it('produces a CRX3 whose header and signature check out', () => {
    const zip = zipExtension(files);
    const { crx, id, publicKey } = packCrx3(zip, TEST_KEY_PEM);
    expect(id).toBe(TEST_KEY_ID);
    const header = parseCrxHeader(crx);
    expect(header.magic).toBe(CRX_MAGIC);
    expect(header.version).toBe(CRX_VERSION);
    expect(crx.subarray(header.zipOffset).equals(Buffer.from(zip))).toBe(true);
    // Walk the hand-encoded CrxFileHeader: field 2 (proof) then field 10000 (signed_header_data).
    const headerBytes = crx.subarray(12, header.zipOffset);
    const fields = decodeFields(headerBytes);
    expect(fields.map((f) => f.field)).toEqual([2, 10000]);
    const proof = decodeFields(fields[0]!.value);
    expect(proof.map((f) => f.field)).toEqual([1, 2]);
    expect(proof[0]!.value.equals(publicKey)).toBe(true);
    const signedHeaderData = fields[1]!.value;
    const signedData = decodeFields(signedHeaderData);
    expect(signedData).toHaveLength(1);
    expect(signedData[0]!.field).toBe(1);
    expect(signedData[0]!.value.equals(createHash('sha256').update(publicKey).digest().subarray(0, 16))).toBe(true);
    // RSA-PKCS1-v1_5 / SHA-256 over "CRX3 SignedData\0" + len + signed_header_data + zip.
    const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), uint32le(signedHeaderData.length), signedHeaderData, Buffer.from(zip)]);
    const verifier = createVerify('sha256');
    verifier.update(payload);
    expect(verifier.verify(createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), proof[1]!.value)).toBe(true);
    // Same input, same bytes.
    expect(packCrx3(zip, TEST_KEY_PEM).crx.equals(crx)).toBe(true);
  });

  it('rejects a broken header parse', () => {
    expect(() => parseCrxHeader(new Uint8Array(3))).toThrow(/too short/);
  });
});

describe('key file and directory reading', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-crx-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loadOrCreateKey creates once (0600) and reuses', async () => {
    const file = path.join(dir, 'keys', 'extension-key.pem');
    const logs: string[] = [];
    const pem = await loadOrCreateKey(file, { info: (m: string) => logs.push(m) });
    expect(pem).toContain('BEGIN PRIVATE KEY');
    expect(logs.join('\n')).not.toContain(pem.split('\n')[1]);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateKey(file)).toBe(pem);
    await fs.writeFile(file, 'garbage');
    expect(await loadOrCreateKey(file)).not.toBe('garbage');
  });

  it('readExtensionDir walks recursively in sorted order and needs a manifest', async () => {
    const ext = path.join(dir, 'ext');
    await fs.mkdir(path.join(ext, 'b'), { recursive: true });
    await fs.writeFile(path.join(ext, 'manifest.json'), '{}');
    await fs.writeFile(path.join(ext, 'z.js'), 'z');
    await fs.writeFile(path.join(ext, 'b', 'a.txt'), 'a');
    const files = await readExtensionDir(ext);
    expect(files.map((f) => f.path)).toEqual(['b/a.txt', 'manifest.json', 'z.js']);
    await expect(readExtensionDir(path.join(dir, 'keys'))).rejects.toThrow(/manifest/);
  });
});

/** Minimal protobuf reader for the test: only length-delimited fields. */
function decodeFields(buf: Buffer): Array<{ field: number; value: Buffer }> {
  const out: Array<{ field: number; value: Buffer }> = [];
  let i = 0;
  const readVarint = (): number => {
    let shift = 0;
    let n = 0;
    for (;;) {
      const b = buf[i++]!;
      n += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return n;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const tag = readVarint();
    if ((tag & 7) !== 2) throw new Error(`unexpected wire type ${tag & 7}`);
    const len = readVarint();
    out.push({ field: Math.floor(tag / 8), value: buf.subarray(i, i + len) });
    i += len;
  }
  return out;
}
