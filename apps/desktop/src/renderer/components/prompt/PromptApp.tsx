import { useCallback, useEffect, useState } from 'react';
import type { PermissionDecision, PromptWindowPayload, UiPromptAnswer } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { applyTheme } from '../../lib/theme';
import { PermissionPrompt } from './PermissionPrompt';
import { UiPrompt } from './UiPrompt';

/** Title above the question, matching the window title main gave this window. */
function titleOf(payload: PromptWindowPayload): string {
  return payload.kind === 'permission' ? `${payload.characterName} needs permission` : `${payload.prompt.characterName} asks`;
}

/**
 * The whole of a prompt window: one question, fetched by `prompts.pending()` (a pull, so the
 * page cannot miss a push that arrived before React mounted). Answering closes the window from
 * main; closing the window instead counts as a dismissal, so Escape simply closes it.
 */
export function PromptApp() {
  const [payload, setPayload] = useState<PromptWindowPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const rp = api();
    void rp.settings
      .get()
      .then((settings) => !cancelled && applyTheme(settings.theme))
      .catch(() => undefined);
    void rp.prompts
      .pending()
      .then((p) => {
        if (cancelled) return;
        if (p) {
          setPayload(p);
          document.title = titleOf(p);
        } else setError('This question is no longer waiting for an answer.');
      })
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  // Escape dismisses: closing the window answers with the fallback (deny / no answer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        window.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = useCallback((call: Promise<void>) => {
    setSent(true);
    // The window is destroyed by main once the answer lands; a failure leaves it usable.
    call.catch((err: unknown) => {
      setSent(false);
      setError(errorMessage(err));
    });
  }, []);

  const onPermission = useCallback((requestId: string, decision: PermissionDecision) => send(api().permissions.respond(requestId, decision)), [send]);
  const onUiAnswer = useCallback((promptId: string, answer: UiPromptAnswer) => send(api().ui.respondPrompt(promptId, answer)), [send]);

  return (
    <div className="prompt-page">
      <div className="prompt-card">
        {error ? (
          <>
            <h2>Nothing to answer</h2>
            <div className="callout callout-danger small">{error}</div>
            <div className="form-actions">
              <span className="grow" />
              <button type="button" className="btn btn-primary" autoFocus onClick={() => window.close()}>
                Close
              </button>
            </div>
          </>
        ) : !payload ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : (
          <fieldset className="prompt-fields" disabled={sent}>
            <h2>{titleOf(payload)}</h2>
            {payload.kind === 'permission' ? (
              <PermissionPrompt
                request={payload.request}
                characterName={payload.characterName}
                packName={payload.packName}
                onRespond={(decision) => onPermission(payload.request.requestId, decision)}
              />
            ) : (
              <UiPrompt prompt={payload.prompt} onRespond={(answer) => onUiAnswer(payload.prompt.promptId, answer)} />
            )}
          </fieldset>
        )}
      </div>
    </div>
  );
}
