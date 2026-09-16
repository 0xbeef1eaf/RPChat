import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** `false` under `allowStopGeneration`: the Stop button stays visible but refuses to be pressed. */
  canAbort: boolean;
  /** Changes whenever the target session changes so the draft is reset. */
  sessionKey: string;
}

export function Composer({ disabled, running, onSend, onAbort, canAbort, sessionKey }: ComposerProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText('');
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

  const canSend = !disabled && !running && text.trim().length > 0;

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
        ) : (
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
      <div className="composer-hint">
        <kbd>Enter</kbd> to send, <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
      </div>
    </div>
  );
}
