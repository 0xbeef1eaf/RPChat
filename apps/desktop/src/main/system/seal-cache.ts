/**
 * The app's own copy of a sealed policy, and why it exists.
 *
 * The daemon defends `/etc/rpchat` well while it is running (docs/system-integration.md "Sealing
 * the policy"), but the one move it cannot answer from inside is being stopped *and* having its
 * files removed in the same breath — from a rescue shell, from another boot, from a root shell the
 * session guard does not confine. Without this cache the app would then come up with no policy at
 * all and cheerfully hand back everything the policy took away, which makes the whole lock worth
 * exactly one `rm -rf`.
 *
 * So the app remembers, in its own user data, that it has seen a seal, together with the sealed
 * policy and its hash. While that memory exists and the machine offers nothing better, the app
 * keeps enforcing it — a missing policy file is read as tampering, not as freedom. The memory is
 * dropped in exactly one case: a **connected** daemon says the machine is not sealed, which only
 * happens after a code has been accepted (or after `rpchatd --unseal`, which also needs one).
 *
 * This is not a security boundary of its own — the user owns their user data and can delete the
 * cache too. It is the difference between "unlocking this needs the code" and "unlocking this
 * needs one command anyone can copy from a forum", and it is reported honestly as
 * `policy.fromCache` rather than pretending the daemon is there.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { PolicyFile } from '@rp/shared';

/** File name under the app's user data. */
export const SEAL_CACHE_FILE = 'sealed-policy.json';

export interface SealCacheEntry {
  version: 1;
  /** When the app first saw this seal. */
  seenAt: string;
  /** The seal's own timestamp, so a newer seal replaces an older memory. */
  sealedAt?: string;
  managedBy?: string;
  /** SHA-256 of the canonical policy JSON, as the daemon computes it. */
  policyHash: string;
  policy: PolicyFile;
}

/** The hash the daemon pins: SHA-256 over the compact JSON with sorted object keys. */
export function policyHash(policy: unknown): string {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex');
}

/**
 * Compact JSON with every object's keys sorted — the canonical form the daemon's `serde_json`
 * writes, so the two sides agree on a hash without either implementing a canonicalisation spec.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export class SealCache {
  constructor(
    private readonly file: string,
    private readonly logger?: Pick<Console, 'info' | 'warn'>,
  ) {}

  /** `<userData>/sealed-policy.json`. */
  static inUserData(userDataDir: string, logger?: Pick<Console, 'info' | 'warn'>): SealCache {
    return new SealCache(path.join(userDataDir, SEAL_CACHE_FILE), logger);
  }

  get path(): string {
    return this.file;
  }

  /** The remembered seal, or null. A damaged file is treated as no memory and logged. */
  async read(): Promise<SealCacheEntry | null> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger?.warn?.(`[policy] cannot read ${this.file}: ${(err as Error).message}`);
      return null;
    }
    try {
      const entry = JSON.parse(text) as SealCacheEntry;
      if (entry?.version !== 1 || typeof entry.policyHash !== 'string' || !entry.policy) throw new Error('not a seal cache entry');
      return entry;
    } catch (err) {
      this.logger?.warn?.(`[policy] ${this.file} is damaged and is being ignored: ${(err as Error).message}`);
      return null;
    }
  }

  /** Remember `policy` as sealed. A re-write with the same hash leaves `seenAt` alone. */
  async remember(policy: PolicyFile, meta: { sealedAt?: string; managedBy?: string } = {}): Promise<SealCacheEntry> {
    const hash = policyHash(policy);
    const existing = await this.read();
    const entry: SealCacheEntry = {
      version: 1,
      seenAt: existing?.policyHash === hash ? existing.seenAt : new Date().toISOString(),
      policyHash: hash,
      policy,
    };
    if (meta.sealedAt !== undefined) entry.sealedAt = meta.sealedAt;
    if (meta.managedBy !== undefined) entry.managedBy = meta.managedBy;
    if (existing && existing.policyHash === hash && existing.sealedAt === entry.sealedAt) return existing;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    this.logger?.info?.(`[policy] this machine is sealed${entry.managedBy ? ` by ${entry.managedBy}` : ''}; the app will keep enforcing the policy even if ${this.file} is the only copy left`);
    return entry;
  }

  /** Forget the seal. Only ever called for a connected daemon that reports an unsealed machine. */
  async clear(): Promise<void> {
    try {
      await fs.rm(this.file, { force: true });
      this.logger?.info?.('[policy] the machine is no longer sealed; the cached policy was dropped');
    } catch (err) {
      this.logger?.warn?.(`[policy] cannot remove ${this.file}: ${(err as Error).message}`);
    }
  }
}
