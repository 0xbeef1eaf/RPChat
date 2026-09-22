/**
 * Videos the media pages cannot decode, made playable.
 *
 * The pack format accepts `mp4 webm mkv mov m4v` (docs/spec/pack.md), but the pages that play them
 * are Chromium, which decodes a narrower set than those containers can hold: H.264, VP8, VP9 and
 * AV1, with AAC, MP3, Opus, Vorbis, FLAC or plain PCM sound. QuickTime is where that bites, because
 * `.mov` is the one extension people reach for whatever is inside it — a phone records HEVC, an
 * editor exports ProRes, and both open as a dead black window with only a decode error in the log.
 *
 * So before a video item opens, the file is probed and, when Chromium would refuse it, converted
 * once into an MP4 next to the other app-generated assets (`<userData>/video-cache`, served under
 * `VIDEO_CACHE_PACK_ID`). Streams that are already fine are copied rather than re-encoded, so a
 * ProRes clip with ordinary AAC sound keeps its sound untouched and only the picture goes through
 * H.264; a file whose picture is fine and whose sound is not (AC-3, ALAC, 24-bit PCM) is a remux of
 * a few hundred milliseconds. The result is keyed by the source's path, size and mtime, so a pack's
 * video is converted once and every later play starts from the cache.
 *
 * `ffmpeg`/`ffprobe` do the work — the same system tools `sdk.webcam` records with. Without them
 * nothing is converted and the file is handed to the page as before (it fails there, with a line in
 * the log saying why), because a missing converter must not stop the videos that play perfectly
 * well from playing.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assetUrl } from '@rp/shared';
import { extensionOf } from '@rp/pack';
import type { CommandResult } from '../commands.js';
import { hasExecutable, spawnCapture } from '../commands.js';

/** Synthetic pack id under which converted videos are served to the media pages. */
export const VIDEO_CACHE_PACK_ID = 'app.rpchat.video';
/** Directory under `<userData>` holding them. */
export const VIDEO_CACHE_DIRNAME = 'video-cache';
/** How much converted video is kept; the oldest go first once a new one pushes the total over. */
export const VIDEO_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** Probing is cheap but not free, and a source this large is not worth re-encoding on a whim. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;
/** A long film re-encodes for minutes; beyond this the conversion is abandoned. */
export const CONVERT_TIMEOUT_MS = 15 * 60_000;
export const PROBE_TIMEOUT_MS = 20_000;

/** Containers the pages open (verified against Electron's Chromium, which demuxes Matroska too). */
export const PLAYABLE_CONTAINERS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
/** Picture codecs Chromium decodes everywhere. */
export const PLAYABLE_VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'vp8', 'vp9', 'av1']);
/** Sound codecs Chromium decodes. PCM only in the flavours it actually handles. */
export const PLAYABLE_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_u8']);

/** What a file holds, as far as the decision below cares: the container is the extension. */
export interface VideoProbe {
  container: string;
  /** First video stream's codec; absent for a file with no picture. */
  video?: string;
  /** First audio stream's codec; absent for a silent file. */
  audio?: string;
  durationSec?: number;
}

/** How to get a playable copy: what to do with each stream. `copy` remuxes, `encode` re-encodes. */
export interface ConversionPlan {
  video: 'copy' | 'encode';
  audio: 'copy' | 'encode' | 'none';
}

/**
 * `ffprobe`'s JSON (see `probeArgs`) → a probe. The first real stream of each type decides: an
 * attached picture (cover art travels as a video stream) is not what the page would be showing.
 */
export function parseProbe(stdout: string, container: string): VideoProbe | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const streams = (parsed as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return undefined;
  const codecOf = (type: string): string | undefined => {
    for (const s of streams) {
      const stream = s as { codec_type?: unknown; codec_name?: unknown; disposition?: { attached_pic?: unknown } };
      if (stream.codec_type !== type || typeof stream.codec_name !== 'string') continue;
      if (stream.disposition?.attached_pic === 1) continue;
      return stream.codec_name.toLowerCase();
    }
    return undefined;
  };
  const probe: VideoProbe = { container: container.toLowerCase() };
  const video = codecOf('video');
  const audio = codecOf('audio');
  if (video !== undefined) probe.video = video;
  if (audio !== undefined) probe.audio = audio;
  const duration = Number((parsed as { format?: { duration?: unknown } }).format?.duration);
  if (Number.isFinite(duration) && duration > 0) probe.durationSec = duration;
  return probe;
}

/**
 * The plan for a probed file, or `undefined` when the page can play it as it is.
 *
 * HEVC is the one platform-dependent case: macOS decodes it through the system, so a `.mov` off an
 * iPhone plays there untouched, while everywhere else it has to be re-encoded (Linux needs a VA-API
 * driver Chromium rarely gets, and on Windows the HEVC extension is a separate, paid install).
 */
export function conversionPlan(probe: VideoProbe, platform: NodeJS.Platform = process.platform): ConversionPlan | undefined {
  // Nothing to show: a file with no picture is left to the page, which plays its sound or reports
  // the error. Converting it would only produce an MP4 with no video stream to map.
  if (probe.video === undefined) return undefined;
  const videoOk = PLAYABLE_VIDEO_CODECS.has(probe.video) || (probe.video === 'hevc' && platform === 'darwin');
  const audioOk = probe.audio === undefined || PLAYABLE_AUDIO_CODECS.has(probe.audio);
  if (videoOk && audioOk && PLAYABLE_CONTAINERS.has(probe.container)) return undefined;
  return { video: videoOk ? 'copy' : 'encode', audio: probe.audio === undefined ? 'none' : audioOk ? 'copy' : 'encode' };
}

export function probeArgs(file: string): string[] {
  const entries = 'stream=codec_type,codec_name:stream_disposition=attached_pic:format=duration';
  return ['-v', 'error', '-print_format', 'json', '-show_entries', entries, '-i', file];
}

/**
 * The conversion itself: one video and at most one audio stream into a faststart MP4, so the page
 * can start playing before the whole file has been read.
 */
export function convertArgs(source: string, dest: string, plan: ConversionPlan): string[] {
  // `0:V:0`: the first *real* video stream, never a piece of cover art.
  const args = ['-v', 'error', '-y', '-i', source, '-map', '0:V:0'];
  args.push(...(plan.audio === 'none' ? ['-an'] : ['-map', '0:a:0']));
  args.push(...(plan.video === 'copy' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']));
  if (plan.audio === 'copy') args.push('-c:a', 'copy');
  else if (plan.audio === 'encode') args.push('-c:a', 'aac', '-b:a', '192k');
  // `-f mp4` explicitly: the file is written under a `.part` name, and ffmpeg picks the format from
  // the extension unless told.
  args.push('-movflags', '+faststart', '-f', 'mp4', dest);
  return args;
}

/**
 * Cache file name for a source. Path, size and mtime together: editing a video in place must not
 * keep serving the copy made from what it used to be.
 */
export function cacheNameFor(file: string, size: number, mtimeMs: number): string {
  const digest = createHash('sha256').update(`${path.resolve(file)}\0${size}\0${Math.round(mtimeMs)}`).digest('hex');
  return `${digest.slice(0, 32)}.mp4`;
}

export interface CacheEntry {
  name: string;
  bytes: number;
  mtimeMs: number;
}

/** Names to delete so the cache fits `capBytes` again: oldest first, newest kept. */
export function pruneList(entries: readonly CacheEntry[], capBytes: number): string[] {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= capBytes) return [];
  const oldestFirst = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
  const doomed: string[] = [];
  for (const entry of oldestFirst) {
    if (total <= capBytes) break;
    doomed.push(entry.name);
    total -= entry.bytes;
  }
  return doomed;
}

export interface VideoCompatDeps {
  /** `<userData>/video-cache`, registered as the root of `VIDEO_CACHE_PACK_ID`. */
  cacheDir: string;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  /** Injectable for tests; defaults to the real `ffprobe`/`ffmpeg` on PATH. */
  spawn?: (file: string, args: string[], opts: { timeoutMs?: number }) => Promise<CommandResult>;
  /** Injectable for tests; answers whether a tool is installed. */
  has?: (name: string) => boolean;
  platform?: NodeJS.Platform;
}

/** A playable stand-in for a file, as the media pages need it. */
export interface PlayableVideo {
  file: string;
  url: string;
}

/**
 * Decides per file whether Chromium can play it and converts the ones it cannot. One instance per
 * app: it remembers what it has already probed (a pack's video is played over and over) and makes
 * sure two characters playing the same file at once share one conversion rather than racing over
 * the same cache entry.
 */
export class VideoCompat {
  /** Source cache key → the answer for it, so a file is probed once per run. */
  private readonly known = new Map<string, PlayableVideo | undefined>();
  /** Conversions in flight, by cache name. */
  private readonly running = new Map<string, Promise<PlayableVideo | undefined>>();
  private warnedMissingTools = false;

  constructor(private readonly deps: VideoCompatDeps) {}

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private run(file: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return (this.deps.spawn ?? spawnCapture)(file, args, { timeoutMs });
  }

  private tool(name: string): boolean {
    return (this.deps.has ?? ((n: string) => hasExecutable(n)))(name);
  }

  /**
   * A file the media page can play instead of `file`, or `undefined` to use the original — which
   * is the answer for everything that already plays, and for everything that cannot be converted
   * (no ffmpeg, a source too large, a conversion that failed).
   */
  async playable(file: string): Promise<PlayableVideo | undefined> {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return undefined; // a missing file is the caller's error to report, not ours
    }
    const name = cacheNameFor(file, stat.size, stat.mtimeMs);
    if (this.known.has(name)) return this.known.get(name);
    const running = this.running.get(name);
    if (running) return running;
    const work = this.resolve(file, stat.size, name).finally(() => this.running.delete(name));
    this.running.set(name, work);
    const result = await work;
    this.known.set(name, result);
    return result;
  }

  private async resolve(file: string, size: number, name: string): Promise<PlayableVideo | undefined> {
    const cached = path.join(this.deps.cacheDir, name);
    if (await touch(cached)) return { file: cached, url: assetUrl(VIDEO_CACHE_PACK_ID, name) };
    const container = extensionOf(file);
    // WebM can only hold codecs the page decodes, so there is nothing to ask ffprobe about.
    if (container === 'webm') return undefined;
    if (!this.tool('ffprobe') || !this.tool('ffmpeg')) {
      if (!this.warnedMissingTools) {
        this.warnedMissingTools = true;
        this.deps.logger.info('[media] ffmpeg/ffprobe not found: videos in a format the page cannot decode (HEVC, ProRes, …) will not play');
      }
      return undefined;
    }
    const probed = await this.probe(file, container);
    if (!probed) return undefined;
    const plan = conversionPlan(probed, this.platform);
    if (!plan) return undefined;
    if (size > MAX_SOURCE_BYTES) {
      this.deps.logger.warn(`[media] ${path.basename(file)} needs converting (${describe(probed)}) but is ${Math.round(size / 1e9)} GB; playing it unconverted`);
      return undefined;
    }
    return this.convert(file, cached, plan, probed);
  }

  private async probe(file: string, container: string): Promise<VideoProbe | undefined> {
    try {
      const result = await this.run('ffprobe', probeArgs(file), PROBE_TIMEOUT_MS);
      if (result.code !== 0) {
        this.deps.logger.warn(`[media] ffprobe failed on ${path.basename(file)}: ${result.stderr.trim() || `exit ${result.code}`}`);
        return undefined;
      }
      return parseProbe(result.stdout, container);
    } catch (err) {
      this.deps.logger.warn(`[media] ffprobe could not run: ${String(err)}`);
      return undefined;
    }
  }

  private async convert(file: string, dest: string, plan: ConversionPlan, probed: VideoProbe): Promise<PlayableVideo | undefined> {
    const partial = `${dest}.part`;
    const started = Date.now();
    const work = plan.video === 'copy' ? 'remuxing' : 're-encoding';
    this.deps.logger.info(`[media] ${work} ${path.basename(file)} (${describe(probed)}) so it can play`);
    try {
      await fs.mkdir(this.deps.cacheDir, { recursive: true });
      await fs.rm(partial, { force: true });
      const result = await this.run('ffmpeg', convertArgs(file, partial, plan), CONVERT_TIMEOUT_MS);
      if (result.code !== 0) {
        await fs.rm(partial, { force: true });
        this.deps.logger.warn(`[media] converting ${path.basename(file)} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
        return undefined;
      }
      await fs.rename(partial, dest);
    } catch (err) {
      await fs.rm(partial, { force: true }).catch(() => undefined);
      this.deps.logger.warn(`[media] converting ${path.basename(file)} failed: ${String(err)}`);
      return undefined;
    }
    this.deps.logger.info(`[media] converted ${path.basename(file)} in ${Math.round((Date.now() - started) / 100) / 10}s`);
    await this.prune(path.basename(dest));
    return { file: dest, url: assetUrl(VIDEO_CACHE_PACK_ID, path.basename(dest)) };
  }

  /**
   * Keep the cache under its cap, oldest conversions first. `keep` is the conversion that has just
   * finished: it is about to be played, so it stays even if it alone is over the cap. Failures here
   * only cost disk.
   */
  private async prune(keep: string): Promise<void> {
    try {
      const names = await fs.readdir(this.deps.cacheDir);
      const entries: CacheEntry[] = [];
      for (const name of names) {
        if (!name.endsWith('.mp4') || name === keep) continue;
        const stat = await fs.stat(path.join(this.deps.cacheDir, name)).catch(() => undefined);
        if (stat?.isFile()) entries.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
      for (const name of pruneList(entries, VIDEO_CACHE_MAX_BYTES)) {
        await fs.rm(path.join(this.deps.cacheDir, name), { force: true });
        this.known.delete(name);
      }
    } catch (err) {
      this.deps.logger.debug(`[media] pruning the video cache failed: ${String(err)}`);
    }
  }
}

function describe(probe: VideoProbe): string {
  return [probe.container, probe.video, probe.audio].filter(Boolean).join('/');
}

/** Marks a cache hit as recently used (so pruning takes the truly cold ones) and reports whether it exists. */
async function touch(file: string): Promise<boolean> {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  const now = new Date();
  await fs.utimes(file, now, now).catch(() => undefined);
  return true;
}
