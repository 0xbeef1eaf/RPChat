import { useMemo } from 'react';
import type { AppRestrictions } from '@rp/shared';
import { formatRelative } from '../lib/format';
import { createSession, navigate, openSession } from '../store/actions';
import type { RouteName } from '../store/state';
import { useAppState } from '../store/store';
import { Avatar } from './common/Avatar';

/** `needs`: the restriction a route depends on — the entry is hidden while the policy withholds it. */
const NAV: Array<{ route: RouteName; label: string; needs?: keyof AppRestrictions }> = [
  { route: 'chat', label: 'Chat' },
  { route: 'packs', label: 'Packs' },
  { route: 'editor', label: 'Pack editor', needs: 'allowPackEditor' },
  { route: 'settings', label: 'Settings' },
  { route: 'log', label: 'Action log' },
  { route: 'sdk', label: 'SDK reference' },
  { route: 'sandbox', label: 'Sandbox', needs: 'allowSandbox' },
];

export function Sidebar() {
  const route = useAppState((s) => s.route);
  const characters = useAppState((s) => s.characters);
  const sessions = useAppState((s) => s.sessions);
  const activeSessionId = useAppState((s) => s.activeSessionId);
  const runtime = useAppState((s) => s.runtime);
  const unread = useAppState((s) => s.unread);
  const appVersion = useAppState((s) => s.appVersion);
  const pendingPermissions = useAppState((s) => s.permissionRequests.length);
  const restrictions = useAppState((s) => s.restrictions);

  // A route the policy withholds is not offered at all; main refuses its channels either way.
  const nav = useMemo(() => NAV.filter((n) => !n.needs || restrictions[n.needs]), [restrictions]);

  // What the character said while the user was on another view — the Chat entry carries the total.
  const unreadTotal = useMemo(() => Object.values(unread).reduce((sum, n) => sum + n, 0), [unread]);

  const characterByRef = useMemo(() => new Map(characters.map((c) => [c.ref, c])), [characters]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="brand">rp-code</span>
      </div>
      <nav className="nav" aria-label="Main">
        {nav.map((n) => (
          <button
            key={n.route}
            type="button"
            className="nav-item"
            aria-current={route === n.route ? 'page' : undefined}
            onClick={() => navigate(n.route)}
          >
            {n.label}
            {n.route === 'chat' && pendingPermissions > 0 ? <span className="badge badge-warning">{pendingPermissions}</span> : null}
            {n.route === 'chat' && route !== 'chat' && unreadTotal > 0 ? (
              <span className="badge badge-accent" title={`${unreadTotal} new message(s) while you were elsewhere`}>
                {unreadTotal}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="sidebar-section sidebar-characters">
        <div className="sidebar-section-title">
          <span>Characters</span>
        </div>
        <div className="sidebar-list">
          {characters.length === 0 ? (
            <div className="muted small" style={{ padding: '2px 8px' }}>
              No packs installed.
            </div>
          ) : (
            characters.map((c) => (
              <div key={c.ref} className="char-item" onDoubleClick={() => createSession(c.ref)}>
                <Avatar name={c.name} url={c.avatarUrl} />
                <div className="item-text">
                  <span className="item-title">{c.name}</span>
                  <span className="item-sub">{c.tagline ?? c.packName}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-icon btn-sm"
                  title={`Open chat with ${c.name}`}
                  aria-label={`Open chat with ${c.name}`}
                  onClick={() => createSession(c.ref)}
                >
                  ›
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="sidebar-section sidebar-sessions">
        <div className="sidebar-section-title">
          <span>Sessions</span>
        </div>
        <div className="sidebar-list">
          {sessions.length === 0 ? (
            <div className="muted small" style={{ padding: '2px 8px' }}>
              No sessions yet.
            </div>
          ) : (
            sessions.map((s) => {
              const c = characterByRef.get(s.characterRef);
              const running = runtime[s.id]?.turnId != null;
              const unseen = unread[s.id] ?? 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  className="session-item"
                  aria-current={s.id === activeSessionId && route === 'chat' ? 'true' : undefined}
                  onClick={() => openSession(s.id)}
                >
                  <Avatar name={c?.name ?? '?'} url={c?.avatarUrl} />
                  <div className="item-text">
                    <span className="item-title">{s.title}</span>
                    <span className="item-sub">{s.lastMessagePreview ?? c?.name ?? s.characterRef}</span>
                  </div>
                  {unseen > 0 ? (
                    <span className="badge badge-accent" title={`${unseen} message(s) you have not read`}>
                      {unseen}
                    </span>
                  ) : null}
                  {running ? <span className="spinner" /> : <span className="item-meta">{formatRelative(s.updatedAt)}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
      <div className="sidebar-footer">{appVersion ? `v${appVersion}` : ''}</div>
    </aside>
  );
}
