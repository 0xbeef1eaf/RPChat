import { memo } from 'react';
import type { ChatMessage } from '@rp/shared';
import { formatTime } from '../../lib/format';
import { Avatar } from '../common/Avatar';
import { Markdown } from '../common/Markdown';
import { ActionCard } from './ActionCard';

interface MessageItemProps {
  message: ChatMessage;
  characterName: string;
  avatarUrl?: string;
  userName: string;
  /** Text is still arriving for this message. */
  streaming: boolean;
  /** Delete this message from the history (hidden while streaming). */
  onDelete?: (messageId: string) => void;
  /** Generate this reply again (only given for the last one, and never while streaming). */
  onRetry?: () => void;
}

function originLabel(origin: ChatMessage['origin']): string | null {
  switch (origin) {
    case 'behaviour':
      return 'script';
    case 'timer':
      return null; // an unprompted message reads like one; no badge
    case 'greeting':
      return 'greeting';
    default:
      return null;
  }
}

export const MessageItem = memo(function MessageItem({ message, characterName, avatarUrl, userName, streaming, onDelete, onRetry }: MessageItemProps) {
  const deleteButton =
    onDelete && !streaming ? (
      <button type="button" className="msg-delete" title="Delete this message from the history" aria-label="Delete message" onClick={() => onDelete(message.id)}>
        ×
      </button>
    ) : null;
  const retryButton =
    onRetry && !streaming ? (
      <button
        type="button"
        className="msg-action"
        title={`Discard this reply and let ${characterName} answer again. Anything it already did — pictures, memories, timers — stays.`}
        aria-label="Regenerate this reply"
        onClick={onRetry}
      >
        ↻
      </button>
    ) : null;
  if (message.kind === 'emote') {
    return (
      <div className="msg msg-emote">
        <div className="msg-body">
          <div className="emote">
            {characterName} {message.content}
            {retryButton}
            {deleteButton}
          </div>
        </div>
      </div>
    );
  }

  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const actions = message.actions ?? [];
  const origin = originLabel(message.origin);
  const hasText = message.content.trim().length > 0;

  return (
    <div className={`msg msg-${message.role}`}>
      {isUser ? null : isSystem ? <span className="avatar" aria-hidden="true">i</span> : <Avatar name={characterName} url={avatarUrl} />}
      <div className="msg-body">
        <div className="msg-meta">
          <span>{isUser ? userName : isSystem ? 'System' : characterName}</span>
          {origin ? <span className="badge">{origin}</span> : null}
          <span>{formatTime(message.createdAt)}</span>
          {message.usage ? (
            <span title="input / output tokens">
              {message.usage.inputTokens}↑ {message.usage.outputTokens}↓
            </span>
          ) : null}
          {retryButton}
          {deleteButton}
        </div>
        {actions.length > 0 ? (
          <div className="actions">
            {actions.map((a) => (
              <ActionCard key={a.id} action={a} />
            ))}
          </div>
        ) : null}
        {hasText || (streaming && actions.length === 0) ? (
          <div className={streaming ? 'bubble streaming-caret' : 'bubble'}>
            {isUser ? <div className="md" style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div> : <Markdown source={message.content} />}
          </div>
        ) : null}
        {message.error ? (
          <div className="msg-error">
            {message.error.code}: {message.error.message}
          </div>
        ) : null}
      </div>
    </div>
  );
});
