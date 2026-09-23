import { useEffect, useMemo, useRef, useState } from 'react';
import { REASONING_EFFORTS } from '@rp/shared';
import type { AppSettings, EditorAsset, MediaTagSuggestion, ModelInfo, ProviderConfig } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { Modal } from '../common/Modal';
import type { MediaEditModel } from '../../lib/editor';
import { frameFor } from '../../lib/frames';
import {
  DEFAULT_TAG_SETTINGS,
  initialProviderId,
  learnedFrom,
  summarise,
  tagOptions,
  taggableAssets,
  visionProviders,
  type TagRunSettings,
} from '../../lib/tagging';

interface AutoTagDialogProps {
  projectKey: string;
  /** The assets currently listed in the Media section (the filter applies to the run too). */
  assets: EditorAsset[];
  /** The unsaved media.json draft, used to tell tagged assets from untagged ones. */
  model: MediaEditModel;
  settings: TagRunSettings;
  onSettings: (settings: TagRunSettings) => void;
  /** Apply the accepted suggestions to the draft. */
  onApply: (suggestions: MediaTagSuggestion[], settings: TagRunSettings) => void;
  onClose: () => void;
}

type Phase = 'config' | 'running' | 'review';

/**
 * Runs the media assets past a vision model (qwen3-vl on a local server, Claude, …) one at a time
 * and lets the author accept the suggestions. Nothing is written until the Media section is saved.
 */
export function AutoTagDialog({ projectKey, assets, model, settings, onSettings, onApply, onClose }: AutoTagDialogProps) {
  const [providers, setProviders] = useState<ProviderConfig[] | null>(null);
  const [defaultProviderId, setDefaultProviderId] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [fetching, setFetching] = useState(false);
  const [phase, setPhase] = useState<Phase>('config');
  const [results, setResults] = useState<MediaTagSuggestion[]>([]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState<string>('');
  const [error, setError] = useState<string>('');
  const cancelled = useRef(false);

  useEffect(() => {
    let live = true;
    api()
      .settings.get()
      .then((s: AppSettings) => {
        if (!live) return;
        setProviders(s.providers);
        setDefaultProviderId(s.defaultProviderId);
        const id = initialProviderId(s.providers, settings.providerId, s.defaultProviderId);
        if (id !== settings.providerId) onSettings({ ...settings, providerId: id });
      })
      .catch((err) => setError(errorMessage(err)));
    return () => {
      live = false;
      cancelled.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vision = useMemo(() => visionProviders(providers ?? []), [providers]);
  const provider = vision.find((p) => p.id === settings.providerId);
  const targets = useMemo(() => taggableAssets(assets, model, settings.scope), [assets, model, settings.scope]);
  const patch = (p: Partial<TagRunSettings>) => onSettings({ ...settings, ...p });

  const fetchModels = async () => {
    if (!provider) return;
    setFetching(true);
    try {
      setModels(await api().settings.listModels(provider));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setFetching(false);
    }
  };

  const run = async () => {
    if (!provider || targets.length === 0) return;
    cancelled.current = false;
    setResults([]);
    setAccepted({});
    setError('');
    setPhase('running');
    const collected: MediaTagSuggestion[] = [];
    for (const asset of targets) {
      if (cancelled.current) break;
      setCurrent(asset.path);
      try {
        const frame = await frameFor(asset);
        if (cancelled.current) break;
        const [suggestion] = await api().editor.suggestMediaTags(
          projectKey,
          [asset.path],
          // `learned` keeps the run consistent: one call per asset means media.json is the only
          // vocabulary main can see, and the draft is not saved until the author says so.
          tagOptions({ ...settings, providerId: provider.id }, { assetPath: asset.path, ...(frame ? { frame } : {}), learned: learnedFrom(collected) }),
        );
        if (suggestion) {
          collected.push(suggestion);
          setResults([...collected]);
          if (!suggestion.error) setAccepted((a) => ({ ...a, [suggestion.path]: true }));
        }
      } catch (err) {
        const failed: MediaTagSuggestion = { path: asset.path, tags: [], newTags: [], description: '', vocabulary: {}, basis: 'filename', error: errorMessage(err) };
        collected.push(failed);
        setResults([...collected]);
      }
    }
    setCurrent('');
    setPhase('review');
  };

  const apply = () => {
    onApply(results.filter((s) => accepted[s.path] && !s.error), settings);
    onClose();
  };

  const done = results.length;
  const usable = results.filter((s) => !s.error && (s.tags.length > 0 || s.description.length > 0));

  return (
    <Modal title="Auto-tag media with a vision model" onClose={phase === 'running' ? undefined : onClose} className="modal-wide">
      {error ? <div className="callout callout-danger">{error}</div> : null}

      {phase === 'config' ? (
        <>
          {providers === null ? (
            <p className="muted">Loading providers…</p>
          ) : vision.length === 0 ? (
            <div className="callout callout-warning">
              No provider is marked as vision-capable. Add one under <strong>Settings → Providers</strong> — for a local model, an OpenAI-compatible
              provider pointing at <code>http://localhost:11434/v1</code> with the model <code>qwen3-vl:8b</code> and “supports vision” ticked.
            </div>
          ) : null}
          <div className="field-grid">
            <div className="field">
              <label htmlFor="tag-provider">Provider</label>
              <select id="tag-provider" value={settings.providerId} onChange={(e) => (patch({ providerId: e.target.value, model: '' }), setModels([]))}>
                {vision.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.id}
                    {p.id === defaultProviderId ? ' (default)' : ''}
                  </option>
                ))}
              </select>
              <span className="field-hint">Only providers that can look at images are listed.</span>
            </div>
            <div className="field">
              <label htmlFor="tag-model">Model</label>
              <div className="input-with-btn">
                <input
                  id="tag-model"
                  type="text"
                  list="tag-models"
                  value={settings.model}
                  placeholder={provider?.model ?? 'qwen3-vl:8b'}
                  onChange={(e) => patch({ model: e.target.value })}
                />
                <datalist id="tag-models">
                  {models.map((m) => (
                    <option key={m.id} value={m.id} />
                  ))}
                </datalist>
                <button type="button" className="btn btn-sm" onClick={fetchModels} disabled={!provider || fetching}>
                  {fetching ? 'Fetching…' : 'Fetch'}
                </button>
              </div>
              <span className="field-hint">Leave empty to use the provider's own model{provider?.model ? ` (${provider.model})` : ''}.</span>
            </div>
            <div className="field">
              <label htmlFor="tag-scope">Assets</label>
              <select id="tag-scope" value={settings.scope} onChange={(e) => patch({ scope: e.target.value as TagRunSettings['scope'] })}>
                <option value="untagged">Untagged only ({taggableAssets(assets, model, 'untagged').length})</option>
                <option value="all">Everything listed ({assets.length})</option>
              </select>
              <span className="field-hint">The Media filter applies: only the assets you can see are tagged.</span>
            </div>
            <div className="field">
              <label htmlFor="tag-max">Tags per asset</label>
              <input id="tag-max" type="number" min={1} max={20} value={settings.maxTags} onChange={(e) => patch({ maxTags: Number(e.target.value) || 1 })} />
            </div>
            <div className="field">
              <label htmlFor="tag-thinking">Thinking</label>
              <select
                id="tag-thinking"
                value={settings.reasoningEffort}
                onChange={(e) => patch({ reasoningEffort: e.target.value as TagRunSettings['reasoningEffort'] })}
              >
                <option value="">Leave it to the model</option>
                {REASONING_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                A local model that thinks first can spend its whole answer budget deliberating and return nothing; <code>none</code> fixes that where the
                model supports it (Qwen3.5 does, Qwen3-VL does not). <code>none</code> and <code>max</code> are Ollama's levels — OpenAI itself takes
                neither.
              </span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="tag-guidance">Guidance (optional)</label>
            <textarea
              id="tag-guidance"
              rows={2}
              value={settings.guidance}
              placeholder="e.g. a noir detective pack — tag by mood and time of day"
              onChange={(e) => patch({ guidance: e.target.value })}
            />
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <label className="check small">
              <input type="checkbox" checked={settings.vocabularyOnly} onChange={(e) => patch({ vocabularyOnly: e.target.checked })} />
              Stay inside the pack's existing tag vocabulary
            </label>
            <label className="check small">
              <input type="checkbox" checked={settings.jsonSchema} onChange={(e) => patch({ jsonSchema: e.target.checked })} />
              Hold the model to the answer format (<code>response_format</code>)
            </label>
            <label className="check small">
              <input type="checkbox" checked={settings.addToVocabulary} onChange={(e) => patch({ addToVocabulary: e.target.checked })} />
              Add new tags to the vocabulary with the model's meaning
            </label>
            <label className="check small">
              <input type="checkbox" checked={settings.replaceTags} onChange={(e) => patch({ replaceTags: e.target.checked })} />
              Replace existing tags instead of adding to them
            </label>
            <label className="check small">
              <input type="checkbox" checked={settings.overwriteDescriptions} onChange={(e) => patch({ overwriteDescriptions: e.target.checked })} />
              Overwrite descriptions that are already written
            </label>
          </div>
          <p className="field-hint">
            {targets.length === 0
              ? 'Nothing to tag with these options.'
              : `${targets.length} asset${targets.length === 1 ? '' : 's'} will be sent to the model, one at a time. Suggestions are reviewed before anything changes.`}
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={run} disabled={!provider || targets.length === 0}>
              Tag {targets.length} asset{targets.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      ) : null}

      {phase !== 'config' ? (
        <>
          <div className="row">
            {phase === 'running' ? <span className="spinner" aria-hidden /> : null}
            <span className="grow small">
              {phase === 'running' ? (
                <>
                  {done + 1} / {targets.length} · <span className="mono">{current}</span>
                </>
              ) : (
                `${summarise(results)} of ${results.length} asset${results.length === 1 ? '' : 's'}`
              )}
            </span>
            {phase === 'running' ? (
              <button type="button" className="btn btn-sm" onClick={() => (cancelled.current = true)}>
                Stop
              </button>
            ) : null}
          </div>
          <div className="suggestion-list">
            {results.map((s) => (
              <div key={s.path} className={s.error ? 'suggestion failed' : 'suggestion'}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={accepted[s.path] ?? false}
                    disabled={Boolean(s.error) || (s.tags.length === 0 && s.description.length === 0)}
                    onChange={(e) => setAccepted((a) => ({ ...a, [s.path]: e.target.checked }))}
                    aria-label={`Apply suggestions for ${s.path}`}
                  />
                  <span className="mono small">{s.path}</span>
                </label>
                {s.error ? (
                  <span className="small callout callout-danger">{s.error}</span>
                ) : (
                  <>
                    <span className="chips">
                      {s.tags.map((t) => (
                        <span key={t} className={s.newTags.includes(t) ? 'chip' : 'chip muted-chip'} title={s.newTags.includes(t) ? s.vocabulary[t] ?? 'new tag' : 'already used in this pack'}>
                          {t}
                        </span>
                      ))}
                      {s.tags.length === 0 ? <span className="muted small">no tags</span> : null}
                    </span>
                    {s.description ? <span className="small">{s.description}</span> : null}
                    {s.basis !== 'image' ? (
                      <span className="muted small">
                        {s.basis === 'frame' ? 'from a video frame' : s.basis === 'text' ? 'from the file text' : 'guessed from the file name — check it'}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>
          {phase === 'review' ? (
            <div className="form-actions">
              <button type="button" className="btn btn-sm" onClick={() => setAccepted(Object.fromEntries(usable.map((s) => [s.path, true])))} disabled={usable.length === 0}>
                Select all
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setAccepted({})}>
                Select none
              </button>
              <span className="grow" />
              <button type="button" className="btn" onClick={onClose}>
                Discard
              </button>
              <button type="button" className="btn btn-primary" onClick={apply} disabled={!results.some((s) => accepted[s.path] && !s.error)}>
                Apply to media.json draft
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
