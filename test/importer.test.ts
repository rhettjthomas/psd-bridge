import { readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';
import { beforeEach, describe, expect, it } from 'vitest';
import { planImport } from '../src/core/plan';
import { psdToIR } from '../src/core/psd-reader';
import { DEFAULT_SETTINGS, type ImportSettings } from '../src/core/settings';
import { installFigmaMock, tree, type MockNode } from './figma-mock';

const { doc, report } = psdToIR(
  readPsd(readFileSync('test/fixtures/sample.psd'), { skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true }),
  'sample.psd',
);

/** Runs a full import with fake PNGs, the way the UI would send it. */
async function runImport(settings: ImportSettings = DEFAULT_SETTINGS) {
  const { Importer } = await import('../src/main/importer');
  const { loadFonts } = await import('../src/main/text');
  const fonts = await loadFonts({ 'Inter-Bold': { family: 'Inter', style: 'Bold' } }, []);
  const plan = planImport(doc, settings);
  const png = { png: new Uint8Array([1]), downscaled: false };
  for (const l of plan.layers) {
    if (l.action === 'raster') {
      const big = l.name === 'Background';
      l.image = { ...png, width: big ? 1024 : l.bounds.width, height: big ? 576 : l.bounds.height, downscaled: big };
    }
    if (l.mask) {
      const bounds = l.mask.defaultColor ? { left: 0, top: 0, width: doc.width, height: doc.height } : l.mask.bounds;
      l.mask = { ...l.mask, bounds, image: { ...png, width: bounds.width, height: bounds.height } };
    }
  }
  const { layers, ...info } = doc;
  const imp = new Importer(info, settings, plan.layers.length, [...report, ...plan.report], fonts.resolved);
  imp.addBatch(plan.layers.slice(0, 3));
  imp.addBatch(plan.layers.slice(3));
  const result = imp.finish([]);
  return { frame: imp.frame as unknown as MockNode, result };
}

describe('Importer', () => {
  beforeEach(() => installFigmaMock());

  it('builds groups, masks, clipping, shadows, and order like Photoshop', async () => {
    const { frame, result } = await runImport();
    expect(tree(frame)).toEqual([
      'FRAME sample @0,0 1920x1080',
      '  RECTANGLE Background @0,0 1920x1080',
      '  RECTANGLE Texture @0,0 512x512 0.60 OVERLAY',
      '  GROUP Hero @0,0 100x100',
      '    GROUP Photo (clipping group) @0,0 100x100',
      '      RECTANGLE Clipping shape @200,150 800x600 mask:ALPHA',
      '      RECTANGLE Photo @200,150 800x600',
      '      RECTANGLE Grade (clipped) @200,150 800x600 SOFT_LIGHT',
      '    GROUP Vignette (masked) @0,0 100x100 0.50 MULTIPLY',
      '      RECTANGLE Layer mask @100,100 300x200 mask:LUMINANCE',
      '      RECTANGLE Vignette (masked) @0,0 960x540',
      '    RECTANGLE Glow (unsupported) @1200,700 200x200',
      '  TEXT Title @240,813.6 100x100 fx:DROP_SHADOW',
      '  GROUP Badge (vector mask) @0,0 100x100',
      '    VECTOR Vector mask @1500,100 300x300 mask:VECTOR',
      '    RECTANGLE Badge (vector mask) @1500,100 300x300',
      '  GROUP Frame (masked group) @0,0 100x100',
      '    RECTANGLE Layer mask @0,0 1920x1080 mask:LUMINANCE',
      '    RECTANGLE Card @1400,400 300x200 fx:INNER_SHADOW',
      '  GROUP Shapes @0,0 100x100',
      '    RECTANGLE Button (rounded rect) @100,950 200x60',
      '    ELLIPSE Dot (ellipse) @400,950 60x60',
      '    VECTOR Ribbon (path + gradient) @600,950 300x80',
      '    VECTOR Rule (open path) @950,990 200x0',
      '    RECTANGLE Noise (unsupported) @1200,950 100x60',
      '  GROUP Type @0,0 100x100',
      '    TEXT Series title (runs) @910,68 100x100',
      '    TEXT Body (box) @1300,700 400x120',
      '    RECTANGLE Arched (warped) @100,100 300x60',
      '    TEXT Side note (rotated) @43.8,900 100x100',
      '  RECTANGLE Source photo (hidden) @0,0 400x300 hidden',
    ]);
    expect(frame.fills).toEqual([]);
    // 11 image layers + 4 shapes + 4 text + 4 PSD groups; the synthetic clipping group isn't counted.
    expect(result.imported).toBe(23);
    expect(result.items).not.toContainEqual(expect.objectContaining({ reason: expect.stringMatching(/^Failed/) }));
    expect(result.items).toContainEqual(expect.objectContaining({ layerName: 'Background', level: 'approximated' }));
  });

  it('builds editable shapes with radii, paints, and strokes', async () => {
    const { frame } = await runImport();
    const shapes = frame.children.find((c) => c.name === 'Shapes')!.children;
    const [button, dot, ribbon] = shapes as any[];
    expect([button.topLeftRadius, button.bottomRightRadius]).toEqual([12, 12]);
    expect(button.fills).toEqual([{ type: 'SOLID', color: { r: expect.closeTo(0.776, 2), g: expect.closeTo(0.957, 2), b: expect.closeTo(0.196, 2) }, opacity: 1 }]);
    expect(dot.strokes).toHaveLength(1);
    expect([dot.strokeWeight, dot.strokeAlign]).toEqual([4, 'INSIDE']);
    expect(ribbon.fills[0].type).toBe('GRADIENT_LINEAR');
    expect(ribbon.fills[0].gradientStops).toHaveLength(2);
    expect(ribbon.dashPattern).toEqual([4, 2]);
    expect(ribbon.vectorPaths[0].windingRule).toBe('NONZERO');
  });

  it('converts shadow geometry into Figma effects', async () => {
    const { frame } = await runImport();
    const card = frame.children.find((c) => c.name === 'Frame (masked group)')!.children[1];
    expect(card.effects).toEqual([{
      type: 'INNER_SHADOW', color: { r: 0, g: 0, b: 0, a: expect.closeTo(0.25, 2) },
      offset: { x: 0, y: 4 }, radius: 4, spread: 4, visible: true, blendMode: 'MULTIPLY',
    }]);
  });

  it('skips shadows when "Rebuild shadows" is off', async () => {
    const { frame } = await runImport({ ...DEFAULT_SETTINGS, rebuildShadows: false });
    expect(tree(frame).join('\n')).not.toContain('fx:');
  });

  it('flattens plain groups but keeps masked groups and clipping groups', async () => {
    const { frame, result } = await runImport({ ...DEFAULT_SETTINGS, flattenGroups: true });
    const names = frame.children.map((c) => `${c.type} ${c.name}`);
    expect(names).not.toContain('GROUP Hero');
    expect(names).toContain('GROUP Photo (clipping group)');
    expect(names).toContain('GROUP Frame (masked group)');
    expect(result.items).toContainEqual(expect.objectContaining({ layerName: 'Frame (masked group)', level: 'approximated' }));
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
    const photo = doc.layers.find((l) => l.name === 'Photo')!;
    imp.addBatch([{ ...photo, action: 'raster', parentId: null, image: undefined }]);
    expect(imp.finish([]).items).toEqual([{ level: 'skipped', layerName: 'Photo', reason: 'No pixel data found.' }]);
  });

  it('leaves clipped layers unclipped when the base failed to place', async () => {
    const { Importer } = await import('../src/main/importer');
    const plan = planImport(doc, DEFAULT_SETTINGS);
    const clip = plan.layers.filter((l) => l.parentId === plan.layers.find((p) => p.action === 'clip')!.id || l.action === 'clip');
    const { layers, ...info } = doc;
    const imp = new Importer(info, DEFAULT_SETTINGS, clip.length, []);
    // Base (Photo) has no image; the clipped layer does.
    imp.addBatch(clip.map((l) => (l.name === 'Grade (clipped)' ? { ...l, image: { width: 1, height: 1, png: new Uint8Array([1]) } } : l)));
    const result = imp.finish([]);
    const group = (imp.frame as unknown as MockNode).children[0];
    expect(group.children.map((c) => c.name)).toEqual(['Grade (clipped)']);
    expect(result.items).toContainEqual(expect.objectContaining({ layerName: 'Photo (clipping group)', level: 'approximated' }));
  });
});
