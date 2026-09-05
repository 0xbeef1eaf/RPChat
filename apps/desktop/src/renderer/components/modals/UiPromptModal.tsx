import { respondUiPrompt } from '../../store/actions';
import { useAppState } from '../../store/store';
import { Modal } from '../common/Modal';

/** `sdk.ui.confirm` / `sdk.ui.choose` questions from a character. */
export function UiPromptModal() {
  const queue = useAppState((s) => s.uiPrompts);
  const prompt = queue[0];
  if (!prompt) return null;

  const cancel = () => respondUiPrompt(prompt.promptId, null);

  return (
    <Modal title={`${prompt.characterName} asks`} onClose={cancel}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{prompt.question}</p>
      {prompt.kind === 'confirm' ? (
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
