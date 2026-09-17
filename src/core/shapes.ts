/**
 * Photoshop shape layers → format-neutral shapes.
 *
 * Live rectangles, rounded rectangles, and ellipses that are still axis-aligned
 * become native shapes; everything else becomes a vector path. Geometry is in
 * document pixels with the layer transform already applied (Photoshop stores
 * transformed points), so nodes are never moved again.
 */
import type { Layer, LineAlignment, LineCapType, LineJoinType } from 'ag-psd';
import type { Bounds } from './model';
import { toPaint, type IRPaint } from './paint';
import { convertPaths, type IRVector } from './paths';

export type IRGeometry =
  | { type: 'rect'; bounds: Bounds; radii: [number, number, number, number] } // TL, TR, BR, BL
  | { type: 'ellipse'; bounds: Bounds }
  | { type: 'path'; vector: IRVector };

export interface IRStroke {
  paint: IRPaint;
  width: number;
  align: 'INSIDE' | 'CENTER' | 'OUTSIDE';
  cap: 'NONE' | 'ROUND' | 'SQUARE';
  join: 'MITER' | 'ROUND' | 'BEVEL';
  /** Dash and gap lengths in pixels; empty = solid. */
  dashes: number[];
}

export interface IRShape {
  geometry: IRGeometry;
  /** Geometry bounds in document pixels (gradients are placed relative to this box). */
  bounds: Bounds;
  fill?: IRPaint;
  stroke?: IRStroke;
  /** When set, the shape can't be editable and imports as pixels. */
  unsupported?: string;
  warnings: string[];
}

// Photoshop keyOriginType values.
const ORIGIN_RECT = 1;
const ORIGIN_ROUNDED_RECT = 2;
const ORIGIN_ELLIPSE = 5;

export function readShape(l: Layer, doc: { width: number; height: number }): IRShape {
  const warnings: string[] = [];
  const docBounds = { left: 0, top: 0, width: doc.width, height: doc.height };

  // A fill layer without a vector mask covers the whole canvas.
  const paths = l.vectorMask?.paths ?? [];
  const vector = paths.length
    ? convertPaths(paths, { invertFrom: l.vectorMask?.fillStartsWithAllPixels ? docBounds : undefined })
    : null;
  if (paths.length && !vector) return fail('Shape has no drawable path.');
  if (vector?.warning) warnings.push(vector.warning);

  const geometry: IRGeometry = vector
    ? liveShape(l, paths.length) ?? { type: 'path', vector }
    : { type: 'rect', bounds: docBounds, radii: [0, 0, 0, 0] };
  const bounds = geometry.type === 'path' ? geometry.vector.bounds : geometry.bounds;

  const stroke = l.vectorStroke;
  const fillOn = stroke?.fillEnabled !== false;
  const fillRes = fillOn ? toPaint(l.vectorFill) : {};
  if (fillRes.unsupported) return fail(fillRes.unsupported);
  if (fillRes.warning) warnings.push(fillRes.warning);

  let irStroke: IRStroke | undefined;
  if (stroke?.strokeEnabled) {
    const res = toPaint(stroke.content, stroke.opacity ?? 1);
    if (res.unsupported) return fail(`Stroke: ${res.unsupported}`);
    if (res.paint?.type === 'pattern') return fail('Pattern strokes have no Figma equivalent.');
    if (res.warning) warnings.push(`Stroke: ${res.warning}`);
    if (stroke.blendMode && stroke.blendMode !== 'normal') warnings.push('Stroke blend mode was imported as Normal.');
    const width = stroke.lineWidth?.value ?? 1;
    if (res.paint && width > 0) {
      irStroke = {
        paint: res.paint,
        width,
        align: ALIGN[stroke.lineAlignment ?? 'center'],
        cap: CAP[stroke.lineCapType ?? 'butt'],
        join: JOIN[stroke.lineJoinType ?? 'miter'],
        // Photoshop dash lengths are multiples of the stroke width.
        dashes: (stroke.lineDashSet ?? []).map((d) => d.value * width),
      };
      const open = geometry.type === 'path' && paths.some((p) => p.open);
      if (open && irStroke.align !== 'CENTER') {
        irStroke.align = 'CENTER';
        warnings.push('Open path stroke centered (Figma only centers strokes on open paths).');
      }
    }
  }

  return { geometry, bounds, fill: fillRes.paint, stroke: irStroke, warnings };

  function fail(reason: string): IRShape {
    return { geometry: { type: 'rect', bounds: docBounds, radii: [0, 0, 0, 0] }, bounds: docBounds, unsupported: reason, warnings };
  }
}

const ALIGN: Record<LineAlignment, IRStroke['align']> = { inside: 'INSIDE', center: 'CENTER', outside: 'OUTSIDE' };
const CAP: Record<LineCapType, IRStroke['cap']> = { butt: 'NONE', round: 'ROUND', square: 'SQUARE' };
const JOIN: Record<LineJoinType, IRStroke['join']> = { miter: 'MITER', round: 'ROUND', bevel: 'BEVEL' };

/** A native rectangle/ellipse when the layer is a single, unrotated live shape. */
function liveShape(l: Layer, subpaths: number): IRGeometry | null {
  const keys = l.vectorOrigination?.keyDescriptorList ?? [];
  if (keys.length !== 1 || subpaths !== 1) return null;
  const k = keys[0];
  if (k.keyShapeInvalidated) return null;
  const type = k.keyOriginType;
  if (type !== ORIGIN_RECT && type !== ORIGIN_ROUNDED_RECT && type !== ORIGIN_ELLIPSE) return null;

  const corners = k.keyOriginBoxCorners;
  if (!corners || corners.length !== 4) return null;
  const [tl, tr, br, bl] = corners;
  const eps = 0.01;
  const axisAligned =
    Math.abs(tl.y - tr.y) < eps && Math.abs(bl.y - br.y) < eps && Math.abs(tl.x - bl.x) < eps && Math.abs(tr.x - br.x) < eps;
  if (!axisAligned || tr.x <= tl.x || bl.y <= tl.y) return null;
  const bounds = { left: tl.x, top: tl.y, width: tr.x - tl.x, height: bl.y - tl.y };

  if (type === ORIGIN_ELLIPSE) return { type: 'ellipse', bounds };

  const r = k.keyOriginRRectRadii;
  const radii: [number, number, number, number] = r
    ? [r.topLeft.value, r.topRight.value, r.bottomRight.value, r.bottomLeft.value]
    : [0, 0, 0, 0];
  if (radii.some((v) => v > 0)) {
    // Radii are stored before the transform; a non-uniform scale would make corners elliptical.
    const t = k.transform;
    if (t && t.length >= 4) {
      const sx = Math.hypot(t[0], t[1]);
      const sy = Math.hypot(t[2], t[3]);
      if (Math.abs(sx - sy) > 1e-3) return null;
      for (let i = 0; i < 4; i++) radii[i] *= sx;
    }
  }
  return { type: 'rect', bounds, radii };
}
