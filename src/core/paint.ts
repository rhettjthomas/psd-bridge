/**
 * Photoshop fills (solid, gradient, pattern) → format-neutral paints, plus the
 * math to place a gradient in Figma's normalized layer space.
 */
import type { ColorStop, OpacityStop, VectorContent } from 'ag-psd';
import type { RGBA } from './model';
import { toRGBA } from './color';

export interface IRGradientStop {
  position: number; // 0–1
  color: RGBA;
}

export type IRGradientKind = 'linear' | 'radial' | 'angular' | 'diamond';

export type IRPaint =
  | { type: 'solid'; color: RGBA; opacity: number }
  | {
      type: 'gradient';
      kind: IRGradientKind;
      stops: IRGradientStop[];
      /** Degrees, counter-clockwise, 0 = left to right (Photoshop convention). */
      angle: number;
      /** 1 = 100%. */
      scale: number;
      /** Fraction of the box size. */
      offset: { x: number; y: number };
      opacity: number;
    }
  | {
      type: 'pattern';
      patternId: string;
      name: string;
      phase: { x: number; y: number };
      opacity: number;
      /** PNG bytes and size, attached by the UI. */
      image?: { png: Uint8Array; width: number; height: number };
    };

export interface PaintResult {
  paint?: IRPaint;
  /** The paint can't be represented; the caller should rasterize. */
  unsupported?: string;
  /** The paint was represented approximately. */
  warning?: string;
}

export function toPaint(content: VectorContent | undefined, opacity = 1): PaintResult {
  if (!content) return {};
  if (content.type === 'color') return { paint: { type: 'solid', color: toRGBA(content.color), opacity } };
  if (content.type === 'pattern') {
    return {
      paint: { type: 'pattern', patternId: content.id, name: content.name, phase: content.phase ?? { x: 0, y: 0 }, opacity },
      warning: 'Pattern imported at 100% scale.',
    };
  }
  if (content.type === 'noise') return { unsupported: 'Noise gradients have no Figma equivalent.' };

  const style = content.style ?? 'linear';
  let stops = mergeStops(content.colorStops ?? [], content.opacityStops ?? []);
  if (content.reverse) stops = stops.map((s) => ({ ...s, position: 1 - s.position })).reverse();
  const kind: IRGradientKind = style === 'angle' ? 'angular' : style === 'reflected' ? 'linear' : style;
  if (style === 'reflected') stops = reflectStops(stops);
  const warnings: string[] = [];
  const midpoints = [...(content.colorStops ?? []), ...(content.opacityStops ?? [])].some(
    (s) => Math.abs(s.midpoint - 0.5) > 0.01,
  );
  if (midpoints) warnings.push('Gradient midpoints were evened out.');
  if (content.align === false) warnings.push('Gradient not aligned with the layer; placed relative to the shape.');
  return {
    paint: {
      type: 'gradient',
      kind,
      stops,
      angle: content.angle ?? 0,
      scale: content.scale ?? 1,
      offset: content.offset ?? { x: 0, y: 0 },
      opacity,
    },
    warning: warnings.join(' ') || undefined,
  };
}

/** Photoshop keeps color and opacity stops separately; Figma needs RGBA stops. */
export function mergeStops(colors: ColorStop[], opacities: OpacityStop[]): IRGradientStop[] {
  const cs = [...colors].sort((a, b) => a.location - b.location);
  const os = [...opacities].sort((a, b) => a.location - b.location);
  if (!cs.length) return [];
  const positions = [...new Set([...cs.map((s) => s.location), ...os.map((s) => s.location)])]
    .map((p) => Math.min(1, Math.max(0, p)))
    .sort((a, b) => a - b);
  return positions.map((position) => {
    const c = sample(cs, position, (s) => toRGBA(s.color), lerpColor);
    const a = os.length ? sample(os, position, (s) => s.opacity, lerp) : 1;
    return { position, color: { ...c, a: c.a * a } };
  });
}

function sample<S extends { location: number }, V>(
  stops: S[],
  t: number,
  get: (s: S) => V,
  mix: (a: V, b: V, u: number) => V,
): V {
  if (t <= stops[0].location) return get(stops[0]);
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.location) {
      const span = b.location - a.location;
      return mix(get(a), get(b), span > 0 ? (t - a.location) / span : 0);
    }
  }
  return get(stops[stops.length - 1]);
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerpColor = (a: RGBA, b: RGBA, u: number): RGBA => ({
  r: lerp(a.r, b.r, u),
  g: lerp(a.g, b.g, u),
  b: lerp(a.b, b.b, u),
  a: lerp(a.a, b.a, u),
});

/** Reflected gradients mirror around the center; express that as one linear gradient. */
function reflectStops(stops: IRGradientStop[]): IRGradientStop[] {
  const right = stops.map((s) => ({ ...s, position: 0.5 + s.position / 2 }));
  const left = stops.map((s) => ({ ...s, position: 0.5 - s.position / 2 })).reverse();
  // The center stop appears in both halves; keep one copy.
  return [...left, ...right.filter((s) => !left.some((l) => l.position === s.position))];
}

export type Matrix = [[number, number, number], [number, number, number]];

/**
 * Figma's gradientTransform maps normalized layer space (0–1 on both axes) to
 * gradient space, where a linear gradient runs from (0, 0.5) to (1, 0.5) and radial
 * gradients are centered at (0.5, 0.5) with radius 0.5.
 *
 * Photoshop places the gradient through the box center (plus offset). A linear
 * gradient's length is the box's extent along the angle, times scale.
 */
export function gradientTransform(
  paint: Extract<IRPaint, { type: 'gradient' }>,
  box: { width: number; height: number },
): Matrix {
  const w = Math.max(box.width, 1e-6);
  const h = Math.max(box.height, 1e-6);
  const rad = (paint.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = -Math.sin(rad); // Photoshop angles are counter-clockwise; screen y points down.
  const cx = w / 2 + paint.offset.x * w;
  const cy = h / 2 + paint.offset.y * h;
  const length = (Math.abs(w * ux) + Math.abs(h * uy)) * paint.scale;

  // Forward map, gradient space → pixels: p = origin + gx·e + gy·f. For linear gradients the
  // gradient runs along e; radial-style gradients (centered, radius 0.5) span `length` across.
  const e = [ux * length, uy * length];
  const f = [-uy * length, ux * length];
  const origin = [cx - e[0] / 2 - f[0] / 2, cy - e[1] / 2 - f[1] / 2];

  // Pixels → normalized layer space.
  const fwd: Matrix = [
    [e[0] / w, f[0] / w, origin[0] / w],
    [e[1] / h, f[1] / h, origin[1] / h],
  ];
  return invert(fwd);
}

export function invert(m: Matrix): Matrix {
  const [[a, b, c], [d, e, f]] = m;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return [[1, 0, 0], [0, 1, 0]];
  return [
    [e / det, -b / det, (b * f - c * e) / det],
    [-d / det, a / det, (c * d - a * f) / det],
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}
