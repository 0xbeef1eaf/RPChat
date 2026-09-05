import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { effectiveOpacity, type MediaLocalEvent } from './mediaState';
import type { WidgetEntry } from './widget';

interface WidgetViewProps {
  entry: WidgetEntry;
  onEvent: (event: MediaLocalEvent) => void;
}

/** `widget` page: title bar + sandboxed iframe (`allow-scripts` only) with parent↔iframe postMessage. */
export function WidgetView({ entry, onEvent }: WidgetViewProps) {
  const { id, widget, options, revision, outbox } = entry;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const clickThrough = Boolean(options.clickThrough);

  // Messages from the iframe (origin is "null" because the sandbox has no allow-same-origin).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      onEvent({ type: 'widget-message', id, data: e.data });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [id, onEvent]);

  // Deliver queued messages to the iframe.
  useEffect(() => {
    if (outbox.length === 0) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    let last = 0;
    for (const m of outbox) {
      win.postMessage(m.message, '*');
      last = m.seq;
    }
    onEvent({ type: 'widget-delivered', id, seq: last });
  }, [outbox, id, onEvent]);

  useLayoutEffect(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) onEvent({ type: 'content-size', id, width: Math.ceil(r.width), height: Math.ceil(r.height) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, widget.width, widget.height, Boolean(widget.title)]);

  const style: CSSProperties = {
    width: options.width ?? widget.width,
    opacity: effectiveOpacity(options.opacity),
    pointerEvents: clickThrough ? 'none' : undefined,
  };

  return (
    <div ref={boxRef} className={`widget-page${clickThrough ? ' click-through' : ''}`} style={style}>
      <div className="widget-title">
        <span className="widget-title-text">{widget.title ?? 'Widget'}</span>
        <button type="button" className="widget-close" aria-label="Close widget" onClick={() => onEvent({ type: 'dismiss', id })}>
          ✕
        </button>
      </div>
      <iframe
        key={revision}
        ref={frameRef}
        className="widget-frame"
        title={widget.title ?? 'Widget'}
        sandbox="allow-scripts"
        srcDoc={widget.html}
        style={{ height: options.height ?? widget.height }}
      />
    </div>
  );
}
