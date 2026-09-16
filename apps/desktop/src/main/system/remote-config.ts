/**
 * The app's half of remote configuration (docs/spec/system.md "Remote configuration").
 *
 * The daemon owns the decision — whether a document may become this machine's policy — but it has
 * no network stack, so the app does the fetching and hands over the bytes. That split is
 * deliberate: it keeps TLS, proxies and the user's network out of a root daemon, and it means a
 * patched or replaced app still cannot loosen a sealed machine, because it cannot produce a
 * signature the daemon will accept.
 *
 * The same policy also names the **packs** this machine is meant to have. They are downloaded
 * here, checked against the checksum the policy pins, and installed through the ordinary pack
 * installer — so a managed machine arrives with its characters already there and keeps them.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { InstalledPackView, PackSource, RemoteConfigStatus, RemotePackStatus } from '@rp/shared';
import { PACK_FILE_EXTENSION, RpError } from '@rp/shared';
import type { DaemonClient } from './daemon-client.js';
import type { PolicyWatcher } from './policy.js';

/** How long after start the first fetch happens, so it never competes with the app coming up. */
export const FIRST_CHECK_DELAY_MS = 20_000;
/** Cap for one policy document (the daemon refuses more than 1 MiB anyway). */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** Cap for one pack download. Packs carry video and audio, so this is generous on purpose. */
export const MAX_PACK_BYTES = 512 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
export const PACK_TIMEOUT_MS = 30 * 60_000;

/** The pack operations this service needs, which is the engine's `packs` facade. */
export interface RemotePackTarget {
  install(sourcePath: string): Promise<InstalledPackView>;
  uninstall(packId: string): Promise<void>;
  /** Installed packs as `{ id, version }`, so a pinned version can be compared. */
  installed(): Promise<{ id: string; version: string }[]>;
}

export interface RemoteConfigDeps {
  daemon: Pick<DaemonClient, 'remoteApply' | 'verifyPack'>;
  policy: PolicyWatcher;
  packs: RemotePackTarget;
  logger: Pick<Console, 'info' | 'warn' | 'debug' | 'error'>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Where downloads are staged. Default `<tmpdir>/rp-remote-packs`. */
  downloadDir?: string;
  now?: () => Date;
  /** Called after a document changed the policy, so the app can re-read settings. */
  onPolicyChanged?: () => void | Promise<void>;
}

/** Pure: whether a pinned pack needs downloading given what is installed. */
export function packNeedsInstall(source: PackSource, installed: { id: string; version: string } | undefined): boolean {
  if (!installed) return true;
  // A pinned version is the contract: anything else installed under that id is replaced.
  if (source.version !== undefined) return installed.version !== source.version;
  // Without a pinned version the download decides, and it is only fetched once — re-downloading
  // a few hundred megabytes on every tick to find out nothing changed would be worse than
  // trusting the id.
  return false;
}

/** Pure: the packs to uninstall when the policy says `removeUnlisted`. */
export function packsToRemove(sources: PackSource[], installed: { id: string; version: string }[]): string[] {
  const listed = new Set(sources.map((s) => s.id));
  return installed.map((p) => p.id).filter((id) => !listed.has(id));
}

/** Pure: milliseconds until the next check, from the policy's interval and the last attempt. */
export function nextCheckDelayMs(intervalMinutes: number, lastCheckedAt: string | undefined, now: Date): number {
  const interval = Math.max(5, intervalMinutes) * 60_000;
  if (!lastCheckedAt) return FIRST_CHECK_DELAY_MS;
  const elapsed = now.getTime() - new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(elapsed)) return interval;
  return Math.max(FIRST_CHECK_DELAY_MS, interval - elapsed);
}

export class RemoteConfigService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private lastCheckedAt: string | undefined;
  private lastAppliedAt: string | undefined;
  private lastError: string | undefined;
  private seq = 0;
  private readonly packStatus = new Map<string, RemotePackStatus>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly deps: RemoteConfigDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  private get downloadDir(): string {
    return this.deps.downloadDir ?? path.join(os.tmpdir(), 'rp-remote-packs');
  }

  /** Begin checking. Safe to call when no policy names a source: the first tick finds that out. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.schedule(FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check().catch((err) => this.deps.logger.warn('[remote] check failed', err));
    }, delayMs);
    this.timer.unref?.();
  }

  async status(): Promise<RemoteConfigStatus> {
    const state = await this.deps.policy.current();
    const remote = state.policy?.remote;
    const out: RemoteConfigStatus = {
      active: remote !== undefined && remote.enabled !== false,
      intervalMinutes: remote?.intervalMinutes ?? 60,
      seq: this.seq,
      packs: [...this.packStatus.values()],
      busy: this.running,
    };
    if (remote?.url) out.url = remote.url;
    if (this.lastCheckedAt) out.lastCheckedAt = this.lastCheckedAt;
    if (this.lastAppliedAt) out.lastAppliedAt = this.lastAppliedAt;
    if (this.lastError) out.lastError = this.lastError;
    return out;
  }

  /**
   * Fetch the configured document, hand it to the daemon and bring the pinned packs into line.
   * Reschedules itself from the policy's interval whatever the outcome — a machine that cannot
   * reach its management server must keep trying, not give up on the first bad hotel wifi.
   */
  async check(): Promise<RemoteConfigStatus> {
    if (this.running) return this.status();
    this.running = true;
    try {
      const state = await this.deps.policy.current();
      const remote = state.policy?.remote;
      if (!remote || remote.enabled === false) {
        this.deps.logger.debug('[remote] no remote configuration for this machine');
        // Packs can be pinned by a purely local policy too, so that half still runs.
        await this.syncPacks();
        return this.status();
      }
      this.lastCheckedAt = this.now().toISOString();
      try {
        const document = await this.fetchDocument(remote.url);
        const applied = await this.deps.daemon.remoteApply(document);
        this.seq = applied.seq;
        this.lastAppliedAt = this.now().toISOString();
        this.lastError = undefined;
        if (applied.changed) {
          this.deps.policy.invalidate();
          this.deps.logger.info(
            `[remote] ${applied.applied} link(s) applied from ${remote.url}, now at ${applied.seq}${applied.unsealed ? ' — the chain unsealed this machine' : ''}`,
          );
          await this.deps.onPolicyChanged?.();
        } else {
          this.deps.logger.debug(`[remote] ${remote.url} is at link ${applied.seq}, which this machine already has`);
        }
      } catch (err) {
        this.lastError = (err as Error).message;
        this.deps.logger.warn(`[remote] ${remote.url}: ${this.lastError}`);
      }
      await this.syncPacks();
      return this.status();
    } finally {
      this.running = false;
      const state = await this.deps.policy.current().catch(() => undefined);
      const interval = state?.policy?.remote?.intervalMinutes ?? 60;
      this.schedule(Math.max(5, interval) * 60_000);
    }
  }

  /** GET the document as text. The bytes are handed on untouched: the signature covers them. */
  private async fetchDocument(url: string): Promise<string> {
    const res = await this.fetchImpl(url, {
      redirect: 'follow',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new RpError('CAPABILITY_FAILED', `HTTP ${res.status} fetching the remote configuration`);
    const text = await res.text();
    if (text.length > MAX_DOCUMENT_BYTES) throw new RpError('CAPABILITY_FAILED', `the remote configuration is ${text.length} bytes; the limit is ${MAX_DOCUMENT_BYTES}`);
    return text;
  }

  /**
   * Install every pack the policy pins that is not already there, and — with `removeUnlisted` —
   * uninstall the rest. Each pack is independent: one bad download does not stop the others.
   */
  async syncPacks(): Promise<RemotePackStatus[]> {
    const state = await this.deps.policy.current();
    const sources = state.policy?.packs?.sources ?? [];
    const removeUnlisted = state.policy?.packs?.removeUnlisted === true;
    if (sources.length === 0 && !removeUnlisted) return [...this.packStatus.values()];
    let installed = await this.deps.packs.installed();

    for (const source of sources) {
      const current = installed.find((p) => p.id === source.id);
      const status: RemotePackStatus = { id: source.id, url: source.url, state: 'installed' };
      if (source.version !== undefined) status.wanted = source.version;
      if (current) status.installed = current.version;
      if (!packNeedsInstall(source, current)) {
        this.packStatus.set(source.id, { ...status, updatedAt: this.packStatus.get(source.id)?.updatedAt ?? this.now().toISOString() });
        continue;
      }
      this.packStatus.set(source.id, { ...status, state: 'downloading' });
      try {
        const view = await this.installFrom(source);
        this.packStatus.set(source.id, { ...status, state: 'installed', installed: view.version, updatedAt: this.now().toISOString() });
        this.deps.logger.info(`[remote] installed pack ${source.id} ${view.version} from ${source.url}`);
      } catch (err) {
        this.packStatus.set(source.id, { ...status, state: 'failed', error: (err as Error).message, updatedAt: this.now().toISOString() });
        this.deps.logger.warn(`[remote] cannot install pack ${source.id} from ${source.url}: ${(err as Error).message}`);
      }
    }

    if (removeUnlisted) {
      installed = await this.deps.packs.installed();
      for (const id of packsToRemove(sources, installed)) {
        try {
          await this.deps.packs.uninstall(id);
          this.packStatus.set(id, { id, url: '', state: 'removed', updatedAt: this.now().toISOString() });
          this.deps.logger.info(`[remote] removed pack ${id}: the policy does not list it`);
        } catch (err) {
          this.deps.logger.warn(`[remote] cannot remove pack ${id}: ${(err as Error).message}`);
        }
      }
    }
    return [...this.packStatus.values()];
  }

  /** Download one pack, check the checksum the policy pins, install it and check the id. */
  private async installFrom(source: PackSource): Promise<InstalledPackView> {
    await fs.mkdir(this.downloadDir, { recursive: true });
    const file = path.join(this.downloadDir, `${source.id}.${randomBytes(4).toString('hex')}${PACK_FILE_EXTENSION}`);
    try {
      const res = await this.fetchImpl(source.url, { redirect: 'follow', signal: AbortSignal.timeout(PACK_TIMEOUT_MS) });
      if (!res.ok) throw new RpError('CAPABILITY_FAILED', `HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength === 0) throw new RpError('CAPABILITY_FAILED', 'the download is empty');
      if (body.byteLength > MAX_PACK_BYTES) throw new RpError('CAPABILITY_FAILED', `the download is ${body.byteLength} bytes; the limit is ${MAX_PACK_BYTES}`);
      // The daemon decides, not the app: it holds the key the administrator's signature is
      // checked against, and it is the side a patched app cannot talk its way past.
      const digest = createHash('sha256').update(body).digest('hex');
      await this.deps.daemon.verifyPack(source.id, digest);
      await fs.writeFile(file, body);
      const view = await this.deps.packs.install(file);
      // The id is the policy's contract: a URL that starts serving a different pack must not
      // quietly install it under this entry.
      if (view.packId !== source.id) {
        await this.deps.packs.uninstall(view.packId).catch(() => undefined);
        throw new RpError('PACK_INVALID', `the download contains pack "${view.packId}", but the policy pins "${source.id}"`);
      }
      if (source.version !== undefined && view.version !== source.version) {
        throw new RpError('PACK_INVALID', `the download is version ${view.version}, but the policy pins ${source.version}`);
      }
      return view;
    } finally {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }
}
