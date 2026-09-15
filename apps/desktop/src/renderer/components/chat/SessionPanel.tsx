import { useEffect, useState } from 'react';
import type { ProviderConfig, Session } from '@rp/shared';

interface SessionPanelProps {
  session: Session;
  providers: ProviderConfig[];
  onSave: (session: Session) => Promise<boolean>;
  /** Omitted while the policy forbids deleting sessions — the button is then not rendered. */
  onDelete?: (() => void) | undefined;
  onReset: () => void;
  onClose: () => void;
}

/** Inline editor for a session's title, scenario and provider/model override. */
export function SessionPanel({ session, providers, onSave, onDelete, onReset, onClose }: SessionPanelProps) {
  const [title, setTitle] = useState(session.title);
  const [scenario, setScenario] = useState(session.scenario ?? '');
  const [providerId, setProviderId] = useState(session.providerId ?? '');
  const [model, setModel] = useState(session.model ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(session.title);
    setScenario(session.scenario ?? '');
    setProviderId(session.providerId ?? '');
    setModel(session.model ?? '');
  }, [session.id, session.title, session.scenario, session.providerId, session.model]);

  const dirty =
    title !== session.title ||
    scenario !== (session.scenario ?? '') ||
    providerId !== (session.providerId ?? '') ||
    model !== (session.model ?? '');

  const save = async () => {
    setSaving(true);
    const next: Session = {
      ...session,
      title: title.trim() || session.title,
      scenario: scenario.trim() ? scenario : undefined,
      providerId: providerId || undefined,
      model: model.trim() || undefined,
    };
    const ok = await onSave(next);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <div className="session-panel">
      <div className="session-panel-inner">
        <div className="field-grid">
          <div className="field">
            <label htmlFor="session-title">Title</label>
            <input id="session-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="session-provider">Provider override</label>
            <select id="session-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">Default</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="session-model">Model override</label>
            <input id="session-model" type="text" value={model} placeholder="provider default" onChange={(e) => setModel(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="session-scenario">Scenario</label>
          <textarea
            id="session-scenario"
            value={scenario}
            placeholder="Optional setting, backstory or instructions prepended to the character's prompt for this session."
            onChange={(e) => setScenario(e.target.value)}
          />
          <span className="field-hint">Changes apply from the next message on.</span>
        </div>
        <div className="form-actions">
          {onDelete ? (
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              Delete session
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={onReset}
            title="Forget scratch state, timers, event subscriptions, the history summary and the status line; messages and memories stay"
          >
            Reset session state
          </button>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
