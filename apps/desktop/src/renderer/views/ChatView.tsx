import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { CHAT_ZOOM_MAX, CHAT_ZOOM_MIN, CHAT_ZOOM_STEP } from '@rp/shared';
import { ConfirmDialog } from '../components/common/Modal';
import { EmptyState } from '../components/common/EmptyState';
import { CharacterStatus } from '../components/chat/CharacterStatus';
import { Composer } from '../components/chat/Composer';
import { EventsDrawer } from '../components/chat/EventsDrawer';
import { MessageList } from '../components/chat/MessageList';
import { ModelTrafficDrawer } from '../components/chat/ModelTrafficDrawer';
import { SessionPanel } from '../components/chat/SessionPanel';
import { Avatar } from '../components/common/Avatar';
import { ZoomControl } from '../components/chat/ZoomControl';
import { abortTurn, clearHistory, closeAllMedia, deleteMessage, deleteSession, navigate, openMemories, resetSessionState, retryTurn, saveSession, sendMessage, setChatZoom } from '../store/actions';
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
  const [eventsOpen, setEventsOpen] = useState(false);
  const [trafficOpen, setTrafficOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const zoom = settings?.chatZoom ?? 1;

  // Ctrl/Cmd +/-/0 resize the transcript, as in a browser (the digits 1-6 switch views).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const step = e.key === '+' || e.key === '=' ? CHAT_ZOOM_STEP : e.key === '-' || e.key === '_' ? -CHAT_ZOOM_STEP : null;
      if (step === null && e.key !== '0') return;
      e.preventDefault();
      void setChatZoom(step === null ? 1 : zoom + step);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const restrictions = useAppState((s) => s.restrictions);
  const session = useMemo(() => sessions.find((s) => s.id === activeSessionId), [sessions, activeSessionId]);
  // `requireCharacterSession` keeps a conversation open, so the last one may not be deleted either.
  const canDeleteSession = restrictions.allowDeleteSession && !(restrictions.requireCharacterSession && sessions.length <= 1);
  const character = useMemo(() => (session ? characters.find((c) => c.ref === session.characterRef) : undefined), [characters, session]);

  const providersConfigured = (settings?.providers.length ?? 0) > 0;
  const onSend = useCallback((text: string) => session && sendMessage(session.id, text), [session]);
  const onAbort = useCallback(() => session && abortTurn(session.id), [session]);
  // Returns void and keeps its identity, so the memoised message it is handed does not re-render.
  const onRetry = useCallback(() => {
    if (session) void retryTurn(session.id);
  }, [session]);

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
  const showTraffic = settings?.debug.showModelTraffic === true;

  return (
    // --chat-zoom scales the transcript and the composer; the header keeps its own size.
    <div className="chat" style={{ '--chat-zoom': zoom } as CSSProperties}>
      <header className="chat-header">
        <Avatar name={characterName} url={character?.avatarUrl} />
        <div className="item-text">
          <div className="item-title">{session.title}</div>
          <div className="item-sub row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span>
              {characterName}
              {character ? ` · ${character.packName}` : ' · pack not installed'}
              {session.model ? ` · ${session.model}` : ''}
            </span>
            {character ? <CharacterStatus characterRef={session.characterRef} /> : null}
          </div>
        </div>
        <ZoomControl zoom={zoom} min={CHAT_ZOOM_MIN} max={CHAT_ZOOM_MAX} step={CHAT_ZOOM_STEP} onChange={(v) => void setChatZoom(v)} />
        <button type="button" className="btn btn-sm" onClick={() => setEventsOpen((v) => !v)} aria-expanded={eventsOpen} title="Host events this character subscribed to">
          Events
        </button>
        {showTraffic ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setTrafficOpen((v) => !v)}
            aria-expanded={trafficOpen}
            title="Every request sent to the model for this session and its response (Settings → General → Debug)"
          >
            Model traffic
            {runtime.exchanges.length > 0 ? <span className="badge badge-accent">{runtime.exchanges.length}</span> : null}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => openMemories({ characterRef: session.characterRef, sessionId: session.id })}
          title={`What ${characterName} remembers about you`}
        >
          Memories
        </button>
        {restrictions.allowCloseMedia ? (
          <button type="button" className="btn btn-sm" onClick={closeAllMedia} title="Close every open media window">
            Close media
          </button>
        ) : null}
        {restrictions.allowDeleteHistory ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setConfirmClear(true)}
            disabled={!messages || messages.length === 0}
            title="Delete every message in this session; memories, timers and state stay"
          >
            Clear history
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}>
          Session settings
        </button>
      </header>
      {eventsOpen ? <EventsDrawer sessionId={session.id} onClose={() => setEventsOpen(false)} /> : null}
      {showTraffic && trafficOpen ? <ModelTrafficDrawer sessionId={session.id} onClose={() => setTrafficOpen(false)} /> : null}
      {panelOpen ? (
        <SessionPanel
          session={session}
          providers={settings?.providers ?? []}
          onSave={saveSession}
          onDelete={canDeleteSession ? () => setConfirmDelete(true) : undefined}
          onReset={restrictions.allowResetState ? () => setConfirmReset(true) : undefined}
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
        markers={runtime.eventMarkers}
        onDeleteMessage={restrictions.allowDeleteHistory ? (messageId) => void deleteMessage(session.id, messageId) : undefined}
        onRetry={onRetry}
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
        canAbort={restrictions.allowStopGeneration}
      />
      {confirmReset ? (
        <ConfirmDialog
          title="Reset session state?"
          message={
            <>
              This forgets what <strong>{characterName}</strong> stored for this session (scratch state, pending timers, event subscriptions,
              the rolling history summary and the status line). Messages, long-term state and memories stay.{' '}
              {restrictions.allowStopGeneration ? 'A running reply is stopped.' : 'A reply already being written has to finish first.'}
            </>
          }
          confirmLabel="Reset"
          danger
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            setPanelOpen(false);
            void resetSessionState(session.id);
          }}
        />
      ) : null}
      {confirmClear ? (
        <ConfirmDialog
          title="Clear history?"
          message={
            <>
              This deletes every message in <strong>{session.title}</strong>. The character keeps its memories, timers and state; only the
              conversation is removed. This cannot be undone.
            </>
          }
          confirmLabel="Clear"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void clearHistory(session.id);
          }}
        />
      ) : null}
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
