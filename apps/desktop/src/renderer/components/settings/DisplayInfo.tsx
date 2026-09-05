import { useCallback, useEffect, useState } from 'react';
import type { DisplayBackendInfo, MonitorInfo } from '@rp/shared';
import { api, errorMessage } from '../../api';

/** What the active display backend can do and which monitors it sees (`sdk.display.*` as the LLM sees it). */
export function DisplayInfo() {
  const [backend, setBackend] = useState<DisplayBackendInfo | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [b, m] = await Promise.all([api().display.backend(), api().display.monitors()]);
      setBackend(b);
      setMonitors(m);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <p className="muted small grow">Overlay capabilities of the active backend. Characters query the same data via <code>sdk.display</code>.</p>
        <button type="button" className="btn btn-sm" onClick={load}>
          Refresh
        </button>
      </div>
      {error ? <div className="callout callout-danger small">{error}</div> : null}
      {backend ? (
        <dl className="kv">
          <dt>Backend</dt>
          <dd>
            <strong>{backend.name}</strong> · {backend.platform} · {backend.windowSystem}
          </dd>
          <dt>Layers</dt>
          <dd>{backend.supports.layers.join(', ') || '—'}</dd>
          <dt>Supports</dt>
          <dd>
            {(
              [
                ['opacity', backend.supports.opacity],
                ['click-through', backend.supports.clickThrough],
                ['monitor selection', backend.supports.monitorSelection],
                ['exact position', backend.supports.exactPosition],
              ] as const
            ).map(([label, ok]) => (
              <span key={label} className={ok ? 'badge badge-success' : 'badge'} style={{ marginRight: 6 }}>
                {ok ? '✓' : '✗'} {label}
              </span>
            ))}
          </dd>
        </dl>
      ) : !error ? (
        <div className="row muted small">
          <span className="spinner" /> Loading…
        </div>
      ) : null}
      {monitors ? (
        monitors.length === 0 ? (
          <p className="muted small">No monitors reported.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Work area</th>
                  <th>Scale</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {monitors.map((m) => (
                  <tr key={m.id}>
                    <td>{m.index}</td>
                    <td>
                      {m.name} <span className="muted mono small">{m.id !== m.name ? m.id : ''}</span>
                    </td>
                    <td className="mono nowrap">
                      {m.width}×{m.height} @ {m.x},{m.y}
                    </td>
                    <td>{m.scale}×</td>
                    <td>
                      {m.primary ? <span className="badge badge-accent">primary</span> : null}{' '}
                      {m.hasCursor ? <span className="badge">cursor</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}
