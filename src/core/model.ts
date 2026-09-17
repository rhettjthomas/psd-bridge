/**
 * Intermediate layer model (IR).
 *
 * A format-neutral description of a layered document. v1 reads PSD → IR in the UI
 * iframe and builds Figma nodes from IR in the main thread. v2 exporters will read
 * Figma → IR and write PSD/AI from it, so each format only needs a reader or writer.
 *
 * Everything here must survive structured cloning (postMessage): plain objects,
 * arrays, numbers, strings, and Uint8Array only.
 */

import type { IRVector } from './paths';
import type { IRShape } from './shapes';

export type LayerKind =
  | 'group'
  | 'pixel'
  | 'shape'
  | 'text'
  | 'smartObject'
  | 'adjustment';

/** Figma-compatible blend mode names (subset of Figma's BlendMode). */
export type IRBlendMode =
  | 'PASS_THROUGH'
  | 'NORMAL'
  | 'DARKEN'
  | 'MULTIPLY'
  | 'LINEAR_BURN'
  | 'COLOR_BURN'
  | 'LIGHTEN'
  | 'SCREEN'
  | 'LINEAR_DODGE'
  | 'COLOR_DODGE'
  | 'OVERLAY'
  | 'SOFT_LIGHT'
  | 'HARD_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY';

export interface Bounds {
  /** Document-space pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RGBA {
  r: number; // 0–1
  g: number;
  b: number;
  a: number;
}

/** Encoded raster. PNG bytes are attached in M2; M1 carries dimensions only. */
export interface IRImage {
  width: number;
  height: number;
  png?: Uint8Array;
  /** True when the source was larger than Figma's image cap and was downscaled. */
  downscaled?: boolean;
}

export interface IRShadow {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: RGBA;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  blendMode: IRBlendMode;
}

export interface IRLayerMask {
  /** Mask pixel bounds; after encoding, the bounds the mask image covers. */
  bounds: Bounds;
  /** Gray level (0–255) outside the mask bounds. 0 hides, 255 shows. */
  defaultColor: number;
  /** Which ag-psd mask holds the user's pixel mask (realMask when a vector mask also exists). */
  source: 'mask' | 'realMask';
  image?: IRImage;
}

export interface IRTextRun {
  /** Character range [start, end) into IRText.content. */
  start: number;
  end: number;
  postScriptName?: string;
  /** Font size in document px (layer transform already applied). */
  fontSize?: number;
  color?: RGBA;
  /** Photoshop tracking, 1/1000 em. */
  tracking?: number;
  /** Fixed leading in document px; undefined = auto. */
  leading?: number;
  underline?: boolean;
  strikethrough?: boolean;
  caps?: 'UPPER' | 'SMALL_CAPS';
}

export interface IRText {
  content: string;
  kind: 'point' | 'box';
  /** Box size for paragraph text (document px, already scaled). */
  boxWidth?: number;
  boxHeight?: number;
  /**
   * Document-space anchor: for point text, the first baseline's anchor (left, center, or
   * right edge by alignment); for box text, the box's top-left corner.
   */
  origin: { x: number; y: number };
  /** Uniform scale taken from the text transform; font sizes are already multiplied by it. */
  scale: number;
  /** Clockwise rotation in degrees, from the text transform. */
  rotation: number;
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  runs: IRTextRun[];
  /** Warped or on-path text can't be editable in Figma; it imports as pixels. */
  warped: boolean;
  /** Vertical text is out of scope; it imports as pixels. */
  vertical: boolean;
  /** Things that will be approximated if this text is imported as editable. */
  warnings: string[];
}

export interface IRLayer {
  /** Stable id within one import (depth-first index). */
  id: number;
  parentId: number | null;
  name: string;
  kind: LayerKind;
  bounds: Bounds;
  visible: boolean;
  /** Layer opacity × fill opacity, 0–1. */
  opacity: number;
  blendMode: IRBlendMode;
  /** Original PSD blend mode, kept for the report when it had no Figma equivalent. */
  sourceBlendMode?: string;
  /** Clipped to the nearest non-clipped sibling below it. */
  clipped: boolean;
  image?: IRImage;
  mask?: IRLayerMask;
  /** Vector mask geometry (non-shape layers). */
  vectorMask?: IRVector;
  shadows: IRShadow[];
  text?: IRText;
  /** Photoshop artboard (a top-level group with its own canvas and background). */
  artboard?: IRArtboard;
  /** Shape geometry and paints (shape and fill layers). */
  shape?: IRShape;
  /** Names of layer styles present but not translatable (bevel, glow, …). */
  unsupportedEffects: string[];
  /** Child ids in stacking order: first = bottom (same as PSD and Figma appendChild). */
  children?: number[];
}

export interface IRArtboard {
  bounds: Bounds;
  /** Background fill; null = transparent. */
  background: RGBA | null;
}

export interface IRDocument {
  name: string;
  width: number;
  height: number;
  colorMode: 'RGB' | 'CMYK' | 'Grayscale' | 'Other';
  bitsPerChannel: number;
  /** Top-level layer ids in stacking order: first = bottom. */
  rootIds: number[];
  /** All layers, depth-first, keyed by position = id. */
  layers: IRLayer[];
}

export type ReportLevel = 'approximated' | 'skipped';

export interface ReportItem {
  level: ReportLevel;
  layerName: string;
  reason: string;
  /** Figma node for this layer, filled in after import so the report can select it. */
  nodeId?: string;
}

export interface ImportReport {
  imported: number;
  items: ReportItem[];
}
