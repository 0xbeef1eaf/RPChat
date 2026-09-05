import { useCallback, useEffect, useState } from 'react';
import type { EventSubscription } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { compactJson, formatRelative } from '../../lib/format';
import { reportError } from '../../store/actions';
import { runtimeFor } from '../../store/state';
import { useAppState } from '../../store/store';

interface EventsDrawerProps {
  sessionId: string;
  onClose: () => void;
}

/** Live `sdk.events.on` subscriptions for the session, with remove buttons. */
export function EventsDrawer({ sessionId, onClose }: EventsDrawerProps) {
  const version = useAppState((s) => runtimeFor(s, sessionId).eventsVersion);
  const [subs, setSubs] = useState<EventSubscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSubs(await api().events.list(sessionId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setSubs([]);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const remove = async (id: string) => {
    try {
      await api().events.remove(id);
      setSubs((list) => (list ? list.filter((s) => s.id !== id) : list));
    } catch (err) {
      reportError('Could not remove subscription', err);
    }
  };

  return (
    <div className="session-panel">
      <div className="session-panel-inner">
        <div className="row">
          <h3 className="grow">Events this character listens to</h3>
          <button type="button" className="btn btn-sm" onClick={load}>
            Refresh
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted small">
          Subscriptions the character created with <code>sdk.events.on</code>. When one fires its code runs in the sandbox (audited), which
          may wake the character. Remove any you do not want.
        </p>
        {error ? <div className="callout callout-danger small">{error}</div> : null}
        {subs === null ? (
          <div className="row muted small">
            <span className="spinner" /> Loading…
          </div>
        ) : subs.length === 0 ? (
          <p className="muted small">No subscriptions in this session.</p>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {subs.map((s) => (
              <div key={s.id} className="cap-row" style={{ alignItems: 'flex-start' }}>
                <div className="item-text">
                  <span className="item-title">
                    <code>{s.event}</code>
                    {s.label ? ` — ${s.label}` : ''}
                    {s.once ? <span className="badge" style={{ marginLeft: 6 }}>once</span> : null}
                  </span>
                  <span className="item-sub">
                    {s.filter && Object.keys(s.filter).length > 0 ? `filter ${compactJson(s.filter, 80)} · ` : ''}
                    fired {s.fired}×{s.lastFiredAt ? ` (last ${formatRelative(s.lastFiredAt)})` : ''} · created {formatRelative(s.createdAt)}
                  </span>
                  {showCode === s.id ? (
                    <pre style={{ marginTop: 6, maxHeight: 200 }}>
                      <code>{s.code}</code>
                    </pre>
                  ) : null}
                </div>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowCode(showCode === s.id ? null : s.id)}>
                  {showCode === s.id ? 'Hide code' : 'Code'}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(s.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
