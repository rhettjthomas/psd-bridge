/**
 * Builds Figma nodes from planned IR layers. Main thread only.
 *
 * Layers arrive parents-first with siblings bottom-first, so appending each node to
 * its parent reproduces Photoshop's stacking order. Figma can't create an empty
 * group, so groups start as transparent placeholder frames at (0,0) and become real
 * groups in finish(), deepest first. Because every placeholder sits at the document
 * origin, parent-relative coordinates are always document coordinates.
 *
 * Masks follow Figma's model: a mask node masks the siblings above it, so a masked
 * layer becomes a group of [mask, content].
 */
import type { DocInfo } from '../core/messages';
import type { ImportReport, IRShadow, ReportItem } from '../core/model';
import type { IRVector } from '../core/paths';
import type { PlannedLayer } from '../core/plan';
import type { ImportSettings } from '../core/settings';
import type { IRShape } from '../core/shapes';
import { applyShapePaints } from './paints';
import { buildTextNode } from './text';

type Container = BaseNode & ChildrenMixin;

export class Importer {
  readonly frame: FrameNode;
  private readonly parents = new Map<number, FrameNode>();
  private readonly placeholders: { frame: FrameNode; layer: PlannedLayer }[] = [];
  private readonly report: ReportItem[];
  /** Layer ids that produced a node (used to validate clipping bases). */
  private readonly placed = new Set<number>();
  private readonly artboards = new Set<SceneNode>();
  /** Layer name → first node placed for it, so report items can link to layers. */
  private readonly nodeByName = new Map<string, string>();
  private imported = 0;
  done = 0;

  constructor(
    readonly doc: DocInfo,
    readonly settings: ImportSettings,
    readonly total: number,
    preflight: ReportItem[],
    private readonly fonts = new Map<string, FontName>(),
  ) {
    this.report = [...preflight];
    const frame = figma.createFrame();
    frame.name = doc.name;
    frame.resize(doc.width, doc.height);
    frame.fills = [];
    frame.clipsContent = true;
    const { x, y } = placementFor(frame);
    frame.x = x;
    frame.y = y;
    this.frame = frame;
  }

  addBatch(layers: PlannedLayer[]) {
    for (const layer of layers) {
      try {
        this.addLayer(layer);
      } catch (err) {
        this.skip(layer.name, `Failed to place: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.done++;
    }
  }

  private addLayer(layer: PlannedLayer) {
    const parent = layer.parentId === null ? this.frame : this.parents.get(layer.parentId) ?? this.frame;

    if (layer.action === 'group' || layer.action === 'clip') {
      const ph = figma.createFrame();
      ph.name = layer.name;
      ph.fills = [];
      ph.clipsContent = false;
      ph.resize(this.doc.width, this.doc.height);
      parent.appendChild(ph);
      ph.x = 0;
      ph.y = 0;
      // Group masks sit at the bottom of the group and mask every child above them.
      if (layer.vectorMask) this.vectorMaskNode(ph, 0, layer.vectorMask, layer.name);
      if (layer.mask?.image?.png) this.pixelMaskNode(ph, ph.children.length, layer);
      this.parents.set(layer.id, ph);
      this.placeholders.push({ frame: ph, layer });
      this.placed.add(layer.id);
      return;
    }

    const content =
      layer.action === 'vector' ? this.shapeNode(parent, layer)
      : layer.action === 'text' ? this.textNode(parent, layer)
      : this.imageNode(parent, layer);
    if (!content) return;

    let node: SceneNode & BlendMixin = content;
    if (layer.mask?.image?.png) {
      const mask = this.pixelMaskNode(parent, parent.children.indexOf(node), layer);
      node = wrap([mask, node], parent, layer.name);
    }
    if (layer.vectorMask) {
      const mask = this.vectorMaskNode(parent, parent.children.indexOf(node), layer.vectorMask, layer.name);
      if (mask) node = wrap([mask, node], parent, layer.name);
    }
    this.applyCommon(node, layer);
    this.imported++;
    this.placed.add(layer.id);
    this.link(layer.name, node);
  }

  private textNode(parent: Container, layer: PlannedLayer): TextNode {
    const origin = { x: this.frame.absoluteTransform[0][2], y: this.frame.absoluteTransform[1][2] };
    return buildTextNode(parent, layer, this.fonts, origin);
  }

  private imageNode(parent: Container, layer: PlannedLayer): RectangleNode | null {
    const img = layer.image;
    if (!img?.png) {
      this.skip(layer.name, 'No pixel data found.');
      return null;
    }
    const rect = figma.createRectangle();
    rect.name = layer.name;
    parent.appendChild(rect);
    rect.resize(Math.max(0.01, layer.bounds.width), Math.max(0.01, layer.bounds.height));
    rect.x = layer.bounds.left;
    rect.y = layer.bounds.top;
    const image = figma.createImage(img.png);
    rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
    if (img.downscaled) {
      this.approximate(layer.name, `Larger than 4096 px; downscaled to ${img.width}×${img.height} and stretched to size.`);
    }
    return rect;
  }

  /** Native rectangle/ellipse or editable vector, positioned in document space. */
  private shapeNode(parent: Container, layer: PlannedLayer): (RectangleNode | EllipseNode | VectorNode) | null {
    const shape = layer.shape as IRShape;
    const g = shape.geometry;
    let node: RectangleNode | EllipseNode | VectorNode;
    if (g.type === 'path') {
      node = figma.createVector();
      parent.appendChild(node);
      placeVectorPaths(node, g.vector);
    } else {
      node = g.type === 'rect' ? figma.createRectangle() : figma.createEllipse();
      parent.appendChild(node);
      node.resize(Math.max(0.01, g.bounds.width), Math.max(0.01, g.bounds.height));
      node.x = g.bounds.left;
      node.y = g.bounds.top;
      if (g.type === 'rect' && node.type === 'RECTANGLE') {
        [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] = g.radii;
      }
    }
    node.name = layer.name;
    try {
      applyShapePaints(node, shape);
    } catch (err) {
      node.fills = [];
      this.approximate(layer.name, `Fill couldn't be applied (${err instanceof Error ? err.message : String(err)}).`);
    }
    return node;
  }

  /** Luminance mask from the layer's mask image, inserted at `index` in `parent`. */
  private pixelMaskNode(parent: Container, index: number, layer: PlannedLayer): RectangleNode {
    const m = layer.mask!;
    const rect = figma.createRectangle();
    rect.name = 'Layer mask';
    parent.insertChild(index, rect);
    rect.resize(Math.max(0.01, m.bounds.width), Math.max(0.01, m.bounds.height));
    rect.x = m.bounds.left;
    rect.y = m.bounds.top;
    const image = figma.createImage(m.image!.png!);
    rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
    rect.isMask = true;
    rect.maskType = 'LUMINANCE';
    if (m.image!.downscaled) this.approximate(layer.name, 'Layer mask was larger than 4096 px and was downscaled.');
    return rect;
  }

  /** Editable vector mask, inserted at `index` in `parent`. */
  private vectorMaskNode(parent: Container, index: number, vec: IRVector, layerName: string): VectorNode | null {
    try {
      const node = figma.createVector();
      node.name = 'Vector mask';
      parent.insertChild(index, node);
      placeVectorPaths(node, vec);
      node.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
      node.strokes = [];
      node.isMask = true;
      node.maskType = 'VECTOR';
      return node;
    } catch (err) {
      this.approximate(layerName, `Vector mask couldn't be built (${err instanceof Error ? err.message : String(err)}); imported unmasked.`);
      return null;
    }
  }

  /** Converts placeholders to groups (deepest first) and returns the final report. */
  finish(uiReport: ReportItem[]): ImportReport {
    for (const { frame, layer } of [...this.placeholders].reverse()) {
      const parent = frame.parent as Container | null;
      if (!parent) continue;
      const hasContent = frame.children.some((c) => !('isMask' in c && c.isMask));
      if (!hasContent) {
        frame.remove();
        this.placed.delete(layer.id);
        if (layer.action === 'group') this.skip(layer.name, 'Empty group.');
        continue;
      }

      if (layer.artboard) {
        this.finishArtboard(frame, layer);
        continue;
      }

      const baseId = layer.children?.[0];
      if (layer.action === 'clip' && (baseId === undefined || !this.placed.has(baseId))) {
        this.approximate(layer.name, 'Clipping base could not be placed; clipped layers imported unclipped.');
      } else if (layer.action === 'clip') {
        // Photoshop clips to the base's pixels; Figma needs a separate mask node, so copy the base.
        const base = frame.children[0];
        const shape = base.clone();
        frame.insertChild(0, shape);
        shape.name = 'Clipping shape';
        shape.visible = true;
        if ('opacity' in shape) shape.opacity = 1;
        if ('effects' in shape) shape.effects = [];
        if ('isMask' in shape) {
          shape.isMask = true;
          shape.maskType = 'ALPHA';
        }
      }

      const index = parent.children.indexOf(frame as SceneNode);
      const group = figma.group([...frame.children], parent, index);
      group.name = layer.name;
      this.applyCommon(group, layer);
      frame.remove();
      this.link(layer.name, group);
      if (layer.action === 'group') this.imported++;
    }

    const roots = this.placeArtboards();
    figma.currentPage.selection = roots;
    figma.viewport.scrollAndZoomIntoView(roots);
    if (!this.nodeByName.has(this.doc.name)) this.nodeByName.set(this.doc.name, roots[0].id);
    const items = [...this.report, ...uiReport].map((item) => {
      const nodeId = this.nodeByName.get(item.layerName);
      return nodeId ? { ...item, nodeId } : item;
    });
    return { imported: this.imported, items };
  }

  /**
   * An artboard keeps its placeholder frame: sized and placed at the artboard's rect,
   * filled with its background, clipped, and with children shifted into its space.
   */
  private finishArtboard(frame: FrameNode, layer: PlannedLayer) {
    const { bounds, background } = layer.artboard!;
    for (const child of frame.children) {
      child.x -= bounds.left;
      child.y -= bounds.top;
    }
    frame.resize(Math.max(0.01, bounds.width), Math.max(0.01, bounds.height));
    frame.x = bounds.left;
    frame.y = bounds.top;
    frame.fills = background ? [solid(background)] : [];
    frame.clipsContent = true;
    frame.visible = layer.visible;
    frame.opacity = layer.opacity;
    if (layer.blendMode !== 'PASS_THROUGH') frame.blendMode = layer.blendMode;
    this.artboards.add(frame);
    this.imported++;
    this.link(layer.name, frame);
  }

  /**
   * Artboards become frames people can work with directly:
   * - one artboard, nothing else: the import frame *is* that artboard;
   * - several artboards, nothing else: each becomes a top-level frame on the page, keeping
   *   the spacing it had in Photoshop, and the document frame goes away;
   * - artboards mixed with loose layers: the document frame stays, so nothing moves.
   *
   * Returns the frames to select afterwards.
   */
  private placeArtboards(): SceneNode[] {
    const kids = [...this.frame.children];
    const boards = kids.filter((k): k is FrameNode => k.type === 'FRAME' && this.artboards.has(k));
    if (!boards.length) return [this.frame];

    if (boards.length !== kids.length) {
      this.approximate(this.doc.name, 'Layers outside the artboards kept the document frame around them.');
      return [this.frame];
    }

    if (boards.length === 1) {
      const board = boards[0];
      // Only fold it in when the artboard itself carries no layer properties of its own.
      if (board.visible && board.opacity === 1 && board.blendMode === 'PASS_THROUGH') {
        this.frame.resize(board.width, board.height);
        this.frame.fills = board.fills;
        for (const child of [...board.children]) {
          const { x, y } = child;
          this.frame.appendChild(child);
          child.x = x;
          child.y = y;
        }
        this.remapNode(board.id, this.frame.id);
        board.remove();
      }
      return [this.frame];
    }

    const page = this.frame.parent ?? figma.currentPage;
    const baseX = this.frame.x;
    const baseY = this.frame.y;
    for (const board of boards) {
      const { x, y } = board;
      page.appendChild(board);
      board.x = baseX + x;
      board.y = baseY + y;
    }
    // The document frame only existed to hold them.
    this.remapNode(this.frame.id, boards[0].id);
    this.frame.remove();
    return boards;
  }

  /** Keeps report links pointing at a node that replaced another. */
  private remapNode(from: string, to: string) {
    for (const [name, id] of this.nodeByName) if (id === from) this.nodeByName.set(name, to);
  }

  /** Removes a partially built import after a fatal error. */
  abort() {
    if (!this.frame.removed) this.frame.remove();
  }

  private link(name: string, node: SceneNode) {
    if (!this.nodeByName.has(name)) this.nodeByName.set(name, node.id);
  }

  private applyCommon(node: SceneNode & BlendMixin, layer: PlannedLayer) {
    node.visible = layer.visible;
    node.opacity = layer.opacity;
    // Figma groups default to pass through; only set a mode that differs.
    if (node.blendMode !== layer.blendMode) node.blendMode = layer.blendMode;
    if (layer.shadows.length && this.settings.rebuildShadows) {
      node.effects = layer.shadows.map(toEffect);
    }
  }

  private skip(layerName: string, reason: string) {
    this.report.push({ level: 'skipped', layerName, reason });
  }

  private approximate(layerName: string, reason: string) {
    this.report.push({ level: 'approximated', layerName, reason });
  }
}

/** Groups `nodes` (already adjacent children of `parent`, bottom-first) in place. */
function wrap(nodes: SceneNode[], parent: Container, name: string): GroupNode {
  const index = parent.children.indexOf(nodes[0]);
  const group = figma.group(nodes, parent, index);
  group.name = name;
  return group;
}

/**
 * Sets document-space path data on a vector and positions it so the geometry lands
 * where Photoshop drew it, whether or not Figma re-origins the path data.
 */
export function placeVectorPaths(node: VectorNode, vec: IRVector) {
  node.x = 0;
  node.y = 0;
  node.vectorPaths = vec.paths.map((p) => ({ windingRule: p.windingRule, data: p.data }));
  const want = firstPoint(vec.paths[0].data);
  const got = firstPoint(node.vectorPaths[0]?.data ?? '');
  if (want && got) {
    node.x = want[0] - got[0];
    node.y = want[1] - got[1];
  }
}

function firstPoint(data: string): [number, number] | null {
  const m = /M\s*(-?[\d.e+-]+)[\s,]+(-?[\d.e+-]+)/.exec(data);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function solid(c: { r: number; g: number; b: number; a: number }): SolidPaint {
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

function toEffect(s: IRShadow): Effect {
  const base = {
    color: s.color,
    offset: s.offset,
    radius: s.radius,
    spread: s.spread,
    visible: true,
    blendMode: s.blendMode,
  };
  return s.type === 'DROP_SHADOW'
    ? { ...base, type: 'DROP_SHADOW', showShadowBehindNode: false }
    : { ...base, type: 'INNER_SHADOW' };
}

/** Place the new frame to the right of everything on the page. */
function placementFor(frame: FrameNode): { x: number; y: number } {
  const others = figma.currentPage.children.filter((n) => n !== frame);
  if (others.length === 0) return { x: 0, y: 0 };
  let right = -Infinity;
  let top = Infinity;
  for (const n of others) {
    right = Math.max(right, n.x + n.width);
    top = Math.min(top, n.y);
  }
  return { x: Math.round(right + 100), y: Math.round(top) };
}
