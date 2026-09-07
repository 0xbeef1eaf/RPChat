import { useState } from 'react';
import type { CapabilityInfo, InstalledPackView } from '@rp/shared';
import { formatDateTime } from '../../lib/format';
import { createSession, openMemories, setGrant } from '../../store/actions';
import { Avatar } from '../common/Avatar';
import { Markdown } from '../common/Markdown';
import { Toggle } from '../common/Toggle';
import { MediaSummary } from './MediaSummary';

interface PackCardProps {
  pack: InstalledPackView;
  capabilities: Map<string, CapabilityInfo>;
  onUninstall: () => void;
}

export function PackCard({ pack, capabilities, onUninstall }: PackCardProps) {
  const [readmeOpen, setReadmeOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const m = pack.manifest;
  const grantByModule = new Map(pack.grants.map((g) => [g.module, g]));
  const blocked = pack.blockedByPolicy ?? [];
  const effective = pack.effectiveCapabilities ?? [];

  const toggle = async (module: string, granted: boolean) => {
    setBusy(module);
    await setGrant(pack.packId, module, granted);
    setBusy(null);
  };

  return (
    <article className="card">
      <div className="pack-head">
        <div className="item-text">
          <div className="pack-title">
            <h2>{m.name}</h2>
            <span className="badge">{m.version}</span>
            <span className="muted small mono">{m.id}</span>
            {blocked.length > 0 ? (
              <span className="badge badge-warning" title={`Denied by Settings → Permissions: ${blocked.join(', ')}`}>
                {blocked.length} blocked by your policy
              </span>
            ) : null}
          </div>
          {m.description ? <p className="muted">{m.description}</p> : null}
          <p className="small muted">
            {m.author ? `by ${m.author.name} · ` : ''}
            {m.license ? `${m.license} · ` : ''}installed {formatDateTime(pack.installedAt)}
            {m.tags && m.tags.length > 0 ? ` · ${m.tags.join(', ')}` : ''}
          </p>
          <MediaSummary assetCounts={pack.assetCounts} assetTags={pack.assetTags} />
        </div>
        <div className="row">
          {pack.readme ? (
            <button type="button" className="btn btn-sm" onClick={() => setReadmeOpen((v) => !v)} aria-expanded={readmeOpen}>
              {readmeOpen ? 'Hide README' : 'README'}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-danger" onClick={onUninstall}>
            Uninstall
          </button>
        </div>
      </div>

      <div className="pack-body">
        <section>
          <h3 style={{ marginBottom: 8 }}>Characters</h3>
          <div className="char-list">
            {pack.characters.length === 0 ? <span className="muted small">This pack has no characters.</span> : null}
            {pack.characters.map((c) => (
              <div key={c.ref} className="char-row">
                <Avatar name={c.name} url={c.avatarUrl} />
                <div className="item-text">
                  <span className="item-title">{c.name}</span>
                  {c.tagline ? <span className="item-sub">{c.tagline}</span> : null}
                </div>
                <button type="button" className="btn btn-sm" onClick={() => openMemories({ characterRef: c.ref })}>
                  Memories
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => createSession(c.ref)}>
                  Start chat
                </button>
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3 style={{ marginBottom: 8 }}>Capabilities</h3>
          {pack.requestedCapabilities.length > 0 ? (
            <p className="field-hint" style={{ marginBottom: 8 }}>
              Effective now: {effective.length > 0 ? effective.map((e) => <code key={e} style={{ marginRight: 4 }}>{e}</code>) : <em>none beyond trusted</em>}
            </p>
          ) : null}
          <div className="cap-list">
            {pack.requestedCapabilities.length === 0 ? (
              <span className="muted small">Only trusted capabilities (chat, state, timers, …) are used.</span>
            ) : null}
            {pack.requestedCapabilities.map((module) => {
              const info = capabilities.get(module);
              const grant = grantByModule.get(module);
              const granted = grant?.granted ?? false;
              const isBlocked = blocked.includes(module);
              return (
                <div key={module} className={isBlocked ? 'cap-row cap-row-blocked' : 'cap-row'}>
                  <div className="item-text">
                    <span className="item-title">
                      {info?.title ?? module} <span className="muted mono small">{module}</span>
                      {info?.permission === 'prompt' ? (
                        <span className="badge badge-warning" style={{ marginLeft: 6 }} title="Every call asks for confirmation">
                          asks each time
                        </span>
                      ) : null}
                      {!info ? <span className="badge badge-danger" style={{ marginLeft: 6 }}>unknown</span> : null}
                      {isBlocked ? (
                        <span className="badge badge-warning" style={{ marginLeft: 6 }} title="Denied globally in Settings → Permissions; this toggle cannot override it">
                          blocked by your policy
                        </span>
                      ) : null}
                    </span>
                    {info?.summary ? <span className="item-sub">{info.summary}</span> : null}
                  </div>
                  <Toggle
                    checked={granted}
                    disabled={busy === module}
                    aria-label={`Allow ${module} for ${m.name}`}
                    onChange={(v) => toggle(module, v)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {readmeOpen && pack.readme ? (
        <div className="readme">
          <Markdown source={pack.readme} />
        </div>
      ) : null}
    </article>
  );
}
