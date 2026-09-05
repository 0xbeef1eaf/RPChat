import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaCommand, MediaWindowEvent } from '@rp/shared';
import { AvatarView } from './AvatarView';
import { DrawView } from './DrawView';
import { MediaItemView } from './MediaItemView';
import { WidgetView } from './WidgetView';
import { applyMediaCommand, applyMediaLocalEvent, INITIAL_MEDIA_STATE, type MediaLocalEvent, type MediaState } from './mediaState';
import type { MediaTransport } from './transport';

interface MediaAppProps {
  transport: MediaTransport;
}

export function MediaApp({ transport }: MediaAppProps) {
  const [state, setState] = useState<MediaState>(INITIAL_MEDIA_STATE);
  // Reducer transitions must run once per command even under StrictMode, so
  // we keep the authoritative state in a ref and mirror it into React state.
  const stateRef = useRef(state);

  const transition = useCallback((fn: (s: MediaState) => { state: MediaState; reports: MediaWindowEvent[] }) => {
    const { state: next, reports } = fn(stateRef.current);
    stateRef.current = next;
    setState(next);
    for (const ev of reports) transport.report(ev);
  }, [transport]);

  useEffect(() => {
    const onCommand = (command: MediaCommand) => transition((s) => applyMediaCommand(s, command));
    return transport.onCommand(onCommand);
  }, [transport, transition]);

  const onEvent = useCallback((event: MediaLocalEvent) => transition((s) => applyMediaLocalEvent(s, event)), [transition]);

  // Escape closes everything in this window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      for (const item of stateRef.current.items) onEvent({ type: 'dismiss', id: item.id });
      for (const w of stateRef.current.widgets) onEvent({ type: 'dismiss', id: w.id });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEvent]);

  // Page kind is implied by what main sends this window: a draw surface fills the viewport,
  // otherwise items/avatar/widgets share the centred stage.
  const draw = state.draws[0];
  if (draw) return <DrawView surface={draw} />;

  return (
    <div className="media-stage">
      {state.items.map((item) => (
        <MediaItemView key={item.id} entry={item} onEvent={onEvent} />
      ))}
      {state.avatar ? <AvatarView avatar={state.avatar} onEvent={onEvent} /> : null}
      {state.widgets.map((w) => (
        <WidgetView key={w.id} entry={w} onEvent={onEvent} />
      ))}
    </div>
  );
}
