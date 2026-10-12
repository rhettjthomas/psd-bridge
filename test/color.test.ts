import { describe, expect, it } from 'vitest';
import { cmykToRGBA, hsbToRGBA, labToRGBA, toRGBA } from '../src/core/color';

const near = (n: number) => expect.closeTo(n, 2);

describe('toRGBA', () => {
  it('reads RGB (0–255) and float RGB (0–1)', () => {
    expect(toRGBA({ r: 255, g: 0, b: 51 })).toEqual({ r: 1, g: 0, b: 0.2, a: 1 });
    expect(toRGBA({ fr: 0.5, fg: 0.25, fb: 0 })).toEqual({ r: 0.5, g: 0.25, b: 0, a: 1 });
  });

  it('reads grayscale as ink percent: 0 is white, 100 is black', () => {
    expect(toRGBA({ k: 0 })).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(toRGBA({ k: 100 })).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(toRGBA({ k: 50 })).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });

  it('converts CMYK instead of falling back to black', () => {
    // The bug this replaced: every CMYK color arrived as black.
    expect(toRGBA({ c: 0, m: 100, y: 100, k: 0 })).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(toRGBA({ c: 0, m: 0, y: 0, k: 0 })).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it('converts HSB and Lab', () => {
    expect(toRGBA({ h: 120, s: 100, b: 100 })).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(toRGBA({ l: 100, a: 0, b: 0 })).toEqual({ r: near(1), g: near(1), b: near(1), a: 1 });
  });
});

describe('cmykToRGBA', () => {
  it('matches the multiply model used for CMYK pixels', () => {
    expect(cmykToRGBA(100, 0, 0, 0)).toEqual({ r: 0, g: 1, b: 1, a: 1 });
    expect(cmykToRGBA(0, 0, 0, 100)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(cmykToRGBA(0, 0, 0, 50)).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
    // Rich black: every ink down, nothing left.
    expect(cmykToRGBA(60, 40, 40, 100)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('clamps out-of-range values', () => {
    expect(cmykToRGBA(-10, 0, 0, 0).r).toBe(1);
    expect(cmykToRGBA(150, 0, 0, 0).r).toBe(0);
  });
});

describe('hsbToRGBA', () => {
  it('maps hues around the wheel', () => {
    expect(hsbToRGBA(0, 100, 100)).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(hsbToRGBA(240, 100, 100)).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(hsbToRGBA(0, 0, 50)).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });
});

describe('labToRGBA', () => {
  it('maps the neutral axis and a known color', () => {
    expect(labToRGBA(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    const mid = labToRGBA(50, 0, 0);
    expect(mid.r).toBeCloseTo(mid.g, 3);
    expect(mid.r).toBeGreaterThan(0.4);
    expect(mid.r).toBeLessThan(0.65);
    // Lab red-ish: strong a, positive b.
    const red = labToRGBA(54, 81, 70);
    expect(red.r).toBeGreaterThan(0.8);
    expect(red.g).toBeLessThan(0.3);
  });
});
