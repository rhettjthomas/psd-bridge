import { beforeEach, describe, expect, it } from 'vitest';
import { readFrame, translateSvgPath } from '../src/main/figma-reader';
import { installFigmaMock } from './figma-mock';

/** Minimal stand-ins for Figma nodes: only the fields the reader reads. */
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

const rect = (name: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({
  type: 'RECTANGLE', id: `r:${name}`, name, visible: true, opacity: 1, blendMode: 'NORMAL', effects: [],
  absoluteBoundingBox: box(x, y, w, h),
  fillGeometry: [{ windingRule: 'NONZERO', data: `M 0 0 L ${w} 0 L ${w} ${h} Z` }],
  ...extra,
});

const frame = (children: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'FRAME', id: 'f:1', name: 'Series art', visible: true, opacity: 1, blendMode: 'PASS_THROUGH', effects: [],
  absoluteBoundingBox: box(100, 50, 1920, 1080), width: 1920, height: 1080, children,
  ...extra,
}) as never;

const read = (node: unknown) => readFrame(node as never);

describe('readFrame', () => {
  beforeEach(() => installFigmaMock());

  it('measures layers from the frame corner and keeps bottom-first order', () => {
    const { doc, nodeIds } = read(frame([rect('Bottom', 100, 50, 200, 100), rect('Top', 300, 150, 50, 50)]));
    expect(doc).toMatchObject({ name: 'Series art', width: 1920, height: 1080, colorMode: 'RGB' });
    expect(doc.layers.map((l) => l.name)).toEqual(['Bottom', 'Top']);
    expect(doc.layers[0].bounds).toEqual({ left: 0, top: 0, width: 200, height: 100 });
    expect(doc.layers[1].bounds).toEqual({ left: 200, top: 100, width: 50, height: 50 });
    expect(nodeIds).toEqual(['r:Bottom', 'r:Top']);
  });

  it('reads groups, visibility, opacity, and blend modes', () => {
    const group = {
      type: 'GROUP', id: 'g:1', name: 'Hero', visible: false, opacity: 0.5, blendMode: 'MULTIPLY', effects: [],
      absoluteBoundingBox: box(100, 50, 400, 400),
      children: [rect('Photo', 100, 50, 400, 400, { blendMode: 'SOFT_LIGHT' })],
    };
    const { doc } = read(frame([group]));
    expect(doc.layers[0]).toMatchObject({ kind: 'group', visible: false, opacity: 0.5, blendMode: 'MULTIPLY', children: [1] });
    expect(doc.layers[1]).toMatchObject({ name: 'Photo', kind: 'shape', parentId: 0, blendMode: 'SOFT_LIGHT' });
  });

  it('turns Figma masks into clipped layers', () => {
    const { doc, report } = read(frame([
      rect('Mask', 100, 50, 100, 100, { isMask: true, maskType: 'ALPHA' }),
      rect('Masked A', 100, 50, 100, 100),
      rect('Masked B', 100, 50, 100, 100),
    ]));
    expect(doc.layers.map((l) => l.clipped)).toEqual([false, true, true]);
    expect(report).toEqual([]);

    const luminance = read(frame([rect('Mask', 100, 50, 10, 10, { isMask: true, maskType: 'LUMINANCE' })]));
    expect(luminance.report[0].reason).toMatch(/luminance mask/);
  });

  it('reads drop shadows and reports effects Photoshop has no equivalent for', () => {
    const { doc, report } = read(frame([
      rect('Card', 100, 50, 10, 10, {
        effects: [
          { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 2, y: 4 }, radius: 8, spread: 1, blendMode: 'MULTIPLY' },
          { type: 'LAYER_BLUR', visible: true, radius: 4 },
          { type: 'INNER_SHADOW', visible: false, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 0 }, radius: 1, blendMode: 'NORMAL' },
        ],
      }),
    ]));
    expect(doc.layers[0].shadows).toEqual([
      { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 2, y: 4 }, radius: 8, spread: 1, blendMode: 'MULTIPLY' },
    ]);
    expect(report).toEqual([{ level: 'skipped', layerName: 'Card', reason: 'Layer blur has no Photoshop equivalent.' }]);
  });

  it('reads text runs, box kind, and alignment', () => {
    const text = {
      type: 'TEXT', id: 't:1', name: 'Title', visible: true, opacity: 1, blendMode: 'NORMAL', effects: [],
      absoluteBoundingBox: box(140, 90, 600, 120), characters: 'THE WAY HOME',
      textAutoResize: 'HEIGHT', textAlignHorizontal: 'CENTER', textAlignVertical: 'TOP', rotation: 0,
      getStyledTextSegments: () => [{
        start: 0, end: 12, fontName: { family: 'Inter', style: 'Semi Bold' }, fontSize: 96,
        fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
        letterSpacing: { unit: 'PERCENT', value: 5 }, lineHeight: { unit: 'PIXELS', value: 110 },
        textDecoration: 'UNDERLINE', textCase: 'UPPER',
      }],
    };
    const { doc } = read(frame([text]));
    const t = doc.layers[0].text!;
    expect(t).toMatchObject({ content: 'THE WAY HOME', kind: 'box', boxWidth: 600, align: 'CENTER', origin: { x: 40, y: 40 } });
    expect(t.runs[0]).toMatchObject({
      postScriptName: 'Inter-SemiBold', fontSize: 96, tracking: 50, leading: 110,
      underline: true, caps: 'UPPER', color: { r: 1, g: 1, b: 1, a: 1 },
    });
  });

  it('shifts shape geometry into frame space', () => {
    const { doc } = read(frame([rect('Badge', 500, 250, 100, 60)]));
    expect(doc.layers[0].vectorMask!.paths[0]).toEqual({ windingRule: 'NONZERO', data: 'M 400 200 L 500 200 L 500 260 Z' });
  });

  it('skips node types it cannot export', () => {
    const { doc, report } = read(frame([{ type: 'SLICE', id: 's:1', name: 'Slice', visible: true }]));
    expect(doc.layers).toEqual([]);
    expect(report[0].reason).toMatch(/can't be exported/);
  });
});

describe('translateSvgPath', () => {
  it('moves absolute commands and leaves relative ones alone', () => {
    expect(translateSvgPath('M0 0L10 5C1 2 3 4 5 6Z', 100, 50)).toBe('M 100 50 L 110 55 C 101 52 103 54 105 56 Z');
    expect(translateSvgPath('M0 0 H 20 V 30 Z', 5, 7)).toBe('M 5 7 H 25 V 37 Z');
    expect(translateSvgPath('M0 0 l 10 10', 5, 5)).toBe('M 5 5 l 10 10');
  });
});

describe('translateSvgPath arcs', () => {
  it('moves only the arc endpoint, not its radii or flags', () => {
    expect(translateSvgPath('M0 0 A 10 20 30 0 1 40 50', 100, 5)).toBe('M 100 5 A 10 20 30 0 1 140 55');
  });
});
