import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
}

type Row = { kind: 'message'; at: string; message: ChatMessage } | { kind: 'marker'; at: string; marker: EventMarker };

/** Merge messages and markers by time (stable: messages first on ties). */
export function mergeRows(messages: ChatMessage[], markers: EventMarker[]): Row[] {
  const rows: Row[] = [
    ...messages.map((m): Row => ({ kind: 'message', at: m.createdAt, message: m })),
    ...markers.map((k): Row => ({ kind: 'marker', at: k.at, marker: k })),
  ];
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === b.kind ? 0 : a.kind === 'message' ? -1 : 1));
}

/** Scrollable transcript that sticks to the bottom while the user has not scrolled up. */
export function MessageList({ messages, characterName, avatarUrl, userName, turnRunning, error, markers = [] }: MessageListProps) {
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
          </div>
        ) : null}
      </div>
    </div>
  );
}
