import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditEntry } from '@rp/shared';
import { api, errorMessage } from '../api';
import { compactJson, formatDateTime, formatDuration, prettyJson } from '../lib/format';
import { useAppState } from '../store/store';

const LIMIT = 500;

function outcomeClass(o: AuditEntry['outcome']): string {
  return o === 'allowed' ? 'badge badge-success' : o === 'denied' ? 'badge badge-warning' : 'badge badge-danger';
}

export function ActionLogView() {
  const sessions = useAppState((s) => s.sessions);
  const activeSessionId = useAppState((s) => s.activeSessionId);
  const [sessionId, setSessionId] = useState<string>('');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api().audit.list({ sessionId: sessionId || undefined, limit: LIMIT });
      setEntries(list.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)));
    } catch (err) {
      setError(errorMessage(err));
      setEntries([]);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const titleBySession = useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions]);

  return (
    <div className="view">
      <div className="view-header">
        <h1>Action log</h1>
        <div className="row">
          <label htmlFor="log-session" className="muted small">
            Session
          </label>
          <select id="log-session" value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ width: 240 }}>
            <option value="">All sessions</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
                {s.id === activeSessionId ? ' (current)' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-sm" onClick={load}>
            Refresh
          </button>
        </div>
      </div>
      <p className="muted small" style={{ marginBottom: 10 }}>
        Every SDK call a character made, whether it was allowed, denied or failed. Click a row for the full arguments.
      </p>
      {error ? <div className="callout callout-danger">{error}</div> : null}
      {entries === null ? (
        <div className="row muted">
          <span className="spinner" /> Loading…
        </div>
      ) : entries.length === 0 ? (
        <p className="muted">No entries yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Session</th>
                <th>Character</th>
                <th>Call</th>
                <th>Arguments</th>
                <th>Outcome</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <RowGroup key={e.id} entry={e} sessionTitle={titleBySession.get(e.sessionId)} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
              ))}
            </tbody>
          </table>
          {entries.length >= LIMIT ? <p className="muted small" style={{ padding: 8 }}>Showing the latest {LIMIT} entries.</p> : null}
        </div>
      )}
    </div>
  );
}

function RowGroup({ entry, sessionTitle, open, onToggle }: { entry: AuditEntry; sessionTitle: string | undefined; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="expandable" onClick={onToggle} aria-expanded={open}>
        <td className="nowrap">{formatDateTime(entry.at)}</td>
        <td>{sessionTitle ?? <span className="muted mono small">{entry.sessionId}</span>}</td>
        <td>{entry.characterRef.split('/').pop()}</td>
        <td className="mono nowrap">
          {entry.module}.{entry.method}
        </td>
        <td className="args">{compactJson(entry.args, 100)}</td>
        <td>
          <span className={outcomeClass(entry.outcome)}>{entry.outcome}</span>
        </td>
        <td className="nowrap">{formatDuration(entry.durationMs)}</td>
      </tr>
      {open ? (
        <tr>
          <td className="detail" colSpan={7}>
            <div className="stack">
              <div>
                <strong className="small">Arguments</strong>
                <pre>
                  <code>{prettyJson(entry.args)}</code>
                </pre>
              </div>
              {entry.error ? (
                <div>
                  <strong className="small">Error</strong>
                  <pre>
                    <code>
                      {entry.error.code}: {entry.error.message}
                    </code>
                  </pre>
                </div>
              ) : null}
              <div className="muted small mono">
                {entry.characterRef} · session {entry.sessionId} · entry {entry.id}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
