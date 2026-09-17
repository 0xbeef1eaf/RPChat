import { useCallback, useEffect, useState } from 'react';
import type { CryptoStatus } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDateTime } from '../../lib/format';
import { reportError } from '../../store/actions';

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

export function EncryptionSection() {
  const [status, setStatus] = useState<CryptoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api().crypto.status());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rotate = async () => {
    setBusy(true);
    try {
      setStatus(await api().crypto.rotateKey());
    } catch (err) {
      reportError('Key rotation failed', err);
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

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="muted small">
        Characters with the <code>crypto</code> capability can lock one of your files away with <code>sdk.crypto.encrypt</code> and bring it back with{' '}
        <code>sdk.crypto.decrypt</code> — only files under your home directory, never anything that looks like a system or session file. The key itself is{' '}
        {status.backend === 'daemon'
          ? 'held by the system daemon (rpchatd), in a file only root can read.'
          : 'kept in this app’s own config, since the system daemon is not installed — Settings → System explains how to install it.'}
      </p>

      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <h3 className="grow">Key</h3>
          <span className="badge">{status.backend === 'daemon' ? 'Daemon-held' : 'App config'}</span>
        </div>
        <dl className="kv small">
          <dt>Active key</dt>
          <dd className="mono">{shortId(status.activeKeyId)}</dd>
          <dt>History</dt>
          <dd>
            {status.keys.length} key{status.keys.length === 1 ? '' : 's'}
            {status.keys[0] ? <span className="muted"> · oldest {formatDateTime(status.keys[0].createdAt)}</span> : null}
          </dd>
          <dt>Pending decrypts</dt>
          <dd>{status.pendingDecrypts === 0 ? 'None' : `${status.pendingDecrypts} file(s) still encrypted`}</dd>
        </dl>
        <p className="field-hint">
          Rotating makes a new key active for future encryption; files already encrypted stay decryptable under the key that encrypted them — nothing needs
          re-encrypting.
        </p>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={() => void rotate()} disabled={busy}>
            Rotate key
          </button>
        </div>
        <p className="field-hint" style={{ marginTop: 8 }}>
          To bring everything back at once, run <code>rpchat-decrypt-all</code> from a terminal: it walks the same log this page counts and decrypts whatever is
          still encrypted, as you, with or without the app running.
        </p>
      </div>
    </div>
  );
}
