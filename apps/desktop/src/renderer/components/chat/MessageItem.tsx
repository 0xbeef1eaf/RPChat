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
}

function originLabel(origin: ChatMessage['origin']): string | null {
  switch (origin) {
    case 'behaviour':
      return 'script';
    case 'timer':
      return 'timer';
    case 'greeting':
      return 'greeting';
    default:
      return null;
  }
}

export const MessageItem = memo(function MessageItem({ message, characterName, avatarUrl, userName, streaming }: MessageItemProps) {
  if (message.kind === 'emote') {
    return (
      <div className="msg msg-emote">
        <div className="msg-body">
          <div className="emote">
            {characterName} {message.content}
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
