/**
 * ag-psd `Psd` → IR. Runs in the UI iframe (ag-psd needs the browser canvas).
 * Only reads data; pixel encoding happens separately so this stays unit-testable.
 */
import type { Color, Layer, LayerEffectShadow, LayerTextData, Psd } from 'ag-psd';
import { mapBlendMode } from './blend';
import { toRGBA } from './color';
import { convertPaths } from './paths';
import { readShape } from './shapes';
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

export { toRGBA };

export function psdToIR(psd: Psd, fileName: string): ReadResult {
  const layers: IRLayer[] = [];
  const report: ReportItem[] = [];
  const sources: Layer[] = [];
  const globalAngle = psd.imageResources?.globalAngle ?? 120;
  const docName = fileName.replace(/\.ps[db]$/i, '');

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
      shadows: [],
      unsupportedEffects: [],
    };
    layers.push(layer);
    sources.push(src);

    readMasks(src, layer, psd, report);

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

    if (src.artboard && kind === 'group') {
      const r = src.artboard.rect;
      layer.artboard = {
        bounds: edgesToBounds(r.left, r.top, r.right, r.bottom),
        background: artboardBackground(src.artboard.backgroundType, src.artboard.color),
      };
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
        } else if (layer.text.vertical) {
          report.push({ level: 'approximated', layerName: name, reason: 'Vertical text imported as pixels.' });
        }
        break;
      case 'shape':
        layer.shape = readShape(src, psd);
        layer.image = { width: layer.bounds.width, height: layer.bounds.height };
        break;
      case 'pixel':
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

function readMasks(src: Layer, layer: IRLayer, psd: Psd, report: ReportItem[]) {
  // With both mask types, ag-psd puts the vector-derived raster in `mask` and the user's pixel mask in `realMask`.
  const fromVector = !!src.mask?.fromVectorData;
  const pixelMask = fromVector ? src.realMask : src.mask;
  const source = fromVector ? 'realMask' : 'mask';
  if (pixelMask) {
    const bounds = edgesToBounds(pixelMask.left, pixelMask.top, pixelMask.right, pixelMask.bottom);
    if (pixelMask.disabled) {
      report.push({ level: 'skipped', layerName: layer.name, reason: 'Disabled layer mask was not imported.' });
    } else if ((bounds.width > 0 && bounds.height > 0) || pixelMask.defaultColor) {
      layer.mask = { bounds, defaultColor: pixelMask.defaultColor ?? 0, source };
      if (pixelMask.userMaskFeather) {
        report.push({ level: 'approximated', layerName: layer.name, reason: 'Layer mask feather was not applied.' });
      }
      if (pixelMask.userMaskDensity !== undefined && pixelMask.userMaskDensity < 1) {
        report.push({ level: 'approximated', layerName: layer.name, reason: 'Layer mask density was imported at 100%.' });
      }
    } else {
      // An empty mask with a black default hides the whole layer.
      layer.visible = false;
      report.push({ level: 'approximated', layerName: layer.name, reason: 'Layer mask hides everything; imported hidden.' });
    }
  }

  const vm = src.vectorMask;
  if (vm && layer.kind !== 'shape') {
    if (vm.disable) {
      report.push({ level: 'skipped', layerName: layer.name, reason: 'Disabled vector mask was not imported.' });
      return;
    }
    const invertFrom = vm.fillStartsWithAllPixels ? { left: 0, top: 0, width: psd.width, height: psd.height } : undefined;
    const vec = convertPaths(vm.paths ?? [], { invertFrom });
    if (vec) {
      layer.vectorMask = vec;
      if (vec.warning) report.push({ level: 'approximated', layerName: layer.name, reason: `Vector mask: ${vec.warning}` });
    }
  }
}

// Photoshop artboardBackgroundType values.
const ARTBOARD_WHITE = 1;
const ARTBOARD_BLACK = 2;
const ARTBOARD_TRANSPARENT = 3;

export function artboardBackground(type: number | undefined, color: Color | undefined): RGBA | null {
  switch (type ?? ARTBOARD_WHITE) {
    case ARTBOARD_WHITE:
      return { r: 1, g: 1, b: 1, a: 1 };
    case ARTBOARD_BLACK:
      return { r: 0, g: 0, b: 0, a: 1 };
    case ARTBOARD_TRANSPARENT:
      return null;
    default:
      return color ? toRGBA(color) : { r: 1, g: 1, b: 1, a: 1 };
  }
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

function readText(t: LayerTextData): IRText {
  const tf = t.transform ?? [1, 0, 0, 1, 0, 0];
  const scale = transformScale(tf);
  const hScale = Math.hypot(tf[0], tf[1]);
  const rotation = (Math.atan2(tf[1], tf[0]) * 180) / Math.PI;
  const warnings = new Set<string>();
  if (Math.abs(hScale - scale) > 1e-3 * scale) warnings.add('Text was scaled unevenly; imported at its vertical scale.');

  // ag-psd already turns paragraph breaks into \n; \u0003 is Photoshop's soft line break.
  const content = t.text.replace(/\u0003/g, '\u2028');
  const base = t.style ?? {};
  const runs: IRTextRun[] = [];
  let pos = 0;
  const styleRuns = t.styleRuns?.length ? t.styleRuns : [{ length: content.length, style: base }];
  for (const r of styleRuns) {
    const st = { ...base, ...r.style };
    const start = Math.min(content.length, pos);
    const end = Math.min(content.length, pos + r.length);
    pos += r.length;
    if (end <= start) continue;
    if (st.fauxBold || st.fauxItalic) warnings.add('Faux bold/italic has no Figma equivalent.');
    if ((st.horizontalScale ?? 1) !== 1 || (st.verticalScale ?? 1) !== 1) warnings.add('Character scaling was not applied.');
    if (st.baselineShift) warnings.add('Baseline shift was not applied.');
    if (st.fontBaseline) warnings.add('Superscript/subscript was not applied.');
    if (st.strokeFlag) warnings.add('Text stroke was not applied.');
    runs.push({
      start,
      end,
      postScriptName: st.font?.name,
      fontSize: st.fontSize !== undefined ? st.fontSize * scale : undefined,
      color: st.fillColor ? toRGBA(st.fillColor) : undefined,
      tracking: st.tracking,
      leading: st.autoLeading === false && st.leading !== undefined ? st.leading * scale : undefined,
      underline: st.underline || undefined,
      strikethrough: st.strikethrough || undefined,
      caps: st.fontCaps === 2 ? 'UPPER' : st.fontCaps === 1 ? 'SMALL_CAPS' : undefined,
    });
  }

  const justs = [t.paragraphStyle?.justification, ...(t.paragraphStyleRuns ?? []).map((r) => r.style.justification)].filter(
    (j): j is NonNullable<typeof j> => !!j,
  );
  const just = t.paragraphStyleRuns?.[0]?.style.justification ?? t.paragraphStyle?.justification ?? 'left';
  if (new Set(justs.map(alignOf)).size > 1) warnings.add('Mixed paragraph alignment; the first paragraph\'s alignment was used.');
  const align = alignOf(just);

  const kind = t.shapeType === 'box' ? 'box' : 'point';
  const box = t.boxBounds;
  const apply = (x: number, y: number) => ({ x: tf[0] * x + tf[2] * y + tf[4], y: tf[1] * x + tf[3] * y + tf[5] });
  const origin = kind === 'box' && box ? apply(box[0], box[1]) : apply(0, 0);
  const warped = (!!t.warp?.style && t.warp.style !== 'none') || !!t.textPath;

  return {
    content,
    kind,
    boxWidth: kind === 'box' && box ? (box[2] - box[0]) * hScale : undefined,
    boxHeight: kind === 'box' && box ? (box[3] - box[1]) * scale : undefined,
    origin,
    scale,
    rotation: Math.abs(rotation) < 0.01 ? 0 : rotation,
    align,
    runs,
    warped,
    vertical: t.orientation === 'vertical',
    warnings: [...warnings],
  };
}

function alignOf(j: string): IRText['align'] {
  return j === 'center' ? 'CENTER' : j === 'right' ? 'RIGHT' : j.startsWith('justify') ? 'JUSTIFIED' : 'LEFT';
}

/** Plain-text tree for logs and the inspect CLI. Top layer printed first, like Photoshop. */
export function formatTree(doc: IRDocument): string {
  const lines = [`${doc.name}  ${doc.width}×${doc.height}  ${doc.colorMode} ${doc.bitsPerChannel}-bit  (${doc.layers.length} layers)`];
  const walk = (ids: number[], depth: number) => {
    for (const id of [...ids].reverse()) {
      const l = doc.layers[id];
      const flags = [
        l.artboard ? 'artboard' : '',
        l.visible ? '' : 'hidden',
        l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : '',
        l.blendMode !== 'NORMAL' && l.blendMode !== 'PASS_THROUGH' ? l.blendMode.toLowerCase() : '',
        l.clipped ? 'clipped' : '',
        l.mask ? 'mask' : '',
        l.vectorMask ? 'vmask' : '',
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
