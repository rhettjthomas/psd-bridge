import { readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { psdToIR } from '../src/core/psd-reader';

const { doc } = psdToIR(
  readPsd(readFileSync('test/fixtures/sample.psd'), { skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true }),
  'sample.psd',
);
const shape = (name: string) => doc.layers.find((l) => l.name === name)!.shape!;

describe('readShape (fixture)', () => {
  it('reads live rounded rectangles as native rects with radii', () => {
    expect(shape('Button (rounded rect)')).toMatchObject({
      geometry: { type: 'rect', bounds: { left: 100, top: 950, width: 200, height: 60 }, radii: [12, 12, 12, 12] },
      fill: { type: 'solid', color: { r: expect.closeTo(0.776, 2), a: 1 } },
      warnings: [],
    });
  });

  it('reads live ellipses with an inside stroke', () => {
    expect(shape('Dot (ellipse)')).toMatchObject({
      geometry: { type: 'ellipse', bounds: { left: 400, top: 950, width: 60, height: 60 } },
      stroke: { width: 4, align: 'INSIDE', cap: 'NONE', join: 'MITER', dashes: [] },
    });
  });

  it('reads custom paths with gradient fills and dashed strokes', () => {
    const s = shape('Ribbon (path + gradient)');
    expect(s.geometry.type).toBe('path');
    expect(s.bounds).toEqual({ left: 600, top: 950, width: 300, height: 80 });
    expect(s.fill).toMatchObject({ type: 'gradient', kind: 'linear', angle: 90 });
    expect(s.stroke).toMatchObject({ width: 2, align: 'CENTER', dashes: [4, 2] });
  });

  it('centers strokes on open paths and honors a disabled fill', () => {
    const s = shape('Rule (open path)');
    expect(s.fill).toBeUndefined();
    expect(s.stroke?.align).toBe('CENTER');
    expect(s.warnings).toContainEqual(expect.stringMatching(/Open path/));
  });

  it('marks noise gradients unsupported', () => {
    expect(shape('Noise (unsupported)').unsupported).toMatch(/Noise/);
  });
});
