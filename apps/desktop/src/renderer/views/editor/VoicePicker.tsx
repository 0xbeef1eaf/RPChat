/**
 * The character's voice: the recording it is cloned from, and the settings that decide how steady
 * it sounds.
 *
 * `seed` is the point of the panel. The model samples, so an unseeded character says the same line
 * with different pacing and emphasis every time. Previewing renders with a real seed and reports it
 * back, so an author can audition takes and lock the one they liked — which is the only way to make
 * a character sound like itself twice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CharacterVoice, VoicePreview, VoiceStudioState } from '@rp/shared';
import { VOICE_PREVIEW_SENTENCE } from '@rp/shared';
import { api } from '../../api';
import { reportError } from '../../store/actions';

interface VoicePickerProps {
  projectKey: string;
  dir: string;
  voice: CharacterVoice | undefined;
  /** Patch the character draft (everything but the reference, which is written on disk by the picker). */
  onChange(patch: Partial<CharacterVoice>): void;
  /** A disk write returned a new project. */
  onProject(project: unknown): void;
}

export function VoicePicker({ projectKey, dir, voice, onChange, onProject }: VoicePickerProps) {
  const [studio, setStudio] = useState<VoiceStudioState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState('');
  const [last, setLast] = useState<VoicePreview | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(() => {
    api()
      .editor.voiceStudio()
      .then(setStudio)
      .catch((err) => reportError('Could not read the voice settings', err));
  }, []);

  useEffect(() => load(), [load]);

  // Keep polling only while something is still downloading, so the panel counts up on a first run.
  const fetching = studio?.engine?.state === 'downloading' || studio?.engine?.state === 'extracting'
    || studio?.model?.state === 'downloading' || studio?.model?.state === 'extracting'
    || studio?.qwen?.state === 'downloading';
  useEffect(() => {
    if (!fetching) return;
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, [fetching, load]);

  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
    },
    [dir],
  );

  const pick = async () => {
    setBusy('pick');
    try {
      onProject(await api().editor.pickVoice(projectKey, dir));
    } catch (err) {
      reportError('Could not use that recording', err);
    } finally {
      setBusy(null);
    }
  };

  const installQwen = async () => {
    setBusy('install');
    try {
      setStudio(await api().editor.installVoiceModel());
    } catch (err) {
      reportError('Could not start the download', err);
    } finally {
      setBusy(null);
    }
  };

  /** Render with the *draft* settings, so unsaved changes can be heard before they are committed. */
  const speak = async (seed?: number) => {
    setBusy('preview');
    try {
      const opts: Record<string, unknown> = {};
      if (line.trim()) opts.text = line.trim();
      if (voice?.model) opts.model = voice.model;
      if (voice?.steps !== undefined) opts.steps = voice.steps;
      if (voice?.rate !== undefined) opts.rate = voice.rate;
      if (voice?.temperature !== undefined) opts.temperature = voice.temperature;
      const useSeed = seed ?? voice?.seed;
      if (useSeed !== undefined && useSeed >= 0) opts.seed = useSeed;

      const preview = await api().editor.previewVoice(projectKey, dir, opts);
      setLast(preview);
      audio.current?.pause();
      const el = new Audio(preview.url);
      audio.current = el;
      await el.play();
    } catch (err) {
      reportError('Could not preview the voice', err);
    } finally {
      setBusy(null);
    }
  };

  const models = studio?.models ?? [];
  const blocked = studio?.unavailable;
  /**
   * The second engine's weights are a deliberate download rather than part of first run, so the
   * panel has to say what it costs and how far along it is. Absent entirely where the engine
   * cannot run, in which case there is nothing worth offering.
   */
  const qwen = ((): { hint: string; offer: boolean } | undefined => {
    const st = studio?.qwen;
    if (!st) return undefined;
    if (st.state === 'ready' || st.state === 'present') return undefined;
    if (st.state === 'downloading') {
      const pct = st.total ? Math.floor(((st.received ?? 0) / st.total) * 100) : 0;
      return { hint: `Downloading the weights — ${pct}%. This keeps going if you leave the panel.`, offer: false };
    }
    if (st.state === 'failed') return { hint: `Download failed: ${st.error ?? 'unknown error'}. Trying again resumes where it stopped.`, offer: true };
    return { hint: 'A much better cloned voice, from a .qvoice profile. The weights are a separate download.', offer: true };
  })();
  const pinned = voice?.seed !== undefined && voice.seed >= 0;
  /** The take just heard is the one saved on the character, so the lock reads as closed. */
  const locked = last !== null && voice?.seed === last.seed;

  return (
    <div className="field" style={{ marginTop: 16 }}>
      <span className="field-label">Voice (sdk.voice.speak)</span>
      <span className="field-hint">
        A cloning model speaks this character in the voice of the recording below. Lock a seed to make it sound the same every time.
      </span>

      {blocked ? <span className={`field-hint${fetching ? '' : ' msg-error'}`}>{blocked}</span> : null}

      <div className="expr-row" style={{ marginTop: 8 }}>
        <div className="item-text">
          <span className="item-title">{voice?.reference ?? 'No recording'}</span>
          <span className="item-sub mono">
            {voice?.reference ? 'Cloned from this file, which ships inside the pack.' : 'Pick a 16-bit PCM wav — around ten seconds of clean speech.'}
          </span>
        </div>
        <button type="button" className="btn btn-sm" onClick={pick} disabled={busy !== null}>
          {busy === 'pick' ? 'Copying…' : voice?.reference ? 'Replace…' : 'Choose a recording…'}
        </button>
        {voice?.reference ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange({ reference: undefined })}>
            Clear
          </button>
        ) : null}
      </div>

      {qwen ? (
        <div className="expr-row" style={{ marginTop: 8 }}>
          <div className="item-text">
            <span className="item-title">Qwen3-TTS</span>
            <span className="item-sub mono">{qwen.hint}</span>
          </div>
          {qwen.offer ? (
            <button type="button" className="btn btn-sm" onClick={installQwen} disabled={busy !== null}>
              {busy === 'install' ? 'Starting…' : 'Download (2.5 GB)'}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="field-grid" style={{ marginTop: 8 }}>
        <div className="field">
          <label htmlFor="ch-voice-model">Model</label>
          <select id="ch-voice-model" value={voice?.model ?? ''} onChange={(e) => onChange({ model: e.target.value || undefined })}>
            <option value="">App default</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} — {m.label}
              </option>
            ))}
            {/* A model named by the pack but missing here must still survive a save. */}
            {voice?.model && !models.some((m) => m.name === voice.model) ? <option value={voice.model}>{voice.model} (not installed)</option> : null}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ch-voice-rate">Speed</label>
          <input id="ch-voice-rate" type="number" min={0.5} max={2} step={0.05} value={voice?.rate ?? ''}
            onChange={(e) => onChange({ rate: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor="ch-voice-steps">Steps</label>
          <input id="ch-voice-steps" type="number" min={1} max={64} step={1} value={voice?.steps ?? ''}
            onChange={(e) => onChange({ steps: e.target.value === '' ? undefined : Math.round(Number(e.target.value)) })} />
          <span className="field-hint">Smoothness. Cheap here — 32 costs little more than 8.</span>
        </div>
        <div className="field">
          <label htmlFor="ch-voice-temp">Temperature</label>
          <input id="ch-voice-temp" type="number" min={0} max={2} step={0.05} value={voice?.temperature ?? ''}
            onChange={(e) => onChange({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })} />
          <span className="field-hint">Model default 0.7. Lower is steadier, higher more expressive.</span>
        </div>
        <div className="field">
          <label htmlFor="ch-voice-seed">Seed</label>
          <input id="ch-voice-seed" type="number" min={-1} step={1} value={voice?.seed ?? ''}
            onChange={(e) => onChange({ seed: e.target.value === '' ? undefined : Math.round(Number(e.target.value)) })} />
          <span className="field-hint">{pinned ? 'Locked — every line uses this take.' : 'Empty means a different delivery every time.'}</span>
        </div>
      </div>

      <div className="field" style={{ marginTop: 8 }}>
        <label htmlFor="ch-voice-line">Try a line</label>
        <input id="ch-voice-line" type="text" placeholder={VOICE_PREVIEW_SENTENCE} value={line} onChange={(e) => setLine(e.target.value)} />
        <div className="row" style={{ marginTop: 4 }}>
          <button type="button" className="btn btn-sm" onClick={() => speak()} disabled={busy !== null || Boolean(blocked)}>
            {busy === 'preview' ? 'Speaking…' : 'Speak it'}
          </button>
          {/* Auditioning ignores a pinned seed, so an author can shop for a better take. */}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => speak(-1)} disabled={busy !== null || Boolean(blocked)}>
            Another take
          </button>
          {last ? (
            <span className="muted small grow row" style={{ gap: 4 }}>
              {last.duration.toFixed(2)}s · seed <code className="mono">{last.seed}</code>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-pressed={locked}
                aria-label={locked ? `Unlock seed ${last.seed}` : `Lock seed ${last.seed}`}
                title={
                  locked
                    ? 'Locked — every line uses this take. Click to let it vary again.'
                    : 'Lock this take so every line sounds the same.'
                }
                onClick={() => onChange({ seed: locked ? undefined : last.seed })}
              >
                {locked ? '🔒' : '🔓'}
              </button>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
