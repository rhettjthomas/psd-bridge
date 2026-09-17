import { readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { planImport } from '../src/core/plan';
import { psdToIR } from '../src/core/psd-reader';
import { DEFAULT_SETTINGS } from '../src/core/settings';

const { doc } = psdToIR(
  readPsd(readFileSync('test/fixtures/sample.psd'), { skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true }),
  'sample.psd',
);
const names = (s = DEFAULT_SETTINGS) => planImport(doc, s).layers.map((l) => `${l.action}:${l.name}`);

describe('planImport', () => {
  it('orders parents first and siblings bottom-first, skipping adjustments and empties', () => {
    expect(names()).toEqual([
      'raster:Background',
      'raster:Texture',
      'group:Hero',
      'clip:Photo (clipping group)',
      'raster:Photo',
      'raster:Grade (clipped)',
      'raster:Vignette (masked)',
      'raster:Glow (unsupported)',
      'raster:Badge (vector mask)',
      'group:Frame (masked group)',
      'raster:Card',
      'group:Shapes',
      'vector:Button (rounded rect)',
      'vector:Dot (ellipse)',
      'vector:Ribbon (path + gradient)',
      'vector:Rule (open path)',
      'raster:Noise (unsupported)',
      'raster:Source photo (hidden)',
    ]);
  });

  it('reports text with no pixel bounds as skipped', () => {
    expect(planImport(doc, DEFAULT_SETTINGS).report).toContainEqual({
      level: 'skipped', layerName: 'Title', reason: 'Layer has no pixels.',
    });
  });

  it('drops hidden layers when "Import hidden layers" is off', () => {
    expect(names({ ...DEFAULT_SETTINGS, importHidden: false })).not.toContain('raster:Source photo (hidden)');
  });

  it('reparents children of plain groups to the frame when flattening', () => {
    const plan = planImport(doc, { ...DEFAULT_SETTINGS, flattenGroups: true });
    const byName = (n: string) => plan.layers.find((l) => l.name === n)!;
    expect(plan.layers.some((l) => l.name === 'Hero')).toBe(false);
    expect(byName('Vignette (masked)').parentId).toBeNull();
    expect(byName('Photo (clipping group)').parentId).toBeNull();
    // Masked groups survive flattening.
    expect(byName('Card').parentId).toBe(byName('Frame (masked group)').id);
  });

  it('wraps a clipping base and its clipped layers in a clip group', () => {
    const plan = planImport(doc, DEFAULT_SETTINGS);
    const byName = (n: string) => plan.layers.find((l) => l.name === n)!;
    const hero = byName('Hero');
    const clip = byName('Photo (clipping group)');
    expect(clip).toMatchObject({ action: 'clip', parentId: hero.id, children: [byName('Photo').id] });
    expect(byName('Photo').parentId).toBe(clip.id);
    expect(byName('Grade (clipped)').parentId).toBe(clip.id);
    expect(byName('Vignette (masked)').parentId).toBe(hero.id);
  });

  it('moves base visibility, opacity, and blend onto the clip group', () => {
    const base = doc.layers.find((l) => l.name === 'Photo')!;
    const tweaked = {
      ...doc,
      layers: doc.layers.map((l) => (l === base ? { ...l, visible: false, opacity: 0.5, blendMode: 'SCREEN' as const } : l)),
    };
    const plan = planImport(tweaked, DEFAULT_SETTINGS);
    expect(plan.layers.find((l) => l.action === 'clip')).toMatchObject({ visible: false, opacity: 0.5, blendMode: 'SCREEN' });
    expect(plan.layers.find((l) => l.name === 'Photo')).toMatchObject({ visible: true, opacity: 1, blendMode: 'NORMAL' });
    // With hidden layers off, the base and everything clipped to it are dropped.
    const noHidden = planImport(tweaked, { ...DEFAULT_SETTINGS, importHidden: false }).layers.map((l) => l.name);
    expect(noHidden).not.toContain('Grade (clipped)');
    expect(noHidden).not.toContain('Photo');
  });

  it('imports a clipped layer with no base unclipped and reports it', () => {
    const first = doc.layers.find((l) => l.name === 'Background')!;
    const tweaked = { ...doc, layers: doc.layers.map((l) => (l === first ? { ...l, clipped: true } : l)) };
    const plan = planImport(tweaked, DEFAULT_SETTINGS);
    expect(plan.layers[0]).toMatchObject({ name: 'Background', parentId: null });
    expect(plan.report).toContainEqual(expect.objectContaining({ layerName: 'Background', level: 'approximated' }));
  });

  it('rasterizes shapes when "Editable vectors" is off, and reports it', () => {
    const plan = planImport(doc, { ...DEFAULT_SETTINGS, editableVectors: false });
    expect(plan.layers.some((l) => l.action === 'vector')).toBe(false);
    // Live shapes without pixel bounds in the synthetic fixture are skipped as empty.
    expect(plan.report).toContainEqual(expect.objectContaining({ layerName: 'Noise (unsupported)', level: 'approximated' }));
  });

  it('reports unsupported shape fills', () => {
    expect(planImport(doc, DEFAULT_SETTINGS).report).toContainEqual({
      level: 'approximated', layerName: 'Noise (unsupported)', reason: 'Shape imported as pixels: Noise gradients have no Figma equivalent.',
    });
  });

  it('reports skipped shadows when "Rebuild shadows" is off', () => {
    const plan = planImport(doc, { ...DEFAULT_SETTINGS, rebuildShadows: false });
    expect(plan.report).toContainEqual(expect.objectContaining({ layerName: 'Card', level: 'skipped' }));
  });
});
