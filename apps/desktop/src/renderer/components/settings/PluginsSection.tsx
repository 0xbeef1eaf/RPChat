import { useCallback, useEffect, useState } from 'react';
import type { PluginInfo } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { refreshCapabilities, reportError, toast } from '../../store/actions';
import { ConfirmDialog, Modal } from '../common/Modal';
import { Toggle } from '../common/Toggle';

const PERMISSION_CLS: Record<PluginInfo['modules'][number]['permission'], string> = {
  trusted: 'badge badge-success',
  pack: 'badge badge-accent',
  prompt: 'badge badge-warning',
};

const STATE_CLS: Record<PluginInfo['state'], string> = {
  active: 'badge badge-success',
  disabled: 'badge',
  error: 'badge badge-danger',
};

export function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [trustDialog, setTrustDialog] = useState(false);
  const [removing, setRemoving] = useState<PluginInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, d] = await Promise.all([api().plugins.list(), api().plugins.pluginsDir()]);
      setPlugins(list.slice().sort((a, b) => a.name.localeCompare(b.name)));
      setDir(d);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setPlugins([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every change to the plugin set changes the SDK registry: refresh both. */
  const afterChange = async () => {
    await Promise.all([load(), refreshCapabilities().catch((err) => console.error('capabilities refresh failed', err))]);
  };

  const install = async () => {
    setTrustDialog(false);
    setBusy('install');
    try {
      const p = await api().plugins.install();
      if (p) {
        toast(p.state === 'error' ? 'error' : 'success', p.state === 'error' ? `${p.name} installed but failed to load: ${p.error ?? 'unknown error'}` : `Installed ${p.name} ${p.version}`);
        await afterChange();
      }
    } catch (err) {
      reportError('Plugin install failed', err);
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (p: PluginInfo, enabled: boolean) => {
    setBusy(p.id);
    try {
      const next = await api().plugins.setEnabled(p.id, enabled);
      setPlugins((list) => (list ? list.map((x) => (x.id === next.id ? next : x)) : list));
      await afterChange();
    } catch (err) {
      reportError(enabled ? 'Could not enable plugin' : 'Could not disable plugin', err);
    } finally {
      setBusy(null);
    }
  };

  const reload = async (p: PluginInfo) => {
    setBusy(p.id);
    try {
      const next = await api().plugins.reload(p.id);
      setPlugins((list) => (list ? list.map((x) => (x.id === next.id ? next : x)) : list));
      toast(next.state === 'error' ? 'error' : 'success', next.state === 'error' ? `${next.name}: ${next.error ?? 'failed to load'}` : `Reloaded ${next.name}`);
      await afterChange();
    } catch (err) {
      reportError('Reload failed', err);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: PluginInfo) => {
    setRemoving(null);
    setBusy(p.id);
    try {
      await api().plugins.remove(p.id);
      toast('info', `Removed ${p.name}`);
      await afterChange();
    } catch (err) {
      reportError('Could not remove plugin', err);
    } finally {
      setBusy(null);
    }
  };

  const openFolder = () => api().plugins.openFolder().catch((err) => reportError('Could not open folder', err));

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap">
        <p className="muted small grow" style={{ minWidth: 240 }}>
          Plugins add SDK modules (typings, docs and a host implementation). They run as <strong>trusted code inside the app</strong>; the
          modules they add still go through the normal permission policy for packs.
        </p>
        <button type="button" className="btn btn-sm" onClick={openFolder}>
          Open plugins folder
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setTrustDialog(true)} disabled={busy !== null}>
          {busy === 'install' ? 'Installing…' : 'Install from folder…'}
        </button>
      </div>
      {dir ? (
        <div className="muted small mono" style={{ overflowWrap: 'anywhere' }} title="Plugins directory">
          {dir}
        </div>
      ) : null}
      {error ? <div className="callout callout-danger small">{error}</div> : null}
      {plugins === null ? (
        <div className="row muted small">
          <span className="spinner" /> Loading…
        </div>
      ) : plugins.length === 0 ? (
        <p className="muted">No plugins installed. A plugin is a folder with a <code>plugin.json</code> and an entry module.</p>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {plugins.map((p) => (
            <article key={p.id} className="card">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="item-text">
                  <div className="pack-title">
                    <h3>{p.name}</h3>
                    <span className="badge">{p.version}</span>
                    <span className={STATE_CLS[p.state]}>{p.state}</span>
                    <span className="muted small mono">{p.id}</span>
                  </div>
                  {p.description ? <p className="muted small">{p.description}</p> : null}
                  <p className="muted small">
                    {p.author ? (
                      <>
                        by{' '}
                        {p.author.url ? (
                          <a href={p.author.url} onClick={(e) => (e.preventDefault(), window.open(p.author!.url!, '_blank', 'noopener,noreferrer'))}>
                            {p.author.name}
                          </a>
                        ) : (
                          p.author.name
                        )}
                        {' · '}
                      </>
                    ) : null}
                    <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {p.dir}
                    </span>
                  </p>
                </div>
                <Toggle checked={p.enabled} disabled={busy !== null} aria-label={`Enable ${p.name}`} onChange={(v) => setEnabled(p, v)} />
              </div>
              {p.state === 'error' && p.error ? (
                <div className="callout callout-danger small" style={{ marginTop: 8 }}>
                  <pre style={{ background: 'transparent', border: 0, padding: 0, whiteSpace: 'pre-wrap' }}>
                    <code>{p.error}</code>
                  </pre>
                </div>
              ) : null}
              <div className="cap-list" style={{ marginTop: 8 }}>
                {p.modules.length === 0 ? <span className="muted small">Declares no modules.</span> : null}
                {p.modules.map((m) => (
                  <div key={m.id} className="cap-row">
                    <div className="item-text">
                      <span className="item-title">
                        {m.title} <span className="muted mono small">sdk.{m.id}</span>
                      </span>
                      <span className="item-sub">
                        {m.methods.length} method{m.methods.length === 1 ? '' : 's'}
                        {m.methods.length > 0 ? `: ${m.methods.slice(0, 6).join(', ')}${m.methods.length > 6 ? ', …' : ''}` : ''}
                      </span>
                    </div>
                    <span className={PERMISSION_CLS[m.permission]}>{m.permission}</span>
                  </div>
                ))}
              </div>
              <div className="form-actions" style={{ marginTop: 10 }}>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setRemoving(p)} disabled={busy !== null}>
                  Remove
                </button>
                <span className="grow" />
                <button type="button" className="btn btn-sm" onClick={() => reload(p)} disabled={busy !== null} title="Re-import the entry module (plugin development)">
                  {busy === p.id ? 'Working…' : 'Reload'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {trustDialog ? (
        <Modal title="Install a plugin?" onClose={() => setTrustDialog(false)}>
          <div className="callout callout-warning">
            <strong>Plugins run as trusted code with the same access as the app.</strong> A plugin can read and write your files, run programs and
            reach the network without any of the sandbox limits that apply to characters. Only install plugins from sources you trust.
          </div>
          <p className="muted small">You will pick the plugin folder next; it is copied into the plugins directory and loaded.</p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setTrustDialog(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={install}>
              I trust it, choose folder…
            </button>
          </div>
        </Modal>
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message="The plugin is unloaded and its folder deleted from the plugins directory. Characters lose the modules it provided."
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      ) : null}
    </div>
  );
}
