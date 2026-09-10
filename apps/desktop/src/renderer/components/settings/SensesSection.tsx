import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, PresenceSnapshot } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDuration } from '../../lib/format';
import { StringListEditor } from '../common/StringListEditor';
import { ManagedBadge, useManaged } from './Managed';

interface SensesSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
  NumberField: (props: { id: string; label: string; value: number; hint?: string; min?: number; step?: number; path?: string; onCommit: (v: number) => void }) => React.JSX.Element;
}

export function SensesSection({ settings, onPatch, NumberField }: SensesSectionProps) {
  const senses = settings.senses;
  const promptManaged = useManaged('senses.includeInPrompt');
  const calendarsManaged = useManaged('senses.calendarSources');
  const watchManaged = useManaged('senses.watchDirs');
  const patch = (p: Partial<AppSettings['senses']>) => onPatch({ senses: { ...senses, ...p } });

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="muted small">
        What characters with the <code>presence</code> capability can sense: idle time, the active window, what is playing, battery and
        screen lock. Nothing leaves your machine except through the prompt to your configured LLM provider.
      </p>
      <LiveSnapshot auto={senses.liveSnapshotAutoRefresh} onAutoChange={(liveSnapshotAutoRefresh) => void patch({ liveSnapshotAutoRefresh })} />
      <div className="field-grid">
        <div className="field">
          <span className="field-label">
            Prompt
            <ManagedBadge show={promptManaged} />
          </span>
          <label className="check">
            <input type="checkbox" checked={senses.includeInPrompt} disabled={promptManaged} onChange={(e) => patch({ includeInPrompt: e.target.checked })} />
            Include a one-line presence summary in every prompt
          </label>
          <span className="field-hint">Only for packs whose effective capabilities include presence.</span>
        </div>
        <NumberField id="senses-poll" label="Poll interval (ms)" path="senses.pollMs" value={senses.pollMs} min={1000} step={500} hint="How often the host samples presence while something needs it." onCommit={(v) => patch({ pollMs: Math.round(v) })} />
        <NumberField
          id="senses-idle"
          label="Idle threshold (seconds)"
          path="senses.idleThresholdMs"
          value={Math.round(senses.idleThresholdMs / 1000)}
          min={10}
          hint="No input for this long counts as away (user-idle / user-back events)."
          onCommit={(v) => patch({ idleThresholdMs: Math.round(v) * 1000 })}
        />
      </div>
      <div className="field">
        <label htmlFor="senses-calendars">
          Calendar sources
          <ManagedBadge show={calendarsManaged} />
        </label>
        <span className="field-hint">ICS files or http(s) URLs read by sdk.calendar (cached 5 min).</span>
        <StringListEditor id="senses-calendars" values={senses.calendarSources} disabled={calendarsManaged} placeholder="/home/me/calendar.ics or https://…/basic.ics" onChange={(calendarSources) => patch({ calendarSources })} />
      </div>
      <div className="field">
        <label htmlFor="senses-watch">
          Watched directories
          <ManagedBadge show={watchManaged} />
        </label>
        <span className="field-hint">Directories that raise file-added events (e.g. your Downloads folder). Dotfiles and partial downloads are ignored.</span>
        <StringListEditor id="senses-watch" values={senses.watchDirs} disabled={watchManaged} placeholder="/home/me/Downloads" onChange={(watchDirs) => patch({ watchDirs })} />
      </div>
    </div>
  );
}

function LiveSnapshot({ auto, onAutoChange }: { auto: boolean; onAutoChange: (auto: boolean) => void }) {
  const [snap, setSnap] = useState<PresenceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await api().senses.snapshot());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [auto, load]);

  return (
    <div className="card" style={{ padding: '10px 14px' }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 className="grow">Live snapshot</h3>
        <label className="check small">
          <input type="checkbox" checked={auto} onChange={(e) => onAutoChange(e.target.checked)} /> auto-refresh
        </label>
        <button type="button" className="btn btn-sm" onClick={load}>
          Refresh
        </button>
      </div>
      {error ? <div className="callout callout-danger small">{error}</div> : null}
      {snap ? (
        <dl className="kv small">
          <dt>Time</dt>
          <dd>
            {snap.localTime} ({snap.dayPart})
          </dd>
          <dt>User</dt>
          <dd>{snap.atKeyboard ? 'at keyboard' : `away for ${formatDuration(snap.idleMs)}`} · idle {formatDuration(snap.idleMs)}</dd>
          <dt>Active window</dt>
          <dd>{snap.activeWindow ? `"${snap.activeWindow.title}" (${snap.activeWindow.app})` : <span className="muted">unknown on this platform</span>}</dd>
          <dt>Playing</dt>
          <dd>
            {snap.nowPlaying ? `${snap.nowPlaying.title}${snap.nowPlaying.artist ? ` — ${snap.nowPlaying.artist}` : ''} (${snap.nowPlaying.status})` : <span className="muted">nothing</span>}
          </dd>
          <dt>Power</dt>
          <dd>
            {snap.batteryPercent !== null ? `${snap.batteryPercent}%` : <span className="muted">no battery info</span>}
            {snap.onBattery === true ? ' · on battery' : snap.onBattery === false ? ' · plugged in' : ''}
          </dd>
          <dt>Screen</dt>
          <dd>{snap.screenLocked === null ? <span className="muted">unknown</span> : snap.screenLocked ? 'locked' : 'unlocked'}</dd>
          <dt>Last message</dt>
          <dd>{snap.sinceLastMessageMs === null ? <span className="muted">—</span> : `${formatDuration(snap.sinceLastMessageMs)} ago`}</dd>
        </dl>
      ) : !error ? (
        <div className="row muted small">
          <span className="spinner" /> Sampling…
        </div>
      ) : null}
    </div>
  );
}
