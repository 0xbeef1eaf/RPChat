/**
 * The QR code the enrolment dialog shows. The thing worth testing is not that a matrix comes back
 * but that a *scanner* reads the right string out of it, so these render the matrix to a bitmap
 * and decode it with an independent decoder (`jsqr`). A QR code that encodes the wrong URI, or one
 * a camera cannot read, fails in the one moment the secret is on screen and never again.
 */
import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { QUIET_ZONE, qrExtent, qrMatrix, qrPath } from '../../renderer/lib/qr';
import type { QrErrorCorrection } from '../../renderer/lib/qr';

/** Draw the matrix the way the component does — quiet zone, dark on light — as RGBA pixels. */
function rasterise(text: string, correction: QrErrorCorrection = 'M', scale = 4) {
  const matrix = qrMatrix(text, correction);
  const extent = qrExtent(matrix);
  const width = extent * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (!matrix.modules[row]?.[column]) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const px = ((row + QUIET_ZONE) * scale + y) * width + (column + QUIET_ZONE) * scale + x;
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width, matrix };
}

function decode(text: string, correction: QrErrorCorrection = 'M'): string | null {
  const { data, width } = rasterise(text, correction);
  return jsQR(data, width, width)?.data ?? null;
}

describe('the enrolment QR code', () => {
  it('scans back as the otpauth URI it was given', () => {
    const uri = 'otpauth://totp/rpchat:policy?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=rpchat&algorithm=SHA1&digits=6&period=30';
    expect(decode(uri)).toBe(uri);
  });

  it('survives the long URIs a real issuer and label produce', () => {
    // 8 digits, SHA512 and a spelled-out issuer is about as long as this gets.
    const uri =
      'otpauth://totp/Acme%20Corporation%20IT%20Department:alice%40workstation-07.example.com' +
      '?secret=MZXW6YTBOI7EC53POJWGKIDCMFZWKZBAMFWGS3TFORZGS3TH&issuer=Acme%20Corporation%20IT%20Department' +
      '&algorithm=SHA512&digits=8&period=60';
    expect(decode(uri)).toBe(uri);
  });

  it('reads back at every error-correction level', () => {
    const uri = 'otpauth://totp/rpchat:policy?secret=JBSWY3DPEHPK3PXP&issuer=rpchat';
    for (const correction of ['L', 'M', 'Q', 'H'] as const) {
      expect(decode(uri, correction)).toBe(uri);
    }
  });

  it('grows the code rather than truncating when the text gets longer', () => {
    const short = qrMatrix('otpauth://totp/a:b?secret=JBSWY3DPEHPK3PXP');
    const long = qrMatrix(`otpauth://totp/a:b?secret=JBSWY3DPEHPK3PXP&label=${'x'.repeat(400)}`);
    expect(long.size).toBeGreaterThan(short.size);
    // Every QR version is (4v + 17) modules square.
    for (const matrix of [short, long]) expect((matrix.size - 17) % 4).toBe(0);
  });

  it('puts the three finder patterns where a scanner looks for them', () => {
    const { modules, size } = qrMatrix('otpauth://totp/a:b?secret=JBSWY3DPEHPK3PXP');
    // A finder is a 7×7 dark ring with a 3×3 dark core; check the corners that carry one.
    for (const [top, left] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ]) {
      expect(modules[top]![left]).toBe(true);
      expect(modules[top]![left! + 1]).toBe(true);
      // The ring's inner border is light.
      expect(modules[top! + 1]![left! + 1]).toBe(false);
      // And the core is dark.
      expect(modules[top! + 3]![left! + 3]).toBe(true);
    }
    // The fourth corner has no finder, which is how a scanner works out the orientation.
    expect(modules[size - 1]![size - 1]).toBe(false);
  });

  it('draws one path covering exactly the dark modules, offset by the quiet zone', () => {
    const matrix = qrMatrix('otpauth://totp/a:b?secret=JBSWY3DPEHPK3PXP');
    const path = qrPath(matrix);
    // Horizontal runs are merged, so there are fewer subpaths than dark modules.
    const dark = matrix.modules.flat().filter(Boolean).length;
    const subpaths = path.split('M').length - 1;
    expect(subpaths).toBeGreaterThan(0);
    expect(subpaths).toBeLessThan(dark);
    // The first dark module of the top-left finder sits at the quiet-zone offset.
    expect(path.startsWith(`M${QUIET_ZONE} ${QUIET_ZONE}h7`)).toBe(true);
    // The drawing never leaves the viewBox.
    const extent = qrExtent(matrix);
    for (const [x, y] of [...path.matchAll(/M(\d+) (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])) {
      expect(x).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(y).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(x).toBeLessThan(extent - QUIET_ZONE + 1);
      expect(y).toBeLessThan(extent - QUIET_ZONE);
    }
  });

  it('refuses an empty string rather than drawing an empty box', () => {
    expect(() => qrMatrix('')).toThrow(/nothing to encode/);
  });
});
