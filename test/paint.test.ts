import { describe, expect, it } from 'vitest';
import { applyMatrix, gradientTransform, invert, mergeStops, toPaint, type IRPaint } from '../src/core/paint';

const red = { r: 255, g: 0, b: 0 };
const blue = { r: 0, g: 0, b: 255 };
const stop = (location: number) => ({ location, midpoint: 0.5 });

describe('mergeStops', () => {
  it('combines color and opacity stops at every position', () => {
    const stops = mergeStops(
      [{ color: red, ...stop(0) }, { color: blue, ...stop(1) }],
      [{ opacity: 1, ...stop(0) }, { opacity: 0, ...stop(0.5) }, { opacity: 0, ...stop(1) }],
    );
    expect(stops.map((s) => s.position)).toEqual([0, 0.5, 1]);
    expect(stops[1].color).toEqual({ r: 0.5, g: 0, b: 0.5, a: 0 });
    expect(stops[0].color.a).toBe(1);
  });
});

describe('toPaint', () => {
  const grad = (extra = {}) => ({
    type: 'solid' as const, name: 'g', colorStops: [{ color: red, ...stop(0) }, { color: blue, ...stop(1) }],
    opacityStops: [{ opacity: 1, ...stop(0) }, { opacity: 1, ...stop(1) }], ...extra,
  });

  it('maps gradient styles to Figma kinds', () => {
    expect((toPaint(grad({ style: 'angle' })).paint as any).kind).toBe('angular');
    expect((toPaint(grad({ style: 'diamond' })).paint as any).kind).toBe('diamond');
  });

  it('mirrors reflected gradients around the center', () => {
    const p = toPaint(grad({ style: 'reflected' })).paint as Extract<IRPaint, { type: 'gradient' }>;
    expect(p.kind).toBe('linear');
    expect(p.stops.map((s) => s.position)).toEqual([0, 0.5, 1]);
    expect(p.stops[0].color).toEqual(p.stops[2].color);
    expect(p.stops[1].color.r).toBe(1);
  });

  it('reverses stops', () => {
    const p = toPaint(grad({ reverse: true })).paint as Extract<IRPaint, { type: 'gradient' }>;
    expect(p.stops[0].color.b).toBe(1);
  });

  it('flags uneven midpoints and rejects noise gradients', () => {
    const uneven = grad({ colorStops: [{ color: red, location: 0, midpoint: 0.2 }, { color: blue, ...stop(1) }] });
    expect(toPaint(uneven).warning).toMatch(/midpoints/);
    expect(toPaint({ type: 'noise', name: 'n', min: [], max: [] }).unsupported).toBeTruthy();
  });
});

describe('gradientTransform', () => {
  const linear = (angle: number, extra: Partial<Extract<IRPaint, { type: 'gradient' }>> = {}) => ({
    type: 'gradient' as const, kind: 'linear' as const, stops: [], angle, scale: 1, offset: { x: 0, y: 0 }, opacity: 1, ...extra,
  });
  /** Where the gradient's start and end handles land in normalized layer space. */
  const handles = (m: ReturnType<typeof gradientTransform>) => {
    const inv = invert(m);
    return [applyMatrix(inv, 0, 0.5), applyMatrix(inv, 1, 0.5)].map(([x, y]) => [round(x), round(y)]);
  };
  const round = (n: number) => Math.round(n * 1000) / 1000 + 0;

  it('runs a 0° gradient left to right across the box', () => {
    expect(handles(gradientTransform(linear(0), { width: 200, height: 100 }))).toEqual([[0, 0.5], [1, 0.5]]);
  });

  it('runs a 90° gradient bottom to top (Photoshop convention)', () => {
    expect(handles(gradientTransform(linear(90), { width: 200, height: 100 }))).toEqual([[0.5, 1], [0.5, 0]]);
  });

  it('applies scale and offset', () => {
    expect(handles(gradientTransform(linear(0, { scale: 0.5, offset: { x: 0.25, y: 0 } }), { width: 200, height: 100 })))
      .toEqual([[0.5, 0.5], [1, 0.5]]);
  });

  it('spans a 45° gradient across the box diagonal extent', () => {
    const [[x0, y0], [x1, y1]] = handles(gradientTransform(linear(45), { width: 100, height: 100 }));
    expect([x0, y0]).toEqual([0, 1]);
    expect([x1, y1]).toEqual([1, 0]);
  });

  it('centers radial gradients on the box', () => {
    const m = gradientTransform({ ...linear(0), kind: 'radial' }, { width: 100, height: 100 });
    expect(applyMatrix(m, 0.5, 0.5).map(round)).toEqual([0.5, 0.5]);
  });
});
