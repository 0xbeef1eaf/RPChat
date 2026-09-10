import { useCallback, useEffect, useState } from 'react';
import type { SystemIntegrationStatus } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDateTime } from '../../lib/format';
import { refreshSettings, reportError, toast } from '../../store/actions';
import { Modal } from '../common/Modal';
import { Toggle } from '../common/Toggle';

export function SystemSection() {
  const [status, setStatus] = useState<SystemIntegrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installerPath, setInstallerPath] = useState<string | null>(null);
  const [installDialog, setInstallDialog] = useState(false);
  const [autostartWanted, setAutostartWanted] = useState(true);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [policyDialog, setPolicyDialog] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api().system.status(), api().system.installerPath()]);
      setStatus(s);
      setInstallerPath(p);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async () => {
    setInstallDialog(false);
    setRunning(true);
    setOutput(null);
    try {
      const r = await api().system.install({ autostart: autostartWanted });
      setOutput({ ok: r.ok, text: r.output || (r.ok ? 'Done.' : 'The installer reported a failure without output.') });
      toast(r.ok ? 'success' : 'error', r.ok ? 'System integration installed' : 'Installer failed');
      await Promise.all([load(), refreshSettings().catch(() => undefined)]);
    } catch (err) {
      setOutput({ ok: false, text: errorMessage(err) });
      reportError('Installer failed', err);
    } finally {
      setRunning(false);
    }
  };

  const setAutostart = async (enabled: boolean) => {
    setBusy(true);
    try {
      setStatus(await api().system.setAutostart(enabled));
    } catch (err) {
      reportError('Could not change autostart', err);
    } finally {
      setBusy(false);
    }
  };

  const copyPath = async () => {
    if (!installerPath) return;
    try {
      await navigator.clipboard.writeText(installerPath);
      toast('success', 'Path copied');
    } catch (err) {
      reportError('Could not copy', err);
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
        <span className="spinner" /> Checking…
      </div>
    );
  }

  const linux = status.platform === 'linux';
  const { daemon, policy, udev, autostart } = status;
  const reloginHint = udev.rulePresent && !udev.inGroup;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row">
        <p className="muted small grow">
          The optional system integration runs a small root daemon (<code>rp-coded</code>) that handles input locking and typing safely, plus a
          root-owned policy file that can force settings on this machine. Input locking and injection (<code>sdk.input</code>) are only
          available through the daemon: until it is installed and connected, those calls fail.
        </p>
        <button type="button" className="btn btn-sm" onClick={load} disabled={running}>
          Refresh
        </button>
      </div>
      {!linux ? (
        <div className="callout small">
          System integration is <strong>Linux only</strong> for now (platform: <code>{status.platform}</code>). Input locking and injection are
          unavailable here; desktop features use the command templates in Settings → Commands.
        </div>
      ) : null}

      <div className="cap-cards">
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Daemon</h3>
            <span className={daemon.connected ? 'badge badge-success' : 'badge badge-danger'}>{daemon.connected ? 'connected' : 'not connected'}</span>
          </div>
          <dl className="kv small">
            {daemon.version ? (
              <>
                <dt>Version</dt>
                <dd>{daemon.version}</dd>
              </>
            ) : null}
            {daemon.socketPath ? (
              <>
                <dt>Socket</dt>
                <dd className="mono">{daemon.socketPath}</dd>
              </>
            ) : null}
            <dt>Devices</dt>
            <dd>
              {daemon.devices ? `${daemon.devices.keyboards} keyboard(s), ${daemon.devices.pointers} pointer(s), uinput ${daemon.devices.uinput ? 'ok' : 'missing'}` : <span className="muted">unknown</span>}
            </dd>
            <dt>Input lock</dt>
            <dd>
              {daemon.locked ? (
                <span className="badge badge-warning">
                  locked until {formatDateTime(daemon.locked.until)}
                  {daemon.locked.reason ? ` — ${daemon.locked.reason}` : ''}
                </span>
              ) : (
                'not locked'
              )}
            </dd>
            {daemon.error ? (
              <>
                <dt>Error</dt>
                <dd className="msg-error">{daemon.error}</dd>
              </>
            ) : null}
          </dl>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Policy</h3>
            <span className={policy.present ? 'badge badge-accent' : 'badge'}>{policy.present ? 'policy file present' : 'no policy file'}</span>
          </div>
          {policy.present ? (
            <dl className="kv small">
              {policy.path ? (
                <>
                  <dt>File</dt>
                  <dd className="mono">{policy.path}</dd>
                </>
              ) : null}
              <dt>Managed by</dt>
              <dd>{policy.managedBy || <span className="muted">not stated</span>}</dd>
              <dt>Forced settings</dt>
              <dd>
                {policy.managed.length === 0 ? (
                  <span className="muted">none</span>
                ) : (
                  <span className="chips">
                    {policy.managed.map((m) => (
                      <span key={m} className="chip mono">
                        {m}
                      </span>
                    ))}
                  </span>
                )}
              </dd>
              {policy.error ? (
                <>
                  <dt>Error</dt>
                  <dd className="msg-error">{policy.error}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <p className="muted small">Administrators can force settings and input-lock limits from a root-owned file. Nothing is forced on this machine.</p>
              {policy.canCreate ? (
                <div>
                  <button type="button" className="btn btn-sm" onClick={() => setPolicyDialog(true)} disabled={running}>
                    Create policy…
                  </button>
                </div>
              ) : !daemon.connected && linux ? (
                <p className="field-hint">Install the system integration to be able to create a policy without root.</p>
              ) : null}
            </div>
          )}
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Device access</h3>
            <span className={udev.rulePresent && udev.inGroup ? 'badge badge-success' : 'badge'}>{udev.rulePresent && udev.inGroup ? 'ready' : 'not set up'}</span>
          </div>
          <dl className="kv small">
            <dt>udev rule</dt>
            <dd>{udev.rulePresent ? 'installed' : 'missing'}</dd>
            <dt>Group</dt>
            <dd>
              <code>{udev.groupName}</code> — {udev.inGroup ? 'you are a member' : 'you are not a member'}
            </dd>
          </dl>
          {reloginHint ? (
            <div className="callout callout-warning small" style={{ marginTop: 8 }}>
              The rule is installed but your session does not have the <code>{udev.groupName}</code> group yet — <strong>log out and back in</strong>{' '}
              for it to take effect.
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Start on login</h3>
            <Toggle checked={autostart.enabled} disabled={busy || !linux} aria-label="Start rp-code on login" onChange={setAutostart} />
          </div>
          <p className="muted small">
            {autostart.method === 'none' ? 'No autostart method available.' : `via ${autostart.method}`}
            {autostart.path ? (
              <>
                {' · '}
                <span className="mono">{autostart.path}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="row wrap">
          <div className="item-text grow">
            <span className="item-title">Install system integration</span>
            <span className="item-sub">Creates the group and udev rule and installs the root daemon service; asks for your password (pkexec).</span>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setInstallDialog(true)} disabled={!linux || !status.installerAvailable || running}>
            {running ? 'Running…' : 'Install system integration…'}
          </button>
        </div>
        {!status.installerAvailable && linux ? <p className="field-hint">The bundled installer script was not found in this build.</p> : null}
        {installerPath ? (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="muted small">Installer script:</span>
            <code className="grow" style={{ overflowWrap: 'anywhere' }}>
              {installerPath}
            </code>
            <button type="button" className="btn btn-sm" onClick={copyPath}>
              Copy
            </button>
          </div>
        ) : null}
        {running ? (
          <div className="row muted small" style={{ marginTop: 8 }}>
            <span className="spinner" /> Waiting for the installer (a password prompt may be open)…
          </div>
        ) : null}
        {output ? (
          <div style={{ marginTop: 8 }}>
            <div className={output.ok ? 'badge badge-success' : 'badge badge-danger'}>{output.ok ? 'installer finished' : 'installer failed'}</div>
            <pre style={{ marginTop: 6, maxHeight: 280, whiteSpace: 'pre-wrap' }}>
              <code>{output.text}</code>
            </pre>
          </div>
        ) : null}
      </div>

      {policyDialog ? (
        <CreatePolicyDialog
          path={policy.path ?? '/etc/rp-code/policy.json'}
          onClose={() => setPolicyDialog(false)}
          onCreated={async (next) => {
            setPolicyDialog(false);
            setStatus(next);
            toast('success', 'Policy written');
            await Promise.all([load(), refreshSettings().catch(() => undefined)]);
          }}
        />
      ) : null}

      {installDialog ? (
        <Modal title="Install system integration?" onClose={() => setInstallDialog(false)}>
          <p>The installer runs with administrator rights and makes these changes:</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              creates the <code>{udev.groupName}</code> group and adds your user to it
            </li>
            <li>installs a udev rule granting that group access to input devices</li>
            <li>
              installs and starts the <code>rp-coded</code> root daemon service (input lock, typing, emergency unlock key)
            </li>
            <li>
              creates <code>/etc/rp-code</code> for the policy file (nothing is written there; you can create the policy from this tab afterwards)
            </li>
            <li>optionally registers the app to start on login</li>
          </ul>
          <label className="check">
            <input type="checkbox" checked={autostartWanted} onChange={(e) => setAutostartWanted(e.target.checked)} />
            Also start rp-code on login
          </label>
          <p className="muted small">You will need to log out and back in for the group membership to apply.</p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setInstallDialog(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={install}>
              Install
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** Validation problems from a `createPolicy` error: the message lists one problem per line after "Invalid policy file:". */
function policyProblems(err: unknown): string[] {
  const message = errorMessage(err);
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length > 1 && /^Invalid policy file:?$/.test(lines[0] ?? '')) return lines.slice(1);
  return [message];
}

function CreatePolicyDialog({ path, onClose, onCreated }: { path: string; onClose: () => void; onCreated: (status: SystemIntegrationStatus) => void | Promise<void> }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [understood, setUnderstood] = useState(false);
  const [writing, setWriting] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);

  const reset = useCallback(async () => {
    setLoading(true);
    try {
      setText(await api().system.policyTemplate());
      setProblems(null);
    } catch (err) {
      setProblems([errorMessage(err)]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reset();
  }, [reset]);

  const submit = async () => {
    setWriting(true);
    setProblems(null);
    try {
      const next = await api().system.createPolicy(text);
      await onCreated(next);
    } catch (err) {
      setProblems(policyProblems(err));
    } finally {
      setWriting(false);
    }
  };

  return (
    <Modal title="Create the policy file" onClose={writing ? undefined : onClose}>
      <p>
        Writes <code>{path}</code> through the rp-code daemon. This does not need your password, but it can only be done once: afterwards only root
        can edit or remove the file, and the values in it override the settings of every user on this machine.
      </p>
      <div className="field">
        <div className="row">
          <label className="grow" htmlFor="policy-json">
            Policy (JSON, prefilled from your current settings)
          </label>
          <button type="button" className="btn btn-sm" onClick={reset} disabled={loading || writing}>
            Reset to current settings
          </button>
        </div>
        <textarea id="policy-json" className="code" rows={20} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} disabled={loading || writing} />
      </div>
      {problems ? (
        <div className="callout callout-danger small">
          <strong>The policy was not written.</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} disabled={writing} />
        I understand this cannot be undone without root
      </label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={writing}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!understood || loading || writing || text.trim().length === 0}>
          {writing ? 'Writing…' : 'Write policy'}
        </button>
      </div>
    </Modal>
  );
}
