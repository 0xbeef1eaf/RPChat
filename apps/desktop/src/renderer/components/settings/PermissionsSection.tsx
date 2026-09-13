import { useMemo } from 'react';
import type { AppSettings, CapabilityInfo } from '@rp/shared';
import { isManaged } from '../../lib/managed';
import { useAppState } from '../../store/store';
import { Toggle } from '../common/Toggle';
import { ManagedBadge } from './Managed';

interface PermissionsSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
}

const LEVELS: Array<{ level: CapabilityInfo['permission']; title: string; hint: string }> = [
  { level: 'pack', title: 'Capabilities', hint: 'On for every character unless you switch them off here; characters use them without asking.' },
  { level: 'prompt', title: 'Confirm-every-call capabilities', hint: 'Also on for every character unless switched off here, and every call additionally asks you first. Third-party modules may declare this level; none of the built-in ones do.' },
];

/** The one and only permission control: which non-trusted modules every character may use. */
export function PermissionsSection({ settings, onPatch }: PermissionsSectionProps) {
  const caps = useAppState((s) => s.capabilities);
  const managed = useAppState((s) => s.managed);
  const error: string | null = null;

  const allow = settings.permissions?.moduleAllow ?? {};
  const grouped = useMemo(() => {
    const m = new Map<CapabilityInfo['permission'], CapabilityInfo[]>();
    for (const c of caps) {
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
        <strong>Capabilities — on for every character unless you switch them off here.</strong> This is the only permission switch:
        it applies to every installed character, now and in the future; packs neither request nor are granted anything. Turning a
        module off removes it from every character's SDK, so it cannot even be attempted. Trusted modules (chat, state, timers,
        memory, events, mood, routine, …) only touch the app's own data and are always available.
        {deniedCount > 0 ? ` Currently ${deniedCount} module${deniedCount === 1 ? '' : 's'} off.` : ''}
      </div>
      {error ? <div className="callout callout-danger small">{error}</div> : null}
      {caps.length === 0 ? <p className="muted small">No capability modules reported.</p> : null}
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
                const forced = isManaged(managed, `permissions.moduleAllow.${c.id}`);
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
                            off
                          </span>
                        ) : null}
                        <ManagedBadge show={forced} />
                      </span>
                      <span className="item-sub">{c.summary}</span>
                    </div>
                    <Toggle checked={allowed} disabled={forced} aria-label={`Allow ${c.id} for every character`} onChange={(v) => setModule(c.id, v)} />
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
