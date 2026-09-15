import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { bubbleRemainingMs, lookTransform, type AvatarPageState } from './avatar';
import { fitMedia, type NaturalSize } from './fit';
import { effectiveOpacity, type MediaLocalEvent } from './mediaState';

interface AvatarViewProps {
  avatar: AvatarPageState;
  onEvent: (event: MediaLocalEvent) => void;
}

/** `avatar` page: expression image, one-shot CSS animations, speech bubble, cursor tracking. */
export function AvatarView({ avatar, onEvent }: AvatarViewProps) {
  const { id, state, animation, opacity, clickThrough } = avatar;
  const ref = useRef<HTMLDivElement>(null);
  // Natural pixel size of the expression image once known; drives the aspect-preserving fit into `size`.
  const [natural, setNatural] = useState<NaturalSize | undefined>(undefined);
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

  // The avatar is drawn `size` wide with its own aspect ratio; the window is then resized to what we
  // report here. Measuring must not depend on the window we are currently in (it still has the size
  // from before a resize), so the figure is pinned to the fitted box and nothing around it may shrink it.
  const fitted = natural ? fitMedia(natural, { width: state.size }) : undefined;

  // Report the rendered size once the image is in, and again whenever it changes (a new expression,
  // a resize, or a bubble re-flowing; the observer converges it).
  useLayoutEffect(() => {
    if (!fitted || !ref.current) return;
    const el = ref.current;
    let last: { width: number; height: number } | undefined;
    const report = () => {
      const r = el.getBoundingClientRect();
      const size = { width: Math.ceil(r.width), height: Math.ceil(r.height) };
      if (size.width <= 0 || size.height <= 0) return;
      if (last && last.width === size.width && last.height === size.height) return;
      last = size;
      onEvent({ type: 'content-size', id, ...size });
    };
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fitted?.width, fitted?.height, state.imageUrl]);

  const style: CSSProperties = {
    opacity: effectiveOpacity(opacity),
    pointerEvents: clickThrough ? 'none' : undefined,
    width: fitted?.width ?? state.size,
  };
  // Only the width is pinned; `height` stays auto (media.css) so the picture can never be squeezed.
  const imgStyle: CSSProperties = {
    width: fitted?.width ?? state.size,
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
          onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={() => onEvent({ type: 'error', id, message: `Avatar image failed to load (${state.expression})` })}
        />
      </div>
    </div>
  );
}
