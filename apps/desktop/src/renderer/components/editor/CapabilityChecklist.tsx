import { useMemo } from 'react';
import type { CapabilityInfo } from '@rp/shared';

interface CapabilityChecklistProps {
  caps: CapabilityInfo[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Modules already requested elsewhere (e.g. by the pack when editing a character) — shown as inherited. */
  inherited?: string[];
}

const LEVELS: Array<{ level: CapabilityInfo['permission']; title: string; hint: string }> = [
  { level: 'trusted', title: 'Always available', hint: 'Only touch the app’s own data; every character has these.' },
  { level: 'pack', title: 'Needs a grant', hint: 'The user grants these per pack at install time.' },
  { level: 'prompt', title: 'Needs a grant and confirms each call', hint: 'The user is asked before every call.' },
];

export function CapabilityChecklist({ caps, selected, onChange, inherited = [] }: CapabilityChecklistProps) {
  const grouped = useMemo(() => {
    const m = new Map<CapabilityInfo['permission'], CapabilityInfo[]>();
    for (const c of caps) m.set(c.permission, [...(m.get(c.permission) ?? []), c]);
    return m;
  }, [caps]);
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  const unknown = selected.filter((id) => !caps.some((c) => c.id === id));

  return (
    <div className="stack" style={{ gap: 12 }}>
      {LEVELS.map(({ level, title, hint }) => {
        const list = grouped.get(level) ?? [];
        if (list.length === 0) return null;
        return (
          <div key={level}>
            <div className="field-label">{title}</div>
            <div className="field-hint" style={{ marginBottom: 6 }}>
              {hint}
            </div>
            <div className="cap-grid">
              {list.map((c) => {
                const always = level === 'trusted';
                const inh = inherited.includes(c.id);
                const checked = always || inh || selected.includes(c.id);
                return (
                  <label key={c.id} className={`cap-check${always ? ' always' : ''}`} title={c.summary}>
                    <input type="checkbox" checked={checked} disabled={always || inh} onChange={(e) => toggle(c.id, e.target.checked)} />
                    <span className="item-text">
                      <span className="item-title">
                        {c.title} <span className="muted mono small">{c.id}</span>
                        {always ? <span className="badge badge-success" style={{ marginLeft: 6 }}>always on</span> : null}
                        {inh ? <span className="badge" style={{ marginLeft: 6 }}>from pack</span> : null}
                        {c.methods.some((m) => m.dangerous) ? <span className="badge badge-danger" style={{ marginLeft: 6 }}>dangerous</span> : null}
                      </span>
                      <span className="item-sub">{c.summary}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      {unknown.length > 0 ? (
        <div className="callout callout-warning small">
          Unknown to this app: {unknown.map((u) => <code key={u} style={{ marginRight: 4 }}>{u}</code>)}
          <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => onChange(selected.filter((id) => !unknown.includes(id)))}>
            Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}
