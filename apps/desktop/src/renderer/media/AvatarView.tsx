import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { bubbleRemainingMs, lookTransform, type AvatarPageState } from './avatar';
import { effectiveOpacity, type MediaLocalEvent } from './mediaState';

interface AvatarViewProps {
  avatar: AvatarPageState;
  onEvent: (event: MediaLocalEvent) => void;
}

/** `avatar` page: expression image, one-shot CSS animations, speech bubble, cursor tracking. */
export function AvatarView({ avatar, onEvent }: AvatarViewProps) {
  const { id, state, animation, opacity, clickThrough } = avatar;
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [look, setLook] = useState({ rotate: 0, dx: 0, dy: 0 });

  // Cursor tracking: subtle tilt toward the pointer (only while the window receives mouse events).
  useEffect(() => {
    if (!state.lookAtCursor) {
      setLook({ rotate: 0, dx: 0, dy: 0 });
      return;
    }
    const onMove = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setLook(lookTransform({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, { x: e.clientX, y: e.clientY }));
    };
    const onLeave = () => setLook({ rotate: 0, dx: 0, dy: 0 });
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, [state.lookAtCursor]);

  // Bubble expiry.
  const until = state.bubble?.until;
  useEffect(() => {
    const ms = bubbleRemainingMs(state.bubble, Date.now());
    if (ms === null) return;
    const t = window.setTimeout(() => onEvent({ type: 'bubble-expired', id }), ms);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, until, state.bubble?.text]);

  // Content size once the image is in.
  useLayoutEffect(() => {
    if (!loaded || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) onEvent({ type: 'content-size', id, width: Math.ceil(r.width), height: Math.ceil(r.height) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, id, state.size, state.imageUrl, Boolean(state.bubble)]);

  const style: CSSProperties = {
    opacity: effectiveOpacity(opacity),
    pointerEvents: clickThrough ? 'none' : undefined,
    width: state.size,
  };
  const imgStyle: CSSProperties = {
    transform: `translate(${look.dx}px, ${look.dy}px) rotate(${look.rotate}deg)`,
  };
  const animClass = animation ? ` anim-${animation.name}` : '';

  return (
    <div ref={ref} className={`avatar-page${clickThrough ? ' click-through' : ''}`} style={style}>
      {state.bubble ? (
        <div className="avatar-bubble" role="status">
          {state.bubble.text}
        </div>
      ) : null}
      <div
        key={animation?.nonce ?? 0}
        className={`avatar-figure${animClass}`}
        onClick={clickThrough ? undefined : () => onEvent({ type: 'avatar-click', id })}
        title={clickThrough ? undefined : state.expression}
      >
        <img
          src={state.imageUrl}
          alt={state.expression}
          draggable={false}
          style={imgStyle}
          onLoad={() => setLoaded(true)}
          onError={() => onEvent({ type: 'error', id, message: `Avatar image failed to load (${state.expression})` })}
        />
      </div>
    </div>
  );
}
