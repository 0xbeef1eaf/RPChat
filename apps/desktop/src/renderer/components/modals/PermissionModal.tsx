import { useMemo } from 'react';
import { respondPermission } from '../../store/actions';
import { useAppState } from '../../store/store';
import { Modal } from '../common/Modal';
import { PermissionPrompt } from '../prompt/PermissionPrompt';

/**
 * Fallback for `prompt`-level capability requests: they normally open a focused window of their
 * own (`prompt.html`), and only arrive here when none could be opened. Shows the oldest first.
 */
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

  return (
    <Modal title="Permission request">
      <PermissionPrompt
        request={request}
        characterName={who.name}
        packName={who.pack}
        {...(who.session ? { sessionTitle: who.session } : {})}
        queued={queue.length - 1}
        onRespond={(decision) => respondPermission(request.requestId, decision)}
      />
    </Modal>
  );
}
