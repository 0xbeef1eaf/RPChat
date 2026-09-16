/**
 * Settings → System: the policy lock (a code from an authenticator app) and remote configuration.
 *
 * The lines are pure functions so they can be tested without a renderer, and because most of the
 * work here is saying precisely what is and is not protected — a lock that overstates itself is
 * worse than no lock, so `residual` from the daemon is shown rather than summarised away.
 */
import { useState } from 'react';
import type { SystemIntegrationStatus } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDateTime } from '../../lib/format';
import { toast } from '../../store/actions';
import { Modal } from '../common/Modal';
import { QrCode } from '../common/QrCode';
import { keyLine, lockoutLine, packLine, remoteLine, runtimeLine, sealLine } from '../../lib/seal';

export function SealCard({ status, onChanged, disabled }: { status: SystemIntegrationStatus; onChanged(next: SystemIntegrationStatus): void; disabled?: boolean }) {
  const seal = status.policy.seal;
  const [sealDialog, setSealDialog] = useState(false);
  const [unsealDialog, setUnsealDialog] = useState(false);
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauth: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tamperLog, setTamperLog] = useState(false);
  const lockout = lockoutLine(seal);
  const runtime = runtimeLine(status.policy.runtime);

  const seal_ = async () => {
    setBusy(true);
    try {
      const res = await api().system.sealPolicy();
      setEnrolment({ secret: res.secret, otpauth: res.otpauth });
      setSealDialog(false);
      onChanged(res.status);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const unseal = async (code: string, removePolicy: boolean) => {
    setBusy(true);
    try {
      const next = await api().system.unsealPolicy(code, removePolicy);
      setUnsealDialog(false);
      onChanged(next);
      toast('success', removePolicy ? 'Policy unlocked and removed' : 'Policy unlocked');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 className="grow">Policy lock</h3>
        <span className={seal.sealed ? 'badge badge-accent' : 'badge'}>{seal.sealed ? 'locked' : 'not locked'}</span>
      </div>
      <p className="muted small">{sealLine(seal, status.policy.fromCache)}</p>
      {lockout ? <div className="callout callout-warning small">{lockout}</div> : null}
      {status.policy.fromCache ? (
        <div className="callout callout-warning small">
          The policy file and the daemon are both gone, so the app is enforcing the copy it kept. This is recorded as tampering, not as an unlock.
        </div>
      ) : null}
      {runtime ? <p className="field-hint">{runtime}</p> : null}
      {seal.sealed && seal.residual.length > 0 ? (
        <details className="small" style={{ marginTop: 6 }}>
          <summary>What the lock cannot do</summary>
          <ul className="muted" style={{ marginTop: 6 }}>
            {seal.residual.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        {!seal.sealed && status.policy.present && status.daemon.connected ? (
          <button type="button" className="btn btn-sm" onClick={() => setSealDialog(true)} disabled={disabled || busy}>
            Lock policy…
          </button>
        ) : null}
        {seal.sealed ? (
          <button type="button" className="btn btn-sm" onClick={() => setUnsealDialog(true)} disabled={disabled || busy}>
            Unlock…
          </button>
        ) : null}
        {seal.tampers.length > 0 ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTamperLog(true)}>
            Tamper log ({seal.tampers.length})
          </button>
        ) : null}
      </div>

      {sealDialog ? (
        <Modal title="Lock this policy behind a code" onClose={() => setSealDialog(false)}>
          <div className="stack">
            <p className="small">
              The policy on this machine is pinned to a new secret and an authenticator app is enrolled with it. Afterwards, changing or removing the policy — from this app or from a
              root shell — needs the code the app is showing. The daemon also puts the policy back if it is edited, and keeps copies of the lock so removing one does not undo it.
            </p>
            <div className="callout callout-warning small">
              The secret is shown once and cannot be read again. Enrol your authenticator app before closing the next dialog, and keep a copy somewhere safe: without it the policy can
              only be removed by reinstalling the machine.
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => setSealDialog(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void seal_()} disabled={busy}>
              {busy ? 'Locking…' : 'Lock policy'}
            </button>
          </div>
        </Modal>
      ) : null}

      {enrolment ? (
        <Modal title="Enrol your authenticator app" onClose={() => setEnrolment(null)}>
          <div className="stack">
            <p className="small">Scan this with your authenticator app now. It is not stored anywhere you can read it again.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <QrCode value={enrolment.otpauth} size={220} label="Scan to enrol this machine's policy lock" />
            </div>
            <details className="small">
              <summary>Can’t scan it?</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <label className="field">
                  <span className="field-label">Secret — type this into your app by hand</span>
                  <input className="input mono" readOnly value={enrolment.secret} onFocus={(e) => e.currentTarget.select()} />
                </label>
                <label className="field">
                  <span className="field-label">Enrolment URI — the same thing the code above encodes</span>
                  <input className="input mono" readOnly value={enrolment.otpauth} onFocus={(e) => e.currentTarget.select()} />
                </label>
              </div>
            </details>
            <div className="callout callout-warning small">Closing this dialog is the last time any of this is on screen.</div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={() => setEnrolment(null)}>
              I have saved them
            </button>
          </div>
        </Modal>
      ) : null}

      {unsealDialog ? <CodeDialog title="Unlock the policy" what="unlock" busy={busy} offerRemove onClose={() => setUnsealDialog(false)} onSubmit={(code, remove) => void unseal(code, remove)} /> : null}

      {tamperLog ? (
        <Modal title="Tamper log" onClose={() => setTamperLog(false)}>
          <p className="muted small">Changes to the locked files that the daemon noticed, newest last.</p>
          <ul className="small stack" style={{ gap: 4, marginTop: 8 }}>
            {seal.tampers.map((t, i) => (
              <li key={`${t.at}-${i}`}>
                <span className="mono">{formatDateTime(t.at)}</span> — {t.kind} at <span className="mono">{t.path}</span> — {t.healed ? 'put back' : 'could not be put back'}
              </li>
            ))}
          </ul>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => setTamperLog(false)}>
              Close
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** Asks for the current code. Used for unlocking, and by the policy editor for a replacement. */
export function CodeDialog({
  title,
  what,
  busy,
  offerRemove,
  onClose,
  onSubmit,
}: {
  title: string;
  what: string;
  busy?: boolean;
  offerRemove?: boolean;
  onClose(): void;
  onSubmit(code: string, removePolicy: boolean): void;
}) {
  const [code, setCode] = useState('');
  const [removePolicy, setRemovePolicy] = useState(false);
  const digits = code.replace(/\D/g, '');
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <p className="small">Enter the code your authenticator app is showing for this machine to {what} the policy. Each code works once.</p>
        <label className="field">
          <span className="field-label">Code</span>
          <input
            className="input mono"
            inputMode="numeric"
            autoFocus
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && digits.length >= 6) onSubmit(digits, removePolicy);
            }}
          />
        </label>
        {offerRemove ? (
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={removePolicy} onChange={(e) => setRemovePolicy(e.currentTarget.checked)} />
            <span>Also delete the policy file, leaving this machine unmanaged</span>
          </label>
        ) : null}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onSubmit(digits, removePolicy)} disabled={busy || digits.length < 6}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </div>
    </Modal>
  );
}

export function RemoteConfigCard({ status, onChanged, disabled }: { status: SystemIntegrationStatus; onChanged(next: SystemIntegrationStatus): void; disabled?: boolean }) {
  const remote = status.remote?.daemon;
  const app = status.remote?.app;
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      onChanged(await api().system.remoteRefresh());
      toast('success', 'Checked for a new configuration');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const packs = app?.packs ?? [];
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 className="grow">Remote configuration</h3>
        <span className={remote?.configured && remote.enabled ? 'badge badge-accent' : 'badge'}>{remote?.configured ? (remote.enabled ? 'managed remotely' : 'switched off') : 'local'}</span>
      </div>
      <p className="muted small">{remoteLine(remote, app)}</p>
      {app?.lastError ? <div className="callout callout-warning small">{app.lastError}</div> : null}
      {keyLine(remote) ? <p className="field-hint">{keyLine(remote)}</p> : null}
      {packs.length > 0 ? (
        <>
          <p className="field-hint" style={{ marginTop: 8 }}>
            Packs this machine is meant to have{remote?.removeUnlisted ? ' (any other pack is removed)' : ''}:
          </p>
          <ul className="small stack" style={{ gap: 2 }}>
            {packs.map((p) => (
              <li key={p.id} className={p.state === 'failed' ? 'msg-error' : undefined}>
                {packLine(p)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {remote?.configured && remote.enabled ? (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={disabled || busy || app?.busy}>
            {busy ? 'Checking…' : 'Check now'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
