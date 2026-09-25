import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { MediaCloseReason } from '@rp/shared';
import { closesOnClick, effectiveOpacity, effectiveVolume, type MediaEntry, type MediaLocalEvent } from './mediaState';
import { fitMedia, type NaturalSize } from './fit';
import { startPlayback } from './playback';

interface MediaItemViewProps {
  entry: MediaEntry;
  onEvent: (event: MediaLocalEvent) => void;
}

const LEAVE_MS = 180;

export function MediaItemView({ entry, onEvent }: MediaItemViewProps) {
  const [leaving, setLeaving] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const [contentReady, setContentReady] = useState(entry.kind === 'audio');
  // Natural pixel size of the image/video once known; drives the aspect-preserving fit into the box.
  const [natural, setNatural] = useState<NaturalSize | undefined>(undefined);

  const clickThrough = entry.kind !== 'audio' && Boolean(entry.options.clickThrough);

  // Animate out, then tell the state machine (with why: a click, or the image's own timer).
  const dismiss = (reason: MediaCloseReason = 'click') => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => onEvent({ type: 'dismiss', id: entry.id, reason }), LEAVE_MS);
  };
  // Every click is reported (main turns it into the `media-clicked` event); whether it also closes
  // the item is `closesOnClick` — a timed image keeps going unless `closeOnClick` says otherwise.
  const clickCloses = closesOnClick(entry);
  const onClick = clickThrough
    ? undefined
    : () => {
        onEvent({ type: 'click', id: entry.id });
        if (clickCloses) dismiss('click');
      };
  const clickTitle = clickCloses ? 'Click to close' : undefined;

  // Image auto-close.
  const durationMs = entry.kind === 'image' ? entry.options.durationMs : undefined;
  useEffect(() => {
    if (!durationMs) return;
    const t = window.setTimeout(() => dismiss('timeout'), Math.max(0, durationMs));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, durationMs]);

  // Apply volume + kick off playback (autoplay attributes alone are not enough after a src swap;
  // `startPlayback` also rides out WebKit's "not without a gesture" refusal in the helper's pages).
  const volume = entry.kind === 'image' ? undefined : entry.options.volume;
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || entry.kind === 'image') return;
    el.volume = effectiveVolume(volume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, volume]);
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || entry.kind === 'image') return;
    const attempt = startPlayback(el, (message) => onEvent({ type: 'error', id: entry.id, message }));
    return () => attempt.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.url]);

  // The box the media may fill (`height` is a cap); the content is scaled to fit it keeping its aspect ratio.
  const boxWidth = entry.kind !== 'audio' ? (entry.options.width ?? 480) : undefined;
  const boxHeight = entry.kind !== 'audio' ? entry.options.height : undefined;
  const fitted = boxWidth !== undefined && natural ? fitMedia(natural, { width: boxWidth, height: boxHeight }) : undefined;
  const width = fitted?.width ?? boxWidth;
  const height = fitted?.height ?? boxHeight;
  // Only the width is pinned (the fit already honours the height cap); height stays auto so the picture can never be squeezed.
  const mediaStyle: CSSProperties | undefined = fitted ? { width: fitted.width } : height ? { maxHeight: height } : undefined;
  // Report the rendered size once the content is known, and again whenever the box changes (the
  // window is resized to what we report, which can re-flow the caption; the observer converges it).
  useLayoutEffect(() => {
    if (!contentReady) return;
    const el = containerRef.current;
    if (!el) return;
    let last: { width: number; height: number } | undefined;
    const report = () => {
      const rect = el.getBoundingClientRect();
      const size = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
      if (size.width <= 0 || size.height <= 0) return;
      if (last && last.width === size.width && last.height === size.height) return;
      last = size;
      onEvent({ type: 'content-size', id: entry.id, ...size });
    };
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentReady, entry.id, width, height]);

  const cls = `media-item ${entry.kind}${leaving ? ' leaving' : ''}${clickThrough ? ' click-through' : ''}${clickCloses ? ' click-closes' : ''}`;
  // No max-height on the container: it must grow around the caption, and its measured height sizes the window.
  const style: CSSProperties = {
    width,
    opacity: entry.kind === 'audio' ? 1 : effectiveOpacity(entry.options.opacity),
    pointerEvents: clickThrough ? 'none' : undefined,
    margin: 0,
  };

  if (entry.kind === 'image') {
    return (
      <figure ref={containerRef as RefObject<HTMLElement>} className={cls} style={style} onClick={onClick} title={clickTitle}>
        <img
          src={entry.url}
          alt={entry.options.caption ?? ''}
          draggable={false}
          style={mediaStyle}
          onLoad={(e) => {
            setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
            setContentReady(true);
          }}
          onError={() => onEvent({ type: 'error', id: entry.id, message: 'Image failed to load' })}
        />
        {entry.options.caption ? <figcaption className="media-caption">{entry.options.caption}</figcaption> : null}
      </figure>
    );
  }

  if (entry.kind === 'video') {
    return (
      <div ref={containerRef as RefObject<HTMLDivElement>} className={cls} style={style}>
        <video
          ref={mediaRef as RefObject<HTMLVideoElement>}
          src={entry.url}
          autoPlay
          playsInline
          loop={Boolean(entry.options.loop)}
          muted={Boolean(entry.options.muted)}
          controls={false}
          style={mediaStyle}
          onLoadedMetadata={(e) => {
            setNatural({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight });
            setContentReady(true);
          }}
          onEnded={() => onEvent({ type: 'ended', id: entry.id })}
          onError={() => onEvent({ type: 'error', id: entry.id, message: 'Video failed to load or decode' })}
          onClick={onClick}
          title={clickTitle}
        />
      </div>
    );
  }

  return (
    <div ref={containerRef as RefObject<HTMLDivElement>} className={cls} style={style}>
      <audio
        ref={mediaRef as RefObject<HTMLAudioElement>}
        src={entry.url}
        autoPlay
        loop={Boolean(entry.options.loop)}
        onEnded={() => onEvent({ type: 'ended', id: entry.id })}
        onError={() => onEvent({ type: 'error', id: entry.id, message: 'Audio failed to load or decode' })}
      />
      <div className="media-audio">
        <span>♪</span>
        <span>{decodeURIComponent(entry.url.split('/').pop() ?? 'audio')}</span>
        <button type="button" className="media-audio-stop" onClick={() => dismiss('click')} aria-label="Stop">
          ✕
        </button>
      </div>
    </div>
  );
}
