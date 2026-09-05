import { useEffect, useMemo, useState } from 'react';
import { isSafeColor, resolveShapes, DEFAULT_DRAW_COLOR, type ResolvedShape } from './draw';
import type { DrawSurface } from './mediaState';

interface DrawViewProps {
  surface: DrawSurface;
}

function useViewport() {
  const [vp, setVp] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setVp({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vp;
}

function ShapeEl({ s }: { s: ResolvedShape }) {
  const color = isSafeColor(s.color) ? s.color : DEFAULT_DRAW_COLOR;
  const g = s.geometry;
  const common = { stroke: color, strokeWidth: s.strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (g.kind) {
    case 'line':
      return <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} {...common} />;
    case 'arrow':
      return (
        <g>
          <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} {...common} />
          <polygon points={g.head} fill={color} stroke="none" />
        </g>
      );
    case 'circle':
      return <circle cx={g.cx} cy={g.cy} r={g.r} {...common} />;
    case 'rect':
      return <rect x={g.x} y={g.y} width={g.width} height={g.height} rx={4} {...common} />;
    case 'text':
    default:
      return (
        <text x={g.x} y={g.y} fill={color} fontSize={g.fontSize} fontWeight={600} stroke="rgba(0,0,0,0.6)" strokeWidth={3} paintOrder="stroke">
          {g.text}
        </text>
      );
  }
}

/** `draw` page: full-viewport, click-through SVG; shapes with `durationMs` fade out toward their end. */
export function DrawView({ surface }: DrawViewProps) {
  const vp = useViewport();
  const shapes = useMemo(() => resolveShapes(surface.shapes, vp), [surface.shapes, vp]);
  return (
    <svg className="draw-page" width={vp.width} height={vp.height} viewBox={`0 0 ${vp.width} ${vp.height}`} aria-hidden="true">
      {shapes.map((s) => (
        <g
          key={s.shapeId}
          className={s.durationMs ? 'draw-shape fading' : 'draw-shape'}
          style={s.durationMs ? { animationDuration: `${Math.max(300, s.durationMs)}ms` } : undefined}
        >
          <ShapeEl s={s} />
        </g>
      ))}
    </svg>
  );
}
