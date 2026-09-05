import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, CapabilityInfo } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { Toggle } from '../common/Toggle';

interface PermissionsSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
}

const LEVELS: Array<{ level: CapabilityInfo['permission']; title: string; hint: string }> = [
  { level: 'pack', title: 'Per-pack capabilities', hint: 'Granted per pack when installed; characters use them freely once granted.' },
  { level: 'prompt', title: 'Confirm-every-call capabilities', hint: 'Third-party modules may still declare this level; none of the built-in ones do.' },
];

/** Global policy: which non-trusted modules any pack may ever use. */
export function PermissionsSection({ settings, onPatch }: PermissionsSectionProps) {
  const [caps, setCaps] = useState<CapabilityInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api()
      .capabilities.list()
      .then(setCaps)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const allow = settings.permissions?.moduleAllow ?? {};
  const grouped = useMemo(() => {
    const m = new Map<CapabilityInfo['permission'], CapabilityInfo[]>();
    for (const c of caps ?? []) {
      if (c.permission === 'trusted') continue;
      m.set(c.permission, [...(m.get(c.permission) ?? []), c]);
    }
    return m;
  }, [caps]);

  const setModule = (id: string, allowed: boolean) => onPatch({ permissions: { moduleAllow: { ...allow, [id]: allowed } } });
  const deniedCount = Object.values(allow).filter((v) => v === false).length;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="callout small">
        <strong>How permissions combine.</strong> A pack can only use a capability if <em>all three</em> hold: its manifest requests it, this
        global policy allows it, and the pack's own toggle (Packs view) is on. Turning a module off here blocks it for every pack,
        installed or future, without changing per-pack toggles; the Packs view shows what is blocked. Trusted modules (chat, state,
        timers, memory, events, mood, routine, …) only touch the app's own data and are always available.
        {deniedCount > 0 ? ` Currently ${deniedCount} module${deniedCount === 1 ? '' : 's'} denied.` : ''}
      </div>
      {error ? <div className="callout callout-danger small">{error}</div> : null}
      {caps === null && !error ? (
        <div className="row muted small">
          <span className="spinner" /> Loading…
        </div>
      ) : null}
      {LEVELS.map(({ level, title, hint }) => {
        const list = grouped.get(level) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={level}>
            <h3>{title}</h3>
            <p className="field-hint" style={{ marginBottom: 8 }}>
              {hint}
            </p>
            <div className="cap-list">
              {list.map((c) => {
                const allowed = allow[c.id] !== false;
                const dangerous = c.methods.some((m) => m.dangerous);
                return (
                  <div key={c.id} className="cap-row">
                    <div className="item-text">
                      <span className="item-title">
                        {c.title} <span className="muted mono small">sdk.{c.id}</span>
                        {dangerous ? (
                          <span className="badge badge-danger" style={{ marginLeft: 6 }} title="Has methods with effects outside the app">
                            dangerous
                          </span>
                        ) : null}
                        {!allowed ? (
                          <span className="badge badge-warning" style={{ marginLeft: 6 }}>
                            denied for all packs
                          </span>
                        ) : null}
                      </span>
                      <span className="item-sub">{c.summary}</span>
                    </div>
                    <Toggle checked={allowed} aria-label={`Allow ${c.id} globally`} onChange={(v) => setModule(c.id, v)} />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
