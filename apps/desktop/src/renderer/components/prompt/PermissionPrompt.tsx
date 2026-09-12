import type { PermissionDecision, PermissionRequest } from '@rp/shared';
import { prettyJson } from '../../lib/format';

export interface PermissionPromptProps {
  request: PermissionRequest;
  /** Display name of the character making the call. */
  characterName: string;
  /** Display name of its pack. */
  packName: string;
  /** Title of the session it is speaking in, when the view knows it. */
  sessionTitle?: string;
  /** How many further requests are waiting behind this one (in-app modal only). */
  queued?: number;
  onRespond: (decision: PermissionDecision) => void;
}

/**
 * What a `prompt`-level capability request looks like: who is asking, for what, with which
 * arguments. Rendered both in its own window and in the main window's fallback modal.
 */
export function PermissionPrompt({ request, characterName, packName, sessionTitle, queued = 0, onRespond }: PermissionPromptProps) {
  const { module, method, args } = request.call;

  return (
    <>
      <p>
        <strong>{characterName}</strong> <span className="muted">({packName})</span> wants to call{' '}
        <code>
          sdk.{module}.{method}
        </code>
        .
      </p>
      <p className="muted">{request.description}</p>
      {request.dangerous ? (
        <div className="callout callout-danger small">
          <strong>This call has effects outside the app</strong> (files, commands, wallpaper, input, browser or clipboard). Only allow it if you
          understand the arguments below and trust this pack.
        </div>
      ) : null}
      <div>
        <div className="field-label">Arguments</div>
        <pre style={{ maxHeight: 220 }}>
          <code>{prettyJson(args)}</code>
        </pre>
      </div>
      <dl className="kv">
        {sessionTitle ? (
          <>
            <dt>Session</dt>
            <dd>{sessionTitle}</dd>
          </>
        ) : null}
        <dt>Pack</dt>
        <dd className="mono">{request.context.packId}</dd>
        {queued > 0 ? (
          <>
            <dt>Queued</dt>
            <dd>{queued} more request(s) waiting</dd>
          </>
        ) : null}
      </dl>
      <div className="form-actions">
        <button type="button" className="btn btn-danger" onClick={() => onRespond('deny')}>
          Deny
        </button>
        <span className="grow" />
        <button type="button" className="btn" onClick={() => onRespond('allow-session')}>
          Allow for this session
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onRespond('allow-once')}>
          Allow once
        </button>
      </div>
    </>
  );
}
