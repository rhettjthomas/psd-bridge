/**
 * Photoshop bezier paths → SVG-style path data for Figma's `vectorPaths`.
 *
 * ag-psd knots are [inX, inY, anchorX, anchorY, outX, outY] in document pixels.
 * Subpaths joined by "combine" become separate Figma paths (their fills union).
 * Subtract/exclude/intersect subpaths are merged into the current path with
 * even-odd winding, which renders holes correctly for the usual cases
 * (letterform counters, cut-outs). True intersections are reported.
 */
import type { BezierPath } from 'ag-psd';
import type { Bounds } from './model';

export type WindingRule = 'NONZERO' | 'EVENODD';

export interface IRPath {
  windingRule: WindingRule;
  /** SVG path data in document pixels. */
  data: string;
}

export interface IRVector {
  paths: IRPath[];
  /** Bounds of all anchor and control points, document pixels. */
  bounds: Bounds;
  /** Set when the geometry could only be approximated. */
  warning?: string;
}

export interface PathOptions {
  /** Start from a filled canvas (Photoshop "fill starts with all pixels"). */
  invertFrom?: Bounds;
}

export function convertPaths(paths: BezierPath[], opts: PathOptions = {}): IRVector | null {
  const out: IRPath[] = [];
  let current: IRPath | null = null;
  let warning: string | undefined;
  const pts: number[] = [];

  if (opts.invertFrom) {
    const b = opts.invertFrom;
    current = { windingRule: 'EVENODD', data: rectData(b) };
    out.push(current);
    pts.push(b.left, b.top, b.left + b.width, b.top + b.height);
  }

  let first = true;
  for (const path of paths) {
    const data = subpathData(path);
    if (!data) continue;
    for (const k of path.knots) pts.push(...k.points);

    // On an inverted mask, the first subpath is cut out of the filled canvas.
    const op = first && opts.invertFrom ? 'subtract' : path.operation ?? 'combine';
    first = false;
    if (current && op !== 'combine') {
      current.data += ' ' + data;
      current.windingRule = 'EVENODD';
      if (op === 'intersect') warning = 'Intersecting path operations were approximated.';
    } else {
      current = { windingRule: path.fillRule === 'non-zero' ? 'NONZERO' : 'EVENODD', data };
      out.push(current);
    }
  }

  if (!out.length) return null;
  return { paths: out, bounds: pointBounds(pts), warning };
}

function subpathData(path: BezierPath): string {
  const k = path.knots;
  if (k.length < 2) return '';
  const p = (n: number) => fmt(n);
  const seg = (a: number[], b: number[]) => `C ${p(a[4])} ${p(a[5])} ${p(b[0])} ${p(b[1])} ${p(b[2])} ${p(b[3])}`;
  const parts = [`M ${p(k[0].points[2])} ${p(k[0].points[3])}`];
  for (let i = 1; i < k.length; i++) parts.push(seg(k[i - 1].points, k[i].points));
  if (!path.open) {
    parts.push(seg(k[k.length - 1].points, k[0].points));
    parts.push('Z');
  }
  return parts.join(' ');
}

function rectData(b: Bounds): string {
  const r = b.left + b.width;
  const btm = b.top + b.height;
  return `M ${fmt(b.left)} ${fmt(b.top)} L ${fmt(r)} ${fmt(b.top)} L ${fmt(r)} ${fmt(btm)} L ${fmt(b.left)} ${fmt(btm)} Z`;
}

function pointBounds(pts: number[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxY = Math.max(maxY, pts[i + 1]);
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

/** Translate every coordinate in path data by (-dx, -dy). Path data here only uses M/L/C/Z. */
export function translatePathData(data: string, dx: number, dy: number): string {
  const tokens = data.split(' ');
  let axis = 0;
  return tokens
    .map((t) => {
      if (/^[MLCZ]$/.test(t)) {
        axis = 0;
        return t;
      }
      const v = Number(t) - (axis === 0 ? dx : dy);
      axis = 1 - axis;
      return fmt(v);
    })
    .join(' ');
}

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}
