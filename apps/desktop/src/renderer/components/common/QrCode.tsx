/**
 * A QR code as inline SVG. Used for enrolling an authenticator app in the policy lock, where the
 * alternative is retyping a base32 secret from a dialog that will never show it again.
 *
 * Deliberately black on white whatever the theme is: a scanner wants dark modules on a light
 * background with a real quiet zone, and a dark-mode-tinted code photographed off a screen is
 * exactly the sort of thing that works on the developer's phone and not on anybody else's.
 */
import { useMemo } from 'react';
import type { QrErrorCorrection } from '../../lib/qr';
import { QUIET_ZONE, qrExtent, qrMatrix, qrPath } from '../../lib/qr';

export function QrCode({
  value,
  size = 200,
  correction = 'M',
  label,
}: {
  value: string;
  /** Rendered width and height in CSS pixels. The SVG scales, so this is only presentation. */
  size?: number;
  correction?: QrErrorCorrection;
  /** What a screen reader says in place of the code. */
  label?: string;
}) {
  const drawn = useMemo(() => {
    try {
      const matrix = qrMatrix(value, correction);
      return { path: qrPath(matrix), extent: qrExtent(matrix) };
    } catch {
      // Too long to encode: the caller always shows the text as well, so this is a gap in the
      // dialog rather than a broken one.
      return null;
    }
  }, [value, correction]);

  if (!drawn) return null;
  return (
    <svg
      role="img"
      aria-label={label ?? 'QR code'}
      width={size}
      height={size}
      viewBox={`0 0 ${drawn.extent} ${drawn.extent}`}
      shapeRendering="crispEdges"
      style={{ borderRadius: 6, display: 'block' }}
    >
      <rect width={drawn.extent} height={drawn.extent} fill="#ffffff" />
      <path d={drawn.path} fill="#000000" />
    </svg>
  );
}
