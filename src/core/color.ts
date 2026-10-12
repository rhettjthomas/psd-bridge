import type { Color } from 'ag-psd';
import type { RGBA } from './model';

/**
 * Photoshop colors → sRGB.
 *
 * Photoshop descriptors carry colors in whatever space the document uses: RGB 0–255,
 * CMYK and grayscale as ink percentages, HSB in degrees and percent, Lab in its own
 * units. Figma only speaks sRGB, so everything is converted here.
 *
 * CMYK uses the same naive multiply model ag-psd applies to CMYK *pixels*, on purpose:
 * a shape's fill and the image beside it then shift the same way instead of
 * disagreeing. Without the document's ICC profile neither can be exact; the import
 * report says so. Converting the file to RGB in Photoshop is the accurate route.
 */
export function toRGBA(c: Color | undefined): RGBA {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  if ('fr' in c) return { r: clamp01(c.fr), g: clamp01(c.fg), b: clamp01(c.fb), a: 1 };
  if ('r' in c) return { r: clamp01(c.r / 255), g: clamp01(c.g / 255), b: clamp01(c.b / 255), a: 'a' in c ? clamp01(c.a) : 1 };
  if ('c' in c) return cmykToRGBA(c.c, c.m, c.y, c.k);
  if ('h' in c) return hsbToRGBA(c.h, c.s, c.b);
  if ('l' in c) return labToRGBA(c.l, c.a, c.b);
  // Grayscale: ink percentage, so 0 is white and 100 is black.
  if ('k' in c) {
    const v = clamp01(1 - c.k / 100);
    return { r: v, g: v, b: v, a: 1 };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

/** CMYK ink percentages (0–100) → sRGB, matching ag-psd's pixel conversion. */
export function cmykToRGBA(c: number, m: number, y: number, k: number): RGBA {
  const ink = (v: number) => 1 - clamp01(v / 100);
  const black = ink(k);
  return { r: clamp01(ink(c) * black), g: clamp01(ink(m) * black), b: clamp01(ink(y) * black), a: 1 };
}

/** Hue in degrees, saturation and brightness in percent. */
export function hsbToRGBA(h: number, s: number, b: number): RGBA {
  const sat = clamp01(s / 100);
  const val = clamp01(b / 100);
  const hue = ((h % 360) + 360) % 360;
  const chroma = val * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - chroma;
  const [r, g, bl] =
    hue < 60 ? [chroma, x, 0]
    : hue < 120 ? [x, chroma, 0]
    : hue < 180 ? [0, chroma, x]
    : hue < 240 ? [0, x, chroma]
    : hue < 300 ? [x, 0, chroma]
    : [chroma, 0, x];
  return { r: clamp01(r + m), g: clamp01(g + m), b: clamp01(bl + m), a: 1 };
}

/** Photoshop Lab (L 0–100, a/b −128…127) → sRGB, through XYZ at D50. */
export function labToRGBA(l: number, a: number, b: number): RGBA {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t: number) => (t > 6 / 29 ? t * t * t : (3 * (6 / 29) ** 2) * (t - 4 / 29));
  // D50 white point, which is what Photoshop's Lab uses.
  const x = 0.9642 * f(fx);
  const y = 1.0 * f(fy);
  const z = 0.8249 * f(fz);
  // XYZ (D50) → linear sRGB, Bradford-adapted.
  const lr = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
  const lg = -0.9787684 * x + 1.9161415 * y + 0.033454 * z;
  const lb = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;
  return { r: gamma(lr), g: gamma(lg), b: gamma(lb), a: 1 };
}

function gamma(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return clamp01(c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
