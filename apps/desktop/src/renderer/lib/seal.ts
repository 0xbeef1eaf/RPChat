/**
 * The sentences Settings → System uses for the policy lock and remote configuration. They live
 * apart from the component so they can be read and tested on their own: most of the work here is
 * saying precisely what is and is not protected, and a lock that overstates itself is worse than
 * no lock.
 */
import type { RemoteConfigStatus, RemoteInfo, RemotePackStatus, SealInfo, SystemIntegrationStatus } from '@rp/shared';
import { formatDateTime } from './format';

/** Pure: the one-line summary of the policy lock, in whichever mode it holds. */
export function sealLine(seal: SealInfo, fromCache = false): string {
  if (!seal.sealed) return 'Not locked. The policy was written once and only root can change it now.';
  const when = seal.sealedAt ? ` since ${formatDateTime(seal.sealedAt)}` : '';
  if (fromCache) return `Locked${when}, but nothing on this machine holds the policy any more: the app is enforcing the copy it cached. Unlock it, or reinstall the system integration.`;
  const layers = [
    seal.selfHeal ? 'restored when edited' : null,
    seal.immutable ? 'immutable' : null,
    seal.denyEscapes ? 'guarded sessions cannot reach it' : null,
    seal.refuseManualStop ? 'the service refuses a manual stop' : null,
  ].filter(Boolean);
  const how =
    seal.mode === 'chain'
      ? 'only a signed link on this machine’s policy chain can change or remove the policy — there is no code, and nothing here can authorise one'
      : `changing or removing the policy needs ${seal.totp ? `${seal.totp.digits}-digit codes every ${seal.totp.period} s` : 'codes from an authenticator app'}`;
  return `Locked${when}: ${how}${layers.length > 0 ? ` (${layers.join(', ')})` : ''}.`;
}

/** Pure: how long the lockout after repeated wrong codes has left, as a sentence. */
export function lockoutLine(seal: SealInfo, now: Date = new Date()): string | null {
  if (!seal.lockedUntil) return null;
  const left = Math.max(0, Math.ceil((new Date(seal.lockedUntil).getTime() - now.getTime()) / 1000));
  if (left === 0) return null;
  return `Too many wrong codes: the lock is refusing them for another ${left} second${left === 1 ? '' : 's'}.`;
}

/** Pure: the runtime policy filesystem line. */
export function runtimeLine(runtime: SystemIntegrationStatus['policy']['runtime']): string | null {
  if (!runtime) return null;
  if (!runtime.present) return `No policy is published in ${runtime.dir}.`;
  const how = runtime.mounted ? (runtime.readOnly ? 'a read-only filesystem the daemon mounts' : 'a filesystem the daemon mounts, currently writable') : 'a plain directory';
  return `The policy the app reads is published in ${runtime.dir} — ${how}${runtime.publishedAt ? `, last written ${formatDateTime(runtime.publishedAt)}` : ''}.`;
}

/** Pure: the Remote Link line for the card header. */
export function remoteLine(remote: RemoteInfo | undefined, app: RemoteConfigStatus | undefined): string {
  if (!remote?.configured) return 'No Remote Link. This machine keeps its own policy; paste a link to have it follow one an administrator publishes.';
  if (!remote.enabled) return `Following is switched off for this machine (remote.enabled: false); the address is still ${remote.url}.`;
  const last = app?.lastAppliedAt ? `last checked ${formatDateTime(app.lastAppliedAt)}` : app?.lastCheckedAt ? `last tried ${formatDateTime(app.lastCheckedAt)}` : 'not fetched yet';
  const at = remote.seq === 0 ? 'no links applied yet' : `at link ${remote.seq}`;
  return `${remote.url} every ${remote.intervalMinutes} minutes — ${at} — ${last}.`;
}

/** Pure: the key a machine pins, shortened for display, with the name its administrator gave it. */
export function keyLine(remote: RemoteInfo | undefined): string | null {
  if (!remote?.configured || !remote.key) return null;
  const short = `${remote.key.slice(0, 12)}…`;
  const named = remote.keyId ? ` (${remote.keyId})` : '';
  const rotated = remote.rotations.length > 0 ? ` — rotated ${remote.rotations.length} time${remote.rotations.length === 1 ? '' : 's'} by the chain itself` : '';
  return `Links must be signed by ${short}${named}${rotated}.`;
}

/** Pure: one pinned pack as a line. */
export function packLine(pack: RemotePackStatus): string {
  switch (pack.state) {
    case 'installed':
      return `${pack.id} ${pack.installed ?? ''}${pack.wanted && pack.wanted !== pack.installed ? ` (the policy pins ${pack.wanted})` : ''}`.trim();
    case 'downloading':
      return `${pack.id} — downloading…`;
    case 'failed':
      return `${pack.id} — failed: ${pack.error ?? 'unknown error'}`;
    case 'removed':
      return `${pack.id} — removed: the policy no longer lists it`;
    default:
      return `${pack.id} — waiting`;
  }
}
