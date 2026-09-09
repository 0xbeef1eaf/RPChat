import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, UpdateStatus } from '@rp/shared';
import { UPDATE_REPO, UPDATE_TOKEN_HELP_URL, releasePageUrl } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDateTime } from '../../lib/format';
import { reportError, toast } from '../../store/actions';
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
    case 'no-token':
      return { text: 'GitHub token needed', badge: 'badge badge-warning' };
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
      return { text: `${s.latestVersion ?? 'The update'} is downloaded — restart to install`, badge: 'badge badge-success' };
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
  const [token, setToken] = useState('');
  const [savingToken, setSavingToken] = useState(false);
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

  const saveToken = async () => {
    const value = token.trim();
    if (!value) return;
    setSavingToken(true);
    try {
      setStatus(await api().updates.setToken(value));
      setToken('');
      toast('success', 'Token saved');
    } catch (err) {
      reportError('Could not save the token', err);
    } finally {
      setSavingToken(false);
    }
  };

  const removeToken = async () => {
    setSavingToken(true);
    try {
      setStatus(await api().updates.setToken(null));
      toast('success', 'Token removed');
    } catch (err) {
      reportError('Could not remove the token', err);
    } finally {
      setSavingToken(false);
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
  const canCheck = !unsupported && !disabledByPolicy && status.tokenPresent && status.state !== 'checking' && status.state !== 'downloading';
  const canDownload = status.state === 'available' && status.canInstallInPlace;
  const canInstall = status.state === 'ready';
  const releaseUrl = status.latestVersion ? releasePageUrl(status.latestVersion) : `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`;
  const showTokenField = !unsupported && !disabledByPolicy;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="muted small">
        The app updates itself from the releases of <code>{`${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`}</code>. The AppImage is replaced in place; package installs are
        notified only.
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
            {status.packaging === 'appimage' ? 'AppImage' : status.packaging === 'deb' ? 'Package (.deb)' : status.packaging === 'dev' ? 'Development' : 'Unpacked build'}
            {status.packaging === 'appimage' ? (status.canInstallInPlace ? ' · updates in place' : ' · read-only location') : null}
          </dd>
          {status.checkedAt ? (
            <>
              <dt>Last check</dt>
              <dd>{formatDateTime(status.checkedAt)}</dd>
            </>
          ) : null}
          {status.tokenPresent ? (
            <>
              <dt>Token</dt>
              <dd>token saved ({status.tokenStorage === 'keyring' ? 'keyring' : 'file'})</dd>
            </>
          ) : null}
        </dl>
        {status.state === 'downloading' ? (
          <progress value={status.progressPercent ?? 0} max={100} style={{ width: '100%', marginTop: 8 }} aria-label="Download progress" />
        ) : null}
        {status.state === 'error' && status.error ? (
          <div className="callout callout-danger small" style={{ marginTop: 8 }}>
            {status.error}
          </div>
        ) : null}
        {status.reason && !unsupported && !disabledByPolicy && status.state !== 'no-token' ? <p className="field-hint">{status.reason}</p> : null}
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
            <button type="button" className="btn btn-primary btn-sm" onClick={() => run('Restart failed', () => api().updates.install())} disabled={busy}>
              Restart to update
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

      {showTokenField ? (
        <div className="card">
          <h3 style={{ marginBottom: 6 }}>GitHub token</h3>
          <p className="muted small" style={{ marginBottom: 8 }}>
            Create a fine-grained personal access token at{' '}
            <a href={UPDATE_TOKEN_HELP_URL} target="_blank" rel="noreferrer">
              github.com/settings/personal-access-tokens
            </a>{' '}
            with read-only <em>Contents</em> access to <code>{`${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`}</code>. It is stored in your system keyring.
          </p>
          <div className="row wrap">
            <div className="field grow" style={{ minWidth: 240 }}>
              <label htmlFor="update-token">{status.tokenPresent ? 'Replace token' : 'Token'}</label>
              <input
                id="update-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="github_pat_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void saveToken()}
              />
              {status.tokenPresent ? <span className="field-hint">token saved ({status.tokenStorage === 'keyring' ? 'keyring' : 'file'})</span> : null}
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={saveToken} disabled={savingToken || token.trim().length === 0}>
              Save token
            </button>
            {status.tokenPresent ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={removeToken} disabled={savingToken}>
                Remove token
              </button>
            ) : null}
          </div>
          {status.tokenStorage === 'file' ? (
            <div className="callout callout-warning small" style={{ marginTop: 8 }}>
              No system keyring is available, so the token is kept in a file only you can read (<code>update-token.bin</code> in the app data folder).
            </div>
          ) : null}
        </div>
      ) : null}

      {!unsupported ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <div className="item-text grow">
              <span className="item-title">
                Check automatically
                <ManagedBadge show={automaticManaged || disabledByPolicy} />
              </span>
              <span className="item-sub">Checks shortly after launch and on the interval below; AppImage updates download in the background.</span>
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
