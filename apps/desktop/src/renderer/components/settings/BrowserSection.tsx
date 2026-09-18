import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, BrowserBlock, BrowserBridgeStatus } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { reportError, toast } from '../../store/actions';
import { Modal } from '../common/Modal';
import { ManagedBadge, useManaged } from './Managed';

type InstallerOutput = { ok: boolean; text: string; what: string };

interface BrowserSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
}

/** Settings → Browser: bridge status, port, trusted extensions, what characters may do, active blocks, policy install, load-unpacked help. */
export function BrowserSection({ settings, onPatch }: BrowserSectionProps) {
  const [status, setStatus] = useState<BrowserBridgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portText, setPortText] = useState<string | null>(null);
  const [trustText, setTrustText] = useState('');
  const [extraDirsText, setExtraDirsText] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<BrowserBlock[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<'install' | 'remove' | null>(null);
  const [output, setOutput] = useState<InstallerOutput | null>(null);
  const [installDialog, setInstallDialog] = useState(false);
  const [removeDialog, setRemoveDialog] = useState(false);
  const browser = settings.browser;
  const blockingManaged = useManaged('browser.allowBlocking');
  const evalManaged = useManaged('browser.allowEval');
  const historyManaged = useManaged('browser.allowHistory');

  const loadBlocks = useCallback(async () => {
    try {
      setBlocks(await api().browser.blocks());
    } catch {
      setBlocks([]);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setStatus(await api().browser.status());
      setError(null);
      await loadBlocks();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [loadBlocks]);

  useEffect(() => {
    void load();
    return api().browser.onStatus((s) => {
      setStatus(s);
      void loadBlocks();
    });
  }, [load, loadBlocks]);

  // Blocks come and go on their own (expiry, the character); keep the list fresh while the tab is open.
  useEffect(() => {
    if (!status?.connected) return;
    const timer = setInterval(() => void loadBlocks(), 10_000);
    return () => clearInterval(timer);
  }, [status?.connected, loadBlocks]);

  const patchBrowser = (patch: Partial<AppSettings['browser']>) => onPatch({ browser: { ...browser, ...patch } });

  const saveExtraDirs = async () => {
    if (extraDirsText === null) return;
    const dirs = extraDirsText
      .split(/[\n,]/)
      .map((d) => d.trim().replace(/\/+$/, ''))
      .filter((d) => d.length > 0);
    setExtraDirsText(null);
    if (dirs.join('\n') === browser.extraPolicyDirs.join('\n')) return;
    const bad = dirs.find((d) => !/^\/[^\s|"'\\]+\/policies\/managed$/.test(d));
    if (bad) {
      toast('error', `"${bad}" is not a managed-policy directory (absolute path ending in /policies/managed)`);
      return;
    }
    if (await patchBrowser({ extraPolicyDirs: dirs })) toast('success', dirs.length === 0 ? 'Extra policy directories cleared' : 'Extra policy directories saved; re-install the policy to write them');
  };

  const clearBlocks = async () => {
    setBusy(true);
    try {
      const r = await api().browser.clearBlocks();
      toast('success', r.removed === 0 ? 'No blocks to clear' : `Cleared ${r.removed} block${r.removed === 1 ? '' : 's'}`);
      await loadBlocks();
    } catch (err) {
      reportError('Could not clear the blocks', err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('success', `${what} copied`);
    } catch (err) {
      reportError('Could not copy', err);
    }
  };

  const savePort = async () => {
    if (portText === null || !status) return;
    const port = Number(portText);
    setPortText(null);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === status.requestedPort) return;
    setBusy(true);
    try {
      setStatus(await api().browser.setPort(port));
      toast('success', `Bridge port set to ${port}. Re-install the browser policy so the extension follows.`);
    } catch (err) {
      reportError('Could not change the bridge port', err);
    } finally {
      setBusy(false);
    }
  };

  const trust = async (id: string) => {
    const clean = id.trim().toLowerCase();
    if (!clean) return;
    setBusy(true);
    try {
      setStatus(await api().browser.trust(clean));
      setTrustText('');
      toast('success', `Extension ${clean} allowed`);
    } catch (err) {
      reportError('Could not allow the extension', err);
    } finally {
      setBusy(false);
    }
  };

  const untrust = async (id: string) => {
    setBusy(true);
    try {
      setStatus(await api().browser.untrust(id));
      toast('success', `Extension ${id} removed`);
    } catch (err) {
      reportError('Could not remove the extension', err);
    } finally {
      setBusy(false);
    }
  };

  const runInstaller = async (what: 'install' | 'remove') => {
    setInstallDialog(false);
    setRemoveDialog(false);
    setRunning(what);
    setOutput(null);
    try {
      const r = what === 'install' ? await api().browser.installPolicy() : await api().browser.removePolicy();
      setOutput({ ok: r.ok, text: r.output || (r.ok ? 'Done.' : 'The installer reported a failure without output.'), what });
      toast(r.ok ? 'success' : 'error', r.ok ? (what === 'install' ? 'Browser policy installed' : 'Browser policy removed') : 'Installer failed');
      await load();
    } catch (err) {
      setOutput({ ok: false, text: errorMessage(err), what });
      reportError('Installer failed', err);
    } finally {
      setRunning(null);
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

  const portMismatch = status.requestedPort !== status.port;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row">
        <p className="muted small grow">
          Characters with the <code>browser</code> capability can open, read and drive tabs in your Chromium-based browser (Chrome, Chromium, Brave,
          Edge, Vivaldi, Opera…) through the <strong>rpchat browser bridge</strong> extension. The extension only ever talks to this app on{' '}
          <code>127.0.0.1</code>, and every extension has to be allowed here once before it can connect.
        </p>
        <button type="button" className="btn btn-sm" onClick={load} disabled={running !== null}>
          Refresh
        </button>
      </div>

      <div className="cap-cards">
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Extension</h3>
            <span className={status.connected ? 'badge badge-success' : 'badge badge-danger'}>{status.connected ? 'connected' : 'not connected'}</span>
          </div>
          <dl className="kv small">
            {status.connected ? (
              <>
                <dt>Browser</dt>
                <dd>{status.browser ?? 'unknown'}</dd>
                <dt>Extension id</dt>
                <dd className="mono">{status.extensionId}</dd>
              </>
            ) : (
              <>
                <dt>Waiting</dt>
                <dd className="muted">install the policy below, or load the extension unpacked; it connects on its own within 30 s</dd>
              </>
            )}
            <dt>Bridge port</dt>
            <dd>
              <span className="row" style={{ gap: 6 }}>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  style={{ width: 110 }}
                  value={portText ?? String(status.requestedPort)}
                  disabled={busy}
                  onChange={(e) => setPortText(e.target.value)}
                  onBlur={savePort}
                  onKeyDown={(e) => e.key === 'Enter' && savePort()}
                  aria-label="Bridge port"
                />
                {portMismatch ? (
                  <span className="badge badge-warning">
                    port {status.requestedPort} was taken — listening on {status.port}
                  </span>
                ) : null}
              </span>
            </dd>
          </dl>
          {portMismatch ? (
            <div className="callout callout-warning small" style={{ marginTop: 8 }}>
              The extension looks for the app on port {status.requestedPort}. Choose a free port here (then re-install the policy, or set it in the
              extension&apos;s popup), or stop whatever is using {status.requestedPort} and restart rpchat.
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Allowed extensions</h3>
            <span className="badge">{status.trusted.length}</span>
          </div>
          {status.trusted.length === 0 ? (
            <p className="muted small">None yet. The first time an extension connects, rpchat asks you whether to allow it.</p>
          ) : (
            <ul className="plain-list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {status.trusted.map((id) => (
                <li key={id} className="row" style={{ gap: 8, padding: '3px 0' }}>
                  <code className="grow" style={{ overflowWrap: 'anywhere' }}>
                    {id}
                  </code>
                  {status.extensionId === id ? <span className="badge badge-success">connected</span> : null}
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => untrust(id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {status.denied.length > 0 ? (
            <div className="callout callout-warning small" style={{ marginTop: 8 }}>
              Refused this session: {status.denied.map((id) => <code key={id}>{id}</code>)}. Allow one below to let it connect.
            </div>
          ) : null}
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <input
              type="text"
              className="mono grow"
              placeholder="extension id (32 letters a–p)"
              value={trustText}
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setTrustText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && trust(trustText)}
              aria-label="Extension id to allow"
            />
            <button type="button" className="btn btn-sm" disabled={busy || trustText.trim().length !== 32} onClick={() => trust(trustText)}>
              Allow
            </button>
          </div>
        </div>
      </div>

      <div className="cap-cards">
        <div className="card">
          <h3 style={{ margin: '0 0 6px' }}>What characters may do</h3>
          <p className="muted small" style={{ margin: '0 0 8px' }}>
            Beyond opening, reading and driving tabs, a character with the <code>browser</code> capability can do the following unless you switch
            it off here. A switched-off call fails and the character is told why.
          </p>
          <div className="stack" style={{ gap: 8 }}>
            <label className="check">
              <input type="checkbox" checked={browser.allowBlocking} disabled={blockingManaged || busy} onChange={(e) => void patchBrowser({ allowBlocking: e.target.checked })} />
              Block pages for a while (<code>sdk.browser.block</code>)
              <ManagedBadge show={blockingManaged} />
            </label>
            <label className="check">
              <input type="checkbox" checked={browser.allowEval} disabled={evalManaged || busy} onChange={(e) => void patchBrowser({ allowEval: e.target.checked })} />
              Run JavaScript in pages (<code>sdk.browser.eval</code>)
              <ManagedBadge show={evalManaged} />
            </label>
            <label className="check">
              <input type="checkbox" checked={browser.allowHistory} disabled={historyManaged || busy} onChange={(e) => void patchBrowser({ allowHistory: e.target.checked })} />
              Read the browser history (<code>sdk.browser.history</code>)
              <ManagedBadge show={historyManaged} />
            </label>
            <dl className="kv small" style={{ marginTop: 4 }}>
              <dt>Home page</dt>
              <dd>{browser.homePage ? <code style={{ overflowWrap: 'anywhere' }}>{browser.homePage}</code> : <span className="muted">not set — new tabs show the plain page</span>}</dd>
            </dl>
            <span className="field-hint">
              What new tabs open (the extension overrides the new-tab page). Only a character sets it, with <code>sdk.browser.setHomePage</code>; ask
              yours to change or clear it.
            </span>
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 className="grow">Active blocks</h3>
            <span className="badge">{blocks.length}</span>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy || !status.connected || blocks.length === 0} onClick={clearBlocks}>
              Clear all blocks
            </button>
          </div>
          {!status.connected ? (
            <p className="muted small">Blocks live in the extension; connect it to see them.</p>
          ) : blocks.length === 0 ? (
            <p className="muted small">No pages are blocked right now.</p>
          ) : (
            <ul className="plain-list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {blocks.map((b) => (
                <li key={b.id} className="stack" style={{ gap: 2, padding: '4px 0' }}>
                  <code style={{ overflowWrap: 'anywhere' }}>{b.patterns.join(', ')}</code>
                  <span className="muted small">
                    {b.mode === 'allow' ? 'the only pages that may open · ' : ''}
                    {b.by ? `by ${b.by}` : 'by a character'}
                    {b.expiresAt ? ` · until ${new Date(b.expiresAt).toLocaleString()}` : ' · no expiry'}
                    {b.redirect ? ` · redirects to ${b.redirect}` : ''}
                    {b.reason ? ` · “${b.reason}”` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row wrap">
          <div className="grow">
            <h3 style={{ margin: 0 }}>Install browser policy</h3>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Writes a managed policy for Chromium, Chrome and every other Chromium-based browser found on this machine that force-installs the bundled
              extension from this app and pins the port; asks for your password (pkexec). The file is for your user account alone — owned by root, so
              nothing here can be edited without a password, and readable only by you, so other users of this computer keep their own.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setInstallDialog(true)}
            disabled={running !== null || !status.installedExtensionId || !status.extensionDir}
          >
            {running === 'install' ? 'Running…' : 'Install browser policy…'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setRemoveDialog(true)} disabled={running !== null}>
            {running === 'remove' ? 'Running…' : 'Remove policy'}
          </button>
        </div>
        <dl className="kv small" style={{ marginTop: 8 }}>
          <dt>Extension id</dt>
          <dd>
            {status.installedExtensionId ? (
              <span className="row" style={{ gap: 6 }}>
                <code style={{ overflowWrap: 'anywhere' }}>{status.installedExtensionId}</code>
                <button type="button" className="btn btn-sm" onClick={() => copy(status.installedExtensionId ?? '', 'Extension id')}>
                  Copy
                </button>
              </span>
            ) : (
              <span className="muted">not available (the signing key could not be created)</span>
            )}
          </dd>
          <dt>Update URL</dt>
          <dd>
            <span className="row" style={{ gap: 6 }}>
              <code style={{ overflowWrap: 'anywhere' }}>{status.updateUrl}</code>
              <button type="button" className="btn btn-sm" onClick={() => copy(status.updateUrl, 'Update URL')}>
                Copy
              </button>
            </span>
          </dd>
          {status.extensionVersion ? (
            <>
              <dt>Bundled version</dt>
              <dd>{status.extensionVersion}</dd>
            </>
          ) : null}
        </dl>
        {!status.extensionDir ? <p className="field-hint">The browser extension is not bundled with this build (resources/extension).</p> : null}
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor="browser-extra-dirs">Extra policy directories</label>
          <textarea
            id="browser-extra-dirs"
            rows={2}
            className="mono"
            placeholder={'/etc/helium/policies/managed\n/etc/ungoogled-chromium/policies/managed'}
            value={extraDirsText ?? browser.extraPolicyDirs.join('\n')}
            disabled={busy || running !== null}
            spellCheck={false}
            onChange={(e) => setExtraDirsText(e.target.value)}
            onBlur={saveExtraDirs}
          />
          <span className="field-hint">
            One per line (or comma separated): managed-policy directories of Chromium forks the installer does not know (Helium, ungoogled-chromium
            derivatives…). They get the same file, and <em>Remove policy</em> cleans them too. Find a browser&apos;s directory
            with <code>chrome://policy</code> or <code>strace -f -e trace=openat &lt;browser&gt; 2&gt;&amp;1 | grep policies/managed</code>.
          </span>
        </div>
        <p className="field-hint" style={{ marginTop: 6 }}>
          Google Chrome on Windows and macOS only force-installs extensions from the Chrome Web Store, so this policy has no effect there; Chrome on
          Linux and every Chromium build (Chromium, Brave, Edge, Vivaldi, Opera…) accept it. Flatpak browsers keep their policies elsewhere — see the
          documentation.
        </p>
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

      <div className="card">
        <h3 style={{ margin: 0 }}>Developers: load the extension unpacked</h3>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          Open <code>chrome://extensions</code>, switch on <em>Developer mode</em>, choose <em>Load unpacked</em> and pick this folder. An unpacked copy
          gets its own id; rpchat asks you to allow it when it first connects.
        </p>
        {status.extensionDir ? (
          <div className="row" style={{ marginTop: 8 }}>
            <code className="grow" style={{ overflowWrap: 'anywhere' }}>
              {status.extensionDir}
            </code>
            <button type="button" className="btn btn-sm" onClick={() => copy(status.extensionDir ?? '', 'Path')}>
              Copy
            </button>
          </div>
        ) : (
          <p className="field-hint">Not available in this build.</p>
        )}
      </div>

      {installDialog ? (
        <Modal title="Install the browser policy?" onClose={() => setInstallDialog(false)}>
          <p>The installer runs with administrator rights and writes one policy file per browser:</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              <code>rpchat-&lt;your user name&gt;.json</code> in <code>/etc/chromium/policies/managed</code> and{' '}
              <code>/etc/opt/chrome/policies/managed</code>, plus the same for Brave, Edge, Vivaldi and Opera when they are installed
              {browser.extraPolicyDirs.length > 0 ? (
                <>
                  , and in {browser.extraPolicyDirs.map((d) => <code key={d}>{d}</code>).reduce<React.ReactNode[]>((acc, el, i) => (i === 0 ? [el] : [...acc, ', ', el]), [])}
                </>
              ) : null}
            </li>
            <li>
              it force-installs extension <code>{status.installedExtensionId}</code> from <code>{status.updateUrl}</code> (this app, on this computer only)
              and tells it to use port {status.requestedPort}
            </li>
            <li>
              the file stays owned by root and only your account may read it, so no character and no program of yours can change the policy, and another
              user&apos;s browser ignores it
            </li>
          </ul>
          <p className="muted small">
            The browser installs the extension within a few minutes or at its next start; the extension then connects to rpchat on its own. Remove the
            policy with the button next to this one.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setInstallDialog(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => runInstaller('install')}>
              Install
            </button>
          </div>
        </Modal>
      ) : null}

      {removeDialog ? (
        <Modal title="Remove the browser policy?" onClose={() => setRemoveDialog(false)}>
          <p>
            Deletes the policy files the installer wrote for your user account (administrator rights, pkexec); other users&apos; are left alone.
            Browsers uninstall the force-installed extension on their next policy refresh.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setRemoveDialog(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={() => runInstaller('remove')}>
              Remove
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
