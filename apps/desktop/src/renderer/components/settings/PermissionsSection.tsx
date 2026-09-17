import { useMemo, useState } from 'react';
import type { AppSettings, CapabilityInfo } from '@rp/shared';
import { functionAllowed, functionKey, isAlwaysAvailableModule, moduleAllowState } from '@rp/shared';
import { isManaged } from '../../lib/managed';
import { useAppState } from '../../store/store';
import { Toggle } from '../common/Toggle';
import { ManagedBadge } from './Managed';

interface PermissionsSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
}

const LEVELS: Array<{ level: CapabilityInfo['permission']; title: string; hint: string }> = [
  { level: 'trusted', title: 'Inside the app', hint: 'Talking, remembering, timers, the character’s own state and media: effects that stay inside rpchat’s own data. On unless you switch one off — but a character without sdk.chat.say cannot answer you, so switch these off deliberately.' },
  { level: 'pack', title: 'Capabilities', hint: 'Reach outside the app. On for every character unless you switch them off here; characters use them without asking.' },
  { level: 'prompt', title: 'Confirm-every-call capabilities', hint: 'Also on for every character unless switched off here, and every call additionally asks you first. Third-party modules may declare this level; none of the built-in ones do.' },
];

/** The one and only permission control: which SDK functions every character may call. */
export function PermissionsSection({ settings, onPatch }: PermissionsSectionProps) {
  const caps = useAppState((s) => s.capabilities);
  const managed = useAppState((s) => s.managed);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const allow = settings.permissions?.functionAllow ?? {};
  const grouped = useMemo(() => {
    const m = new Map<CapabilityInfo['permission'], CapabilityInfo[]>();
    for (const c of caps) {
      if (isAlwaysAvailableModule(c.id)) continue;
      m.set(c.permission, [...(m.get(c.permission) ?? []), c]);
    }
    return m;
  }, [caps]);

  /**
   * Every write sends the whole map (a patch replaces it rather than merging), and every key that
   * would only repeat "on" is left out, so the stored policy stays as small as the decisions in it.
   */
  const write = (next: Record<string, boolean>) => onPatch({ permissions: { functionAllow: next } });

  const setModule = (c: CapabilityInfo, allowed: boolean) => {
    const next = { ...allow };
    for (const m of c.methods) delete next[functionKey(c.id, m.name)];
    if (allowed) delete next[c.id];
    else next[c.id] = false;
    return write(next);
  };

  const setFunction = (c: CapabilityInfo, method: string, allowed: boolean) => {
    const next = { ...allow };
    const key = functionKey(c.id, method);
    // The module's own entry stays the default for its siblings, so only the odd one out is stored.
    if (allowed === (next[c.id] !== false)) delete next[key];
    else next[key] = allowed;
    return write(next);
  };

  const offCount = caps.reduce(
    (n, c) => (isAlwaysAvailableModule(c.id) ? n : n + c.methods.filter((m) => !functionAllowed(allow, c.id, m.name)).length),
    0,
  );

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="callout small">
        <strong>Every SDK function is on for every character unless you switch it off here.</strong> This is the only permission
        switch: it applies to every installed character, now and in the future; packs neither request nor are granted anything.
        Switching a module off removes all of its functions from every character’s SDK; open it to switch off single functions
        instead. Either way the function is not there to attempt. A pack may describe fewer functions than this in its
        character’s prompt, but it can never reach past what you allow here. <span className="mono">sdk.lib</span> — the
        character’s own saved functions — is always available and not listed.
        {offCount > 0 ? ` Currently ${offCount} function${offCount === 1 ? '' : 's'} off.` : ''}
      </div>
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
                const names = c.methods.map((m) => m.name);
                const state = moduleAllowState(allow, c.id, names);
                const dangerous = c.methods.some((m) => m.dangerous);
                const forced = isManaged(managed, `permissions.functionAllow.${c.id}`);
                const expanded = open[c.id] === true;
                return (
                  <div key={c.id} className="stack" style={{ gap: 2 }}>
                    <div className="cap-row">
                      <div className="item-text">
                        <span className="item-title">
                          {c.title} <span className="muted mono small">sdk.{c.id}</span>
                          {dangerous ? (
                            <span className="badge badge-danger" style={{ marginLeft: 6 }} title="Has functions with effects outside the app">
                              dangerous
                            </span>
                          ) : null}
                          {state === 'none' ? (
                            <span className="badge badge-warning" style={{ marginLeft: 6 }}>
                              off
                            </span>
                          ) : null}
                          {state === 'some' ? (
                            <span className="badge badge-warning" style={{ marginLeft: 6 }}>
                              {names.filter((n) => !functionAllowed(allow, c.id, n)).length} of {names.length} off
                            </span>
                          ) : null}
                          <ManagedBadge show={forced} />
                        </span>
                        <span className="item-sub">{c.summary}</span>
                      </div>
                      {names.length > 0 ? (
                        <button type="button" className="ghost small" aria-expanded={expanded} onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}>
                          {expanded ? 'Hide functions' : `${names.length} functions`}
                        </button>
                      ) : null}
                      <Toggle
                        checked={state !== 'none'}
                        disabled={forced}
                        aria-label={`Allow every function of ${c.id} for every character`}
                        onChange={(v) => setModule(c, v)}
                      />
                    </div>
                    {expanded
                      ? c.methods.map((m) => {
                          const on = functionAllowed(allow, c.id, m.name);
                          const pinned = isManaged(managed, `permissions.functionAllow.${functionKey(c.id, m.name)}`);
                          return (
                            <div key={m.name} className="cap-row" style={{ paddingLeft: 24 }}>
                              <div className="item-text">
                                <span className="item-title mono small">
                                  sdk.{c.id}.{m.name}
                                  {m.dangerous ? (
                                    <span className="badge badge-danger" style={{ marginLeft: 6 }} title="Effects outside the app">
                                      dangerous
                                    </span>
                                  ) : null}
                                  <ManagedBadge show={pinned} />
                                </span>
                                <span className="item-sub">{m.description}</span>
                              </div>
                              <Toggle checked={on} disabled={pinned} aria-label={`Allow sdk.${c.id}.${m.name} for every character`} onChange={(v) => setFunction(c, m.name, v)} />
                            </div>
                          );
                        })
                      : null}
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
