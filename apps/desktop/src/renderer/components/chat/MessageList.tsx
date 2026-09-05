import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, SerializedError } from '@rp/shared';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: ChatMessage[] | undefined;
  characterName: string;
  avatarUrl?: string;
  userName: string;
  turnRunning: boolean;
  error: SerializedError | null;
}

/** Scrollable transcript that sticks to the bottom while the user has not scrolled up. */
export function MessageList({ messages, characterName, avatarUrl, userName, turnRunning, error }: MessageListProps) {
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
  }, [pinned, lastId, lastLen, lastActions, messages?.length, error]);

  // New session → always start at the bottom.
  useEffect(() => {
    setPinned(true);
  }, [messages === undefined]);

  const streamingId = turnRunning && messages ? messages.at(-1)?.id : undefined;

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
          messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              characterName={characterName}
              avatarUrl={avatarUrl}
              userName={userName}
              streaming={m.id === streamingId && m.role === 'assistant'}
            />
          ))
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
