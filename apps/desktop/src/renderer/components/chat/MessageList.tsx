import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SELF_WAKE_PREFIX } from '@rp/shared';
import type { ChatMessage, SerializedError } from '@rp/shared';
import { formatTime } from '../../lib/format';
import type { EventMarker } from '../../store/state';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: ChatMessage[] | undefined;
  characterName: string;
  avatarUrl?: string;
  userName: string;
  turnRunning: boolean;
  error: SerializedError | null;
  /** `event-fired` markers, rendered inline at their time. */
  markers?: EventMarker[];
  onDeleteMessage?: (messageId: string) => void;
  /** Discard the last reply and generate another; offered on that reply and on a failed turn. */
  onRetry?: () => void;
}

type Row = { kind: 'message'; at: string; message: ChatMessage } | { kind: 'marker'; at: string; marker: EventMarker };

/** Merge messages and markers by time (stable: messages first on ties). */
/** Self-wake notes are for the model only; showing them would reveal that the character was prompted. */
export function isWakeNote(m: ChatMessage): boolean {
  return m.role === 'system' && m.content.startsWith(SELF_WAKE_PREFIX);
}

export function mergeRows(messages: ChatMessage[], markers: EventMarker[]): Row[] {
  const rows: Row[] = [
    ...messages.filter((m) => !isWakeNote(m)).map((m): Row => ({ kind: 'message', at: m.createdAt, message: m })),
    ...markers.map((k): Row => ({ kind: 'marker', at: k.at, marker: k })),
  ];
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === b.kind ? 0 : a.kind === 'message' ? -1 : 1));
}

/** Scrollable transcript that sticks to the bottom while the user has not scrolled up. */
/**
 * Whether "generate another reply" makes sense: the turn's input has to still be there. A
 * transcript of nothing but assistant messages (a fresh session showing only its greeting) has
 * nothing for the character to answer.
 */
export function canRetry(messages: ChatMessage[] | undefined): boolean {
  return Boolean(messages?.some((m) => m.role !== 'assistant'));
}

export function MessageList({ messages, characterName, avatarUrl, userName, turnRunning, error, markers = [], onDeleteMessage, onRetry }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distance < 48);
  };

  const lastId = messages?.at(-1)?.id;
  const lastLen = messages?.at(-1)?.content.length ?? 0;
  const lastActions = messages?.at(-1)?.actions?.length ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [pinned, lastId, lastLen, lastActions, messages?.length, markers.length, error]);

  // New session → always start at the bottom.
  useEffect(() => {
    setPinned(true);
  }, [messages === undefined]);

  const streamingId = turnRunning && messages ? messages.at(-1)?.id : undefined;
  const rows = useMemo(() => (messages ? mergeRows(messages, markers) : []), [messages, markers]);
  // One retry, on the newest reply: the engine regenerates the whole run of messages the last
  // turn added, so a button per assistant message would promise something finer than it does.
  const retryable = onRetry && !turnRunning && canRetry(messages);
  const lastVisible = rows.at(-1);
  const retryMessageId = retryable && lastVisible?.kind === 'message' && lastVisible.message.role === 'assistant' ? lastVisible.message.id : undefined;

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-inner">
        {messages === undefined ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : messages.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center' }}>
            Say hello to {characterName}.
          </p>
        ) : (
          rows.map((row) =>
            row.kind === 'message' ? (
              <MessageItem
                key={row.message.id}
                message={row.message}
                characterName={characterName}
                avatarUrl={avatarUrl}
                userName={userName}
                streaming={row.message.id === streamingId && row.message.role === 'assistant'}
                onDelete={onDeleteMessage}
                {...(row.message.id === retryMessageId ? { onRetry } : {})}
              />
            ) : (
              <div key={`marker-${row.marker.id}`} className="event-marker" title={`subscription ${row.marker.subscriptionId}`}>
                <span className="event-marker-line" />
                <span className="event-marker-text">
                  ⚡ {row.marker.event} · {formatTime(row.marker.at)}
                </span>
                <span className="event-marker-line" />
              </div>
            ),
          )
        )}
        {error ? (
          <div className="callout callout-danger small">
            <strong>{error.code}</strong>: {error.message}
            {retryable ? (
              <div className="form-actions">
                <span className="grow" />
                <button type="button" className="btn btn-sm" onClick={onRetry}>
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
