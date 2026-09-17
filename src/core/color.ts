import type { Color } from 'ag-psd';
import type { RGBA } from './model';

/** ag-psd colors: RGB is 0–255, FRGB is 0–1, grayscale k is 0–255 ink. */
export function toRGBA(c: Color | undefined): RGBA {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  if ('fr' in c) return { r: c.fr, g: c.fg, b: c.fb, a: 1 };
  if ('r' in c) return { r: c.r / 255, g: c.g / 255, b: c.b / 255, a: 'a' in c ? c.a : 1 };
  if ('k' in c && !('c' in c)) {
    const v = 1 - c.k / 255;
    return { r: v, g: v, b: v, a: 1 };
  }
  // HSB / CMYK / LAB: not expected after RGB prep. Fall back to black; the doc-level report covers it.
  return { r: 0, g: 0, b: 0, a: 1 };
}
