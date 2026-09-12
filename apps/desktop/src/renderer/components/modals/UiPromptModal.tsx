import { respondUiPrompt } from '../../store/actions';
import { useAppState } from '../../store/store';
import { Modal } from '../common/Modal';
import { UiPrompt } from '../prompt/UiPrompt';

/**
 * Fallback for `sdk.ui.confirm` / `choose` / `ask`: a question normally opens a focused window
 * of its own (`prompt.html`), and only arrives here when none could be opened.
 */
export function UiPromptModal() {
  const queue = useAppState((s) => s.uiPrompts);
  const prompt = queue[0];
  if (!prompt) return null;

  return (
    <Modal title={`${prompt.characterName} asks`} onClose={() => respondUiPrompt(prompt.promptId, null)}>
      <UiPrompt prompt={prompt} onRespond={(answer) => respondUiPrompt(prompt.promptId, answer)} />
    </Modal>
  );
}
