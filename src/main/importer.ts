/**
 * Builds Figma nodes from planned IR layers. Main thread only.
 *
 * Layers arrive parents-first with siblings bottom-first, so appending each node to
 * its parent reproduces Photoshop's stacking order. Figma can't create an empty
 * group, so groups start as transparent placeholder frames at (0,0) and become real
 * groups in finish(), deepest first.
 */
import type { DocInfo } from '../core/messages';
import type { ImportReport, ReportItem } from '../core/model';
import type { PlannedLayer } from '../core/plan';
import type { ImportSettings } from '../core/settings';

type Parent = FrameNode;

export class Importer {
  readonly frame: FrameNode;
  private readonly parents = new Map<number, Parent>();
  private readonly placeholders: { frame: FrameNode; layer: PlannedLayer }[] = [];
  private readonly report: ReportItem[];
  private imported = 0;
  done = 0;

  constructor(
    readonly doc: DocInfo,
    readonly settings: ImportSettings,
    readonly total: number,
    preflight: ReportItem[],
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

    if (layer.action === 'group') {
      const ph = figma.createFrame();
      ph.name = layer.name;
      ph.fills = [];
      ph.clipsContent = false;
      ph.resize(this.doc.width, this.doc.height);
      parent.appendChild(ph);
      ph.x = 0;
      ph.y = 0;
      this.parents.set(layer.id, ph);
      this.placeholders.push({ frame: ph, layer });
      return;
    }

    const img = layer.image;
    if (!img?.png) {
      this.skip(layer.name, 'No pixel data found.');
      return;
    }

    const rect = figma.createRectangle();
    rect.name = layer.name;
    parent.appendChild(rect);
    rect.resize(Math.max(0.01, layer.bounds.width), Math.max(0.01, layer.bounds.height));
    rect.x = layer.bounds.left;
    rect.y = layer.bounds.top;
    const image = figma.createImage(img.png);
    rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
    applyCommon(rect, layer);
    this.imported++;

    if (img.downscaled) {
      this.approximate(layer.name, `Larger than 4096 px; downscaled to ${img.width}×${img.height} and stretched to size.`);
    }
  }

  /** Converts placeholders to groups (deepest first) and returns the final report. */
  finish(uiReport: ReportItem[]): ImportReport {
    for (const { frame, layer } of [...this.placeholders].reverse()) {
      const parent = frame.parent as (BaseNode & ChildrenMixin) | null;
      if (!parent) continue;
      if (frame.children.length === 0) {
        frame.remove();
        this.skip(layer.name, 'Empty group.');
        continue;
      }
      const index = parent.children.indexOf(frame as SceneNode);
      const group = figma.group([...frame.children], parent, index);
      group.name = layer.name;
      applyCommon(group, layer);
      frame.remove();
      this.imported++;
    }

    figma.currentPage.selection = [this.frame];
    figma.viewport.scrollAndZoomIntoView([this.frame]);
    return { imported: this.imported, items: [...this.report, ...uiReport] };
  }

  /** Removes a partially built import after a fatal error. */
  abort() {
    if (!this.frame.removed) this.frame.remove();
  }

  private skip(layerName: string, reason: string) {
    this.report.push({ level: 'skipped', layerName, reason });
  }

  private approximate(layerName: string, reason: string) {
    this.report.push({ level: 'approximated', layerName, reason });
  }
}

function applyCommon(node: SceneNode & BlendMixin, layer: PlannedLayer) {
  node.visible = layer.visible;
  node.opacity = layer.opacity;
  // Figma groups default to pass through; only set a mode that differs.
  if (node.blendMode !== layer.blendMode) node.blendMode = layer.blendMode;
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
