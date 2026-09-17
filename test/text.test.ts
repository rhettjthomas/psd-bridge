import { readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';
import { beforeEach, describe, expect, it } from 'vitest';
import { planImport, type PlannedLayer } from '../src/core/plan';
import { psdToIR } from '../src/core/psd-reader';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { buildTextNode, loadFonts } from '../src/main/text';
import { installFigmaMock, type MockNode } from './figma-mock';

const { doc } = psdToIR(
  readPsd(readFileSync('test/fixtures/sample.psd'), { skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true }),
  'sample.psd',
);
const planned = planImport(doc, DEFAULT_SETTINGS).layers;
const layer = (name: string) => planned.find((l) => l.name === name)!;

describe('loadFonts', () => {
  beforeEach(() => installFigmaMock());

  it('loads chosen fonts and reports ones that fail or were skipped', async () => {
    const { resolved, report } = await loadFonts(
      { 'Inter-Bold': { family: 'Inter', style: 'Bold' }, 'Gone-Bold': { family: 'Gone', style: 'Bold' } },
      ['Skipped-Font'],
    );
    expect([...resolved.keys()]).toEqual(['Inter-Bold']);
    expect(report.map((r) => r.layerName).sort()).toEqual(['Gone-Bold', 'Skipped-Font']);
  });
});

describe('buildTextNode', () => {
  let figma: ReturnType<typeof installFigmaMock>;
  let parent: MockNode;
  beforeEach(async () => {
    figma = installFigmaMock();
    parent = figma.createFrame();
    parent.x = 1000;
    parent.y = 500;
  });

  const build = async (l: PlannedLayer, fonts: Record<string, { family: string; style: string }> = {}) => {
    const { resolved } = await loadFonts(fonts, []);
    return buildTextNode(parent as any, l, resolved, { x: 1000, y: 500 }) as unknown as MockNode;
  };

  it('applies style runs: fonts, sizes, tracking, leading, caps, underline, color', async () => {
    const node = await build(layer('Series title (runs)'), { 'Inter-Bold': { family: 'Inter', style: 'Bold' } });
    expect(node.characters).toBe('Grace\nUpon Grace');
    expect(node.textAlignHorizontal).toBe('CENTER');
    expect(node.textAutoResize).toBe('WIDTH_AND_HEIGHT');
    const r = node.ranges;
    expect(r).toContainEqual({ start: 0, end: 6, fontName: { family: 'Inter', style: 'Bold' } });
    // The unmatched font falls back to the default rather than failing.
    expect(r).toContainEqual({ start: 6, end: 16, fontName: { family: 'Inter', style: 'Regular' } });
    expect(r).toContainEqual({ start: 0, end: 6, fontSize: 80 });
    expect(r).toContainEqual({ start: 0, end: 6, letterSpacing: { unit: 'PERCENT', value: 10 } });
    expect(r).toContainEqual({ start: 0, end: 6, lineHeight: { unit: 'AUTO' } });
    expect(r).toContainEqual({ start: 6, end: 16, lineHeight: { unit: 'PIXELS', value: 72 } });
    expect(r).toContainEqual({ start: 0, end: 6, textCase: 'UPPER' });
    expect(r).toContainEqual({ start: 6, end: 16, textDecoration: 'UNDERLINE' });
    expect(r).toContainEqual({
      start: 6, end: 16,
      fills: [{ type: 'SOLID', color: { r: expect.closeTo(0.776, 2), g: expect.closeTo(0.957, 2), b: expect.closeTo(0.196, 2) }, opacity: 1 }],
    });
  });

  it('sizes box text to the box with a fixed width', async () => {
    const node = await build(layer('Body (box)'), { ArialMT: { family: 'Arial', style: 'Regular' } });
    expect([node.width, node.height, node.textAutoResize]).toEqual([400, 120, 'HEIGHT']);
    expect([node.x, node.y]).toEqual([1300, 700]);
  });

  it('aligns rendered glyphs with the PSD pixel bounds', async () => {
    const withInk = { ...layer('Body (box)'), bounds: { left: 1302, top: 705, width: 380, height: 20 } };
    const node = await build(withInk);
    const ink = node.absoluteRenderBounds!;
    // Box text keeps its x from the transform and aligns vertically.
    expect(node.x).toBe(1300);
    expect(ink.y).toBe(500 + 705);

    const point = { ...layer('Title'), bounds: { left: 240, top: 820, width: 600, height: 70 } };
    const p = await build(point, { 'Inter-Bold': { family: 'Inter', style: 'Bold' } });
    const pInk = p.absoluteRenderBounds!;
    expect([pInk.x, pInk.y]).toEqual([1000 + 240, 500 + 820]);
  });

  it('aligns centered point text by its center', async () => {
    const l = { ...layer('Series title (runs)'), bounds: { left: 900, top: 40, width: 120, height: 150 } };
    const node = await build(l);
    const ink = node.absoluteRenderBounds!;
    expect(ink.x + ink.width / 2).toBe(1000 + 960);
  });

  it('rotates text and places it from the transform', async () => {
    const node = await build(layer('Side note (rotated)'));
    expect(node.rotation).toBe(90);
    // Anchor (60, 900); the top-left sits 0.9 em "above" the baseline in the text's rotated frame.
    expect(node.x).toBeCloseTo(60 - 18 * 0.9);
    expect(node.y).toBeCloseTo(900);
  });
});
