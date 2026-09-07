import { useCallback, useEffect, useState } from 'react';
import type { EditorProjectSummary } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { EmptyState } from '../../components/common/EmptyState';
import { ConfirmDialog, Modal } from '../../components/common/Modal';
import { isValidCharacterId, isValidPackId, suggestCharacterId, suggestPackId } from '../../lib/editor';
import { formatRelative } from '../../lib/format';
import { reportError, setEditorLocation, toast } from '../../store/actions';
import { useAppState } from '../../store/store';

export function ProjectList() {
  const [projects, setProjects] = useState<EditorProjectSummary[] | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [forgetting, setForgetting] = useState<EditorProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, ws] = await Promise.all([api().editor.listProjects(), api().editor.workspaceDir()]);
      setProjects(list.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
      setWorkspace(ws);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (key: string) => setEditorLocation({ projectKey: key, section: 'pack', characterDir: null });

  const openFolder = async () => {
    setBusy(true);
    try {
      const p = await api().editor.open();
      if (p) open(p.summary.key);
    } catch (err) {
      reportError('Could not open folder', err);
    } finally {
      setBusy(false);
    }
  };

  const forget = async (p: EditorProjectSummary) => {
    setForgetting(null);
    try {
      await api().editor.forget(p.key);
      await load();
    } catch (err) {
      reportError('Could not remove project', err);
    }
  };

  const actions = (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} disabled={busy}>
        New pack
      </button>
      <button type="button" className="btn" onClick={openFolder} disabled={busy}>
        Open folder…
      </button>
      <button type="button" className="btn" onClick={() => setImporting(true)} disabled={busy}>
        Import installed pack…
      </button>
    </>
  );

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Pack editor</h1>
          {workspace ? (
            <div className="muted small mono" title="New packs are created here">
              {workspace}
            </div>
          ) : null}
        </div>
        <div className="row">{actions}</div>
      </div>
      {error ? <div className="callout callout-danger">{error}</div> : null}
      {projects === null ? (
        <div className="row muted">
          <span className="spinner" /> Loading…
        </div>
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet" actions={actions}>
          A project is a pack folder on disk. Start a new one, open an existing pack folder, or copy an installed pack into the
          workspace to tweak it. Every edit is written straight to the folder, so the project is always a real pack.
        </EmptyState>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <article key={p.key} className="card project-card">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="item-text">
                  <div className="pack-title">
                    <h2>{p.name || p.packId}</h2>
                    <span className="badge">{p.version}</span>
                    {p.installed ? <span className="badge badge-success">installed</span> : null}
                  </div>
                  <span className="muted small mono">{p.packId}</span>
                  <span className="muted small">
                    {p.characterCount} character{p.characterCount === 1 ? '' : 's'} · edited {formatRelative(p.updatedAt)}
                  </span>
                  <span className="muted small mono" style={{ overflowWrap: 'anywhere' }}>
                    {p.dir}
                  </span>
                </div>
              </div>
              <div className="form-actions" style={{ marginTop: 10 }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForgetting(p)} title="Remove from this list; files stay on disk">
                  Forget
                </button>
                <span className="grow" />
                <button type="button" className="btn btn-sm btn-primary" onClick={() => open(p.key)}>
                  Open
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {creating ? <NewPackDialog onClose={() => setCreating(false)} onCreated={(key) => (setCreating(false), open(key))} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} onImported={(key) => (setImporting(false), open(key))} /> : null}
      {forgetting ? (
        <ConfirmDialog
          title={`Forget ${forgetting.name}?`}
          message="The project is removed from this list only; nothing is deleted from disk."
          confirmLabel="Forget"
          onCancel={() => setForgetting(null)}
          onConfirm={() => forget(forgetting)}
        />
      ) : null}
    </div>
  );
}

function NewPackDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const userName = useAppState((s) => s.settings?.userDisplayName);
  const [name, setName] = useState('');
  const [packId, setPackId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [characterName, setCharacterName] = useState('');
  const [busy, setBusy] = useState(false);

  const effectiveId = idTouched ? packId : suggestPackId(name, userName);
  const characterId = suggestCharacterId(characterName || name);
  const valid = name.trim().length > 0 && isValidPackId(effectiveId) && characterName.trim().length > 0 && isValidCharacterId(characterId);

  const create = async () => {
    setBusy(true);
    try {
      const p = await api().editor.create({ packId: effectiveId, name: name.trim(), characterId, characterName: characterName.trim() });
      toast('success', `Created ${p.manifest.name}`);
      onCreated(p.summary.key);
    } catch (err) {
      reportError('Could not create pack', err);
      setBusy(false);
    }
  };

  return (
    <Modal title="New pack" onClose={busy ? undefined : onClose}>
      <div className="field">
        <label htmlFor="np-name">Pack name</label>
        <input id="np-name" type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Luna" />
      </div>
      <div className="field">
        <label htmlFor="np-id">Pack id</label>
        <input
          id="np-id"
          type="text"
          className="mono"
          value={effectiveId}
          onChange={(e) => (setIdTouched(true), setPackId(e.target.value.toLowerCase()))}
          spellCheck={false}
        />
        <span className="field-hint">
          Reverse-DNS, lower-case: <code>com.you.pack</code>. Suggested from your display name and the pack name.
          {effectiveId && !isValidPackId(effectiveId) ? <strong className="msg-error"> Invalid id.</strong> : null}
        </span>
      </div>
      <div className="field">
        <label htmlFor="np-char">First character name</label>
        <input id="np-char" type="text" value={characterName} onChange={(e) => setCharacterName(e.target.value)} placeholder="Luna" />
        <span className="field-hint">
          Character id: <code>{characterId}</code>
        </span>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={create} disabled={!valid || busy}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Modal>
  );
}

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (key: string) => void }) {
  const packs = useAppState((s) => s.packs);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (packId: string) => {
    setBusy(packId);
    try {
      const p = await api().editor.importInstalled(packId);
      toast('success', `Copied ${p.manifest.name} into the workspace`);
      onImported(p.summary.key);
    } catch (err) {
      reportError('Import failed', err);
      setBusy(null);
    }
  };
  return (
    <Modal title="Import an installed pack" onClose={busy ? undefined : onClose}>
      <p className="muted small">The installed files are copied into the workspace; the installed pack itself is not changed until you install the project back.</p>
      {packs.length === 0 ? <p className="muted">No packs installed.</p> : null}
      <div className="stack">
        {packs.map((p) => (
          <div key={p.packId} className="provider-row">
            <div className="item-text">
              <span className="item-title">{p.manifest.name}</span>
              <span className="item-sub mono">
                {p.packId} · {p.version}
              </span>
            </div>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => run(p.packId)} disabled={busy !== null}>
              {busy === p.packId ? 'Copying…' : 'Import'}
            </button>
          </div>
        ))}
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy !== null}>
          Close
        </button>
      </div>
    </Modal>
  );
}
