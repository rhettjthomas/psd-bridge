/** IR paints and strokes → Figma paints. Main thread only. */
import { gradientTransform, type IRPaint } from '../core/paint';
import type { Bounds } from '../core/model';
import type { IRShape, IRStroke } from '../core/shapes';

const GRADIENT_TYPE = {
  linear: 'GRADIENT_LINEAR',
  radial: 'GRADIENT_RADIAL',
  angular: 'GRADIENT_ANGULAR',
  diamond: 'GRADIENT_DIAMOND',
} as const;

export function toFigmaPaint(p: IRPaint, box: Bounds): Paint {
  switch (p.type) {
    case 'solid':
      return { type: 'SOLID', color: { r: p.color.r, g: p.color.g, b: p.color.b }, opacity: p.color.a * p.opacity };
    case 'gradient':
      return {
        type: GRADIENT_TYPE[p.kind],
        gradientTransform: gradientTransform(p, box) as Transform,
        gradientStops: p.stops.map((s) => ({ position: s.position, color: s.color })),
        opacity: p.opacity,
      };
    case 'pattern': {
      if (!p.image) throw new Error(`Pattern "${p.name}" has no image data.`);
      const image = figma.createImage(p.image.png);
      return { type: 'IMAGE', scaleMode: 'TILE', imageHash: image.hash, scalingFactor: 1, opacity: p.opacity };
    }
  }
}

export function applyShapePaints(node: GeometryMixin & MinimalStrokesMixin, shape: IRShape) {
  node.fills = shape.fill ? [toFigmaPaint(shape.fill, shape.bounds)] : [];
  applyStroke(node, shape.stroke, shape.bounds);
}

function applyStroke(node: GeometryMixin & MinimalStrokesMixin, s: IRStroke | undefined, box: Bounds) {
  if (!s) {
    node.strokes = [];
    return;
  }
  node.strokes = [toFigmaPaint(s.paint, box)];
  node.strokeWeight = s.width;
  node.strokeAlign = s.align;
  node.strokeJoin = s.join;
  if ('strokeCap' in node) (node as VectorNode).strokeCap = s.cap;
  node.dashPattern = s.dashes;
}
