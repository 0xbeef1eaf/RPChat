import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import type { EditorAsset, MediaManifestEntry } from '@rp/shared';
import { api } from '../../api';
import { ConfirmDialog } from '../../components/common/Modal';
import { TagInput } from '../../components/editor/TagInput';
import { fromEditModel, toEditModel, undocumentedTags, unusedVocabulary, type MediaEditModel } from '../../lib/editor';
import { formatBytes } from '../../lib/format';
import { reportError, toast } from '../../store/actions';
import { useDraft, useEditor } from './context';
import { SaveBar } from './SaveBar';

const KIND_GLYPH: Record<string, string> = { image: '🖼', video: '🎬', audio: '♪', text: '📄', other: '📦' };

export function MediaSection() {
  const { project, setProject } = useEditor();
  const key = project.summary.key;
  const assetPaths = useMemo(() => project.assets.map((a) => a.path), [project.assets]);
  const folderTags = useMemo(() => Object.fromEntries(project.assets.map((a) => [a.path, a.folderTags])), [project.assets]);
  const savedModel = useMemo(() => toEditModel(project.mediaManifest, assetPaths), [project.mediaManifest, assetPaths]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<EditorAsset | null>(null);
  const [view, setView] = useState<'assets' | 'rules' | 'vocabulary'>('assets');

  const save = useCallback(
    async (draft: MediaEditModel) => {
      try {
        const p = await api().editor.saveMediaManifest(key, fromEditModel(draft));
        setProject(p);
        toast('success', 'media.json saved');
        return toEditModel(p.mediaManifest, p.assets.map((a) => a.path));
      } catch (err) {
        reportError('Could not save media.json', err);
        return null;
      }
    },
    [key, setProject],
  );

  const d = useDraft<MediaEditModel>(savedModel, save);
  const { draft, edit } = d;
  // Assets added/removed on disk: keep edits for assets that still exist.
  useEffect(() => {
    d.external(savedModel, (dr, saved) => ({
      ...dr,
      perAsset: Object.fromEntries(Object.keys(saved.perAsset).map((p) => [p, dr.perAsset[p] ?? saved.perAsset[p]!])),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedModel]);

  const vocabulary = Object.keys(draft.vocabulary);
  const suggestions = useMemo(() => Array.from(new Set([...vocabulary, ...project.tags.map((t) => t.tag)])).sort(), [vocabulary, project.tags]);
  const unused = useMemo(() => unusedVocabulary(draft, folderTags), [draft, folderTags]);
  const undocumented = useMemo(() => undocumentedTags(draft, folderTags), [draft, folderTags]);

  const addFiles = async () => {
    setBusy(true);
    try {
      setProject(await api().editor.addMedia(key));
    } catch (err) {
      reportError('Could not add files', err);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const pathForFile = (api().app as { pathForFile?: (f: File) => string }).pathForFile;
    if (typeof pathForFile !== 'function') {
      toast('error', 'Drag and drop is not available in this build; use “Add files”.');
      return;
    }
    const paths = files.map((f) => pathForFile(f)).filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (paths.length === 0) {
      toast('error', 'Could not resolve the dropped files to paths.');
      return;
    }
    setBusy(true);
    try {
      setProject(await api().editor.addMediaFiles(key, paths));
      toast('success', `Added ${paths.length} file${paths.length === 1 ? '' : 's'}`);
    } catch (err) {
      reportError('Could not add dropped files', err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (asset: EditorAsset) => {
    setRemoving(null);
    try {
      setProject(await api().editor.removeMedia(key, asset.path));
    } catch (err) {
      reportError('Could not remove asset', err);
    }
  };

  const setAsset = (path: string, patch: Partial<{ tags: string[]; description: string }>) =>
    edit((dr) => ({ ...dr, perAsset: { ...dr.perAsset, [path]: { ...(dr.perAsset[path] ?? { tags: [], description: '' }), ...patch } } }));
  const setRule = (i: number, patch: Partial<MediaManifestEntry>) => edit((dr) => ({ ...dr, rules: dr.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const setVocab = (tag: string, meaning: string) => edit((dr) => ({ ...dr, vocabulary: { ...dr.vocabulary, [tag]: meaning } }));
  const [newTag, setNewTag] = useState('');

  return (
    <div>
      <div className="section-head">
        <h1>Media</h1>
        <div className="tabs" style={{ margin: 0, borderBottom: 0 }}>
          {(['assets', 'rules', 'vocabulary'] as const).map((t) => (
            <button key={t} type="button" role="tab" className="tab" aria-selected={view === t} onClick={() => setView(t)}>
              {t === 'assets' ? `Assets (${project.assets.length})` : t === 'rules' ? `Rules (${draft.rules.length})` : `Tag vocabulary (${vocabulary.length})`}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" onClick={addFiles} disabled={busy}>
          Add files…
        </button>
      </div>

      {view === 'assets' ? (
        <>
          <div
            className={over ? 'dropzone over' : 'dropzone'}
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            {busy ? 'Copying…' : 'Drop images, video or audio here — they are copied into media/<kind>/'}
          </div>
          <label className="check small" style={{ margin: '10px 0' }}>
            <input type="checkbox" checked={draft.folderTags} onChange={(e) => edit({ folderTags: e.target.checked })} />
            Folder names become tags (e.g. media/images/portraits/ → “portraits”)
          </label>
          {project.assets.length === 0 ? <p className="muted">No assets yet.</p> : null}
          <div className="asset-grid">
            {project.assets.map((a) => {
              const e = draft.perAsset[a.path] ?? { tags: [], description: '' };
              const viaRules = a.manifestTags.filter((t) => !e.tags.includes(t));
              return (
                <div key={a.path} className="asset-card">
                  {a.kind === 'image' ? <img className="asset-thumb" src={a.url} alt="" /> : <div className="asset-thumb">{KIND_GLYPH[a.kind] ?? '?'}</div>}
                  <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                    <div className="item-text">
                      <span className="item-title mono small">{a.path}</span>
                      <span className="item-sub">
                        <span className="badge">{a.kind}</span> {formatBytes(a.bytes)} · {a.mime}
                      </span>
                    </div>
                    {a.folderTags.length > 0 || viaRules.length > 0 ? (
                      <span className="chips">
                        {a.folderTags.map((t) => (
                          <span key={`f-${t}`} className="chip muted-chip" title="From the folder name">
                            {t}
                          </span>
                        ))}
                        {viaRules.map((t) => (
                          <span key={`r-${t}`} className="chip muted-chip" title="From a rule">
                            {t} ·rule
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <TagInput tags={e.tags} suggestions={suggestions} onChange={(tags) => setAsset(a.path, { tags })} aria-label={`Tags for ${a.path}`} />
                    <input type="text" value={e.description} placeholder="Description for the model" onChange={(ev) => setAsset(a.path, { description: ev.target.value })} />
                    <div>
                      <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={() => setRemoving(a)}>
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {view === 'rules' ? (
        <div>
          <p className="muted small" style={{ marginBottom: 8 }}>
            Glob entries in media.json that tag many files at once (<code>media/images/luna-*.png</code>, <code>media/video/**</code>, or a directory).
            Exact per-file entries are edited on the Assets tab.
          </p>
          <div className="rule-row muted small">
            <span>Match</span>
            <span>Tags</span>
            <span>Description</span>
            <span />
          </div>
          {draft.rules.map((r, i) => (
            <div key={i} className="rule-row">
              <input type="text" className="mono" value={r.match} onChange={(e) => setRule(i, { match: e.target.value })} />
              <TagInput tags={r.tags ?? []} suggestions={suggestions} onChange={(tags) => setRule(i, { tags })} />
              <input type="text" value={r.description ?? ''} onChange={(e) => setRule(i, { description: e.target.value || undefined })} />
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Remove rule" onClick={() => edit((dr) => ({ ...dr, rules: dr.rules.filter((_, j) => j !== i) }))}>
                ×
              </button>
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => edit((dr) => ({ ...dr, rules: [...dr.rules, { match: 'media/', tags: [] }] }))}>
              Add rule
            </button>
          </div>
        </div>
      ) : null}

      {view === 'vocabulary' ? (
        <div>
          <p className="muted small" style={{ marginBottom: 8 }}>
            What each tag means, shown to the model so it can pick assets by meaning. Unused tags are flagged; used-but-undocumented tags can be added below.
          </p>
          <div className="vocab-row muted small">
            <span>Tag</span>
            <span>Meaning</span>
            <span />
          </div>
          {vocabulary.sort().map((tag) => (
            <div key={tag} className="vocab-row">
              <span className="mono">
                {tag}
                {unused.includes(tag) ? (
                  <span className="badge badge-warning" style={{ marginLeft: 6 }}>
                    unused
                  </span>
                ) : null}
              </span>
              <input type="text" value={draft.vocabulary[tag] ?? ''} onChange={(e) => setVocab(tag, e.target.value)} />
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`Remove ${tag}`}
                onClick={() =>
                  edit((dr) => {
                    const vocabulary = { ...dr.vocabulary };
                    delete vocabulary[tag];
                    return { ...dr, vocabulary };
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <input type="text" className="mono" value={newTag} placeholder="new tag" list="vocab-undocumented" style={{ maxWidth: 220 }} onChange={(e) => setNewTag(e.target.value.trim().toLowerCase())} />
            <datalist id="vocab-undocumented">
              {undocumented.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <button type="button" className="btn btn-sm" disabled={!newTag || newTag in draft.vocabulary} onClick={() => (setVocab(newTag, ''), setNewTag(''))}>
              Add
            </button>
          </div>
          {undocumented.length > 0 ? (
            <p className="field-hint" style={{ marginTop: 8 }}>
              Used without a meaning: {undocumented.map((t) => (
                <button key={t} type="button" className="chip-btn" style={{ marginRight: 4 }} onClick={() => setVocab(t, '')}>
                  + {t}
                </button>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}

      <SaveBar dirty={d.dirty} onSave={d.save} onDiscard={() => d.reset(savedModel)} label="Save media.json" />
      {removing ? (
        <ConfirmDialog
          title="Remove asset?"
          message={
            <>
              Deletes <code>{removing.path}</code> from the project folder and drops its media.json entry.
            </>
          }
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      ) : null}
    </div>
  );
}
