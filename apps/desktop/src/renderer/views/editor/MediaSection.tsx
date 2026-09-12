import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import type { AddMediaOptions, EditorAsset, MediaManifestEntry, MediaTagSuggestion } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { AutoTagDialog } from '../../components/editor/AutoTagDialog';
import { ConfirmDialog } from '../../components/common/Modal';
import { TagInput } from '../../components/editor/TagInput';
import { fromEditModel, toEditModel, undocumentedTags, unusedVocabulary, type MediaEditModel } from '../../lib/editor';
import { formatBytes } from '../../lib/format';
import {
  ensureWallpaperVocabulary,
  isWallpaper,
  needsWallpaperCapability,
  setWallpaperTag,
  WALLPAPER_TAG,
  wallpaperSource,
  wallpaperWarnings,
  withWallpaperCapability,
} from '../../lib/wallpaper';
import { frameFor } from '../../lib/frames';
import { applySuggestions, DEFAULT_TAG_SETTINGS, summarise, type TagRunSettings } from '../../lib/tagging';
import { reportError, toast } from '../../store/actions';
import { useDraft, useEditor } from './context';
import { SaveBar } from './SaveBar';

const KIND_GLYPH: Record<string, string> = { image: '🖼', video: '🎬', audio: '♪', text: '📄', other: '📦' };
const WALLPAPER_OPTIONS: AddMediaOptions = { subfolder: 'wallpapers', kinds: ['image'], title: 'Add wallpapers' };
type AssetFilter = 'all' | 'image' | 'video' | 'audio' | 'wallpaper';
const FILTERS: Array<{ id: AssetFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'wallpaper', label: 'Wallpapers' },
];

export function MediaSection() {
  const { project, setProject } = useEditor();
  const key = project.summary.key;
  const assetPaths = useMemo(() => project.assets.map((a) => a.path), [project.assets]);
  const folderTags = useMemo(() => Object.fromEntries(project.assets.map((a) => [a.path, a.folderTags])), [project.assets]);
  const savedModel = useMemo(() => toEditModel(project.mediaManifest, assetPaths), [project.mediaManifest, assetPaths]);
  const [over, setOver] = useState<'media' | 'wallpapers' | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<AssetFilter>('all');
  const [resolutions, setResolutions] = useState<Record<string, { w: number; h: number }>>({});
  const [capPrompt, setCapPrompt] = useState(false);
  const [removing, setRemoving] = useState<EditorAsset | null>(null);
  const [view, setView] = useState<'assets' | 'rules' | 'vocabulary'>('assets');
  const [autoTag, setAutoTag] = useState(false);
  const [tagSettings, setTagSettings] = useState<TagRunSettings>(DEFAULT_TAG_SETTINGS);
  const [tagging, setTagging] = useState<string | null>(null);

  const save = useCallback(
    async (draft: MediaEditModel) => {
      try {
        const folder = Object.fromEntries(project.assets.map((a) => [a.path, a.folderTags]));
        const p = await api().editor.saveMediaManifest(key, fromEditModel(ensureWallpaperVocabulary(draft, folder)));
        setProject(p);
        toast('success', 'media.json saved');
        return toEditModel(p.mediaManifest, p.assets.map((a) => a.path));
      } catch (err) {
        reportError('Could not save media.json', err);
        return null;
      }
    },
    [key, setProject, project.assets],
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

  const addFiles = async (options?: AddMediaOptions) => {
    setBusy(true);
    try {
      setProject(await api().editor.addMedia(key, options));
    } catch (err) {
      reportError('Could not add files', err);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>, options?: AddMediaOptions) => {
    e.preventDefault();
    setOver(null);
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
      setProject(await api().editor.addMediaFiles(key, paths, options));
      toast('success', `Added ${paths.length} ${options?.subfolder === 'wallpapers' ? 'wallpaper' : 'file'}${paths.length === 1 ? '' : 's'}`);
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

  /** Fold accepted suggestions into the draft; the user still has to save media.json. */
  const applySuggested = (list: MediaTagSuggestion[], settings: TagRunSettings) => {
    if (list.length === 0) return;
    edit((dr) => applySuggestions(dr, list, settings));
    toast('success', `${summarise(list)} — review and save media.json`);
  };

  /** The ✨ button on one asset: one call with the dialog's current settings, applied straight away. */
  const suggestForAsset = async (asset: EditorAsset) => {
    setTagging(asset.path);
    try {
      const frame = await frameFor(asset);
      const [suggestion] = await api().editor.suggestMediaTags(key, [asset.path], {
        ...(tagSettings.providerId ? { providerId: tagSettings.providerId } : {}),
        ...(tagSettings.model.trim() ? { model: tagSettings.model.trim() } : {}),
        maxTags: tagSettings.maxTags,
        vocabularyOnly: tagSettings.vocabularyOnly,
        ...(tagSettings.guidance.trim() ? { guidance: tagSettings.guidance.trim() } : {}),
        ...(frame ? { frames: { [asset.path]: frame } } : {}),
      });
      if (!suggestion) return;
      if (suggestion.error) toast('error', suggestion.error);
      else applySuggested([suggestion], tagSettings);
    } catch (err) {
      toast('error', `Could not tag ${asset.path}: ${errorMessage(err)}`);
    } finally {
      setTagging(null);
    }
  };

  const setAsset = (path: string, patch: Partial<{ tags: string[]; description: string }>) =>
    edit((dr) => ({ ...dr, perAsset: { ...dr.perAsset, [path]: { ...(dr.perAsset[path] ?? { tags: [], description: '' }), ...patch } } }));
  const setRule = (i: number, patch: Partial<MediaManifestEntry>) => edit((dr) => ({ ...dr, rules: dr.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const setVocab = (tag: string, meaning: string) => edit((dr) => ({ ...dr, vocabulary: { ...dr.vocabulary, [tag]: meaning } }));
  const [newTag, setNewTag] = useState('');

  const wallpaperOf = (a: EditorAsset) => ({ kind: a.kind, folderTags: draft.folderTags ? a.folderTags : [], manifestTags: draft.perAsset[a.path]?.tags ?? [] });
  const wallpaperAssets = useMemo(() => project.assets.filter((a) => isWallpaper(wallpaperOf(a))), [project.assets, draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const missingCapability = needsWallpaperCapability(wallpaperAssets.length > 0, project.manifest.capabilities);
  const visibleAssets = project.assets.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'wallpaper') return wallpaperAssets.includes(a);
    return a.kind === filter;
  });

  const requestCapability = async () => {
    setCapPrompt(false);
    try {
      const p = await api().editor.saveManifest(key, { ...project.manifest, capabilities: withWallpaperCapability(project.manifest.capabilities) });
      setProject(p);
      toast('success', 'pack.json now requests the wallpaper capability');
    } catch (err) {
      reportError('Could not update pack.json', err);
    }
  };
  const onRequestCapability = async () => {
    // The Pack section cannot be left dirty (the shell guards it); this section's own media.json draft can be.
    if (d.dirty) {
      setCapPrompt(true);
      return;
    }
    await requestCapability();
  };

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
        <button type="button" className="btn btn-sm" onClick={() => addFiles()} disabled={busy}>
          Add files…
        </button>
        <button type="button" className="btn btn-sm" onClick={() => addFiles(WALLPAPER_OPTIONS)} disabled={busy} title="Images copied into media/images/wallpapers/ (tagged “wallpapers” by folder)">
          Add wallpapers…
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setAutoTag(true)}
          disabled={busy || project.assets.length === 0}
          title="Describe and tag the listed assets with a vision model (e.g. qwen3-vl on a local server)"
        >
          ✨ Auto-tag…
        </button>
      </div>

      {missingCapability ? (
        <div className="callout callout-warning row" style={{ marginBottom: 12 }}>
          <span className="grow">
            This pack has {wallpaperAssets.length} wallpaper{wallpaperAssets.length === 1 ? '' : 's'} but does not request the <code>wallpaper</code>{' '}
            capability, so characters cannot set them.
          </span>
          <button type="button" className="btn btn-sm btn-primary" onClick={onRequestCapability}>
            Request the wallpaper capability
          </button>
        </div>
      ) : null}

      {view === 'assets' ? (
        <>
          <div className="split" style={{ gap: 10 }}>
            <div
              className={over === 'media' ? 'dropzone over' : 'dropzone'}
              onDragOver={(e) => (e.preventDefault(), setOver('media'))}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => onDrop(e)}
            >
              {busy ? 'Copying…' : 'Drop images, video or audio here — copied into media/<kind>/'}
            </div>
            <div
              className={over === 'wallpapers' ? 'dropzone over' : 'dropzone'}
              onDragOver={(e) => (e.preventDefault(), setOver('wallpapers'))}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => onDrop(e, { subfolder: 'wallpapers' })}
            >
              <strong>Drop wallpapers here</strong>
              <div className="small">copied into media/images/wallpapers/ and tagged by folder</div>
            </div>
          </div>
          <div className="chips" style={{ margin: '10px 0 2px' }} role="group" aria-label="Filter assets">
            {FILTERS.map((f) => {
              const n = f.id === 'all' ? project.assets.length : f.id === 'wallpaper' ? wallpaperAssets.length : project.assets.filter((a) => a.kind === f.id).length;
              return (
                <button key={f.id} type="button" className={filter === f.id ? 'chip-btn on' : 'chip-btn'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label} ({n})
                </button>
              );
            })}
          </div>
          <label className="check small" style={{ margin: '10px 0' }}>
            <input type="checkbox" checked={draft.folderTags} onChange={(e) => edit({ folderTags: e.target.checked })} />
            Folder names become tags (e.g. media/images/portraits/ → “portraits”)
          </label>
          {project.assets.length === 0 ? <p className="muted">No assets yet.</p> : visibleAssets.length === 0 ? <p className="muted">Nothing matches this filter.</p> : null}
          <div className="asset-grid">
            {visibleAssets.map((a) => {
              const e = draft.perAsset[a.path] ?? { tags: [], description: '' };
              const viaRules = a.manifestTags.filter((t) => !e.tags.includes(t));
              const source = wallpaperSource(wallpaperOf(a));
              const res = resolutions[a.path];
              const warnings = source && res ? wallpaperWarnings(res.w, res.h) : [];
              return (
                <div key={a.path} className="asset-card">
                  {a.kind === 'image' ? (
                    <img
                      className="asset-thumb"
                      src={a.url}
                      alt=""
                      onLoad={(ev) => {
                        const img = ev.currentTarget;
                        if (img.naturalWidth > 0) setResolutions((r) => (r[a.path]?.w === img.naturalWidth && r[a.path]?.h === img.naturalHeight ? r : { ...r, [a.path]: { w: img.naturalWidth, h: img.naturalHeight } }));
                      }}
                    />
                  ) : (
                    <div className="asset-thumb">{KIND_GLYPH[a.kind] ?? '?'}</div>
                  )}
                  <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                    <div className="item-text">
                      <span className="item-title mono small">{a.path}</span>
                      <span className="item-sub">
                        <span className="badge">{a.kind}</span> {formatBytes(a.bytes)} · {a.mime}
                        {source ? (
                          <span className="badge badge-accent" style={{ marginLeft: 6 }} title={source === 'folder' ? 'Tagged by its folder' : 'Tagged in media.json'}>
                            Wallpaper
                          </span>
                        ) : null}
                      </span>
                      {source && (filter === 'wallpaper' || warnings.length > 0) ? (
                        <span className="item-sub">
                          {res ? `${res.w} × ${res.h}` : 'reading size…'}
                          {warnings.map((w) => (
                            <span key={w} className="badge badge-warning" style={{ marginLeft: 6 }}>
                              {w}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </div>
                    {a.kind === 'image' ? (
                      <label className="check small" title={source === 'folder' ? 'This image is a wallpaper because of its folder; move the file to change that.' : undefined}>
                        <input
                          type="checkbox"
                          checked={source !== null}
                          disabled={source === 'folder'}
                          onChange={(ev) => setAsset(a.path, { tags: setWallpaperTag(e.tags, ev.target.checked) })}
                        />
                        Wallpaper <span className="muted mono">#{WALLPAPER_TAG}</span>
                        {source === 'folder' ? <span className="muted"> (from folder)</span> : null}
                      </label>
                    ) : null}
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
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => suggestForAsset(a)}
                        disabled={tagging !== null}
                        title="Ask the vision model for tags and a description for this asset"
                      >
                        {tagging === a.path ? <span className="spinner" aria-hidden /> : '✨'} Suggest
                      </button>
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
      {autoTag ? (
        <AutoTagDialog
          projectKey={key}
          assets={visibleAssets}
          model={draft}
          settings={tagSettings}
          onSettings={setTagSettings}
          onApply={applySuggested}
          onClose={() => setAutoTag(false)}
        />
      ) : null}
      {capPrompt ? (
        <ConfirmDialog
          title="Save media.json first?"
          message="Requesting the capability rewrites pack.json and reloads the project. Your unsaved media.json changes will be saved first."
          confirmLabel="Save and request"
          onCancel={() => setCapPrompt(false)}
          onConfirm={async () => {
            setCapPrompt(false);
            if (await d.save()) await requestCapability();
          }}
        />
      ) : null}
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
