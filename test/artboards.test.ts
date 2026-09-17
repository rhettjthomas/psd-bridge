import { readPsd, writePsdBuffer, type Layer, type Psd } from 'ag-psd';
import { beforeEach, describe, expect, it } from 'vitest';
import { planImport } from '../src/core/plan';
import { artboardBackground, psdToIR } from '../src/core/psd-reader';
import { DEFAULT_SETTINGS, type ImportSettings } from '../src/core/settings';
import { Importer } from '../src/main/importer';
import { installFigmaMock, tree, type MockNode } from './figma-mock';

const solid = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });
const px = (name: string, left: number, top: number, w: number, h: number): Layer => ({
  name, left, top, right: left + w, bottom: top + h, imageData: solid(w, h),
});
const board = (name: string, left: number, top: number, w: number, h: number, backgroundType: number, children: Layer[], color?: { r: number; g: number; b: number }): Layer => ({
  name,
  children,
  opened: true,
  artboard: { rect: { left, top, right: left + w, bottom: top + h }, backgroundType, color: color ?? { r: 255, g: 255, b: 255 } },
});

/** Writes and re-reads the PSD so the test covers ag-psd's artboard parsing too. */
function importPsd(psd: Psd, settings: ImportSettings = DEFAULT_SETTINGS) {
  const read = readPsd(writePsdBuffer(psd), { skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true });
  const { doc } = psdToIR(read, 'boards.psd');
  const plan = planImport(doc, settings);
  for (const l of plan.layers) {
    if (l.action === 'raster') l.image = { width: l.bounds.width, height: l.bounds.height, png: new Uint8Array([1]) };
  }
  const { layers, ...info } = doc;
  const imp = new Importer(info, settings, plan.layers.length, []);
  imp.addBatch(plan.layers);
  const result = imp.finish([]);
  return { doc, frame: imp.frame as unknown as MockNode, result };
}

describe('artboardBackground', () => {
  it('maps Photoshop background types', () => {
    expect(artboardBackground(1, undefined)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(artboardBackground(2, undefined)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(artboardBackground(3, undefined)).toBeNull();
    expect(artboardBackground(4, { r: 255, g: 0, b: 51 })).toEqual({ r: 1, g: 0, b: 0.2, a: 1 });
    expect(artboardBackground(undefined, undefined)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
});

describe('artboards', () => {
  beforeEach(() => installFigmaMock());

  it('turns a lone artboard into the import frame, with its background', () => {
    const { doc, frame } = importPsd({
      width: 1200,
      height: 800,
      children: [board('Hero', 100, 50, 1000, 600, 2, [px('Title', 150, 100, 300, 80)])],
    });
    expect(doc.layers[0].artboard).toEqual({
      bounds: { left: 100, top: 50, width: 1000, height: 600 },
      background: { r: 0, g: 0, b: 0, a: 1 },
    });
    expect(tree(frame)).toEqual([
      'FRAME boards @0,0 1000x600',
      // Positions are now relative to the artboard.
      '  RECTANGLE Title @50,50 300x80',
    ]);
    expect(frame.fills).toEqual([{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }]);
    expect(frame.clipsContent).toBe(true);
  });

  it('keeps several artboards as clipped frames at their positions', () => {
    const { frame, result } = importPsd({
      width: 2000,
      height: 800,
      children: [
        board('Square', 0, 0, 800, 800, 3, [px('A', 10, 10, 50, 50)]),
        board('Wide', 900, 100, 1100, 600, 4, [px('B', 950, 150, 50, 50)], { r: 20, g: 40, b: 60 }),
      ],
    });
    expect(tree(frame)).toEqual([
      'FRAME boards @0,0 2000x800',
      '  FRAME Square @0,0 800x800',
      '    RECTANGLE A @10,10 50x50',
      '  FRAME Wide @900,100 1100x600',
      '    RECTANGLE B @50,50 50x50',
    ]);
    const [square, wide] = frame.children;
    expect(square.fills).toEqual([]);
    expect(wide.fills).toEqual([{ type: 'SOLID', color: { r: 20 / 255, g: 40 / 255, b: 60 / 255 }, opacity: 1 }]);
    expect(wide.clipsContent).toBe(true);
    expect(result.imported).toBe(4);
  });

  it('keeps artboards when flattening groups', () => {
    const { frame } = importPsd(
      { width: 1000, height: 600, children: [board('Hero', 0, 0, 1000, 600, 1, [{ name: 'G', children: [px('C', 5, 5, 10, 10)] }])] },
      { ...DEFAULT_SETTINGS, flattenGroups: true },
    );
    expect(tree(frame)).toEqual(['FRAME boards @0,0 1000x600', '  RECTANGLE C @5,5 10x10']);
    expect(frame.fills).toEqual([{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }]);
  });
});
