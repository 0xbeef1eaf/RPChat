import { useState } from 'react';
import type { InstalledPackView } from '@rp/shared';
import { formatDateTime } from '../../lib/format';
import { createSession, openMemories, openSettings } from '../../store/actions';
import { Avatar } from '../common/Avatar';
import { Markdown } from '../common/Markdown';
import { MediaSummary } from './MediaSummary';

interface PackCardProps {
  pack: InstalledPackView;
  /** Omitted while the policy forbids removing packs — the button is then not rendered. */
  onUninstall?: (() => void) | undefined;
}

export function PackCard({ pack, onUninstall }: PackCardProps) {
  const [readmeOpen, setReadmeOpen] = useState(false);
  const m = pack.manifest;

  return (
    <article className="card">
      <div className="pack-head">
        <div className="item-text">
          <div className="pack-title">
            <h2>{m.name}</h2>
            <span className="badge">{m.version}</span>
            <span className="muted small mono">{m.id}</span>
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
          {onUninstall ? (
            <button type="button" className="btn btn-sm btn-danger" onClick={onUninstall}>
              Uninstall
            </button>
          ) : null}
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
          <h3 style={{ marginBottom: 8 }}>Permissions</h3>
          <p className="field-hint pack-permissions-note">
            Permissions apply to every character and are set under Settings → Permissions.
          </p>
          <button type="button" className="btn btn-sm" onClick={() => openSettings('permissions')}>
            Open Settings → Permissions
          </button>
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
