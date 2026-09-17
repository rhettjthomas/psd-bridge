import { readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { psdToIR, toRGBA } from '../src/core/psd-reader';

const psd = readPsd(readFileSync('test/fixtures/sample.psd'), {
  skipThumbnail: true,
  skipCompositeImageData: true,
  skipLayerImageData: true,
});
const { doc, report } = psdToIR(psd, 'sample.psd');
const byName = (name: string) => doc.layers.find((l) => l.name === name)!;

describe('psdToIR (fixture)', () => {
  it('reads document info', () => {
    expect(doc).toMatchObject({ name: 'sample', width: 1920, height: 1080, colorMode: 'RGB', bitsPerChannel: 8 });
  });

  it('keeps stacking order bottom-first and positions from PSD offsets', () => {
    expect(doc.rootIds.map((id) => doc.layers[id].name)[0]).toBe('Background');
    const hero = byName('Hero');
    expect(hero.kind).toBe('group');
    expect(hero.children!.map((id) => doc.layers[id].name)).toEqual([
      'Photo', 'Grade (clipped)', 'Vignette (masked)', 'Glow (unsupported)',
    ]);
    expect(byName('Photo').bounds).toEqual({ left: 200, top: 150, width: 800, height: 600 });
    expect(byName('Photo').parentId).toBe(hero.id);
  });

  it('carries visibility, opacity, blend, clipping, and masks', () => {
    expect(byName('Source photo (hidden)').visible).toBe(false);
    expect(byName('Texture')).toMatchObject({ blendMode: 'OVERLAY' });
    expect(byName('Texture').opacity).toBeCloseTo(0.6, 2);
    expect(byName('Grade (clipped)')).toMatchObject({ clipped: true, blendMode: 'SOFT_LIGHT' });
    expect(byName('Vignette (masked)').mask).toEqual({
      bounds: { left: 100, top: 100, width: 300, height: 200 }, defaultColor: 0, source: 'mask',
    });
    expect(byName('Frame (masked group)').mask).toMatchObject({ defaultColor: 255 });
    expect(byName('Glow (unsupported)')).toMatchObject({ blendMode: 'NORMAL', sourceBlendMode: 'vivid light' });
  });

  it('reads vector masks as even-odd paths with holes', () => {
    const vm = byName('Badge (vector mask)').vectorMask!;
    expect(vm.paths).toHaveLength(1);
    expect(vm.paths[0].windingRule).toBe('EVENODD');
    expect(vm.paths[0].data.match(/M /g)).toHaveLength(2);
    expect(vm.bounds.left).toBeCloseTo(1500);
    expect(vm.bounds.width).toBeCloseTo(300);
  });

  it('reads text and shadows', () => {
    const title = byName('Title');
    expect(title.kind).toBe('text');
    expect(title.text).toMatchObject({ content: 'THE WAY HOME', kind: 'point', warped: false });
    expect(title.text!.runs[0]).toMatchObject({ postScriptName: 'Inter-Bold', fontSize: 96, tracking: 50 });
    expect(title.shadows).toHaveLength(1);
    expect(title.shadows[0]).toMatchObject({ type: 'DROP_SHADOW', offset: { x: 5, y: 8.66 }, radius: 20 });
    expect(title.shadows[0].color.a).toBeCloseTo(0.5, 2);
  });

  it('reports what it cannot translate', () => {
    const reasons = report.map((r) => `${r.level}:${r.layerName}`);
    expect(reasons).toEqual(expect.arrayContaining([
      'approximated:Glow (unsupported)',
      'skipped:Title',
      'skipped:Curves',
      'skipped:Empty layer',
    ]));
  });
});

describe('toRGBA', () => {
  it('handles 0–255 RGB and 0–1 FRGB', () => {
    expect(toRGBA({ r: 255, g: 0, b: 51 })).toEqual({ r: 1, g: 0, b: 0.2, a: 1 });
    expect(toRGBA({ fr: 0.5, fg: 0.5, fb: 0.5 })).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });
});
