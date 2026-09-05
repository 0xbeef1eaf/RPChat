import type { ActionRecord } from '@rp/shared';
import { compactJson, formatDuration, prettyJson } from '../../lib/format';

interface ActionCardProps {
  action: ActionRecord;
}

function outcomeBadge(action: ActionRecord) {
  const r = action.result;
  if (!r) {
    return (
      <span className="badge badge-accent row">
        <span className="spinner" /> running
      </span>
    );
  }
  return r.ok ? <span className="badge badge-success">ok</span> : <span className="badge badge-danger">failed</span>;
}

/** One `run_action` invocation attached to an assistant message; collapsed by default. */
export function ActionCard({ action }: ActionCardProps) {
  const r = action.result;
  return (
    <details className="action">
      <summary>
        <span className="action-purpose" title={action.purpose}>
          {action.purpose || 'Action'}
        </span>
        {outcomeBadge(action)}
        {r ? <span className="muted small nowrap">{formatDuration(r.durationMs)}</span> : null}
      </summary>
      <div className="action-body">
        <div>
          <h4>
            Code <span className="muted">({action.language}, {action.source === 'tool' ? 'tool call' : 'fenced block'})</span>
          </h4>
          <pre>
            <code>{action.code}</code>
          </pre>
        </div>
        {r?.error ? (
          <div>
            <h4>Error</h4>
            <div className="callout callout-danger">
              <div>
                <strong>{r.error.code}</strong> — {r.error.message}
              </div>
              {r.error.stack ? (
                <pre>
                  <code>{r.error.stack}</code>
                </pre>
              ) : null}
            </div>
          </div>
        ) : null}
        {r && r.ok && r.returnValue !== undefined && r.returnValue !== null ? (
          <div>
            <h4>Result</h4>
            <pre>
              <code>{prettyJson(r.returnValue)}</code>
            </pre>
          </div>
        ) : null}
        {r && r.logs.length > 0 ? (
          <div>
            <h4>Logs</h4>
            <div className="stack" style={{ gap: 2 }}>
              {r.logs.map((l, i) => (
                <div key={i} className={`log-line log-${l.level}`}>
                  <span className="log-level">{l.level}</span>
                  <span>{l.message}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {r && r.calls.length > 0 ? (
          <div>
            <h4>SDK calls</h4>
            <div className="call-list">
              {r.calls.map((c) => (
                <div key={c.callId} className="call-line" title={compactJson(c.args, 600)}>
                  <span className={c.ok ? '' : 'badge badge-danger'}>{c.ok ? '✓' : '✗'}</span>
                  <span>
                    {c.module}.{c.method}
                  </span>
                  <span className="call-args">{compactJson(c.args, 80)}</span>
                  <span className="muted nowrap">{formatDuration(c.durationMs)}</span>
                  {c.error ? <span className="muted">{c.error.message}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
