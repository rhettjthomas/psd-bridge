import { describe, expect, it } from 'vitest';
import { combineOpacity, fitImageSize, shadowBlurAndSpread, shadowOffset, trackingToPercent, transformScale } from '../src/core/units';

describe('shadowOffset', () => {
  it('casts the default 120° light down and to the right', () => {
    expect(shadowOffset(120, 10)).toEqual({ x: 5, y: 8.66 });
  });
  it('casts light from the top straight down', () => {
    expect(shadowOffset(90, 4)).toEqual({ x: 0, y: 4 });
  });
  it('casts light from the right to the left', () => {
    expect(shadowOffset(0, 3)).toEqual({ x: -3, y: 0 });
  });
});

describe('shadowBlurAndSpread', () => {
  it('splits size by spread percent', () => {
    expect(shadowBlurAndSpread(20, 25)).toEqual({ radius: 15, spread: 5 });
    expect(shadowBlurAndSpread(20, 0)).toEqual({ radius: 20, spread: 0 });
  });
});

describe('text units', () => {
  it('converts tracking (1/1000 em) to Figma percent', () => {
    expect(trackingToPercent(50)).toBe(5);
    expect(trackingToPercent(-25)).toBe(-2.5);
  });
  it('reads uniform scale from a text transform', () => {
    expect(transformScale([2, 0, 0, 2, 10, 10])).toBe(2);
    expect(transformScale(undefined)).toBe(1);
    const r = Math.PI / 6;
    expect(transformScale([1.5 * Math.cos(r), 1.5 * Math.sin(r), -1.5 * Math.sin(r), 1.5 * Math.cos(r), 0, 0])).toBeCloseTo(1.5);
  });
});

describe('combineOpacity', () => {
  it('multiplies layer and fill opacity', () => {
    expect(combineOpacity(0.5, 0.5)).toBe(0.25);
    expect(combineOpacity()).toBe(1);
  });
});

describe('fitImageSize', () => {
  it('leaves small images alone', () => {
    expect(fitImageSize(1920, 1080)).toEqual({ width: 1920, height: 1080, downscaled: false });
  });
  it('downscales to the 4096 cap keeping aspect', () => {
    expect(fitImageSize(8192, 2048)).toEqual({ width: 4096, height: 1024, downscaled: true });
  });
});
