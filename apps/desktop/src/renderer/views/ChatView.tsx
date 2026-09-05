import { useCallback, useMemo, useState } from 'react';
import { ConfirmDialog } from '../components/common/Modal';
import { EmptyState } from '../components/common/EmptyState';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { SessionPanel } from '../components/chat/SessionPanel';
import { Avatar } from '../components/common/Avatar';
import { abortTurn, closeAllMedia, deleteSession, navigate, saveSession, sendMessage } from '../store/actions';
import { runtimeFor } from '../store/state';
import { useAppState } from '../store/store';

export function ChatView() {
  const activeSessionId = useAppState((s) => s.activeSessionId);
  const sessions = useAppState((s) => s.sessions);
  const characters = useAppState((s) => s.characters);
  const settings = useAppState((s) => s.settings);
  const messages = useAppState((s) => (activeSessionId ? s.messages[activeSessionId] : undefined));
  const runtime = useAppState((s) => runtimeFor(s, activeSessionId));
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const session = useMemo(() => sessions.find((s) => s.id === activeSessionId), [sessions, activeSessionId]);
  const character = useMemo(() => (session ? characters.find((c) => c.ref === session.characterRef) : undefined), [characters, session]);

  const providersConfigured = (settings?.providers.length ?? 0) > 0;
  const onSend = useCallback((text: string) => session && sendMessage(session.id, text), [session]);
  const onAbort = useCallback(() => session && abortTurn(session.id), [session]);

  if (!session) {
    const hasCharacters = characters.length > 0;
    return (
      <div className="view">
        <EmptyState
          title={hasCharacters ? 'Pick a character' : 'No packs installed'}
          actions={
            hasCharacters ? undefined : (
              <button type="button" className="btn btn-primary" onClick={() => navigate('packs')}>
                Install a pack
              </button>
            )
          }
        >
          {hasCharacters
            ? 'Choose a character in the sidebar and press + to start a new chat, or continue a previous session.'
            : 'Characters come from packs. Install a .rppack file or a pack folder to get started.'}
          {!providersConfigured ? (
            <p style={{ marginTop: 10 }}>
              You also need an LLM provider:{' '}
              <button type="button" className="btn btn-sm" onClick={() => navigate('settings')}>
                Open settings
              </button>
            </p>
          ) : null}
        </EmptyState>
      </div>
    );
  }

  const characterName = character?.name ?? session.characterRef.split('/').pop() ?? 'Character';
  const running = runtime.turnId !== null;

  return (
    <div className="chat">
      <header className="chat-header">
        <Avatar name={characterName} url={character?.avatarUrl} />
        <div className="item-text">
          <div className="item-title">{session.title}</div>
          <div className="item-sub">
            {characterName}
            {character ? ` · ${character.packName}` : ' · pack not installed'}
            {session.model ? ` · ${session.model}` : ''}
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={closeAllMedia} title="Close every open media window">
          Close media
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}>
          Session settings
        </button>
      </header>
      {panelOpen ? (
        <SessionPanel
          session={session}
          providers={settings?.providers ?? []}
          onSave={saveSession}
          onDelete={() => setConfirmDelete(true)}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
      <MessageList
        messages={messages}
        characterName={characterName}
        avatarUrl={character?.avatarUrl}
        userName={settings?.userDisplayName || 'You'}
        turnRunning={running}
        error={runtime.error}
      />
      <div className="status-line" aria-live="polite">
        {running ? <span className="spinner" /> : null}
        {runtime.status ? <span>{runtime.status}</span> : running ? <span>{characterName} is thinking…</span> : null}
      </div>
      {!providersConfigured ? (
        <div className="callout callout-warning small" style={{ margin: '0 18px 8px' }}>
          No LLM provider is configured.{' '}
          <button type="button" className="btn btn-sm" onClick={() => navigate('settings')}>
            Add one in Settings
          </button>
        </div>
      ) : null}
      <Composer
        sessionKey={session.id}
        disabled={!providersConfigured || !character}
        running={running}
        onSend={onSend}
        onAbort={onAbort}
      />
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete session?"
          message={
            <>
              This removes <strong>{session.title}</strong> and its messages. This cannot be undone.
            </>
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            setPanelOpen(false);
            void deleteSession(session.id);
          }}
        />
      ) : null}
    </div>
  );
}
