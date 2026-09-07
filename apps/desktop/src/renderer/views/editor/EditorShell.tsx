import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorProject } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { Modal } from '../../components/common/Modal';
import { suggestCharacterId as suggestId } from '../../lib/editor';
import { createSession, refreshCharacters, refreshPacks, reportError, setEditorLocation, toast } from '../../store/actions';
import type { EditorSection } from '../../store/state';
import { useAppState } from '../../store/store';
import { CharacterSection } from './CharacterSection';
import { EditorContext, type SectionHandle } from './context';
import { MediaSection } from './MediaSection';
import { PackSection } from './PackSection';
import { PublishSection } from './PublishSection';
import { ReadmeSection } from './ReadmeSection';

interface EditorShellProps {
  projectKey: string;
  active: boolean;
}

type Target = { section: EditorSection; characterDir: string | null } | { section: 'list' };

export function EditorShell({ projectKey, active }: EditorShellProps) {
  const section = useAppState((s) => s.editor.section);
  const characterDir = useAppState((s) => s.editor.characterDir);
  const [project, setProjectState] = useState<EditorProject | null>(null);
  const caps = useAppState((s) => s.capabilities);
  const [error, setError] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installed, setInstalled] = useState<{ packId: string; characters: Array<{ ref: string; name: string }> } | null>(null);
  const handleRef = useRef<SectionHandle | null>(null);

  const setProject = useCallback((p: EditorProject) => setProjectState(p), []);
  const register = useCallback((h: SectionHandle | null) => {
    handleRef.current = h;
  }, []);

  useEffect(() => {
    api()
      .editor.read(projectKey)
      .then(setProjectState)
      .catch((err) => setError(errorMessage(err)));
  }, [projectKey]);

  // Unsaved-changes guard for rail navigation and going back to the list.
  const go = useCallback((target: Target) => {
    if (handleRef.current?.dirty) {
      setPendingTarget(target);
      return;
    }
    if (target.section === 'list') setEditorLocation({ projectKey: null, characterDir: null, section: 'pack' });
    else setEditorLocation({ section: target.section, characterDir: target.characterDir });
  }, []);

  const resolvePending = async (how: 'save' | 'discard' | 'cancel') => {
    const target = pendingTarget;
    setPendingTarget(null);
    if (!target || how === 'cancel') return;
    if (how === 'save' && handleRef.current) {
      const ok = await handleRef.current.save();
      if (!ok) return;
    }
    handleRef.current = null;
    if (target.section === 'list') setEditorLocation({ projectKey: null, characterDir: null, section: 'pack' });
    else setEditorLocation({ section: target.section, characterDir: target.characterDir });
  };

  // Ctrl/Cmd+S saves the active section.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (handleRef.current?.dirty) void handleRef.current.save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const ctx = useMemo(() => (project ? { project, caps, setProject, register } : null), [project, caps, setProject, register]);

  const run = async (what: 'install' | 'export' | 'reveal') => {
    if (!project) return;
    if (handleRef.current?.dirty && what !== 'reveal') {
      toast('info', 'Save your changes first');
      return;
    }
    setBusy(what);
    try {
      if (what === 'install') {
        const view = await api().editor.installToApp(projectKey);
        await Promise.all([refreshPacks(), refreshCharacters()]);
        setInstalled({ packId: view.packId, characters: view.characters.map((c) => ({ ref: c.ref, name: c.name })) });
        setProjectState(await api().editor.read(projectKey));
        toast('success', `Installed ${view.manifest.name} ${view.manifest.version}`);
      } else if (what === 'export') {
        const file = await api().editor.exportPack(projectKey);
        if (file) toast('success', `Exported to ${file}`);
      } else {
        await api().editor.revealInFolder(projectKey);
      }
    } catch (err) {
      reportError(what === 'install' ? 'Install failed' : what === 'export' ? 'Export failed' : 'Could not reveal folder', err);
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="view">
        <div className="callout callout-danger">{error}</div>
        <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setEditorLocation({ projectKey: null })}>
          Back to projects
        </button>
      </div>
    );
  }
  if (!project || !ctx) {
    return (
      <div className="view row muted">
        <span className="spinner" /> Opening project…
      </div>
    );
  }

  const v = project.validation;
  const pill = !v.ok ? (
    <span className="badge badge-danger">{v.problems.length} problem{v.problems.length === 1 ? '' : 's'}</span>
  ) : v.warnings.length > 0 ? (
    <span className="badge badge-warning">{v.warnings.length} warning{v.warnings.length === 1 ? '' : 's'}</span>
  ) : (
    <span className="badge badge-success">valid</span>
  );

  const railItem = (label: string, target: Target, current: boolean, extra?: string) => (
    <button type="button" className="nav-item" aria-current={current ? 'page' : undefined} onClick={() => go(target)}>
      {label}
      {extra ? <span className="muted small" style={{ marginLeft: 'auto' }}>{extra}</span> : null}
    </button>
  );

  return (
    <EditorContext.Provider value={ctx}>
      <div className="editor">
        <header className="editor-header">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => go({ section: 'list' })} title="Back to projects">
            ← Projects
          </button>
          <div className="item-text">
            <div className="item-title">{project.manifest.name}</div>
            <div className="item-sub mono">
              {project.manifest.id} · {project.manifest.version}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => go({ section: 'publish', characterDir: null })} title={[...v.problems, ...v.warnings].join('\n') || 'No problems'}>
            {pill}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => run('reveal')} disabled={busy !== null}>
            Reveal folder
          </button>
          <button type="button" className="btn btn-sm" onClick={() => run('export')} disabled={busy !== null}>
            {busy === 'export' ? 'Exporting…' : 'Export .rppack'}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => run('install')} disabled={busy !== null}>
            {busy === 'install' ? 'Installing…' : 'Install to app'}
          </button>
        </header>
        <div className="editor-body">
          <nav className="editor-rail" aria-label="Editor sections">
            {railItem('Pack', { section: 'pack', characterDir: null }, section === 'pack')}
            <div className="sidebar-section-title" style={{ padding: '10px 10px 2px' }}>
              Characters
            </div>
            {project.characters.map((c) =>
              railItem(c.definition.name || c.definition.id, { section: 'character', characterDir: c.dir }, section === 'character' && characterDir === c.dir),
            )}
            <AddCharacter />
            {railItem('Media', { section: 'media', characterDir: null }, section === 'media', String(project.assets.length))}
            {railItem('README', { section: 'readme', characterDir: null }, section === 'readme')}
            {railItem('Check & publish', { section: 'publish', characterDir: null }, section === 'publish')}
          </nav>
          <div className="editor-main">
            {section === 'pack' ? <PackSection key="pack" /> : null}
            {section === 'character' && characterDir ? (
              project.characters.some((c) => c.dir === characterDir) ? (
                <CharacterSection key={characterDir} dir={characterDir} />
              ) : (
                <p className="muted">This character no longer exists.</p>
              )
            ) : null}
            {section === 'media' ? <MediaSection key="media" /> : null}
            {section === 'readme' ? <ReadmeSection key="readme" /> : null}
            {section === 'publish' ? <PublishSection key="publish" onInstall={() => run('install')} installing={busy === 'install'} /> : null}
          </div>
        </div>
      </div>
      {pendingTarget ? (
        <Modal title="Unsaved changes" onClose={() => resolvePending('cancel')}>
          <p>This section has unsaved changes. Save them before leaving?</p>
          <div className="form-actions">
            <button type="button" className="btn btn-danger" onClick={() => resolvePending('discard')}>
              Discard
            </button>
            <span className="grow" />
            <button type="button" className="btn" onClick={() => resolvePending('cancel')}>
              Stay
            </button>
            <button type="button" className="btn btn-primary" onClick={() => resolvePending('save')}>
              Save and continue
            </button>
          </div>
        </Modal>
      ) : null}
      {installed ? (
        <Modal title="Installed" onClose={() => setInstalled(null)}>
          <p>The pack is installed in the app. Start a chat?</p>
          <div className="choice-list">
            {installed.characters.map((c) => (
              <button
                key={c.ref}
                type="button"
                className="btn"
                onClick={() => {
                  setInstalled(null);
                  void createSession(c.ref);
                }}
              >
                Start a chat with {c.name}
              </button>
            ))}
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setInstalled(null)}>
              Later
            </button>
          </div>
        </Modal>
      ) : null}
    </EditorContext.Provider>
  );
}

function AddCharacter() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="nav-item muted" onClick={() => setOpen(true)}>
        + Add character
      </button>
      {open ? <AddCharacterDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddCharacterDialog({ onClose }: { onClose: () => void }) {
  const { project, setProject } = useEditorSafe();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const effectiveId = touched ? id : suggestId(name);
  const exists = project?.characters.some((c) => c.definition.id === effectiveId);
  const valid = name.trim().length > 0 && /^[a-z0-9][a-z0-9-_]*$/.test(effectiveId) && !exists;

  const add = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const p = await api().editor.addCharacter(project.summary.key, effectiveId, name.trim());
      setProject(p);
      const dir = p.characters.find((c) => c.definition.id === effectiveId)?.dir ?? null;
      setEditorLocation({ section: dir ? 'character' : 'pack', characterDir: dir });
      onClose();
    } catch (err) {
      reportError('Could not add character', err);
      setBusy(false);
    }
  };

  return (
    <Modal title="Add character" onClose={busy ? undefined : onClose}>
      <div className="field">
        <label htmlFor="ac-name">Name</label>
        <input id="ac-name" type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ac-id">Id</label>
        <input id="ac-id" type="text" className="mono" value={effectiveId} onChange={(e) => (setTouched(true), setId(e.target.value.toLowerCase()))} />
        {exists ? <span className="field-hint msg-error">A character with this id exists.</span> : null}
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={add} disabled={!valid || busy}>
          Add
        </button>
      </div>
    </Modal>
  );
}

function useEditorSafe() {
  const ctx = useContext(EditorContext);
  return { project: ctx?.project ?? null, setProject: ctx?.setProject ?? (() => undefined) };
}
