import { useCallback, useEffect, useState } from 'react';
import type { PackManifest } from '@rp/shared';
import { api } from '../../api';
import { TagInput } from '../../components/editor/TagInput';
import { isSemver, isValidPackId } from '../../lib/editor';
import { reportError, toast } from '../../store/actions';
import { useDraft, useEditor } from './context';
import { SaveBar } from './SaveBar';

export function PackSection() {
  const { project, setProject } = useEditor();
  const [idUnlocked, setIdUnlocked] = useState(false);

  const save = useCallback(
    async (draft: PackManifest) => {
      try {
        const p = await api().editor.saveManifest(project.summary.key, draft);
        setProject(p);
        toast('success', 'pack.json saved');
        return p.manifest;
      } catch (err) {
        reportError('Could not save pack.json', err);
        return null;
      }
    },
    [project.summary.key, setProject],
  );

  const d = useDraft<PackManifest>(project.manifest, save);
  const { draft, edit } = d;
  // External refresh (e.g. after adding a character): keep local edits, take the new character list.
  useEffect(() => {
    d.external(project.manifest, (dr, saved) => ({ ...dr, characters: saved.characters }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.manifest]);

  const author = draft.author ?? { name: '' };
  const setAuthor = (patch: Partial<typeof author>) => {
    const next = { ...author, ...patch };
    edit({ author: next.name.trim() || next.url ? next : undefined });
  };

  return (
    <div>
      <div className="section-head">
        <h1>Pack</h1>
      </div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="pk-id">Pack id</label>
          <div className="input-with-btn">
            <input id="pk-id" type="text" className="mono" value={draft.id} disabled={!idUnlocked} onChange={(e) => edit({ id: e.target.value.toLowerCase() })} />
            <button type="button" className="btn btn-sm" onClick={() => setIdUnlocked((v) => !v)} title="Changing the id makes it a different pack for the app">
              {idUnlocked ? 'Lock' : 'Advanced'}
            </button>
          </div>
          <span className="field-hint">{isValidPackId(draft.id) ? 'Reverse-DNS id; locked after creation.' : <strong className="msg-error">Invalid id (lower-case reverse-DNS).</strong>}</span>
        </div>
        <div className="field">
          <label htmlFor="pk-name">Name</label>
          <input id="pk-name" type="text" value={draft.name} onChange={(e) => edit({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pk-version">Version</label>
          <input id="pk-version" type="text" className="mono" value={draft.version} onChange={(e) => edit({ version: e.target.value.trim() })} />
          <span className="field-hint">{isSemver(draft.version) ? 'Semantic version (major.minor.patch).' : <strong className="msg-error">Not a semver (e.g. 1.0.0).</strong>}</span>
        </div>
        <div className="field">
          <label htmlFor="pk-license">License</label>
          <input id="pk-license" type="text" value={draft.license ?? ''} placeholder="CC-BY-4.0" onChange={(e) => edit({ license: e.target.value || undefined })} />
        </div>
        <div className="field">
          <label htmlFor="pk-author">Author name</label>
          <input id="pk-author" type="text" value={author.name} onChange={(e) => setAuthor({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pk-author-url">Author URL</label>
          <input id="pk-author-url" type="url" value={author.url ?? ''} onChange={(e) => setAuthor({ url: e.target.value || undefined })} />
        </div>
        <div className="field">
          <label htmlFor="pk-homepage">Homepage</label>
          <input id="pk-homepage" type="url" value={draft.homepage ?? ''} onChange={(e) => edit({ homepage: e.target.value || undefined })} />
        </div>
        <div className="field">
          <label htmlFor="pk-minapp">Min app version</label>
          <input id="pk-minapp" type="text" className="mono" value={draft.minAppVersion ?? ''} placeholder="0.1.0" onChange={(e) => edit({ minAppVersion: e.target.value.trim() || undefined })} />
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="pk-desc">Description</label>
        <textarea id="pk-desc" value={draft.description ?? ''} onChange={(e) => edit({ description: e.target.value || undefined })} />
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <span className="field-label">Tags</span>
        <TagInput tags={draft.tags ?? []} onChange={(tags) => edit({ tags: tags.length ? tags : undefined })} placeholder="companion, sci-fi…" />
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <span className="field-label">Characters</span>
        <span className="muted small mono">{draft.characters.join(', ') || 'none'}</span>
        <span className="field-hint">Managed from the rail (add / remove characters).</span>
      </div>
      <SaveBar dirty={d.dirty} onSave={d.save} onDiscard={() => d.reset(project.manifest)} />
    </div>
  );
}
