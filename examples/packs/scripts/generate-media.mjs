#!/usr/bin/env node
// Regenerates the tiny, deterministic media files shipped with the example packs.
// Usage: node examples/packs/scripts/generate-media.mjs
// Only Node built-ins are used (zlib for PNG deflate), so it runs without installing anything.

import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const luna = join(here, '..', 'luna');
const makima = join(here, '..', 'makima');

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

/** Encodes a pixel function into a PNG buffer: RGBA by default, RGB with `{ rgb: true }`. */
function png(width, height, pixel, { rgb = false } = {}) {
  const bpp = rgb ? 3 : 4;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
      if (!rgb) raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = rgb ? 2 : 6;  // colour type RGB / RGBA
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

// ---------- Makima (placeholder art: abstract compositions in her palette) ----------
// No copyrighted artwork is reproduced; these are procedural stand-ins meant to be replaced.

const PAL = {
  bg: [26, 20, 22],
  hair: [163, 50, 43],
  hairDark: [110, 30, 28],
  skin: [243, 227, 211],
  eye: [232, 197, 71],
  eyeDark: [70, 40, 20],
  line: [60, 30, 30],
};
const mix = (a, b, t) => [clamp(a[0] + (b[0] - a[0]) * t), clamp(a[1] + (b[1] - a[1]) * t), clamp(a[2] + (b[2] - a[2]) * t)];
const smoothstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** A ringed "eye": concentric yellow/dark rings, optionally lidded from the top. */
function eyeAt(px, py, cx, cy, r, { rings = 3, lid = 0, squint = 1 } = {}) {
  const dx = (px - cx) / r, dy = (py - cy) / (r * squint);
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > 1) return null;
  if (py < cy - r * squint * (1 - 2 * lid)) return null; // eyelid
  const ring = Math.floor(d * rings * 2);
  const c = ring % 2 === 0 ? PAL.eye : PAL.eyeDark;
  if (d < 0.18) return PAL.eyeDark; // pupil
  return c;
}

/** Abstract portrait: hair mass, pale oval, ringed eyes, a mouth line. Options shape the expression. */
function facePixel(size, opts) {
  const s = size;
  return (x, y) => {
    const u = x / s, v = y / s;
    let c = mix(PAL.bg, [40, 22, 26], v);
    // hair: a broad rounded mass framing the face, with darker strands
    const hx = (u - 0.5) / 0.42, hy = (v - 0.42) / 0.5;
    if (hx * hx + hy * hy < 1) c = mix(PAL.hair, PAL.hairDark, 0.5 + 0.5 * Math.sin(u * 60 + v * 8));
    // face oval
    const fx = (u - 0.5) / 0.26, fy = (v - 0.5) / 0.34;
    if (fx * fx + fy * fy < 1) c = mix(PAL.skin, [225, 200, 185], v);
    // eyes
    const eye = eyeAt(x, y, s * 0.4, s * 0.47, s * opts.eyeR, opts) ?? eyeAt(x, y, s * 0.6, s * 0.47, s * opts.eyeR, opts);
    if (eye) c = mix(c, eye, opts.eyeGlow);
    // mouth: an arc whose curvature sets the expression
    const mx = (u - 0.5) / 0.09;
    if (Math.abs(mx) < 1) {
      const my = 0.66 + opts.mouth * (1 - mx * mx) * 0.03;
      if (Math.abs(v - my) < 0.006) c = PAL.line;
    }
    // cool tint for displeasure
    if (opts.cool) c = mix(c, [40, 40, 70], 0.18);
    return [...c, 255];
  };
}

const EXPRESSIONS = {
  neutral: { eyeR: 0.055, rings: 3, mouth: 0, eyeGlow: 0.9 },
  smile: { eyeR: 0.05, rings: 3, mouth: 1, eyeGlow: 0.9, squint: 0.7 },
  stare: { eyeR: 0.075, rings: 5, mouth: 0, eyeGlow: 1 },
  displeased: { eyeR: 0.055, rings: 3, mouth: -1, eyeGlow: 0.85, lid: 0.35, cool: true },
};

const makimaAvatar = png(256, 256, facePixel(256, EXPRESSIONS.neutral));
const makimaExpressions = Object.fromEntries(
  Object.entries(EXPRESSIONS).map(([name, opts]) => [name, png(256, 256, facePixel(256, opts))]),
);

/** Deterministic pseudo-random in [0, 1) from integer inputs. */
function hash(a, b = 0) {
  let h = (a * 374761393 + b * 668265263) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const W = 1920, H = 1080;

// Red-tinted city dusk: gradient sky, a low sun, building silhouettes.
const redDusk = png(W, H, (x, y) => {
  const v = y / H;
  let c = mix([120, 24, 30], [40, 10, 14], smoothstep(0, 0.7, v));
  c = mix(c, [220, 90, 50], 0.35 * (1 - smoothstep(0.1, 0.62, v)));
  const sdx = (x - 1300) / 170, sdy = (y - 560) / 170;
  const sd = Math.sqrt(sdx * sdx + sdy * sdy);
  if (sd < 1) c = mix(c, [235, 120, 70], 0.8 * (1 - sd * sd));
  const col = Math.floor(x / 48);
  const top = 0.6 + 0.3 * hash(col, 7);
  if (v > top) {
    c = [18, 8, 10];
    if (((x % 48) > 10 && (x % 48) < 38) && (y % 40 > 12 && y % 40 < 22) && hash(col, Math.floor(y / 40)) > 0.55) c = [200, 130, 60];
  }
  if (v > 0.92) c = [12, 6, 8];
  return [...c, 255];
}, { rgb: true });

// Dim office: blue-grey dusk light through blinds, a desk line.
const dimOffice = png(W, H, (x, y) => {
  const v = y / H, u = x / W;
  let c = mix([44, 46, 58], [18, 18, 26], smoothstep(0, 1, v));
  const inWindow = u > 0.55 && u < 0.92 && v > 0.12 && v < 0.72;
  if (inWindow) {
    const slat = (y % 28) < 20;
    c = slat ? mix([120, 110, 100], [70, 40, 40], u) : [30, 28, 34];
    c = mix(c, [200, 120, 80], 0.15 * (1 - v));
  }
  const glow = Math.exp(-((u - 0.73) ** 2) * 18 - ((v - 0.45) ** 2) * 6);
  c = mix(c, [110, 80, 70], 0.25 * glow);
  if (v > 0.8) c = mix([24, 20, 20], [14, 12, 12], (v - 0.8) / 0.2);
  if (Math.abs(v - 0.8) < 0.002) c = [60, 52, 48];
  return [...c, 255];
}, { rgb: true });

// Ring motif: thin concentric yellow rings on near-black, red vignette.
const ringMotif = png(W, H, (x, y) => {
  const dx = x - 1250, dy = y - 540;
  const d = Math.sqrt(dx * dx + dy * dy);
  let c = [14, 10, 12];
  const period = 46;
  const ring = Math.floor(d / period);
  const phase = (d % period) / period;
  const thickness = 0.08;
  if (phase < thickness && ring > 1) {
    const fade = Math.exp(-d / 900) * (ring % 3 === 0 ? 1 : 0.45);
    c = mix(c, PAL.eye, fade);
  }
  const vig = Math.min(1, Math.sqrt(((x - 960) / 960) ** 2 + ((y - 540) / 540) ** 2));
  c = mix(c, [60, 14, 18], 0.35 * vig);
  return [...c, 255];
}, { rgb: true });

/** Generic 16-bit mono WAV from a sample function of time (seconds). */
function wavFrom(seconds, sample, sampleRate = 16000) {
  const n = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(clamp16(sample(i / sampleRate) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Low two-tone "attention": A3 then E3, soft attack, slow decay.
const attentionWav = wavFrom(0.9, (t) => {
  const seg = t < 0.42 ? 0 : 1;
  const t0 = seg === 0 ? t : t - 0.42;
  const f = seg === 0 ? 220 : 164.8;
  const env = Math.min(1, t0 / 0.03) * Math.exp(-3.2 * t0);
  return (0.7 * Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(2 * Math.PI * f * 2 * t)) * env * 0.6;
});

// Soft click: a short filtered noise burst with a faint 1.2 kHz tick.
const clickWav = wavFrom(0.08, (t) => {
  const noise = (hash(Math.floor(t * 16000), 3) * 2 - 1) * Math.exp(-90 * t);
  const tick = Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-60 * t);
  return (0.5 * noise + 0.4 * tick) * 0.5;
});

/** Slow ring pulse: 24 frames at 12 fps, encoded to VP9 webm with ffmpeg when available. */
function ringPulseWebm() {
  const frames = 24, size = 256;
  const dir = mkdtempSync(join(tmpdir(), 'rp-ring-'));
  try {
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      const frame = png(size, size, (x, y) => {
        const dx = x - 128, dy = y - 128;
        const d = Math.sqrt(dx * dx + dy * dy);
        let c = [14, 10, 12];
        for (let k = 0; k < 3; k++) {
          const r = ((t + k / 3) % 1) * 120 + 8;
          const a = (1 - ((t + k / 3) % 1)) * Math.exp(-Math.abs(d - r) / 2.5);
          c = mix(c, PAL.eye, a);
        }
        if (d < 6) c = mix(c, PAL.eye, 0.8);
        return [...c, 255];
      }, { rgb: true });
      writeFileSync(join(dir, `${String(i).padStart(2, '0')}.png`), frame);
    }
    const out = join(dir, 'ring-pulse.webm');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12', '-i', join(dir, '%02d.png'),
      '-c:v', 'libvpx-vp9', '-b:v', '120k', '-pix_fmt', 'yuv420p', out]);
    return readFileSyncSafe(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readFileSyncSafe(file) {
  return Buffer.from(readFileSync(file));
}

// ---------- game cards (Makima): 64x64 solid colours with one simple shape each ----------

const CARDS = {
  'red-circle': [[196, 48, 60], (x, y) => (x - 32) ** 2 + (y - 32) ** 2 <= 18 ** 2],
  'blue-square': [[52, 98, 196], (x, y) => Math.abs(x - 32) <= 16 && Math.abs(y - 32) <= 16],
  'green-diamond': [[46, 139, 87], (x, y) => Math.abs(x - 32) + Math.abs(y - 32) <= 20],
  'yellow-triangle': [[232, 197, 71], (x, y) => y >= 16 && y <= 48 && Math.abs(x - 32) <= (y - 16) * 0.6],
  'purple-ring': [[124, 77, 172], (x, y) => { const d = Math.sqrt((x - 32) ** 2 + (y - 32) ** 2); return d >= 11 && d <= 19; }],
  'orange-cross': [[228, 120, 40], (x, y) => Math.abs(x - 32) <= 5 || Math.abs(y - 32) <= 5],
  'teal-bar': [[42, 157, 143], (x, y) => Math.abs(y - 32) <= 7 && Math.abs(x - 32) <= 22],
  'pink-dot': [[214, 96, 150], (x, y) => (x - 32) ** 2 + (y - 32) ** 2 <= 8 ** 2],
};
const cards = Object.fromEntries(
  Object.entries(CARDS).map(([name, [colour, inside]]) => [
    name,
    png(64, 64, (x, y) => {
      const edge = x < 2 || y < 2 || x > 61 || y > 61;
      if (edge) return [30, 30, 34];
      return inside(x, y) ? [245, 245, 245] : colour;
    }, { rgb: true }),
  ]),
);

// ---------- write ----------

const outputs = [
  [join(luna, 'characters', 'luna', 'avatar.png'), avatar],
  [join(luna, 'media', 'images', 'luna-smile.png'), smile],
  [join(luna, 'media', 'images', 'luna-wave.png'), wave],
  [join(luna, 'media', 'audio', 'chime.wav'), chimeWav()],
  [join(makima, 'characters', 'makima', 'avatar.png'), makimaAvatar],
  ...Object.entries(makimaExpressions).map(([name, bytes]) => [join(makima, 'characters', 'makima', 'expressions', `${name}.png`), bytes]),
  [join(makima, 'media', 'images', 'wallpapers', 'red-dusk.png'), redDusk],
  [join(makima, 'media', 'images', 'wallpapers', 'dim-office.png'), dimOffice],
  [join(makima, 'media', 'images', 'wallpapers', 'ring-motif.png'), ringMotif],
  [join(makima, 'media', 'audio', 'attention.wav'), attentionWav],
  [join(makima, 'media', 'audio', 'click.wav'), clickWav],
  ...Object.entries(cards).map(([name, bytes]) => [join(makima, 'media', 'images', 'cards', `${name}.png`), bytes]),
];
try {
  outputs.push([join(makima, 'media', 'video', 'ring-pulse.webm'), ringPulseWebm()]);
} catch (err) {
  console.warn(`skipping ring-pulse.webm (ffmpeg with libvpx-vp9 needed): ${err.message}`);
}
// `--only=<substring>` writes only the outputs whose path contains it (e.g. `--only=cards`).
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
for (const [file, bytes] of outputs) {
  if (only && !file.includes(only)) continue;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`${file} (${bytes.length} bytes)`);
}
