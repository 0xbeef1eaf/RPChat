import { useCallback, useEffect, useState } from 'react';
import type { AppRestrictions, DevRules, GuardAttemptRecord, SystemIntegrationStatus } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDateTime } from '../../lib/format';
import { refreshSettings, reportError, toast } from '../../store/actions';
import { Modal } from '../common/Modal';
import { Toggle } from '../common/Toggle';
import { CreatePolicyDialog } from './PolicyEditor';
import { RemoteConfigCard, SealCard } from './SealSection';
import { RemoteLinkCard } from './RemoteLinkSection';

export function SystemSection() {
  const [status, setStatus] = useState<SystemIntegrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installerPath, setInstallerPath] = useState<string | null>(null);
  const [installDialog, setInstallDialog] = useState(false);
  const [autostartWanted, setAutostartWanted] = useState(true);
  const [systemInstallWanted, setSystemInstallWanted] = useState(true);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [policyDialog, setPolicyDialog] = useState(false);
  const [auditLog, setAuditLog] = useState(false);

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
      const r = await api().system.install({ autostart: autostartWanted, systemInstall: systemInstallWanted });
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

  const applyGuard = async () => {
    setBusy(true);
    try {
      const next = await api().system.guardApply();
      setStatus(next);
      toast(next.guard.lastError ? 'error' : 'success', next.guard.lastError ? `Session guard: ${next.guard.lastError}` : `Session guard ${next.guard.mode}: ${next.guard.loaded.length} profile(s) loaded`);
    } catch (err) {
      reportError('Could not apply the session guard', err);
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
  const { daemon, policy, udev, autostart, install: appInstall, guard } = status;
  const reloginHint = udev.rulePresent && !udev.inGroup;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row">
        <p className="muted small grow">
          The optional system integration runs a small root daemon (<code>rpchatd</code>) that handles input locking and typing safely, plus a
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
            <h3 className="grow">App install</h3>
            <span className={appInstall.systemInstall ? 'badge badge-success' : 'badge'}>
              {appInstall.systemInstall ? 'system install' : appInstall.execInDir ? 'system install (daemon offline)' : appInstall.canSystemInstall ? 'AppImage' : 'not a system install'}
            </span>
          </div>
          <p className="muted small">{systemInstallLine(appInstall)}</p>
          {appInstall.systemInstall && !appInstall.daemonSupportsUpdates ? (
            <div className="callout callout-warning small" style={{ marginTop: 8 }}>
              The installed daemon is too old to apply updates by itself; run the installer below once to update it.
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Policy</h3>
            <span className={policy.present ? 'badge badge-accent' : 'badge'}>{policy.present ? 'policy file present' : 'no policy file'}</span>
          </div>
          {policy.present ? (
            <>
              {!policy.allowQuit ? (
                <div className="callout callout-warning small" style={{ marginBottom: 8 }}>
                  {quitDisabledLine(policy)}
                </div>
              ) : null}
              <dl className="kv small">
                {policy.path ? (
                  <>
                    <dt>File</dt>
                    <dd className="mono">{policy.path}</dd>
                  </>
                ) : null}
                <dt>Managed by</dt>
                <dd>{policy.managedBy || <span className="muted">not stated</span>}</dd>
                <dt>Restrictions</dt>
                <dd>
                  {restrictionLabels(policy.restrictions).length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    <span className="chips">
                      {restrictionLabels(policy.restrictions).map((label) => (
                        <span key={label} className="chip">
                          {label}
                        </span>
                      ))}
                    </span>
                  )}
                </dd>
                <dt>Development</dt>
                <dd>{policy.dev.allow && policy.dev.devTools ? <span className="muted">{devLine(policy.dev)}</span> : devLine(policy.dev)}</dd>
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
              {policy.seal.sealed || (policy.present && daemon.connected) ? (
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-sm" onClick={() => setPolicyDialog(true)} disabled={running || !policy.seal.sealed}>
                    Edit policy…
                  </button>
                  {!policy.seal.sealed ? (
                    <p className="field-hint">
                      The policy was written once and only root can change it now. Lock it behind an authenticator code below and it becomes editable again — with the code.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
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

        {linux && (policy.present || policy.seal.sealed) ? <SealCard status={status} onChanged={setStatus} disabled={running} /> : null}
        {linux ? <RemoteLinkCard status={status} onChanged={setStatus} disabled={running} /> : null}
        {linux && (status.remote?.daemon.configured || (status.remote?.app.packs.length ?? 0) > 0) ? <RemoteConfigCard status={status} onChanged={setStatus} disabled={running} /> : null}

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Session guard</h3>
            <span className={guardBadgeClass(guard)}>{guardBadge(guard)}</span>
          </div>
          <p className="muted small">{guardLine(guard)}</p>
          {guard.lastError ? (
            <div className="callout callout-danger small" style={{ marginTop: 8 }}>
              {guard.lastError}
            </div>
          ) : null}
          {(guard.warnings ?? []).map((w) => (
            <div key={w} className="callout callout-warning small" style={{ marginTop: 8 }}>
              {w}
            </div>
          ))}
          {guard.configured && guard.daemonSupportsGuard && guard.pamConfigured === false ? (
            <div className="callout callout-warning small" style={{ marginTop: 8 }}>
              The <code>pam_apparmor</code> session line is missing, so new logins are not confined. Run the installer below (it passes <code>--guard</code> while the policy has the
              guard on).
            </div>
          ) : null}
          {guard.residual.length > 0 ? (
            <details className="small" style={{ marginTop: 8 }}>
              <summary className="muted">What it cannot do ({guard.residual.length})</summary>
              <ul className="muted">
                {guard.residual.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => setAuditLog(true)} disabled={!linux}>
              Audit log…
            </button>
            {guard.configured && guard.daemonSupportsGuard ? (
              <button type="button" className="btn btn-sm" onClick={applyGuard} disabled={busy || running}>
                Apply now
              </button>
            ) : null}
          </div>
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
            <Toggle checked={autostart.enabled} disabled={busy || !linux} aria-label="Start rpchat on login" onChange={setAutostart} />
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
            <span className="item-sub">
              Creates the group and udev rule and installs the root daemon service{appInstall.canSystemInstall ? `; unpacks the AppImage to ${appInstall.dir} so updates need no password` : ''}; asks for your
              password (pkexec).
            </span>
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

      {auditLog ? <GuardAuditDialog onClose={() => setAuditLog(false)} /> : null}
      {policyDialog ? (
        <CreatePolicyDialog
          path={policy.path ?? '/etc/rpchat/policy.json'}
          sealed={policy.seal.sealed}
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
              installs and starts the <code>rpchatd</code> root daemon service (input lock, typing, emergency unlock key)
            </li>
            <li>
              creates <code>/etc/rpchat</code> for the policy file (nothing is written there; you can create the policy from this tab afterwards)
            </li>
            <li>optionally registers the app to start on login</li>
            {appInstall.canSystemInstall ? (
              <li>
                optionally unpacks this AppImage to <code>{appInstall.dir}</code> (root-owned) and points the menu and autostart entries at it, so later updates
                are installed by the daemon without a password and the previous version is kept for rollback
              </li>
            ) : null}
          </ul>
          <label className="check">
            <input type="checkbox" checked={autostartWanted} onChange={(e) => setAutostartWanted(e.target.checked)} />
            Also start rpchat on login
          </label>
          {appInstall.canSystemInstall ? (
            <label className="check">
              <input type="checkbox" checked={systemInstallWanted} onChange={(e) => setSystemInstallWanted(e.target.checked)} />
              Install the app to <code>{appInstall.dir}</code> (system install; recommended)
            </label>
          ) : null}
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

/** Pure: the Settings → System "Session guard" line (docs/system-integration.md "Session guard"). */
export function guardLine(guard: SystemIntegrationStatus['guard']): string {
  if (!guard.configured) return 'Off. The policy file has no guard block (guard.mode is off): the listed users\' sessions are not confined.';
  if (!guard.daemonSupportsGuard) return `Session guard: ${guard.mode} in the policy, but ${guard.residual[0] ?? 'the daemon does not report it'}.`;
  if (!guard.available) return `Session guard: ${guard.mode} in the policy, but unavailable: AppArmor is not active on this kernel (no /sys/kernel/security/apparmor).`;
  const users = guard.users.length > 0 ? guard.users.join(', ') : 'nobody';
  const what = [guard.shell ? `shell ${guard.shell}` : null, guard.compositor ? `compositor ${guard.compositor}` : null].filter(Boolean).join(', ');
  if (guard.loaded.length === 0) return `Session guard: ${guard.mode} (AppArmor) — nothing loaded yet — users: ${users}.`;
  return `Session guard: ${guard.mode} (AppArmor) — ${guard.loaded.length} profiles loaded — users: ${users}${what ? ` — ${what}` : ''}${guard.appliedAt ? ` — applied ${formatDateTime(guard.appliedAt)}` : ''}.`;
}

function guardBadge(guard: SystemIntegrationStatus['guard']): string {
  if (!guard.configured) return 'off';
  if (!guard.daemonSupportsGuard || !guard.available) return 'unavailable';
  if (guard.lastError) return 'error';
  if ((guard.warnings ?? []).length > 0) return `${guard.mode} (not effective)`;
  return guard.loaded.length > 0 ? guard.mode : `${guard.mode} (pending)`;
}

function guardBadgeClass(guard: SystemIntegrationStatus['guard']): string {
  if (!guard.configured) return 'badge';
  if (!guard.daemonSupportsGuard || !guard.available || guard.lastError || (guard.warnings ?? []).length > 0) return 'badge badge-warning';
  return guard.mode === 'enforce' ? 'badge badge-accent' : 'badge badge-success';
}

/** Pure: one audit-log row. */
export function guardAttemptLine(a: GuardAttemptRecord): string {
  return `${a.blocked ? 'blocked' : 'logged'} ${a.kind} ${a.operation}${a.target ? ` on ${a.target}` : ''} by ${a.command || '?'} (pid ${a.pid}) under ${a.profile}`;
}

function GuardAuditDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<GuardAttemptRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(await api().system.guardAttempts());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Modal title="Session guard: audit log" onClose={onClose} className="modal-wide">
      <p className="muted small">
        The last {rows?.length ?? 0} attempts the daemon reported since the app started (one per target every 10 s). In audit mode nothing is blocked; these are what
        enforce mode would stop. The full log is in <code>journalctl -k</code> (<code>apparmor=</code> lines with <code>profile=&quot;rpchat-…&quot;</code>).
      </p>
      {error ? <div className="callout callout-danger small">{error}</div> : null}
      {rows === null ? (
        <div className="row muted small">
          <span className="spinner" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <p className="muted small">No attempts reported yet.</p>
      ) : (
        <ul className="list small mono">
          {rows.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <span className="muted">{formatDateTime(a.at)}</span> {guardAttemptLine(a)}
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" className="btn btn-sm" onClick={load}>
          Refresh
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** Pure: the Settings → System "App install" line (docs/system-integration.md "System install"). */
export function systemInstallLine(install: SystemIntegrationStatus['install']): string {
  const versions = `${install.dir}${install.current ? ` (v${install.current})` : ''}${install.previous ? `, previous v${install.previous}` : ''}`;
  if (install.systemInstall) return `System install: ${versions}. Updates are applied by the system service.`;
  if (install.execInDir) return `System install: ${install.dir}. The daemon is not connected, so updates cannot be applied until it is.`;
  if (install.canSystemInstall) return `Running as an AppImage. The installer below can unpack it to ${install.dir} so updates are applied by the daemon without a password prompt.`;
  return `Not a system install (the app does not run from ${install.dir}).`;
}

/**
 * Pure: the Settings → System line for `app.allowQuit: false` — who manages it and which users the
 * daemon relaunches the app for (nobody when the list is empty: then a killed app stays down).
 */
export function quitDisabledLine(policy: Pick<SystemIntegrationStatus['policy'], 'managedBy' | 'users'>): string {
  const by = policy.managedBy ? ` (managed by ${policy.managedBy})` : '';
  const who = policy.users.length > 0 ? ` for: ${policy.users.join(', ')}` : '; no users are listed in app.users, so the daemon relaunches nobody';
  return `Quitting is disabled by policy${by}${who}. Closing the window hides it; Ctrl+Q and the tray do not quit.`;
}

/**
 * Pure: how the policy's `dev` block reads in Settings → System. It is the decision this process
 * started with, so it describes the running app rather than the file as it stands now.
 */
export function devLine(dev: DevRules): string {
  if (dev.allow) return dev.devTools ? 'switches available' : 'DevTools disabled';
  return dev.devTools ? 'switches locked off, DevTools left open' : 'switches and DevTools locked off';
}

/** How each `app` restriction reads in Settings → System when it is in force. */
const RESTRICTION_LABELS: Record<keyof AppRestrictions, string> = {
  allowPackEditor: 'pack editor disabled',
  allowPackRemove: 'packs cannot be removed',
  allowPackInstall: 'packs cannot be installed or replaced',
  allowStopGeneration: 'a reply cannot be stopped once it starts',
  allowDeleteSession: 'sessions cannot be deleted',
  allowDeleteHistory: 'chat history cannot be deleted',
  allowDeleteMemories: 'memories cannot be deleted',
  allowRemoveEvents: 'event handlers cannot be removed',
  allowSandbox: 'sandbox disabled',
  requireCharacterSession: 'a conversation stays open',
};

/** Pure: one label per restriction in force (an `allow*` switched off, a `require*` switched on). */
export function restrictionLabels(restrictions: AppRestrictions): string[] {
  return (Object.keys(RESTRICTION_LABELS) as Array<keyof AppRestrictions>)
    .filter((k) => (k.startsWith('require') ? restrictions[k] : !restrictions[k]))
    .map((k) => RESTRICTION_LABELS[k]);
}
