import type { BezierPath } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { convertPaths, translatePathData } from '../src/core/paths';

const knot = (ax: number, ay: number, inX = ax, inY = ay, outX = ax, outY = ay) => ({
  linked: true,
  points: [inX, inY, ax, ay, outX, outY],
});

const tri: BezierPath = { open: false, fillRule: 'non-zero', knots: [knot(0, 0), knot(10, 0), knot(5, 10)] };

describe('convertPaths', () => {
  it('writes closed subpaths as cubic segments back to the start', () => {
    expect(convertPaths([tri])).toEqual({
      paths: [{ windingRule: 'NONZERO', data: 'M 0 0 C 0 0 10 0 10 0 C 10 0 5 10 5 10 C 5 10 0 0 0 0 Z' }],
      bounds: { left: 0, top: 0, width: 10, height: 10 },
      warning: undefined,
    });
  });

  it('uses bezier handles: out-handle of one knot, in-handle of the next', () => {
    const curve: BezierPath = { open: true, fillRule: 'even-odd', knots: [knot(0, 0, 0, 0, 3, -2), knot(10, 0, 7, -2, 10, 0)] };
    expect(convertPaths([curve])!.paths[0].data).toBe('M 0 0 C 3 -2 7 -2 10 0');
    expect(convertPaths([curve])!.bounds).toEqual({ left: 0, top: -2, width: 10, height: 2 });
  });

  it('keeps combined subpaths separate and merges subtracted ones with even-odd', () => {
    const hole = { ...tri, operation: 'subtract' as const };
    const other = { ...tri, operation: 'combine' as const };
    const out = convertPaths([tri, hole, other])!;
    expect(out.paths.map((p) => p.windingRule)).toEqual(['EVENODD', 'NONZERO']);
    expect(out.paths[0].data.match(/M /g)).toHaveLength(2);
  });

  it('reports intersections as approximated', () => {
    expect(convertPaths([tri, { ...tri, operation: 'intersect' }])!.warning).toMatch(/Intersect/);
  });

  it('inverts from a filled canvas', () => {
    const out = convertPaths([tri], { invertFrom: { left: 0, top: 0, width: 100, height: 50 } })!;
    expect(out.paths).toHaveLength(1);
    expect(out.paths[0].windingRule).toBe('EVENODD');
    expect(out.paths[0].data.startsWith('M 0 0 L 100 0 L 100 50 L 0 50 Z M 0 0 C')).toBe(true);
  });

  it('ignores degenerate subpaths', () => {
    expect(convertPaths([{ open: true, fillRule: 'non-zero', knots: [knot(1, 1)] }])).toBeNull();
  });
});

describe('translatePathData', () => {
  it('shifts x and y coordinates', () => {
    expect(translatePathData('M 10 20 L 30 40 C 1 2 3 4 5 6 Z', 10, 20)).toBe('M 0 0 L 20 20 C -9 -18 -7 -16 -5 -14 Z');
  });
});
