/**
 * Figma nodes → the intermediate layer model. Main thread only.
 *
 * The mirror image of `src/core/psd-reader.ts`: v1 reads PSD → IR, v2 reads Figma → IR,
 * and the writers build from the same model. Everything is measured in document pixels
 * relative to the exported frame's top-left corner, which is what PSD uses.
 *
 * This pass reads structure and properties. Pixels (M2) and paints (M3) come later.
 */
import type { Bounds, IRDocument, IRLayer, IRShadow, IRText, IRTextRun, LayerKind, ReportItem, RGBA } from '../core/model';
import type { IRPath, IRVector } from '../core/paths';
import { combineOpacity } from '../core/units';

/** Figma node types that become editable shapes. */
const SHAPE_TYPES = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'VECTOR', 'BOOLEAN_OPERATION'];
/** Node types that hold children and become groups. */
const CONTAINER_TYPES = ['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'];

export interface FrameReadResult {
  doc: IRDocument;
  report: ReportItem[];
  /** Figma node id for each IR layer, so the exporter can fetch pixels later. */
  nodeIds: string[];
}

export function readFrame(frame: FrameNode | ComponentNode | InstanceNode | GroupNode): FrameReadResult {
  const layers: IRLayer[] = [];
  const report: ReportItem[] = [];
  const nodeIds: string[] = [];
  const box = frame.absoluteBoundingBox;
  const origin = { x: box?.x ?? 0, y: box?.y ?? 0 };
  const width = Math.max(1, Math.round(box?.width ?? frame.width));
  const height = Math.max(1, Math.round(box?.height ?? frame.height));

  const visit = (node: SceneNode, parentId: number | null): number | null => {
    const kind = layerKindOf(node);
    if (!kind) {
      report.push({ level: 'skipped', layerName: node.name, reason: `${friendlyType(node.type)} layers can't be exported.` });
      return null;
    }

    const id = layers.length;
    const layer: IRLayer = {
      id,
      parentId,
      name: node.name,
      kind,
      bounds: boundsOf(node, origin),
      visible: node.visible,
      opacity: 'opacity' in node ? combineOpacity(node.opacity) : 1,
      blendMode: blendOf(node, kind === 'group'),
      clipped: false,
      shadows: shadowsOf(node, report),
      unsupportedEffects: [],
    };
    layers.push(layer);
    nodeIds.push(node.id);

    if (kind === 'text' && node.type === 'TEXT') layer.text = readText(node, origin, report);
    if (kind === 'shape') layer.vectorMask = geometryOf(node, origin) ?? undefined;

    if (kind === 'group' && 'children' in node) {
      // Figma lists children bottom-first, the same order the model uses.
      const children: number[] = [];
      for (const child of node.children) {
        const childId = visit(child, id);
        if (childId !== null) children.push(childId);
      }
      layer.children = children;
      // A mask node masks the siblings above it; the model marks the masked layers instead.
      applyMasks(node.children, children, layers, report);
    }
    return id;
  };

  const rootIds: number[] = [];
  for (const child of 'children' in frame ? frame.children : []) {
    const id = visit(child, null);
    if (id !== null) rootIds.push(id);
  }
  applyMasks('children' in frame ? frame.children : [], rootIds, layers, report);

  return {
    doc: { name: frame.name, width, height, colorMode: 'RGB', bitsPerChannel: 8, rootIds, layers },
    report,
    nodeIds,
  };
}

export function layerKindOf(node: SceneNode): LayerKind | null {
  if (node.type === 'TEXT') return 'text';
  if (SHAPE_TYPES.indexOf(node.type) >= 0) return 'shape';
  if (CONTAINER_TYPES.indexOf(node.type) >= 0) return 'group';
  if (node.type === 'SLICE') return null;
  // Stamps, widgets, embeds, connectors and the like: export what they look like.
  return 'pixel';
}

function friendlyType(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');
}

/** Bounds in document space, relative to the exported frame's top-left. */
function boundsOf(node: SceneNode, origin: { x: number; y: number }): Bounds {
  const box = node.absoluteBoundingBox;
  if (!box) return { left: 0, top: 0, width: 0, height: 0 };
  return {
    left: Math.round(box.x - origin.x),
    top: Math.round(box.y - origin.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

function blendOf(node: SceneNode, isGroup: boolean): IRLayer['blendMode'] {
  const mode = 'blendMode' in node ? node.blendMode : 'NORMAL';
  if (mode === 'PASS_THROUGH') return isGroup ? 'PASS_THROUGH' : 'NORMAL';
  // Figma's set is the same list the model uses.
  return mode as IRLayer['blendMode'];
}

/**
 * Figma masks the siblings above a mask node; the model marks each masked layer as
 * clipped to the one below, which is how Photoshop expresses it.
 */
function applyMasks(nodes: readonly SceneNode[], ids: number[], layers: IRLayer[], report: ReportItem[]) {
  let masking = false;
  nodes.forEach((node, i) => {
    const id = ids[i];
    if (id === undefined) return;
    const isMask = 'isMask' in node && node.isMask;
    if (isMask) {
      masking = true;
      const type = 'maskType' in node ? node.maskType : 'ALPHA';
      if (type !== 'ALPHA') {
        report.push({ level: 'approximated', layerName: node.name, reason: `${type.toLowerCase()} mask exported as an alpha mask.` });
      }
      return;
    }
    if (masking) layers[id].clipped = true;
  });
}

function shadowsOf(node: SceneNode, report: ReportItem[]): IRShadow[] {
  if (!('effects' in node)) return [];
  const shadows: IRShadow[] = [];
  for (const effect of node.effects) {
    if (!effect.visible) continue;
    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      shadows.push({
        type: effect.type,
        color: effect.color as RGBA,
        offset: { x: effect.offset.x, y: effect.offset.y },
        radius: effect.radius,
        spread: effect.spread ?? 0,
        blendMode: effect.blendMode as IRShadow['blendMode'],
      });
    } else {
      report.push({ level: 'skipped', layerName: node.name, reason: `${friendlyType(effect.type)} has no Photoshop equivalent.` });
    }
  }
  return shadows;
}

/** Outline geometry in document space. Figma bakes corner radii and smoothing into it. */
function geometryOf(node: SceneNode, origin: { x: number; y: number }): IRVector | null {
  if (!('fillGeometry' in node)) return null;
  const box = node.absoluteBoundingBox;
  if (!box) return null;
  const dx = box.x - origin.x;
  const dy = box.y - origin.y;
  const paths: IRPath[] = node.fillGeometry.map((p) => ({
    windingRule: p.windingRule === 'EVENODD' ? 'EVENODD' : 'NONZERO',
    data: translateSvgPath(p.data, dx, dy),
  }));
  if (!paths.length) return null;
  return { paths, bounds: boundsOf(node, origin) };
}

/**
 * Shifts an SVG path's coordinates. Figma emits absolute M/L/C/Q/Z commands in node
 * space, so only the absolute commands' coordinate pairs need moving.
 */
export function translateSvgPath(data: string, dx: number, dy: number): string {
  return data.replace(/([MLCQSTAHVZmlcqstahvz])([^MLCQSTAHVZmlcqstahvz]*)/g, (_, cmd: string, args: string) => {
    if (cmd === 'Z' || cmd === 'z') return ` ${cmd} `;
    const nums = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === 'H') return ` H ${nums.map((n) => round(n + dx)).join(' ')} `;
    if (cmd === 'V') return ` V ${nums.map((n) => round(n + dy)).join(' ')} `;
    if (cmd !== cmd.toUpperCase()) return ` ${cmd} ${nums.map(round).join(' ')} `; // relative: unchanged
    if (cmd === 'A') {
      // Arc: rx ry rotation large-arc sweep x y — only the last pair is a point.
      const out = nums.map((n, i) => (i % 7 === 5 ? n + dx : i % 7 === 6 ? n + dy : n));
      return ` A ${out.map(round).join(' ')} `;
    }
    const moved = nums.map((n, i) => (i % 2 === 0 ? n + dx : n + dy));
    return ` ${cmd} ${moved.map(round).join(' ')} `;
  }).replace(/\s+/g, ' ').trim();
}

function round(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

function readText(node: TextNode, origin: { x: number; y: number }, report: ReportItem[]): IRText {
  const bounds = boundsOf(node, origin);
  const segments = node.getStyledTextSegments([
    'fontName',
    'fontSize',
    'fills',
    'letterSpacing',
    'lineHeight',
    'textDecoration',
    'textCase',
  ]);
  const runs: IRTextRun[] = segments.map((seg) => ({
    start: seg.start,
    end: seg.end,
    // The PSD writer turns family + style into a PostScript name.
    postScriptName: `${seg.fontName.family}-${seg.fontName.style}`.replace(/\s+/g, ''),
    fontSize: seg.fontSize,
    color: solidOf(seg.fills),
    tracking: seg.letterSpacing.unit === 'PERCENT' ? seg.letterSpacing.value * 10 : undefined,
    leading: seg.lineHeight.unit === 'PIXELS' ? seg.lineHeight.value : undefined,
    underline: seg.textDecoration === 'UNDERLINE' || undefined,
    strikethrough: seg.textDecoration === 'STRIKETHROUGH' || undefined,
    caps: seg.textCase === 'UPPER' ? 'UPPER' : seg.textCase === 'SMALL_CAPS' ? 'SMALL_CAPS' : undefined,
  }));

  for (const seg of segments) {
    if (seg.letterSpacing.unit === 'PIXELS' && seg.letterSpacing.value) {
      report.push({ level: 'approximated', layerName: node.name, reason: 'Letter spacing in pixels was converted to a percentage.' });
      break;
    }
  }
  if (node.textAlignVertical !== 'TOP') {
    report.push({ level: 'approximated', layerName: node.name, reason: 'Vertical text alignment has no Photoshop equivalent.' });
  }

  const auto = node.textAutoResize === 'WIDTH_AND_HEIGHT';
  return {
    content: node.characters,
    kind: auto ? 'point' : 'box',
    boxWidth: auto ? undefined : bounds.width,
    boxHeight: auto ? undefined : bounds.height,
    // Photoshop anchors point text on the first baseline; the writer adjusts using the box.
    origin: { x: bounds.left, y: bounds.top },
    scale: 1,
    rotation: -node.rotation,
    align: node.textAlignHorizontal as IRText['align'],
    runs,
    warped: false,
    vertical: false,
    warnings: [],
  };
}

/** Pixel-space letter spacing needs the font size, which the runs already carry. */
function solidOf(fills: readonly Paint[] | typeof figma.mixed): RGBA | undefined {
  if (fills === figma.mixed || !fills.length) return undefined;
  const paint = fills.find((p) => p.type === 'SOLID' && p.visible !== false) as SolidPaint | undefined;
  if (!paint) return undefined;
  return { ...paint.color, a: paint.opacity ?? 1 };
}
