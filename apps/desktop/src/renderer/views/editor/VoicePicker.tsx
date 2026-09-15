/**
 * The character's voice: which model speaks it, and which reference recording it is cloned from.
 *
 * Voices come from `kyutai/tts-voices` — several hundred clips — so the list is filtered and paged
 * rather than rendered whole. Auditioning one downloads it and synthesises a fixed sample sentence
 * in the background, cached from then on; choosing one copies the wav into the character directory
 * so the published pack carries its own voice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterVoice, VoiceBankCatalogue, VoiceBankEntry } from '@rp/shared';
import { api } from '../../api';
import { reportError } from '../../store/actions';

interface VoicePickerProps {
  /** Project key and character dir, for the `useVoice` write. */
  projectKey: string;
  dir: string;
  voice: CharacterVoice | undefined;
  /** Patch the character draft (model/rate/steps live in the draft like any other field). */
  onChange(patch: Partial<CharacterVoice>): void;
  /** A disk write returned a new project; the parent re-reads it. */
  onProject(project: unknown): void;
}

/** Voices shown per page. The bank is ~750 clips; rendering them all would jank the panel. */
const PAGE = 40;

export function VoicePicker({ projectKey, dir, voice, onChange, onProject }: VoicePickerProps) {
  const [catalogue, setCatalogue] = useState<VoiceBankCatalogue | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [collection, setCollection] = useState<string>('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [playing, setPlaying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const load = useCallback((refresh = false) => {
    setLoading(true);
    api()
      .editor.voiceBank(refresh)
      .then(setCatalogue)
      .catch((err) => reportError('Could not load the voice bank', err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open && !catalogue) load();
  }, [open, catalogue, load]);

  // While the speech engine is still being fetched, re-read the catalogue so the panel counts up
  // instead of sitting on a stale percentage until the author closes and reopens it.
  const fetching = catalogue?.engine?.state === 'downloading' || catalogue?.engine?.state === 'extracting';
  useEffect(() => {
    if (!open || !fetching) return;
    const timer = window.setInterval(() => load(), 2000);
    return () => window.clearInterval(timer);
  }, [open, fetching, load]);

  // Stop any sample still playing when the panel closes or the character changes.
  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
    },
    [dir],
  );

  const visible = useMemo(() => {
    const all = catalogue?.voices ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((v) => (collection === '' || v.collection === collection) && (q === '' || v.label.toLowerCase().includes(q) || v.path.toLowerCase().includes(q)));
  }, [catalogue, collection, query]);

  const page = useMemo(() => visible.slice(0, limit), [visible, limit]);

  // Pull the recordings on screen down in the background, so pressing play is usually instant.
  useEffect(() => {
    const pending = page.filter((v) => !v.ready).map((v) => v.path);
    if (pending.length === 0) return;
    api()
      .editor.voicePrefetch(pending)
      .catch(() => undefined); // best effort: a failed prefetch just means play downloads on demand
  }, [page]);

  useEffect(() => setLimit(PAGE), [collection, query]);

  const play = async (entry: VoiceBankEntry) => {
    audio.current?.pause();
    setPlaying(entry.path);
    try {
      const url = await api().editor.voicePreview(entry.path);
      const el = new Audio(url);
      audio.current = el;
      el.onended = () => setPlaying((p) => (p === entry.path ? null : p));
      el.onerror = () => setPlaying((p) => (p === entry.path ? null : p));
      await el.play();
    } catch (err) {
      setPlaying(null);
      reportError(`Could not play ${entry.label}`, err);
    }
  };

  const use = async (entry: VoiceBankEntry) => {
    setBusy(entry.path);
    try {
      const project = await api().editor.useVoice(projectKey, dir, entry.path);
      onProject(project);
      setOpen(false);
    } catch (err) {
      reportError(`Could not use ${entry.label}`, err);
    } finally {
      setBusy(null);
    }
  };

  const models = catalogue?.models ?? [];
  const collections = catalogue?.collections ?? [];
  const licenseOf = (id: string) => collections.find((c) => c.id === id);

  return (
    <div className="field" style={{ marginTop: 16 }}>
      <span className="field-label">Voice (sdk.voice.speak)</span>
      <span className="field-hint">
        A cloning model such as Pocket TTS speaks this character in the voice of the reference clip below. Leave the model empty to use the app default.
      </span>

      <div className="field-grid" style={{ marginTop: 4 }}>
        <div className="field">
          <label htmlFor="ch-voice-model">Model</label>
          <select id="ch-voice-model" value={voice?.model ?? ''} onChange={(e) => onChange({ model: e.target.value || undefined })}>
            <option value="">App default</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} — {m.label}
              </option>
            ))}
            {/* A model named by the pack but not installed here must still survive a save. */}
            {voice?.model && !models.some((m) => m.name === voice.model) ? <option value={voice.model}>{voice.model} (not installed)</option> : null}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ch-voice-rate">Speed</label>
          <input
            id="ch-voice-rate"
            type="number"
            min={0.5}
            max={2}
            step={0.05}
            value={voice?.rate ?? ''}
            onChange={(e) => onChange({ rate: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="ch-voice-steps">Steps</label>
          <input
            id="ch-voice-steps"
            type="number"
            min={1}
            max={64}
            step={1}
            value={voice?.steps ?? ''}
            onChange={(e) => onChange({ steps: e.target.value === '' ? undefined : Math.round(Number(e.target.value)) })}
          />
        </div>
      </div>

      <div className="expr-row" style={{ marginTop: 8 }}>
        <div className="item-text">
          <span className="item-title">{voice?.reference ? voice.reference : 'No reference clip'}</span>
          <span className="item-sub mono">{voice?.referenceSource ?? 'A cloning model needs one; models with a speaker bank do not.'}</span>
          {voice?.attribution ? <span className="item-sub">{voice.attribution}</span> : null}
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : voice?.reference ? 'Change…' : 'Choose a voice…'}
        </button>
        {voice?.reference ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange({ reference: undefined, referenceSource: undefined, attribution: undefined })}>
            Clear
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          {catalogue?.previewsUnavailable ? (
            // A download in progress is not a mistake the author made, so it reads as a hint.
            <span className={`field-hint${fetching ? '' : ' msg-error'}`}>{catalogue.previewsUnavailable}</span>
          ) : null}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className={`btn btn-sm${collection === '' ? '' : ' btn-ghost'}`} onClick={() => setCollection('')}>
              All ({catalogue?.voices.length ?? 0})
            </button>
            {collections.map((c) => (
              <button key={c.id} type="button" className={`btn btn-sm${collection === c.id ? '' : ' btn-ghost'}`} onClick={() => setCollection(c.id)} title={`${c.note} — ${c.license}`}>
                {c.label} ({c.count})
              </button>
            ))}
          </div>
          {collection ? (
            <span className="field-hint">
              {licenseOf(collection)?.note} Licence: <code className="mono">{licenseOf(collection)?.license}</code>
              {licenseOf(collection)?.nonCommercial ? ' — non-commercial use only.' : null}
            </span>
          ) : null}
          <input type="search" placeholder="Search voices…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {loading ? <span className="muted small">Loading the catalogue…</span> : null}
          {!loading && visible.length === 0 ? <span className="muted small">No voices match.</span> : null}
          <div className="stack" style={{ gap: 4 }}>
            {page.map((entry) => {
              const lic = licenseOf(entry.collection);
              return (
                <div key={entry.path} className="expr-row">
                  <div className="item-text">
                    <span className="item-title">
                      {entry.label}
                      {entry.enhanced ? <span className="muted small"> · cleaned</span> : null}
                    </span>
                    <span className="item-sub mono">
                      {entry.collection}
                      {lic ? ` · ${lic.license}` : ''}
                      {entry.ready ? '' : ' · downloading'}
                    </span>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => play(entry)} disabled={playing === entry.path || Boolean(catalogue?.previewsUnavailable)}>
                    {playing === entry.path ? 'Playing…' : 'Play'}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => use(entry)} disabled={busy !== null}>
                    {busy === entry.path ? 'Copying…' : 'Use'}
                  </button>
                </div>
              );
            })}
          </div>
          {visible.length > page.length ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({visible.length - page.length} left)
            </button>
          ) : null}
          <div className="row">
            <span className="muted small grow">
              {catalogue ? `${catalogue.voices.length} voices from ${catalogue.repo}` : ''}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => load(true)} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
