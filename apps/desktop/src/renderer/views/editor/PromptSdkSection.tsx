import { useMemo, useState } from 'react';
import type { CapabilityInfo } from '@rp/shared';
import { functionKey, isAlwaysAvailableModule, selectionCovers } from '@rp/shared';
import { Toggle } from '../../components/common/Toggle';
import { useAppState } from '../../store/store';

interface PromptSdkSectionProps {
  /** `character.json`'s `promptFunctions`; `undefined` means "everything the user allows". */
  value: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}

/** A module id is stored when every function of it is picked; otherwise each function is listed. */
function normalise(picked: ReadonlySet<string>, caps: readonly CapabilityInfo[]): string[] {
  const out: string[] = [];
  for (const c of caps) {
    if (isAlwaysAvailableModule(c.id)) continue;
    const names = c.methods.map((m) => m.name).filter((name) => picked.has(functionKey(c.id, name)));
    if (names.length === 0) continue;
    if (names.length === c.methods.length) out.push(c.id);
    else for (const name of names) out.push(functionKey(c.id, name));
  }
  return out;
}

/**
 * Editor → Character → "SDK in the prompt": which functions the character's own reference describes.
 *
 * It is an editorial choice about the prompt, not a permission. Code still reaches everything the
 * user allows, so a pack can keep a module out of the character's reference and still call it from
 * a `lib` function of its own — and it can never add anything the user switched off.
 */
export function PromptSdkSection({ value, onChange }: PromptSdkSectionProps) {
  const caps = useAppState((s) => s.capabilities).filter((c) => !isAlwaysAvailableModule(c.id));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const narrowed = value !== undefined;

  /** What is ticked right now: every function when the character names none. */
  const picked = useMemo(() => {
    const set = new Set<string>();
    for (const c of caps) for (const m of c.methods) if (selectionCovers(value, c.id, m.name)) set.add(functionKey(c.id, m.name));
    return set;
  }, [caps, value]);

  const write = (next: Set<string>) => onChange(normalise(next, caps));

  const setModule = (c: CapabilityInfo, on: boolean) => {
    const next = new Set(picked);
    for (const m of c.methods) if (on) next.add(functionKey(c.id, m.name));
      else next.delete(functionKey(c.id, m.name));
    write(next);
  };

  const setFunction = (c: CapabilityInfo, name: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(functionKey(c.id, name));
    else next.delete(functionKey(c.id, name));
    write(next);
  };

  return (
    <div className="field" style={{ marginTop: 16 }}>
      <span className="field-label">SDK in the prompt</span>
      <p className="field-hint">
        Which SDK functions your character’s prompt describes. A shorter reference is a cheaper, more focused prompt — pick the
        ones this character actually works with. It does not restrict the pack: your behaviour scripts and <code className="mono">lib</code>{' '}
        functions still call anything the user allows, so you can hide <code className="mono">sdk.wallpaper</code> from the character
        and still set the wallpaper from a <code className="mono">lib</code> function. It cannot widen anything either — the user’s
        Settings → Permissions always has the last word, and <code className="mono">sdk.lib</code> is always described.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <Toggle
          checked={!narrowed}
          aria-label="Describe every function the user allows"
          onChange={(v) => onChange(v ? undefined : normalise(picked, caps))}
        />
        <span className="small">Describe every function the user allows</span>
      </div>
      {narrowed ? (
        <div className="cap-list">
          {caps.length === 0 ? <span className="muted small">No capability modules reported.</span> : null}
          {caps.map((c) => {
            const names = c.methods.map((m) => m.name);
            const on = names.filter((n) => picked.has(functionKey(c.id, n))).length;
            const expanded = open[c.id] === true;
            return (
              <div key={c.id} className="stack" style={{ gap: 2 }}>
                <div className="cap-row">
                  <div className="item-text">
                    <span className="item-title">
                      {c.title} <span className="muted mono small">sdk.{c.id}</span>
                      {on > 0 && on < names.length ? (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          {on} of {names.length}
                        </span>
                      ) : null}
                    </span>
                    <span className="item-sub">{c.summary}</span>
                  </div>
                  {names.length > 0 ? (
                    <button type="button" className="ghost small" aria-expanded={expanded} onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}>
                      {expanded ? 'Hide functions' : `${names.length} functions`}
                    </button>
                  ) : null}
                  <Toggle checked={on > 0} aria-label={`Describe sdk.${c.id} in the prompt`} onChange={(v) => setModule(c, v)} />
                </div>
                {expanded
                  ? c.methods.map((m) => (
                      <div key={m.name} className="cap-row" style={{ paddingLeft: 24 }}>
                        <div className="item-text">
                          <span className="item-title mono small">
                            sdk.{c.id}.{m.name}
                          </span>
                          <span className="item-sub">{m.description}</span>
                        </div>
                        <Toggle checked={picked.has(functionKey(c.id, m.name))} aria-label={`Describe sdk.${c.id}.${m.name} in the prompt`} onChange={(v) => setFunction(c, m.name, v)} />
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
