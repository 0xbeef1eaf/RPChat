import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../commands.js';
import {
  VIDEO_CACHE_PACK_ID,
  VideoCompat,
  cacheNameFor,
  conversionPlan,
  convertArgs,
  parseProbe,
  pruneList,
} from './video-compat.js';

const probeJson = (streams: Array<{ codec_type: string; codec_name: string; disposition?: { attached_pic: number } }>, duration = '12.5'): string =>
  JSON.stringify({ streams, format: { duration } });

const H264_AAC = probeJson([
  { codec_type: 'video', codec_name: 'h264' },
  { codec_type: 'audio', codec_name: 'aac' },
]);
const HEVC_AAC = probeJson([
  { codec_type: 'video', codec_name: 'hevc' },
  { codec_type: 'audio', codec_name: 'aac' },
]);
const PRORES_PCM = probeJson([
  { codec_type: 'video', codec_name: 'prores' },
  { codec_type: 'audio', codec_name: 'pcm_s24le' },
]);

describe('parseProbe', () => {
  it('takes the first stream of each type and the duration', () => {
    const probe = parseProbe(
      probeJson([
        { codec_type: 'video', codec_name: 'HEVC' },
        { codec_type: 'video', codec_name: 'mjpeg' },
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'audio', codec_name: 'ac3' },
      ]),
      'MOV',
    );
    expect(probe).toEqual({ container: 'mov', video: 'hevc', audio: 'aac', durationSec: 12.5 });
  });

  it('looks past cover art, which travels as a video stream', () => {
    const probe = parseProbe(
      probeJson([
        { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        { codec_type: 'video', codec_name: 'hevc', disposition: { attached_pic: 0 } },
        { codec_type: 'audio', codec_name: 'aac', disposition: { attached_pic: 0 } },
      ]),
      'mov',
    );
    expect(probe).toMatchObject({ video: 'hevc', audio: 'aac' });
  });

  it('leaves a silent file without an audio codec and survives junk', () => {
    expect(parseProbe(probeJson([{ codec_type: 'video', codec_name: 'prores' }], 'N/A'), 'mov')).toEqual({ container: 'mov', video: 'prores' });
    expect(parseProbe('not json', 'mov')).toBeUndefined();
    expect(parseProbe('{}', 'mov')).toBeUndefined();
  });
});

describe('conversionPlan', () => {
  it('leaves a QuickTime file Chromium can already decode alone', () => {
    expect(conversionPlan({ container: 'mov', video: 'h264', audio: 'aac' }, 'linux')).toBeUndefined();
    expect(conversionPlan({ container: 'mov', video: 'h264', audio: 'pcm_s16le' }, 'linux')).toBeUndefined();
    expect(conversionPlan({ container: 'mp4', video: 'av1' }, 'linux')).toBeUndefined();
  });

  it('re-encodes an HEVC QuickTime everywhere but macOS, which decodes it through the system', () => {
    expect(conversionPlan({ container: 'mov', video: 'hevc', audio: 'aac' }, 'linux')).toEqual({ video: 'encode', audio: 'copy' });
    expect(conversionPlan({ container: 'mov', video: 'hevc', audio: 'aac' }, 'win32')).toEqual({ video: 'encode', audio: 'copy' });
    expect(conversionPlan({ container: 'mov', video: 'hevc', audio: 'aac' }, 'darwin')).toBeUndefined();
  });

  it('leaves a file with no picture to the page: there is nothing to convert for', () => {
    expect(conversionPlan({ container: 'mov', audio: 'alac' }, 'linux')).toBeUndefined();
  });

  it('re-encodes ProRes and its uncommon sound, and drops the map for a silent file', () => {
    expect(conversionPlan({ container: 'mov', video: 'prores', audio: 'pcm_s24le' }, 'linux')).toEqual({ video: 'encode', audio: 'encode' });
    expect(conversionPlan({ container: 'mov', video: 'prores' }, 'linux')).toEqual({ video: 'encode', audio: 'none' });
  });

  it('re-encodes only the sound when only the sound is the problem', () => {
    // Matroska itself the page opens; AC-3 inside it, it does not.
    expect(conversionPlan({ container: 'mkv', video: 'h264', audio: 'aac' }, 'linux')).toBeUndefined();
    expect(conversionPlan({ container: 'mkv', video: 'h264', audio: 'ac3' }, 'linux')).toEqual({ video: 'copy', audio: 'encode' });
    expect(conversionPlan({ container: 'mov', video: 'h264', audio: 'alac' }, 'linux')).toEqual({ video: 'copy', audio: 'encode' });
  });
});

describe('convertArgs', () => {
  it('copies what it can and always writes a faststart mp4, named as the format it is', () => {
    expect(convertArgs('/a/in.mkv', '/c/out.part', { video: 'copy', audio: 'encode' })).toEqual([
      ...['-v', 'error', '-y', '-i', '/a/in.mkv', '-map', '0:V:0', '-map', '0:a:0'],
      ...['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', '/c/out.part'],
    ]);
  });

  it('re-encodes an HEVC picture to 8-bit H.264 and a silent file stays silent', () => {
    expect(convertArgs('/a/in.mov', '/c/out.mp4', { video: 'encode', audio: 'none' })).toEqual([
      ...['-v', 'error', '-y', '-i', '/a/in.mov', '-map', '0:V:0', '-an'],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'],
      ...['-movflags', '+faststart', '-f', 'mp4', '/c/out.mp4'],
    ]);
  });
});

describe('cacheNameFor', () => {
  it('changes when the file is edited in place', () => {
    const a = cacheNameFor('/p/v.mov', 100, 1_000);
    expect(a).toMatch(/^[0-9a-f]{32}\.mp4$/);
    expect(cacheNameFor('/p/v.mov', 100, 1_000)).toBe(a);
    expect(cacheNameFor('/p/v.mov', 101, 1_000)).not.toBe(a);
    expect(cacheNameFor('/p/v.mov', 100, 2_000)).not.toBe(a);
    expect(cacheNameFor('/p/other.mov', 100, 1_000)).not.toBe(a);
  });
});

describe('pruneList', () => {
  const entries = [
    { name: 'old.mp4', bytes: 40, mtimeMs: 1 },
    { name: 'mid.mp4', bytes: 40, mtimeMs: 2 },
    { name: 'new.mp4', bytes: 40, mtimeMs: 3 },
  ];
  it('keeps everything while the cache fits', () => {
    expect(pruneList(entries, 120)).toEqual([]);
  });
  it('drops the oldest until it does', () => {
    expect(pruneList(entries, 80)).toEqual(['old.mp4']);
    expect(pruneList(entries, 39)).toEqual(['old.mp4', 'mid.mp4', 'new.mp4']);
  });
});

/** A `VideoCompat` over a temp cache dir with scripted `ffprobe`/`ffmpeg` runs. */
function make(opts: { probe?: string; probeCode?: number; convertCode?: number; tools?: boolean; platform?: NodeJS.Platform } = {}) {
  const runs: Array<{ file: string; args: string[] }> = [];
  const warnings: string[] = [];
  const compat = new VideoCompat({
    cacheDir,
    logger: { debug: () => undefined, info: () => undefined, warn: (m: unknown) => warnings.push(String(m)) },
    has: () => opts.tools !== false,
    platform: opts.platform ?? 'linux',
    spawn: async (file, args): Promise<CommandResult> => {
      runs.push({ file, args });
      if (file === 'ffprobe') return { code: opts.probeCode ?? 0, stdout: opts.probe ?? H264_AAC, stderr: '' };
      // The scripted ffmpeg writes the output file itself, as the real one would.
      const dest = args[args.length - 1] as string;
      if ((opts.convertCode ?? 0) === 0) fs.writeFileSync(dest, 'converted');
      return { code: opts.convertCode ?? 0, stdout: '', stderr: opts.convertCode ? 'broken' : '' };
    },
  });
  return { compat, runs, warnings };
}

let dir: string;
let cacheDir: string;
const source = (name: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'source bytes');
  return file;
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-video-compat-'));
  cacheDir = path.join(dir, 'cache');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('VideoCompat.playable', () => {
  it('plays a file Chromium handles where it lies, without running ffmpeg', async () => {
    const { compat, runs } = make();
    expect(await compat.playable(source('fine.mov'))).toBeUndefined();
    expect(runs.map((r) => r.file)).toEqual(['ffprobe']);
  });

  it('does not even probe a webm', async () => {
    const { compat, runs } = make();
    expect(await compat.playable(source('clip.webm'))).toBeUndefined();
    expect(runs).toEqual([]);
  });

  it('converts an HEVC QuickTime and serves the copy under the cache pack id', async () => {
    const { compat, runs } = make({ probe: HEVC_AAC });
    const file = source('phone.mov');
    const playable = await compat.playable(file);
    expect(playable).toBeDefined();
    expect(path.dirname(playable!.file)).toBe(cacheDir);
    expect(playable!.url).toBe(`rp-asset://${VIDEO_CACHE_PACK_ID}/${path.basename(playable!.file)}`);
    expect(fs.readFileSync(playable!.file, 'utf8')).toBe('converted');
    expect(runs.map((r) => r.file)).toEqual(['ffprobe', 'ffmpeg']);
    // The picture is re-encoded, the sound copied, and nothing is left half-written.
    expect(runs[1]?.args).toContain('libx264');
    expect(fs.readdirSync(cacheDir).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('converts each source once, then answers from the cache', async () => {
    const { compat, runs } = make({ probe: PRORES_PCM });
    const file = source('export.mov');
    const first = await compat.playable(file);
    const again = await compat.playable(file);
    expect(again).toEqual(first);
    expect(runs.map((r) => r.file)).toEqual(['ffprobe', 'ffmpeg']);
    // A second instance (a later run of the app) finds the same entry on disk and skips the probe.
    const fresh = make({ probe: PRORES_PCM });
    expect(await fresh.compat.playable(file)).toEqual(first);
    expect(fresh.runs).toEqual([]);
  });

  it('shares one conversion between callers racing for the same file', async () => {
    const { compat, runs } = make({ probe: HEVC_AAC });
    const file = source('shared.mov');
    const [a, b] = await Promise.all([compat.playable(file), compat.playable(file)]);
    expect(a).toEqual(b);
    expect(runs.filter((r) => r.file === 'ffmpeg')).toHaveLength(1);
  });

  it('re-converts a video that was replaced in place', async () => {
    const { compat, runs } = make({ probe: HEVC_AAC });
    const file = source('changing.mov');
    const first = await compat.playable(file);
    fs.writeFileSync(file, 'different bytes entirely');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const second = await compat.playable(file);
    expect(second!.file).not.toBe(first!.file);
    expect(runs.filter((r) => r.file === 'ffmpeg')).toHaveLength(2);
  });

  it('falls back to the original when the conversion fails, leaving no half-written file', async () => {
    const { compat, warnings } = make({ probe: HEVC_AAC, convertCode: 1 });
    expect(await compat.playable(source('bad.mov'))).toBeUndefined();
    expect(warnings.join(' ')).toContain('bad.mov');
    expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).toEqual([]);
  });

  it('falls back to the original when ffprobe cannot read the file', async () => {
    const { compat, warnings } = make({ probeCode: 1, probe: '' });
    expect(await compat.playable(source('weird.mov'))).toBeUndefined();
    expect(warnings.join(' ')).toContain('ffprobe failed');
  });

  it('does nothing at all without ffmpeg installed', async () => {
    const { compat, runs } = make({ probe: HEVC_AAC, tools: false });
    expect(await compat.playable(source('phone.mov'))).toBeUndefined();
    expect(runs).toEqual([]);
  });

  it('leaves a missing file to the caller', async () => {
    const { compat, runs } = make();
    expect(await compat.playable(path.join(dir, 'nope.mov'))).toBeUndefined();
    expect(runs).toEqual([]);
  });

  it('plays an HEVC QuickTime untouched on macOS', async () => {
    const { compat, runs } = make({ probe: HEVC_AAC, platform: 'darwin' });
    expect(await compat.playable(source('phone.mov'))).toBeUndefined();
    expect(runs.map((r) => r.file)).toEqual(['ffprobe']);
  });
});
