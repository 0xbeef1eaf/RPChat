/**
 * QR codes for the one thing this app needs them for: enrolling an authenticator app in the
 * policy lock.
 *
 * The enrolment dialog used to show the `otpauth://` URI as text and suggest making a QR from it
 * elsewhere, which is not a flow anybody should have to follow while holding a secret that is
 * displayed exactly once.
 *
 * What is here is the encoding only — `qrcode-generator` does the Reed-Solomon and the masking —
 * turned into a plain matrix of booleans. The drawing is React elements in `QrCode.tsx` rather
 * than an SVG string, so nothing goes near `dangerouslySetInnerHTML`, and the matrix is a data
 * structure the tests can decode and read back.
 */
import qrcode from 'qrcode-generator';

/** How many modules of clear space surround the code. The spec asks for four; scanners need it. */
export const QUIET_ZONE = 4;

/**
 * Error correction level. `M` (~15%) is what authenticator enrolment normally uses: `L` is
 * fragile on a screen someone is photographing at an angle, and `H` makes the code denser than a
 * phone camera enjoys for a URI this long.
 */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** `true` is a dark module. Indexed `[row][column]`, quiet zone **not** included. */
  modules: boolean[][];
  /** Width and height in modules, without the quiet zone. */
  size: number;
}

/**
 * Encode `text` as a QR matrix. Throws when the text does not fit any version at this correction
 * level — for an `otpauth://` URI that would take a pathological issuer, but a caller showing one
 * should still be ready to fall back to the text.
 */
export function qrMatrix(text: string, correction: QrErrorCorrection = 'M'): QrMatrix {
  if (text.length === 0) throw new Error('nothing to encode');
  // Type 0 lets the library pick the smallest version that fits.
  const qr = qrcode(0, correction);
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    for (let column = 0; column < size; column += 1) line.push(qr.isDark(row, column));
    modules.push(line);
  }
  return { modules, size };
}

/**
 * The dark modules as one SVG path, in a coordinate space where one module is one unit and the
 * origin is the top-left of the quiet zone. One path for the whole code rather than a rect per
 * module: a version-6 code is over a thousand modules, and a thousand DOM nodes in a dialog is
 * the kind of thing that makes a window feel slow for no reason.
 */
export function qrPath(matrix: QrMatrix, quietZone = QUIET_ZONE): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    const line = matrix.modules[row] ?? [];
    let run = 0;
    for (let column = 0; column <= matrix.size; column += 1) {
      // Merge horizontal runs of dark modules into one rectangle.
      if (line[column]) {
        run += 1;
        continue;
      }
      if (run > 0) {
        parts.push(`M${column - run + quietZone} ${row + quietZone}h${run}v1h-${run}z`);
        run = 0;
      }
    }
  }
  return parts.join('');
}

/** Width of the drawing in modules, quiet zone included — the SVG's `viewBox` extent. */
export function qrExtent(matrix: QrMatrix, quietZone = QUIET_ZONE): number {
  return matrix.size + quietZone * 2;
}
