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

/** A row as drawn: a run of markers with no message between them shares one divider line. */
type DisplayRow = { kind: 'message'; at: string; message: ChatMessage } | { kind: 'markers'; at: string; markers: EventMarker[] };

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

/**
 * Fold a run of markers into one row. Events firing while nobody is talking — a media widget
 * clicked a dozen times, a timer ticking — drew a divider line each, pushing the conversation off
 * screen for something the reader skims past. Only a message breaks a run, so however long the
 * quiet stretch is, it stays one line.
 */
export function groupMarkers(rows: Row[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  for (const row of rows) {
    if (row.kind === 'message') {
      out.push(row);
      continue;
    }
    const last = out.at(-1);
    // `out`'s groups are ours, so extending one in place is safe.
    if (last?.kind === 'markers') last.markers.push(row.marker);
    else out.push({ kind: 'markers', at: row.at, markers: [row.marker] });
  }
  return out;
}

/** "10:15" for a run that fired at one time, "10:15–10:19" for one that spread out. */
export function markerRunTime(markers: EventMarker[]): string {
  const first = markers[0];
  const last = markers.at(-1);
  if (!first || !last) return '';
  const from = formatTime(first.at);
  const to = formatTime(last.at);
  return from === to ? from : `${from}–${to}`;
}

/** "user-idle ×2, time" — the names behind a collapsed row, short enough to stay on one line. */
export function summarizeMarkers(markers: EventMarker[]): string {
  const counts = new Map<string, number>();
  for (const m of markers) counts.set(m.event, (counts.get(m.event) ?? 0) + 1);
  const names = [...counts].map(([event, n]) => (n > 1 ? `${event} ×${n}` : event));
  return names.length > 3 ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more` : names.join(', ');
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
  const rows = useMemo(() => (messages ? groupMarkers(mergeRows(messages, markers)) : []), [messages, markers]);
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
              <EventMarkerRow key={`marker-${row.markers[0]?.id}`} markers={row.markers} />
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

/** One divider line for a run of events; a collapsed run expands to the individual firings. */
function EventMarkerRow({ markers }: { markers: EventMarker[] }) {
  const [open, setOpen] = useState(false);
  const first = markers[0];
  if (!first) return null;
  if (markers.length === 1) {
    return (
      <div className="event-marker" title={`subscription ${first.subscriptionId}`}>
        <span className="event-marker-line" />
        <span className="event-marker-text">
          ⚡ {first.event} · {formatTime(first.at)}
        </span>
        <span className="event-marker-line" />
      </div>
    );
  }
  return (
    <div className="event-marker-group">
      <div className="event-marker">
        <span className="event-marker-line" />
        <button type="button" className="event-marker-text event-marker-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          ⚡ {markers.length} events · {summarizeMarkers(markers)} · {markerRunTime(markers)} {open ? '▴' : '▾'}
        </button>
        <span className="event-marker-line" />
      </div>
      {open ? (
        <div className="event-marker-list">
          {markers.map((m) => (
            <span key={m.id} title={`subscription ${m.subscriptionId}`}>
              {m.event} · {formatTime(m.at)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
