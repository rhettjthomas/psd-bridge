/**
 * Editable text from IR text. Main thread only.
 *
 * Positioning: Figma exposes no font metrics, so after building the node we compare
 * its rendered glyph bounds with the PSD layer's pixel bounds (also glyph bounds) and
 * shift it to match. Point text aligns by its anchor edge; box text keeps the box's
 * x from the transform and aligns only vertically. Rotated text uses the transform.
 */
import { DEFAULT_FONT, type FontName as IRFontName } from '../core/fonts';
import type { IRText, ReportItem } from '../core/model';
import type { PlannedLayer } from '../core/plan';
import { trackingToPercent } from '../core/units';

export interface LoadedFonts {
  /** PostScript name → loaded font. Unlisted names use DEFAULT_FONT. */
  resolved: Map<string, FontName>;
  report: ReportItem[];
}

export async function loadFonts(choices: Record<string, IRFontName>, skipped: string[]): Promise<LoadedFonts> {
  const report: ReportItem[] = [];
  await figma.loadFontAsync(DEFAULT_FONT);
  const loaded = new Map<string, Promise<boolean>>();
  const load = (f: FontName) => {
    const key = JSON.stringify([f.family, f.style]);
    if (!loaded.has(key)) loaded.set(key, figma.loadFontAsync(f).then(() => true, () => false));
    return loaded.get(key)!;
  };

  const resolved = new Map<string, FontName>();
  await Promise.all(
    Object.entries(choices).map(async ([ps, font]) => {
      if (await load(font)) {
        resolved.set(ps, font);
      } else {
        report.push({ level: 'approximated', layerName: ps, reason: `Couldn't load ${font.family} ${font.style}; used ${DEFAULT_FONT.family}.` });
      }
    }),
  );
  for (const ps of skipped) {
    report.push({ level: 'approximated', layerName: ps, reason: `Font skipped in font matching; text uses ${DEFAULT_FONT.family} ${DEFAULT_FONT.style}.` });
  }
  return { resolved, report };
}

/** Builds a text node inside `parent` at document coordinates. */
export function buildTextNode(
  parent: BaseNode & ChildrenMixin,
  layer: PlannedLayer,
  fonts: Map<string, FontName>,
  frameOrigin: { x: number; y: number },
): TextNode {
  const t = layer.text as IRText;
  const node = figma.createText();
  parent.appendChild(node);
  node.name = layer.name;
  node.fontName = DEFAULT_FONT;
  node.characters = t.content;

  const len = t.content.length;
  for (const run of t.runs) {
    const { start, end } = run;
    if (end <= start || end > len) continue;
    const font = (run.postScriptName && fonts.get(run.postScriptName)) || DEFAULT_FONT;
    node.setRangeFontName(start, end, font);
    if (run.fontSize) node.setRangeFontSize(start, end, Math.max(1, round2(run.fontSize)));
    const c = run.color ?? { r: 0, g: 0, b: 0, a: 1 };
    node.setRangeFills(start, end, [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }]);
    if (run.tracking) node.setRangeLetterSpacing(start, end, { unit: 'PERCENT', value: trackingToPercent(run.tracking) });
    node.setRangeLineHeight(start, end, run.leading ? { unit: 'PIXELS', value: round2(run.leading) } : { unit: 'AUTO' });
    if (run.underline) node.setRangeTextDecoration(start, end, 'UNDERLINE');
    else if (run.strikethrough) node.setRangeTextDecoration(start, end, 'STRIKETHROUGH');
    if (run.caps) node.setRangeTextCase(start, end, run.caps);
  }

  node.textAlignHorizontal = t.align;
  if (t.kind === 'box' && t.boxWidth) {
    node.textAutoResize = 'NONE';
    node.resize(Math.max(1, t.boxWidth), Math.max(1, t.boxHeight ?? node.height));
    node.textAutoResize = 'HEIGHT';
  } else {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  position(node, layer, t, frameOrigin);
  return node;
}

function position(node: TextNode, layer: PlannedLayer, t: IRText, frameOrigin: { x: number; y: number }) {
  const firstSize = t.runs.find((r) => r.fontSize)?.fontSize ?? 12;

  // Start from the transform: box text at its box corner; point text with its first
  // baseline roughly on the anchor (Figma's auto line height puts it near 0.9 em).
  // (lx, ly) is the node's top-left relative to the anchor, in the text's own frame.
  let lx = 0;
  let ly = 0;
  if (t.kind === 'point') {
    ly = -firstSize * 0.9;
    if (t.align === 'CENTER') lx = -node.width / 2;
    else if (t.align === 'RIGHT') lx = -node.width;
  }

  if (t.rotation) {
    // Rotate the offset with the text (clockwise, y down), then rotate the node around its
    // top-left corner. Figma's rotation is counter-clockwise.
    const r = (t.rotation * Math.PI) / 180;
    node.x = t.origin.x + lx * Math.cos(r) - ly * Math.sin(r);
    node.y = t.origin.y + lx * Math.sin(r) + ly * Math.cos(r);
    node.rotation = -t.rotation;
    return;
  }
  node.x = t.origin.x + lx;
  node.y = t.origin.y + ly;

  const ink = node.absoluteRenderBounds;
  const b = layer.bounds;
  if (!ink || b.width <= 0 || b.height <= 0) return;
  const target = { left: frameOrigin.x + b.left, top: frameOrigin.y + b.top, width: b.width, height: b.height };
  const dy = target.top - ink.y;
  let dx = 0;
  if (t.kind === 'point') {
    if (t.align === 'CENTER') dx = target.left + target.width / 2 - (ink.x + ink.width / 2);
    else if (t.align === 'RIGHT') dx = target.left + target.width - (ink.x + ink.width);
    else dx = target.left - ink.x;
  }
  node.x = round2(node.x + dx);
  node.y = round2(node.y + dy);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
