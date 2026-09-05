import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { effectiveOpacity, effectiveVolume, type MediaEntry, type MediaLocalEvent } from './mediaState';

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

  const clickThrough = entry.kind !== 'audio' && Boolean(entry.options.clickThrough);

  // Animate out, then tell the state machine.
  const dismiss = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => onEvent({ type: 'dismiss', id: entry.id }), LEAVE_MS);
  };
  const onClick = clickThrough ? undefined : dismiss;

  // Image auto-close.
  const durationMs = entry.kind === 'image' ? entry.options.durationMs : undefined;
  useEffect(() => {
    if (!durationMs) return;
    const t = window.setTimeout(dismiss, Math.max(0, durationMs));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, durationMs]);

  // Apply volume + kick off playback (autoplay attributes alone are not enough after a src swap).
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
    el.play().catch((err: unknown) => onEvent({ type: 'error', id: entry.id, message: err instanceof Error ? err.message : String(err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.url]);

  // Report the rendered size once the content is known (and again if width/height options change).
  const width = entry.kind !== 'audio' ? (entry.options.width ?? 480) : undefined;
  const height = entry.kind !== 'audio' ? entry.options.height : undefined;
  useLayoutEffect(() => {
    if (!contentReady) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      onEvent({ type: 'content-size', id: entry.id, width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentReady, entry.id, width, height]);

  const cls = `media-item ${entry.kind}${leaving ? ' leaving' : ''}${clickThrough ? ' click-through' : ''}`;
  const style: CSSProperties = {
    width,
    maxHeight: height,
    opacity: entry.kind === 'audio' ? 1 : effectiveOpacity(entry.options.opacity),
    pointerEvents: clickThrough ? 'none' : undefined,
    margin: 0,
  };

  if (entry.kind === 'image') {
    return (
      <figure ref={containerRef as RefObject<HTMLElement>} className={cls} style={style} onClick={onClick} title={clickThrough ? undefined : 'Click to close'}>
        <img
          src={entry.url}
          alt={entry.options.caption ?? ''}
          draggable={false}
          style={height ? { maxHeight: height } : undefined}
          onLoad={() => setContentReady(true)}
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
          style={height ? { maxHeight: height } : undefined}
          onLoadedMetadata={() => setContentReady(true)}
          onEnded={() => onEvent({ type: 'ended', id: entry.id })}
          onError={() => onEvent({ type: 'error', id: entry.id, message: 'Video failed to load or decode' })}
          onClick={onClick}
          title={clickThrough ? undefined : 'Click to close'}
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
        <button type="button" className="media-audio-stop" onClick={dismiss} aria-label="Stop">
          ✕
        </button>
      </div>
    </div>
  );
}
