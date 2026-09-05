import { useEffect, useState } from 'react';
import type { UiPromptRequest } from '@rp/shared';
import { respondUiPrompt } from '../../store/actions';
import { useAppState } from '../../store/store';
import { Modal } from '../common/Modal';

/** `sdk.ui.ask`: a free-text answer. */
function TextPrompt({ prompt, onCancel }: { prompt: UiPromptRequest; onCancel: () => void }) {
  const [value, setValue] = useState(prompt.defaultValue ?? '');
  useEffect(() => setValue(prompt.defaultValue ?? ''), [prompt.promptId, prompt.defaultValue]);
  const submit = () => respondUiPrompt(prompt.promptId, value);
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
            if (e.key === 'Enter') submit();
          }}
        />
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Dismiss
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-primary" onClick={submit}>
          Send
        </button>
      </div>
    </>
  );
}

/** `sdk.ui.confirm` / `sdk.ui.choose` / `sdk.ui.ask` questions from a character. */
export function UiPromptModal() {
  const queue = useAppState((s) => s.uiPrompts);
  const prompt = queue[0];
  if (!prompt) return null;

  const cancel = () => respondUiPrompt(prompt.promptId, null);

  return (
    <Modal title={`${prompt.characterName} asks`} onClose={cancel}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{prompt.question}</p>
      {prompt.kind === 'text' ? (
        <TextPrompt prompt={prompt} onCancel={cancel} />
      ) : prompt.kind === 'confirm' ? (
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={cancel}>
            Dismiss
          </button>
          <span className="grow" />
          <button type="button" className="btn" onClick={() => respondUiPrompt(prompt.promptId, false)}>
            No
          </button>
          <button type="button" className="btn btn-primary" onClick={() => respondUiPrompt(prompt.promptId, true)}>
            Yes
          </button>
        </div>
      ) : (
        <>
          <div className="choice-list">
            {(prompt.options ?? []).map((opt, i) => (
              <button key={`${i}-${opt}`} type="button" className="btn" onClick={() => respondUiPrompt(prompt.promptId, opt)}>
                {opt}
              </button>
            ))}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={cancel}>
              None of these
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
