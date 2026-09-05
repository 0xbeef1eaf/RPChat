import { useMemo } from 'react';
import { prettyJson } from '../../lib/format';
import { respondPermission } from '../../store/actions';
import { useAppState } from '../../store/store';
import { Modal } from '../common/Modal';

/** Shows the oldest pending `prompt`-level capability request. */
export function PermissionModal() {
  const queue = useAppState((s) => s.permissionRequests);
  const characters = useAppState((s) => s.characters);
  const sessions = useAppState((s) => s.sessions);
  const request = queue[0];

  const who = useMemo(() => {
    if (!request) return null;
    const ref = `${request.context.packId}/${request.context.characterId}`;
    const c = characters.find((x) => x.ref === ref);
    const s = sessions.find((x) => x.id === request.context.sessionId);
    return { name: c?.name ?? request.context.characterId, pack: c?.packName ?? request.context.packId, session: s?.title };
  }, [request, characters, sessions]);

  if (!request || !who) return null;
  const { module, method, args } = request.call;

  return (
    <Modal title="Permission request">
      <p>
        <strong>{who.name}</strong> <span className="muted">({who.pack})</span> wants to call{' '}
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
        {who.session ? (
          <>
            <dt>Session</dt>
            <dd>{who.session}</dd>
          </>
        ) : null}
        <dt>Pack</dt>
        <dd className="mono">{request.context.packId}</dd>
        {queue.length > 1 ? (
          <>
            <dt>Queued</dt>
            <dd>{queue.length - 1} more request(s) waiting</dd>
          </>
        ) : null}
      </dl>
      <div className="form-actions">
        <button type="button" className="btn btn-danger" onClick={() => respondPermission(request.requestId, 'deny')}>
          Deny
        </button>
        <span className="grow" />
        <button type="button" className="btn" onClick={() => respondPermission(request.requestId, 'allow-session')}>
          Allow for this session
        </button>
        <button type="button" className="btn btn-primary" onClick={() => respondPermission(request.requestId, 'allow-once')}>
          Allow once
        </button>
      </div>
    </Modal>
  );
}
