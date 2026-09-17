import { readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';
import { beforeEach, describe, expect, it } from 'vitest';
import { planImport } from '../src/core/plan';
import { psdToIR } from '../src/core/psd-reader';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { installFigmaMock, tree, type MockNode } from './figma-mock';

const { doc, report } = psdToIR(
  readPsd(readFileSync('test/fixtures/sample.psd'), { skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true }),
  'sample.psd',
);

async function runImport(settings = DEFAULT_SETTINGS) {
  const { Importer } = await import('../src/main/importer');
  const plan = planImport(doc, settings);
  for (const l of plan.layers) {
    if (l.action === 'raster') {
      const big = l.name === 'Background';
      l.image = { width: big ? 1024 : l.bounds.width, height: big ? 576 : l.bounds.height, png: new Uint8Array([1]), downscaled: big };
    }
  }
  const { layers, ...info } = doc;
  const imp = new Importer(info, settings, plan.layers.length, [...report, ...plan.report]);
  imp.addBatch(plan.layers.slice(0, 3));
  imp.addBatch(plan.layers.slice(3));
  const result = imp.finish([]);
  return { frame: imp.frame as unknown as MockNode, result };
}

describe('Importer', () => {
  beforeEach(() => installFigmaMock());

  it('builds the frame with correct order, positions, groups, and properties', async () => {
    const { frame, result } = await runImport();
    expect(tree(frame)).toEqual([
      'FRAME sample @0,0 1920x1080',
      '  RECTANGLE Background @0,0 1920x1080',
      '  RECTANGLE Texture @0,0 512x512 0.60 OVERLAY',
      '  GROUP Hero @0,0 100x100',
      '    RECTANGLE Photo @200,150 800x600',
      '    RECTANGLE Grade (clipped) @200,150 800x600 SOFT_LIGHT',
      '    RECTANGLE Vignette (masked) @0,0 960x540 0.50 MULTIPLY',
      '    RECTANGLE Glow (unsupported) @1200,700 200x200',
      '  RECTANGLE Source photo (hidden) @0,0 400x300 hidden',
    ]);
    expect(frame.fills).toEqual([]);
    expect(result.imported).toBe(8);
    expect(result.items).toContainEqual(expect.objectContaining({ layerName: 'Background', level: 'approximated' }));
  });

  it('flattens groups into the frame', async () => {
    const { frame } = await runImport({ ...DEFAULT_SETTINGS, flattenGroups: true });
    expect(frame.children.map((c) => c.type)).not.toContain('GROUP');
    expect(frame.children.map((c) => c.name)).toContain('Photo');
  });

  it('places a new frame to the right of existing content', async () => {
    const figma = (globalThis as any).figma;
    const existing = figma.createFrame();
    existing.x = 50;
    existing.y = 20;
    existing.resize(300, 200);
    const { frame } = await runImport();
    expect([frame.x, frame.y]).toEqual([450, 20]);
  });

  it('reports layers without pixel data instead of throwing', async () => {
    const { Importer } = await import('../src/main/importer');
    const { layers, ...info } = doc;
    const imp = new Importer(info, DEFAULT_SETTINGS, 1, []);
    imp.addBatch([{ ...doc.layers[0], action: 'raster', parentId: null, image: undefined }]);
    expect(imp.finish([]).items).toEqual([{ level: 'skipped', layerName: 'Empty layer', reason: 'No pixel data found.' }].map((i) => ({ ...i, layerName: doc.layers[0].name })));
  });
});
