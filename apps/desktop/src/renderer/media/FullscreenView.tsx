import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { effectiveOpacity, effectiveVolume, type FullscreenEntry, type MediaLocalEvent } from './mediaState';
import type { NaturalSize } from './fit';
import { tileLayout, tilePositions } from './tile';

/** The url inside a CSS `url("…")`; the state machine has already vetted the scheme. */
function cssUrl(url: string): string {
  return url.replace(/[\\"]/g, (c) => `\\${c}`);
}

interface FullscreenViewProps {
  entry: FullscreenEntry;
  onEvent: (event: MediaLocalEvent) => void;
}

/** The window is the monitor, so the viewport is the screen this overlay covers; `scale` is its pixel ratio. */
function useViewport(): { width: number; height: number; scale: number } {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1 });
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const onResize = () => setVp(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vp;
}

/**
 * An image washed over the screen. CSS does the repeating: the tile is the picture fitted into the
 * screen, centred, and `repeat` fills the rest outwards from it.
 */
function FullscreenImage({ entry, onEvent }: FullscreenViewProps) {
  const vp = useViewport();
  const [natural, setNatural] = useState<NaturalSize | undefined>(undefined);
  const tile = natural ? tileLayout(natural, vp) : undefined;
  const style: CSSProperties | undefined = tile
    ? {
        backgroundImage: `url("${cssUrl(entry.url)}")`,
        backgroundSize: `${tile.width}px ${tile.height}px`,
        backgroundPosition: 'center',
        backgroundRepeat: 'repeat',
      }
    : undefined;
  return (
    <div className="media-fullscreen-fade" style={style}>
      {/* Hidden loader: its natural size decides the tile, and it is where a load failure surfaces. */}
      <img
        className="media-fullscreen-probe"
        src={entry.url}
        alt=""
        draggable={false}
        onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        onError={() => onEvent({ type: 'error', id: entry.id, message: 'Image failed to load' })}
      />
    </div>
  );
}

/**
 * A video washed over the screen. One element decodes and one canvas paints its frames into every
 * tile, so the copies can never drift apart and only one decoder runs.
 */
function FullscreenVideo({ entry, onEvent }: FullscreenViewProps) {
  const vp = useViewport();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const volume = entry.options.volume;
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = effectiveVolume(volume);
  }, [entry.id, volume]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.play().catch((err: unknown) => onEvent({ type: 'error', id: entry.id, message: err instanceof Error ? err.message : String(err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.url]);

  // Paint every frame into the tiles until the overlay goes away. The canvas holds device pixels and
  // the tiling is laid out in CSS px, so the drawing is scaled by the screen's pixel ratio.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const ctx = canvas.getContext('2d');
      if (!ctx || video.readyState < 2 || video.videoWidth === 0) return;
      const layout = tileLayout({ width: video.videoWidth, height: video.videoHeight }, vp);
      ctx.setTransform(vp.scale, 0, 0, vp.scale, 0, 0);
      ctx.clearRect(0, 0, vp.width, vp.height);
      for (const pos of tilePositions(layout)) ctx.drawImage(video, pos.x, pos.y, layout.width, layout.height);
    };
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [entry.id, vp]);

  return (
    <div className="media-fullscreen-fade">
      <canvas ref={canvasRef} className="media-fullscreen-canvas" width={Math.round(vp.width * vp.scale)} height={Math.round(vp.height * vp.scale)} />
      {/* Hidden decoder: the canvas above is what is seen, and this is the element that carries the sound. */}
      <video
        ref={videoRef}
        className="media-fullscreen-probe"
        src={entry.url}
        autoPlay
        playsInline
        loop={Boolean(entry.options.loop)}
        muted={Boolean(entry.options.muted)}
        controls={false}
        onEnded={() => onEvent({ type: 'ended', id: entry.id })}
        onError={() => onEvent({ type: 'error', id: entry.id, message: 'Video failed to load or decode' })}
      />
    </div>
  );
}

/**
 * `fullscreen` page (`sdk.media.overlay`): the media covers the whole screen and never takes a
 * click. Its aspect ratio is kept — it is fitted into the screen and repeats out from the centre to
 * cover what is left over. The requested opacity sits on the outer surface, so the inner fade-in
 * (whose animation ends fully opaque) cannot undo it.
 */
export function FullscreenView({ entry, onEvent }: FullscreenViewProps) {
  return (
    <div className="media-fullscreen" style={{ opacity: effectiveOpacity(entry.options.opacity) }} aria-hidden="true">
      {entry.options.media === 'video' ? <FullscreenVideo entry={entry} onEvent={onEvent} /> : <FullscreenImage entry={entry} onEvent={onEvent} />}
    </div>
  );
}
