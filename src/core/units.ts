/** Figma rejects images larger than this on either side. */
export const FIGMA_MAX_IMAGE_SIZE = 4096;

/**
 * Photoshop shadow angle is the light direction in degrees (counter-clockwise, 0 = light
 * from the right). The shadow falls opposite the light; screen y grows downward.
 * The default 120° gives a shadow down and to the right.
 */
export function shadowOffset(angleDeg: number, distance: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: round2(-Math.cos(rad) * distance), y: round2(Math.sin(rad) * distance) };
}

/**
 * Photoshop shadow "size" becomes the Figma blur radius, and "spread"/"choke" (0–100%)
 * becomes the part of the size that is solid.
 */
export function shadowBlurAndSpread(size: number, spreadPercent: number): { radius: number; spread: number } {
  const spread = (size * clamp(spreadPercent, 0, 100)) / 100;
  return { radius: round2(size - spread), spread: round2(spread) };
}

/** Photoshop tracking is 1/1000 em; Figma letter spacing in PERCENT is tracking ÷ 10. */
export function trackingToPercent(tracking: number): number {
  return tracking / 10;
}

/** PSD layer opacity and fill opacity are both 0–1; Figma only has layer opacity. */
export function combineOpacity(opacity = 1, fillOpacity = 1): number {
  return clamp(opacity, 0, 1) * clamp(fillOpacity, 0, 1);
}

/** Fit (w, h) inside the Figma image cap, keeping aspect ratio. */
export function fitImageSize(width: number, height: number, max = FIGMA_MAX_IMAGE_SIZE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    downscaled: scale < 1,
  };
}

/**
 * Uniform scale from a 2D affine transform [xx, xy, yx, yy, tx, ty].
 * Uses the vertical scale because it's what Photoshop applies to font size.
 */
export function transformScale(t: number[] | undefined): number {
  if (!t || t.length < 4) return 1;
  const [, xy, , yy] = t;
  const s = Math.hypot(xy, yy);
  return s > 0 ? s : 1;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
