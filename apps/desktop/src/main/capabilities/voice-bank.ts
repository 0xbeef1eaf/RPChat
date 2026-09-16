/**
 * The voice bank: a local mirror of the `kyutai/tts-voices` reference recordings that Pocket TTS
 * clones from, plus one cached sample sentence per voice so the pack editor can audition them.
 *
 * Layout under `<userData>/voice-bank/`:
 *   catalogue.json          the file listing, refetched at most daily
 *   files/<repo path>.wav   downloaded recordings, mirroring the repo's own paths
 *   previews/<model>/<id>.wav  the sample sentence spoken in that voice by that model
 *
 * Downloads run in the background with a small concurrency cap: the catalogue is ~750 clips of
 * roughly 1 MB each, so fetching it all eagerly would be rude. Nothing here blocks `sdk.voice`;
 * the bank is an editor-time convenience, and a character speaks from the wav copied into its own
 * directory rather than from this cache.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AssetInstallStatus, InstalledVoiceModel, SherpaInstallStatus, VoiceBankCatalogue, VoiceBankCollection, VoiceBankEntry, VoiceBankProgress } from '@rp/shared';
import { RpError, VOICE_BANK_COLLECTIONS, VOICE_BANK_REPO, VOICE_PREVIEW_SENTENCE, voiceLabel } from '@rp/shared';
import type { CommandResult } from '../commands.js';
import { spawnCapture } from '../commands.js';
import type { VoiceModel } from './voice-models.js';
import { buildSherpaArgs } from './voice-models.js';

export const VOICE_BANK_DIRNAME = 'voice-bank';
/** Synthetic pack id under which bank previews are served to the renderer. */
export const VOICE_BANK_PACK_ID = 'app.rp-code.voice-bank';
/** How long a fetched catalogue is reused before the repo is listed again. */
export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
/** Parallel downloads. Small on purpose: this is background work behind an editor panel. */
export const DOWNLOAD_CONCURRENCY = 3;
/** Refuse a "wav" that is implausibly large, so a redirect to an HTML error page cannot fill the disk. */
export const MAX_VOICE_BYTES = 12 * 1024 * 1024;
/** Cap for one preview synthesis; the sample sentence is short, so this is generous. */
export const PREVIEW_TIMEOUT_MS = 60_000;

const API_BASE = 'https://huggingface.co/api/models';
const FILE_BASE = 'https://huggingface.co';

interface TreeEntry {
  type: string;
  path: string;
  size?: number;
}

export interface VoiceBankDeps {
  /** `<userData>/voice-bank`. */
  dir: string;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Voice models currently installed, used to pick the one that generates previews. */
  models(): Promise<VoiceModel[]>;
  /** Locates `sherpa-onnx-offline-tts`. */
  findSherpa(): string | undefined;
  /** State of the managed engine install, so a download in progress can be shown as such. */
  engineStatus?(): SherpaInstallStatus;
  /** State of the default voice model download, likewise. */
  modelStatus?(): AssetInstallStatus;
  /** onnxruntime threads for preview synthesis. */
  numThreads(): Promise<number>;
  /** Injectable for tests. */
  spawn?: (file: string, args: string[], opts: { timeoutMs?: number }) => Promise<CommandResult>;
}

/** Split a repo path into its collection id (`cml-tts/fr/x.wav` belongs to `cml-tts`). */
function collectionOf(repoPath: string): string {
  return repoPath.split('/')[0] ?? 'other';
}

/** Stable, filesystem-safe id for one voice, used to name its cached preview. */
export function previewId(repoPath: string, sentence: string): string {
  return createHash('sha1').update(`${repoPath}\u0000${sentence}`).digest('hex').slice(0, 16);
}

/**
 * Turn a raw repo listing into the catalogue the editor renders. Non-wav entries (the safetensors
 * embeddings for TTS 1.6B, the README) are dropped: only Pocket TTS reference audio is useful here.
 */
export function buildCatalogue(entries: TreeEntry[]): { collections: VoiceBankCollection[]; voices: VoiceBankEntry[] } {
  const voices: VoiceBankEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file' || !/\.wav$/i.test(entry.path)) continue;
    voices.push({
      path: entry.path,
      collection: collectionOf(entry.path),
      label: voiceLabel(entry.path),
      bytes: entry.size ?? 0,
      enhanced: /_enhanced\.wav$/i.test(entry.path),
      ready: false,
    });
  }
  voices.sort((a, b) => a.collection.localeCompare(b.collection) || a.label.localeCompare(b.label));
  const counts = new Map<string, number>();
  for (const v of voices) counts.set(v.collection, (counts.get(v.collection) ?? 0) + 1);
  const collections: VoiceBankCollection[] = [...counts.entries()]
    .map(([id, count]) => {
      const known = VOICE_BANK_COLLECTIONS[id];
      return known
        ? { id, count, ...known }
        : { id, count, label: id, license: 'unknown', nonCommercial: true, note: 'Not described in the repository README; check its licence before shipping a pack with it.' };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return { collections, voices };
}

export class VoiceBank {
  private catalogueCache: { at: number; entries: TreeEntry[] } | undefined;
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly queue: string[] = [];
  private active = 0;
  private readonly failures: Array<{ path: string; reason: string }> = [];

  constructor(private readonly deps: VoiceBankDeps) {}

  private get filesDir(): string {
    return path.join(this.deps.dir, 'files');
  }

  private get previewsDir(): string {
    return path.join(this.deps.dir, 'previews');
  }

  /** Absolute path of a downloaded recording (whether or not it exists yet). */
  localPath(repoPath: string): string {
    return path.join(this.filesDir, ...repoPath.split('/'));
  }

  /**
   * The catalogue, with `ready` reflecting what is on disk and `previewUrl` set for voices that
   * already have a cached sample. Re-listing the repo is skipped while the cached listing is fresh.
   */
  async catalogue(opts: { refresh?: boolean } = {}): Promise<VoiceBankCatalogue> {
    const entries = await this.entries(opts.refresh === true);
    const { collections, voices } = buildCatalogue(entries);
    const models = await this.deps.models();
    const previewModel = this.previewModel(models);
    const ready = await this.readySet();
    const previews = previewModel ? await this.previewSet(previewModel.name) : new Set<string>();
    for (const voice of voices) {
      voice.ready = ready.has(voice.path);
      const id = previewId(voice.path, VOICE_PREVIEW_SENTENCE);
      if (previewModel && previews.has(`${id}.wav`)) voice.previewUrl = `${previewModel.name}/${id}.wav`;
    }
    const installed: InstalledVoiceModel[] = models.map((m) => ({ name: m.name, label: m.label, engine: m.engine, clones: m.clones }));
    const catalogue: VoiceBankCatalogue = { repo: VOICE_BANK_REPO, fetchedAt: new Date(this.catalogueCache?.at ?? Date.now()).toISOString(), collections, voices, models: installed };
    const why = this.whyNoPreviews(models);
    if (why) catalogue.previewsUnavailable = why;
    const engine = this.deps.engineStatus?.();
    if (engine) catalogue.engine = engine;
    const model = this.deps.modelStatus?.();
    if (model) catalogue.model = model;
    return catalogue;
  }

  /** The cloning model previews are synthesised with: the first installed one that clones. */
  private previewModel(models: VoiceModel[]): VoiceModel | undefined {
    return models.find((m) => m.clones);
  }

  private whyNoPreviews(models: VoiceModel[]): string | undefined {
    if (!this.previewModel(models)) return describeMissingModel(this.deps.modelStatus?.());
    if (!this.deps.findSherpa()) return describeMissingEngine(this.deps.engineStatus?.());
    return undefined;
  }

  /** The repo file listing, from cache, disk, or the Hugging Face API. */
  private async entries(refresh: boolean): Promise<TreeEntry[]> {
    const now = Date.now();
    if (!refresh && this.catalogueCache && now - this.catalogueCache.at < CATALOGUE_TTL_MS) return this.catalogueCache.entries;
    if (!refresh) {
      const cached = await this.readCatalogueFile();
      if (cached && now - cached.at < CATALOGUE_TTL_MS) {
        this.catalogueCache = cached;
        return cached.entries;
      }
    }
    try {
      const entries = await this.fetchTree();
      this.catalogueCache = { at: now, entries };
      await fs.mkdir(this.deps.dir, { recursive: true });
      await fs.writeFile(path.join(this.deps.dir, 'catalogue.json'), JSON.stringify({ at: now, repo: VOICE_BANK_REPO, entries }), 'utf8');
      return entries;
    } catch (err) {
      // Offline is not fatal: a stale listing still lets the editor show what is already downloaded.
      const cached = this.catalogueCache ?? (await this.readCatalogueFile());
      if (cached) {
        this.deps.logger.warn(`[voice-bank] using the cached catalogue: ${(err as Error).message}`);
        this.catalogueCache = cached;
        return cached.entries;
      }
      throw new RpError('CAPABILITY_FAILED', `Could not list ${VOICE_BANK_REPO}: ${(err as Error).message}`, { repo: VOICE_BANK_REPO });
    }
  }

  private async readCatalogueFile(): Promise<{ at: number; entries: TreeEntry[] } | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.deps.dir, 'catalogue.json'), 'utf8');
      const parsed = JSON.parse(raw) as { at?: number; entries?: TreeEntry[] };
      if (!Array.isArray(parsed.entries)) return undefined;
      return { at: typeof parsed.at === 'number' ? parsed.at : 0, entries: parsed.entries };
    } catch {
      return undefined;
    }
  }

  /** Page through the tree endpoint, following the `Link: …; rel="next"` cursor to the end. */
  private async fetchTree(): Promise<TreeEntry[]> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    let url: string | undefined = `${API_BASE}/${VOICE_BANK_REPO}/tree/main?recursive=true`;
    const all: TreeEntry[] = [];
    // The repo is a few thousand entries; the guard stops a malformed `Link` header looping forever.
    for (let page = 0; url && page < 50; page += 1) {
      const res: Response = await doFetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} listing ${url}`);
      const batch = (await res.json()) as TreeEntry[];
      if (!Array.isArray(batch)) throw new Error('unexpected listing payload');
      all.push(...batch);
      url = nextLink(res.headers.get('link'));
    }
    return all;
  }

  /** Repo paths already downloaded. */
  private async readySet(): Promise<Set<string>> {
    const out = new Set<string>();
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) out.add(rel);
      }
    };
    await walk(this.filesDir, '');
    return out;
  }

  private async previewSet(model: string): Promise<Set<string>> {
    const names = await fs.readdir(path.join(this.previewsDir, model)).catch(() => []);
    return new Set(names);
  }

  /**
   * Download one recording if it is not already present. Concurrent requests for the same path
   * share a single download.
   */
  async ensureVoice(repoPath: string): Promise<string> {
    const target = this.localPath(repoPath);
    if (!isInsideDir(this.filesDir, target)) throw new RpError('PATH_ESCAPE', `Voice path "${repoPath}" escapes the voice bank`, { path: repoPath });
    const stat = await fs.stat(target).catch(() => undefined);
    if (stat?.isFile() && stat.size > 0) return target;
    const existing = this.inFlight.get(repoPath);
    if (existing) return existing;
    const job = this.download(repoPath, target).finally(() => this.inFlight.delete(repoPath));
    this.inFlight.set(repoPath, job);
    return job;
  }

  private async download(repoPath: string, target: string): Promise<string> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const url = `${FILE_BASE}/${VOICE_BANK_REPO}/resolve/main/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
    const res = await doFetch(url, { redirect: 'follow' });
    if (!res.ok) throw new RpError('CAPABILITY_FAILED', `Could not download ${repoPath}: HTTP ${res.status}`, { path: repoPath, status: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_VOICE_BYTES) throw new RpError('CAPABILITY_FAILED', `${repoPath} is ${buf.byteLength} bytes, which is larger than a reference clip should be`, { path: repoPath });
    if (buf.byteLength < 64 || buf.subarray(0, 4).toString('ascii') !== 'RIFF') {
      throw new RpError('CAPABILITY_FAILED', `${repoPath} did not come back as a wav file`, { path: repoPath });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Write beside the target and rename, so an interrupted download never leaves a half wav behind.
    const tmp = `${target}.part`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);
    this.deps.logger.debug?.(`[voice-bank] downloaded ${repoPath} (${buf.byteLength} bytes)`);
    return target;
  }

  /**
   * Queue recordings for download in the background. Returns immediately; progress is readable
   * through `progress()`. Paths already on disk or in flight are skipped.
   */
  prefetch(repoPaths: string[]): void {
    for (const p of repoPaths) if (!this.queue.includes(p) && !this.inFlight.has(p)) this.queue.push(p);
    this.pump();
  }

  private pump(): void {
    while (this.active < DOWNLOAD_CONCURRENCY && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) return;
      this.active += 1;
      void this.ensureVoice(next)
        .catch((err: unknown) => {
          this.failures.push({ path: next, reason: (err as Error).message });
          if (this.failures.length > 20) this.failures.shift();
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  progress(): VoiceBankProgress {
    return { ready: 0, pending: this.queue.length + this.active, failed: [...this.failures] };
  }

  /**
   * The cached sample sentence for one voice, synthesising it first if needed. Returns the path
   * relative to the bank's preview root, which the renderer turns into an `rp-asset://` URL.
   */
  async ensurePreview(repoPath: string): Promise<string> {
    const models = await this.deps.models();
    const model = this.previewModel(models);
    const why = this.whyNoPreviews(models);
    if (!model || why) throw new RpError('CAPABILITY_FAILED', why ?? 'Previews are unavailable', { path: repoPath });
    const binary = this.deps.findSherpa();
    if (!binary) throw new RpError('CAPABILITY_FAILED', 'sherpa-onnx-offline-tts was not found', { path: repoPath });

    const id = previewId(repoPath, VOICE_PREVIEW_SENTENCE);
    const rel = `${model.name}/${id}.wav`;
    const out = path.join(this.previewsDir, model.name, `${id}.wav`);
    const stat = await fs.stat(out).catch(() => undefined);
    if (stat?.isFile() && stat.size > 0) return rel;

    const reference = await this.ensureVoice(repoPath);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const args = buildSherpaArgs(model, {
      text: VOICE_PREVIEW_SENTENCE,
      outFile: out,
      reference,
      numThreads: await this.deps.numThreads(),
    });
    const spawnFn = this.deps.spawn ?? ((f, a, o) => spawnCapture(f, a, o));
    const result = await spawnFn(binary, args, { timeoutMs: PREVIEW_TIMEOUT_MS });
    if (result.code !== 0) {
      await fs.rm(out, { force: true }).catch(() => undefined);
      throw new RpError(
        'CAPABILITY_FAILED',
        `Could not generate a sample for ${repoPath}: ${(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 300)}`,
        { path: repoPath, model: model.name },
      );
    }
    return rel;
  }

  /** Root served as `VOICE_BANK_PACK_ID` over `rp-asset://`, so previews can be played in the editor. */
  previewRoot(): string {
    return this.previewsDir;
  }
}

/**
 * Why there is no voice model yet. Like the engine, the default model is fetched on first start, so
 * the common case is "still downloading" rather than anything the author has to go and fix.
 */
export function describeMissingModel(status: AssetInstallStatus | undefined): string {
  switch (status?.state) {
    case 'downloading': {
      const pct = status.total ? Math.floor(((status.received ?? 0) / status.total) * 100) : 0;
      return `Downloading the Pocket TTS voice model (${pct}%). Samples will work once it finishes.`;
    }
    case 'extracting':
      return 'Unpacking the Pocket TTS voice model. Samples will work once it finishes.';
    case 'failed':
      return `The Pocket TTS voice model could not be downloaded (${status.error ?? 'unknown error'}); unpack one under the voices folder yourself.`;
    case 'disabled':
      return 'The automatic model download is switched off; turn it on in Settings, or unpack a Pocket TTS model under the voices folder.';
    default:
      return 'No cloning voice model is installed; unpack a Pocket TTS model under the voices folder to hear these voices.';
  }
}

/**
 * Why the engine is not usable, in terms of what is actually happening. A download in progress is
 * the common case on first run and should read as "wait", not as "you did something wrong".
 */
export function describeMissingEngine(status: SherpaInstallStatus | undefined): string {
  switch (status?.state) {
    case 'downloading': {
      const pct = status.total ? Math.floor(((status.received ?? 0) / status.total) * 100) : 0;
      return `Downloading the speech engine (${pct}%). Samples will work once it finishes.`;
    }
    case 'extracting':
      return 'Unpacking the speech engine. Samples will work once it finishes.';
    case 'failed':
      return `The speech engine could not be downloaded (${status.error ?? 'unknown error'}); install sherpa-onnx-offline-tts yourself, or set RP_SHERPA_TTS.`;
    case 'unsupported':
      return `No prebuilt speech engine is published for this platform; install sherpa-onnx-offline-tts yourself, or set RP_SHERPA_TTS.`;
    case 'disabled':
      return 'The automatic engine download is switched off; turn it on in Settings, install sherpa-onnx-offline-tts yourself, or set RP_SHERPA_TTS.';
    default:
      return 'sherpa-onnx-offline-tts was not found, so samples cannot be generated.';
  }
}

/** The `rel="next"` URL of an RFC 5988 `Link` header, if it has one. */
export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}
