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
      'raster:Photo',
      'raster:Grade (clipped)',
      'raster:Vignette (masked)',
      'raster:Glow (unsupported)',
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

  it('reparents children to the frame when flattening groups', () => {
    const plan = planImport(doc, { ...DEFAULT_SETTINGS, flattenGroups: true });
    expect(plan.layers.some((l) => l.action === 'group')).toBe(false);
    expect(plan.layers.find((l) => l.name === 'Photo')!.parentId).toBeNull();
  });

  it('keeps children under their group otherwise', () => {
    const plan = planImport(doc, DEFAULT_SETTINGS);
    const hero = plan.layers.find((l) => l.name === 'Hero')!;
    expect(plan.layers.find((l) => l.name === 'Photo')!.parentId).toBe(hero.id);
  });
});
