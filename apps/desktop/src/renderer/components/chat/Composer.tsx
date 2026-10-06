import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { QueuedMessage } from '@rp/shared';

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** `false` under `allowStopGeneration`: the Stop button stays visible but refuses to be pressed. */
  canAbort: boolean;
  /** Changes whenever the target session changes so the draft is reset. */
  sessionKey: string;
  /** Messages already sent that the next turn will deliver, oldest first. */
  queued: QueuedMessage[];
  onUnqueue: (messageId: string) => void;
  /** Unsent text this session had, put back when it is opened (or the app restarted). */
  draft?: string;
  /** The unsent text changed (sending clears it). */
  onDraftChange?: (text: string) => void;
}

export function Composer({ disabled, running, onSend, onAbort, canAbort, sessionKey, queued, onUnqueue, draft, onDraftChange }: ComposerProps) {
  const [text, setTextState] = useState(draft ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftRef = useRef(onDraftChange);
  onDraftRef.current = onDraftChange;
  const setText = (value: string): void => {
    setTextState(value);
    onDraftRef.current?.(value);
  };

  useEffect(() => {
    setTextState(draftRef.current ?? '');
    ref.current?.focus();
  }, [sessionKey]);

  // Grow with content up to the CSS max-height (which scales with the chat zoom).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const max = Number.parseFloat(getComputedStyle(el).maxHeight) || 220;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  // A reply in flight no longer stops a message: it is queued, and the next turn takes it.
  const canSend = !disabled && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      {queued.length > 0 ? (
        <ul className="composer-queue" aria-label="Queued messages">
          {queued.map((m) => (
            <li key={m.id}>
              <span className="composer-queue-text">{m.text}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                title="Take this message back before it is sent"
                aria-label={`Remove queued message: ${m.text}`}
                onClick={() => onUnqueue(m.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="composer-inner">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={disabled ? 'Configure a provider in Settings to start chatting' : 'Write a message…'}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message"
        />
        {running ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={onAbort}
            disabled={!canAbort}
            title={canAbort ? 'Stop this reply' : 'The system policy does not allow stopping a reply once it has started'}
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={!canSend}
          title={running ? 'Queue this message; it is answered when this reply is done' : undefined}
        >
          {running ? 'Queue' : 'Send'}
        </button>
      </div>
      <div className="composer-hint">
        <kbd>Enter</kbd> to {running ? 'queue' : 'send'}, <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
        {running ? ' · queued messages are answered together when this reply ends' : ''}
      </div>
    </div>
  );
}
