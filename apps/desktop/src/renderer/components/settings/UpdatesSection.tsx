import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, UpdateStatus } from '@rp/shared';
import { UPDATE_REPO, releasePageUrl } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDateTime } from '../../lib/format';
import { reportError } from '../../store/actions';
import { Toggle } from '../common/Toggle';
import { ManagedBadge, useManaged } from './Managed';

interface UpdatesSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
}

const INTERVALS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: 'Every hour' },
  { hours: 6, label: 'Every 6 hours' },
  { hours: 24, label: 'Once a day' },
  { hours: 168, label: 'Once a week' },
];

function stateLabel(s: UpdateStatus): { text: string; badge: string } {
  switch (s.state) {
    case 'unsupported':
      return { text: 'Not available in this build', badge: 'badge' };
    case 'disabled':
      return { text: 'Disabled by policy', badge: 'badge badge-warning' };
    case 'idle':
      return { text: 'Not checked yet', badge: 'badge' };
    case 'checking':
      return { text: 'Checking…', badge: 'badge badge-accent' };
    case 'up-to-date':
      return { text: 'Up to date', badge: 'badge badge-success' };
    case 'available':
      return { text: `${s.latestVersion ?? 'A new version'} is available`, badge: 'badge badge-accent' };
    case 'downloading':
      return { text: `Downloading ${s.latestVersion ?? ''}… ${s.progressPercent ?? 0}%`, badge: 'badge badge-accent' };
    case 'ready':
      return { text: `${s.latestVersion ?? 'The update'} is downloaded — ${s.packaging === 'system' ? 'apply and restart' : 'restart to install'}`, badge: 'badge badge-success' };
    case 'installing':
      return { text: `Applying ${s.latestVersion ?? 'the update'}…`, badge: 'badge badge-accent' };
    case 'error':
      return { text: 'Check failed', badge: 'badge badge-danger' };
    default:
      return { text: s.state, badge: 'badge' };
  }
}

export function UpdatesSection({ settings, onPatch }: UpdatesSectionProps) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const automaticManaged = useManaged('updates.automatic');

  const load = useCallback(async () => {
    try {
      setStatus(await api().updates.status());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    return api().updates.onStatus((s) => setStatus(s));
  }, [load]);

  const run = async (label: string, action: () => Promise<UpdateStatus | void>) => {
    setBusy(true);
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch (err) {
      reportError(label, err);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="stack">
        <div className="callout callout-danger small">{error}</div>
        <div>
          <button type="button" className="btn btn-sm" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="row muted small">
        <span className="spinner" /> Loading…
      </div>
    );
  }

  const label = stateLabel(status);
  const disabledByPolicy = status.state === 'disabled';
  const unsupported = status.state === 'unsupported';
  const systemInstall = status.packaging === 'system';
  const canCheck = !unsupported && !disabledByPolicy && status.state !== 'checking' && status.state !== 'downloading' && status.state !== 'installing';
  const canDownload = status.state === 'available' && status.canInstallInPlace;
  const canInstall = status.state === 'ready' && (!systemInstall || status.canInstallInPlace);
  const releaseUrl = status.latestVersion ? releasePageUrl(status.latestVersion) : `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="muted small">
        The app updates itself from the releases of <code>{`${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`}</code>.{' '}
        {systemInstall
          ? 'Updates are applied by the system service (rpchatd): no password prompt, and the previous version is kept for rollback.'
          : 'The AppImage is replaced in place; package installs are notified only.'}
      </p>

      {unsupported ? <div className="callout small">Updates are only available in packaged builds.</div> : null}
      {disabledByPolicy ? (
        <div className="callout callout-warning small">
          Update checks are switched off by the system policy on this machine. <ManagedBadge />
        </div>
      ) : null}

      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <h3 className="grow">Version</h3>
          <span className={label.badge}>{label.text}</span>
        </div>
        <dl className="kv small">
          <dt>Installed</dt>
          <dd className="mono">{status.currentVersion}</dd>
          {status.latestVersion && status.latestVersion !== status.currentVersion ? (
            <>
              <dt>Latest</dt>
              <dd className="mono">
                {status.latestVersion}
                {status.releaseDate ? <span className="muted"> · {formatDateTime(status.releaseDate)}</span> : null}
              </dd>
            </>
          ) : null}
          <dt>Packaging</dt>
          <dd>
            {status.packaging === 'appimage' ? 'AppImage' : status.packaging === 'deb' ? 'Package (.deb)' : status.packaging === 'dev' ? 'Development' : status.packaging === 'system' ? 'System install' : 'Unpacked build'}
            {status.packaging === 'appimage' ? (status.canInstallInPlace ? ' · updates in place' : ' · read-only location') : null}
            {systemInstall ? (status.canInstallInPlace ? ' · applied by the system service' : ' · system service not available') : null}
          </dd>
          {status.systemInstall ? (
            <>
              <dt>Install</dt>
              <dd>
                <span className="mono">{status.systemInstall.dir}</span>
                {status.systemInstall.current ? ` (v${status.systemInstall.current})` : ''}
                {status.systemInstall.previous ? `, previous v${status.systemInstall.previous}` : ''}
              </dd>
            </>
          ) : null}
          {status.checkedAt ? (
            <>
              <dt>Last check</dt>
              <dd>{formatDateTime(status.checkedAt)}</dd>
            </>
          ) : null}
        </dl>
        {status.state === 'downloading' ? (
          <progress value={status.progressPercent ?? 0} max={100} style={{ width: '100%', marginTop: 8 }} aria-label="Download progress" />
        ) : null}
        {status.error ? (
          <div className="callout callout-danger small" style={{ marginTop: 8 }}>
            {status.error}
          </div>
        ) : null}
        {status.state === 'installing' ? (
          <div className="row muted small" style={{ marginTop: 8 }}>
            <span className="spinner" /> The system service is verifying and installing the update; the app restarts when it is done.
          </div>
        ) : null}
        {status.reason && !unsupported && !disabledByPolicy ? <p className="field-hint">{status.reason}</p> : null}
        {status.releaseNotes && (status.state === 'available' || status.state === 'downloading' || status.state === 'ready') ? (
          <details style={{ marginTop: 8 }}>
            <summary className="small">Release notes</summary>
            <pre style={{ marginTop: 6, maxHeight: 220, whiteSpace: 'pre-wrap' }}>
              <code>{status.releaseNotes}</code>
            </pre>
          </details>
        ) : null}
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={() => run('Update check failed', () => api().updates.check())} disabled={!canCheck || busy}>
            {status.state === 'checking' ? 'Checking…' : 'Check now'}
          </button>
          {canDownload ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => run('Download failed', () => api().updates.download())} disabled={busy}>
              Download {status.latestVersion}
            </button>
          ) : null}
          {canInstall ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => run(systemInstall ? 'Update failed' : 'Restart failed', () => api().updates.install())} disabled={busy}>
              {systemInstall ? 'Apply update and restart' : 'Restart to update'}
            </button>
          ) : null}
          {(status.state === 'available' || status.state === 'ready' || status.state === 'downloading') && !status.canInstallInPlace ? (
            <a className="btn btn-sm" href={releaseUrl} target="_blank" rel="noreferrer">
              Open release page
            </a>
          ) : null}
        </div>
        {status.packaging === 'deb' && !unsupported && !disabledByPolicy ? (
          <p className="field-hint" style={{ marginTop: 8 }}>
            Installed from a package: new releases are announced here and applied by installing the <code>.deb</code> from the{' '}
            <a href={releaseUrl} target="_blank" rel="noreferrer">
              release page
            </a>
            .
          </p>
        ) : null}
      </div>

      {!unsupported ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <div className="item-text grow">
              <span className="item-title">
                Check automatically
                <ManagedBadge show={automaticManaged || disabledByPolicy} />
              </span>
              <span className="item-sub">Checks shortly after launch and on the interval below; AppImage and system-install updates download in the background.</span>
            </div>
            <Toggle
              checked={settings.updates.automatic}
              disabled={automaticManaged || disabledByPolicy}
              aria-label="Check for updates automatically"
              onChange={(v) => void onPatch({ updates: { ...settings.updates, automatic: v } })}
            />
          </div>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="update-interval">Check interval</label>
            <select
              id="update-interval"
              value={String(settings.updates.checkIntervalHours)}
              disabled={disabledByPolicy || !settings.updates.automatic}
              onChange={(e) => void onPatch({ updates: { ...settings.updates, checkIntervalHours: Number(e.target.value) } })}
            >
              {INTERVALS.some((i) => i.hours === settings.updates.checkIntervalHours) ? null : (
                <option value={String(settings.updates.checkIntervalHours)}>Every {settings.updates.checkIntervalHours} hours</option>
              )}
              {INTERVALS.map((i) => (
                <option key={i.hours} value={String(i.hours)}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
    </div>
  );
}
