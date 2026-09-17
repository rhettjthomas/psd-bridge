import { describe, expect, it } from 'vitest';
import { mapBlendMode } from '../src/core/blend';

describe('mapBlendMode', () => {
  it('maps supported modes', () => {
    expect(mapBlendMode('soft light', false)).toEqual({ mode: 'SOFT_LIGHT', fallback: false });
    expect(mapBlendMode('luminosity', false).mode).toBe('LUMINOSITY');
  });
  it('falls back to Normal and flags unsupported modes', () => {
    expect(mapBlendMode('vivid light', false)).toEqual({ mode: 'NORMAL', fallback: true });
    expect(mapBlendMode('dissolve', false).fallback).toBe(true);
  });
  it('defaults groups to pass through', () => {
    expect(mapBlendMode(undefined, true).mode).toBe('PASS_THROUGH');
    expect(mapBlendMode('pass through', false).mode).toBe('NORMAL');
  });
});
