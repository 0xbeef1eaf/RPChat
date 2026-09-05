#!/usr/bin/env node
// Regenerates the tiny, deterministic media files shipped with the example packs.
// Usage: node examples/packs/scripts/generate-media.mjs
// Only Node built-ins are used (zlib for PNG deflate), so it runs without installing anything.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const luna = join(here, '..', 'luna');

// ---------- PNG ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([len, typeBytes, data, crc]);
}

/** Encodes an RGBA pixel function into a PNG buffer. */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

// Avatar: 16x16, a soft violet disc on a night-blue background.
const avatar = png(16, 16, (x, y) => {
  const dx = x - 7.5, dy = y - 7.5;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 6.5) return [clamp(170 + dy * 6), clamp(120 + dx * 4), 230, 255];
  return [20, 24, 48, 255];
});

// Smile: 32x32 warm gradient with a curved highlight.
const smile = png(32, 32, (x, y) => {
  const onArc = Math.abs((y - 20) - 0.05 * (x - 16) ** 2) < 1.2 && x > 8 && x < 24;
  if (onArc) return [255, 255, 240, 255];
  return [clamp(240 - y * 2), clamp(150 + x * 2), clamp(120 + y * 3), 255];
});

// Wave: 32x32 cool gradient with a diagonal band.
const wave = png(32, 32, (x, y) => {
  const band = Math.abs(x - y) < 2 || Math.abs(x + y - 31) < 2;
  if (band) return [255, 255, 255, 255];
  return [clamp(90 + x * 3), clamp(120 + y * 3), clamp(200 + x), 255];
});

// ---------- WAV ----------

/** 16-bit mono PCM WAV of a short decaying two-tone chime. */
function chimeWav() {
  const sampleRate = 16000;
  const seconds = 0.6;
  const n = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-4 * t);
    const s = 0.6 * Math.sin(2 * Math.PI * 880 * t) + 0.3 * Math.sin(2 * Math.PI * 1320 * t);
    data.writeInt16LE(clamp16(s * env * 0.8 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function clamp16(v) {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

// ---------- write ----------

const outputs = [
  [join(luna, 'characters', 'luna', 'avatar.png'), avatar],
  [join(luna, 'media', 'images', 'luna-smile.png'), smile],
  [join(luna, 'media', 'images', 'luna-wave.png'), wave],
  [join(luna, 'media', 'audio', 'chime.wav'), chimeWav()],
];
for (const [file, bytes] of outputs) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`${file} (${bytes.length} bytes)`);
}
