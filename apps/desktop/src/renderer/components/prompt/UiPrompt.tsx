import { useEffect, useState } from 'react';
import type { UiPromptAnswer, UiPromptRequest } from '@rp/shared';

export interface UiPromptProps {
  prompt: UiPromptRequest;
  onRespond: (answer: UiPromptAnswer) => void;
}

/** `sdk.ui.ask`: a free-text answer. */
function TextPrompt({ prompt, onRespond }: UiPromptProps) {
  const [value, setValue] = useState(prompt.defaultValue ?? '');
  useEffect(() => setValue(prompt.defaultValue ?? ''), [prompt.promptId, prompt.defaultValue]);
  return (
    <>
      {prompt.multiline ? (
        <textarea rows={5} autoFocus style={{ width: '100%' }} placeholder={prompt.placeholder ?? ''} value={value} onChange={(e) => setValue(e.target.value)} />
      ) : (
        <input
          type="text"
          autoFocus
          placeholder={prompt.placeholder ?? ''}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRespond(value);
          }}
        />
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={() => onRespond(null)}>
          Dismiss
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-primary" onClick={() => onRespond(value)}>
          Send
        </button>
      </div>
    </>
  );
}

/**
 * A character's question (`sdk.ui.confirm` / `choose` / `ask`). Rendered both in its own window
 * and in the main window's fallback modal.
 */
export function UiPrompt({ prompt, onRespond }: UiPromptProps) {
  return (
    <>
      <p style={{ whiteSpace: 'pre-wrap' }}>{prompt.question}</p>
      {prompt.kind === 'text' ? (
        <TextPrompt prompt={prompt} onRespond={onRespond} />
      ) : prompt.kind === 'confirm' ? (
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onRespond(null)}>
            Dismiss
          </button>
          <span className="grow" />
          <button type="button" className="btn" onClick={() => onRespond(false)}>
            No
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => onRespond(true)}>
            Yes
          </button>
        </div>
      ) : (
        <>
          <div className="choice-list">
            {(prompt.options ?? []).map((opt, i) => (
              <button key={`${i}-${opt}`} type="button" className="btn" autoFocus={i === 0} onClick={() => onRespond(opt)}>
                {opt}
              </button>
            ))}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onRespond(null)}>
              None of these
            </button>
          </div>
        </>
      )}
    </>
  );
}
