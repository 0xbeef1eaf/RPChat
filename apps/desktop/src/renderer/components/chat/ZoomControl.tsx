export interface ZoomControlProps {
  /** Current scale, 1 = 100%. */
  zoom: number;
  min: number;
  max: number;
  step: number;
  onChange: (zoom: number) => void;
}

/** Makes the chat text bigger or smaller (Ctrl +, Ctrl -, Ctrl 0), and shows the current scale. */
export function ZoomControl({ zoom, min, max, step, onChange }: ZoomControlProps) {
  const percent = Math.round(zoom * 100);
  return (
    <div className="zoom-control" role="group" aria-label="Chat text size">
      <button type="button" className="btn btn-sm" onClick={() => onChange(zoom - step)} disabled={zoom <= min} title="Smaller chat text (Ctrl -)" aria-label="Smaller chat text">
        A−
      </button>
      <button
        type="button"
        className="btn btn-sm zoom-value"
        onClick={() => onChange(1)}
        disabled={zoom === 1}
        title="Reset the chat text size (Ctrl 0)"
        aria-label={`Chat text size ${percent}%, reset`}
      >
        {percent}%
      </button>
      <button type="button" className="btn btn-sm" onClick={() => onChange(zoom + step)} disabled={zoom >= max} title="Bigger chat text (Ctrl +)" aria-label="Bigger chat text">
        A+
      </button>
    </div>
  );
}
