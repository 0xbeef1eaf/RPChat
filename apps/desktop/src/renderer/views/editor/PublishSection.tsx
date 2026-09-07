import { useState } from 'react';
import { api } from '../../api';
import { reportError, toast } from '../../store/actions';
import { useEditor } from './context';

interface PublishSectionProps {
  onInstall: () => void;
  installing: boolean;
}

export function PublishSection({ onInstall, installing }: PublishSectionProps) {
  const { project, setProject } = useEditor();
  const [busy, setBusy] = useState<string | null>(null);
  const v = project.validation;

  const revalidate = async () => {
    setBusy('validate');
    try {
      const validation = await api().editor.validate(project.summary.key);
      setProject({ ...project, validation });
    } catch (err) {
      reportError('Validation failed', err);
    } finally {
      setBusy(null);
    }
  };

  const exportPack = async () => {
    setBusy('export');
    try {
      const file = await api().editor.exportPack(project.summary.key);
      if (file) toast('success', `Exported to ${file}`);
    } catch (err) {
      reportError('Export failed', err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="view-narrow">
      <div className="section-head">
        <h1>Check & publish</h1>
        <button type="button" className="btn btn-sm" onClick={revalidate} disabled={busy !== null}>
          {busy === 'validate' ? 'Checking…' : 'Re-run checks'}
        </button>
      </div>
      <div className={`callout ${!v.ok ? 'callout-danger' : v.warnings.length ? 'callout-warning' : 'callout-success'}`}>
        {!v.ok ? (
          <>
            <strong>{v.problems.length} problem{v.problems.length === 1 ? '' : 's'}</strong> — fix these before installing or exporting.
          </>
        ) : v.warnings.length ? (
          <>
            <strong>Valid</strong> with {v.warnings.length} warning{v.warnings.length === 1 ? '' : 's'}.
          </>
        ) : (
          <strong>Valid pack.</strong>
        )}
      </div>
      {v.problems.length > 0 ? (
        <section className="section" style={{ marginTop: 14 }}>
          <h2>Problems</h2>
          <ul className="problem-list">
            {v.problems.map((p, i) => (
              <li key={i} className="msg-error">
                {p}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {v.warnings.length > 0 ? (
        <section className="section" style={{ marginTop: 14 }}>
          <h2>Warnings</h2>
          <ul className="problem-list">
            {v.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="section" style={{ marginTop: 18 }}>
        <h2>Publish</h2>
        <div className="stack" style={{ gap: 10 }}>
          <div className="card row">
            <div className="item-text">
              <span className="item-title">Install to this app</span>
              <span className="item-sub">Installs the project folder as a pack (replacing an installed pack with the same id; grants are kept). Then start a chat.</span>
            </div>
            <button type="button" className="btn btn-primary" onClick={onInstall} disabled={installing || !v.ok}>
              {installing ? 'Installing…' : project.summary.installed ? 'Reinstall' : 'Install'}
            </button>
          </div>
          <div className="card row">
            <div className="item-text">
              <span className="item-title">Export .rppack</span>
              <span className="item-sub">A zip of the folder you can share. Others install it from the Packs view.</span>
            </div>
            <button type="button" className="btn" onClick={exportPack} disabled={busy !== null || !v.ok}>
              {busy === 'export' ? 'Exporting…' : 'Export…'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
