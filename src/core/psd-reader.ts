/**
 * ag-psd `Psd` → IR. Runs in the UI iframe (ag-psd needs the browser canvas).
 * Only reads data; pixel encoding happens separately so this stays unit-testable.
 */
import type { Color, Layer, LayerEffectShadow, LayerTextData, Psd } from 'ag-psd';
import { mapBlendMode } from './blend';
import type { Bounds, IRDocument, IRLayer, IRShadow, IRText, IRTextRun, LayerKind, ReportItem, RGBA } from './model';
import { combineOpacity, shadowBlurAndSpread, shadowOffset, transformScale } from './units';

// ag-psd's ColorMode is a const enum, which isolated builds can't import.
const COLOR_MODE_GRAYSCALE = 1;
const COLOR_MODE_RGB = 3;
const COLOR_MODE_CMYK = 4;

const UNSUPPORTED_EFFECTS = [
  ['outerGlow', 'Outer glow'],
  ['innerGlow', 'Inner glow'],
  ['bevel', 'Bevel & emboss'],
  ['satin', 'Satin'],
  ['solidFill', 'Color overlay'],
  ['gradientOverlay', 'Gradient overlay'],
  ['patternOverlay', 'Pattern overlay'],
  ['stroke', 'Stroke'],
] as const;

export interface ReadResult {
  doc: IRDocument;
  report: ReportItem[];
  /** Source ag-psd layers indexed by IR id, for decoding pixels later. */
  sources: Layer[];
}

export function psdToIR(psd: Psd, fileName: string): ReadResult {
  const layers: IRLayer[] = [];
  const report: ReportItem[] = [];
  const sources: Layer[] = [];
  const globalAngle = psd.imageResources?.globalAngle ?? 120;
  const docName = fileName.replace(/\.psd$/i, '');

  const colorMode =
    psd.colorMode === COLOR_MODE_RGB ? 'RGB'
    : psd.colorMode === COLOR_MODE_CMYK ? 'CMYK'
    : psd.colorMode === COLOR_MODE_GRAYSCALE ? 'Grayscale'
    : psd.colorMode === undefined ? 'RGB'
    : 'Other';
  const bitsPerChannel = psd.bitsPerChannel ?? 8;
  if (colorMode !== 'RGB') {
    report.push({ level: 'approximated', layerName: docName, reason: `${colorMode} document; colors may shift. Convert to RGB in Photoshop.` });
  }
  if (bitsPerChannel !== 8) {
    report.push({ level: 'approximated', layerName: docName, reason: `${bitsPerChannel}-bit document; convert to 8-bit in Photoshop for accurate color.` });
  }

  const visit = (src: Layer, parentId: number | null): number => {
    const id = layers.length;
    const kind = layerKind(src);
    const name = src.name || `Layer ${id + 1}`;
    const blend = mapBlendMode(src.blendMode, kind === 'group');
    if (blend.fallback) {
      report.push({ level: 'approximated', layerName: name, reason: `Blend mode "${src.blendMode}" has no Figma equivalent; using Normal.` });
    }

    const layer: IRLayer = {
      id,
      parentId,
      name,
      kind,
      bounds: layerBounds(src),
      visible: !src.hidden,
      opacity: combineOpacity(src.opacity, src.fillOpacity),
      blendMode: blend.mode,
      sourceBlendMode: blend.fallback ? src.blendMode : undefined,
      clipped: !!src.clipping,
      hasVectorMask: !!src.vectorMask && kind !== 'shape',
      shadows: [],
      unsupportedEffects: [],
    };
    layers.push(layer);
    sources.push(src);

    if (src.mask && !src.mask.fromVectorData) {
      const m = src.mask;
      layer.mask = {
        bounds: edgesToBounds(m.left, m.top, m.right, m.bottom),
        disabled: m.disabled,
      };
    }

    const fx = src.effects;
    if (fx && !fx.disabled) {
      const shadows = [
        ...(fx.dropShadow ?? []).map((s) => toShadow(s, 'DROP_SHADOW', globalAngle)),
        ...(fx.innerShadow ?? []).map((s) => toShadow(s, 'INNER_SHADOW', globalAngle)),
      ];
      layer.shadows = shadows.filter((s): s is IRShadow => s !== null);
      for (const [key, label] of UNSUPPORTED_EFFECTS) {
        const e = fx[key];
        const list = Array.isArray(e) ? e : e ? [e] : [];
        if (list.some((x) => x.enabled !== false && x.present !== false)) layer.unsupportedEffects.push(label);
      }
      if (layer.unsupportedEffects.length) {
        report.push({ level: 'skipped', layerName: name, reason: `Layer styles not imported: ${layer.unsupportedEffects.join(', ')}.` });
      }
    }

    switch (kind) {
      case 'group':
        layer.children = (src.children ?? []).map((c) => visit(c, id));
        break;
      case 'adjustment':
        report.push({ level: 'skipped', layerName: name, reason: 'Adjustment layers are not imported; merge them during PSD prep.' });
        break;
      case 'smartObject':
        layer.image = { width: layer.bounds.width, height: layer.bounds.height };
        report.push({ level: 'approximated', layerName: name, reason: 'Smart object imported as a flat image.' });
        break;
      case 'text':
        layer.text = readText(src.text!);
        if (layer.text.warped) {
          report.push({ level: 'approximated', layerName: name, reason: 'Warped or on-path text imported as pixels.' });
        }
        break;
      case 'pixel':
      case 'shape':
        layer.image = { width: layer.bounds.width, height: layer.bounds.height };
        break;
    }

    if (kind === 'pixel' && (layer.bounds.width <= 0 || layer.bounds.height <= 0)) {
      report.push({ level: 'skipped', layerName: name, reason: 'Empty layer (no pixels).' });
    }
    return id;
  };

  const rootIds = (psd.children ?? []).map((c) => visit(c, null));

  return {
    doc: { name: docName, width: psd.width, height: psd.height, colorMode, bitsPerChannel, rootIds, layers },
    report,
    sources,
  };
}

export function layerKind(l: Layer): LayerKind {
  if (l.children !== undefined) return 'group';
  if (l.adjustment) return 'adjustment';
  if (l.text) return 'text';
  if (l.placedLayer) return 'smartObject';
  if (l.vectorFill || (l.vectorMask && l.vectorStroke)) return 'shape';
  return 'pixel';
}

function layerBounds(l: Layer): Bounds {
  return edgesToBounds(l.left, l.top, l.right, l.bottom);
}

function edgesToBounds(left = 0, top = 0, right = left, bottom = top): Bounds {
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function toShadow(s: LayerEffectShadow, type: IRShadow['type'], globalAngle: number): IRShadow | null {
  if (s.enabled === false || s.present === false) return null;
  const angle = s.useGlobalLight ? globalAngle : s.angle ?? globalAngle;
  const size = s.size?.value ?? 0;
  const { radius, spread } = shadowBlurAndSpread(size, s.choke?.value ?? 0);
  const color = toRGBA(s.color);
  color.a *= s.opacity ?? 1;
  return {
    type,
    color,
    offset: shadowOffset(angle, s.distance?.value ?? 0),
    radius,
    spread,
    blendMode: mapBlendMode(s.blendMode, false).mode,
  };
}

export function toRGBA(c: Color | undefined): RGBA {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  if ('fr' in c) return { r: c.fr, g: c.fg, b: c.fb, a: 1 };
  if ('r' in c) return { r: c.r / 255, g: c.g / 255, b: c.b / 255, a: 'a' in c ? c.a : 1 };
  if ('k' in c && !('c' in c)) {
    const v = 1 - c.k / 255;
    return { r: v, g: v, b: v, a: 1 };
  }
  // HSB / CMYK / LAB: not expected after RGB prep. Fall back to black; the doc-level report covers it.
  return { r: 0, g: 0, b: 0, a: 1 };
}

function readText(t: LayerTextData): IRText {
  const scale = transformScale(t.transform);
  const base = t.style ?? {};
  const runs: IRTextRun[] = [];
  let pos = 0;
  const styleRuns = t.styleRuns?.length ? t.styleRuns : [{ length: t.text.length, style: base }];
  for (const r of styleRuns) {
    const st = { ...base, ...r.style };
    runs.push({
      start: pos,
      end: Math.min(t.text.length, pos + r.length),
      postScriptName: st.font?.name,
      fontSize: st.fontSize !== undefined ? st.fontSize * scale : undefined,
      color: st.fillColor ? toRGBA(st.fillColor) : undefined,
      tracking: st.tracking,
      leading: st.autoLeading === false && st.leading !== undefined ? st.leading * scale : undefined,
    });
    pos += r.length;
  }

  const just = t.paragraphStyle?.justification ?? t.paragraphStyleRuns?.[0]?.style.justification ?? 'left';
  const align = just === 'center' ? 'CENTER' : just === 'right' ? 'RIGHT' : just.startsWith('justify') ? 'JUSTIFIED' : 'LEFT';
  const kind = t.shapeType === 'box' ? 'box' : 'point';
  const box = t.boxBounds;
  const warped = (!!t.warp?.style && t.warp.style !== 'none') || !!t.textPath;

  return {
    // Photoshop uses \r for line breaks.
    content: t.text.replace(/\r/g, '\n'),
    kind,
    boxWidth: kind === 'box' && box ? (box[2] - box[0]) * scale : undefined,
    boxHeight: kind === 'box' && box ? (box[3] - box[1]) * scale : undefined,
    scale,
    align,
    runs,
    warped,
  };
}

/** Plain-text tree for logs and the inspect CLI. Top layer printed first, like Photoshop. */
export function formatTree(doc: IRDocument): string {
  const lines = [`${doc.name}  ${doc.width}×${doc.height}  ${doc.colorMode} ${doc.bitsPerChannel}-bit  (${doc.layers.length} layers)`];
  const walk = (ids: number[], depth: number) => {
    for (const id of [...ids].reverse()) {
      const l = doc.layers[id];
      const flags = [
        l.visible ? '' : 'hidden',
        l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : '',
        l.blendMode !== 'NORMAL' && l.blendMode !== 'PASS_THROUGH' ? l.blendMode.toLowerCase() : '',
        l.clipped ? 'clipped' : '',
        l.mask ? 'mask' : '',
        l.hasVectorMask ? 'vmask' : '',
        l.shadows.length ? `${l.shadows.length} shadow` : '',
      ].filter(Boolean);
      const b = l.bounds;
      lines.push(
        `${'  '.repeat(depth + 1)}${kindIcon(l.kind)} ${l.name}  [${b.left},${b.top} ${b.width}×${b.height}]${flags.length ? '  ' + flags.join(' ') : ''}`,
      );
      if (l.children) walk(l.children, depth + 1);
    }
  };
  walk(doc.rootIds, 0);
  return lines.join('\n');
}

function kindIcon(k: LayerKind): string {
  return { group: '▾', pixel: '▪', shape: '◆', text: 'T', smartObject: '◫', adjustment: '◐' }[k];
}
