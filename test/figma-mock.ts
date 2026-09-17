import { translatePathData } from '../src/core/paths';

/** Minimal in-memory stand-in for the Figma plugin API, enough for the importer. */
type AnyNode = MockNode;

let nextNodeId = 1;

export class MockNode {
  readonly id = `mock:${nextNodeId++}`;
  children: AnyNode[] = [];
  parent: AnyNode | null = null;
  removed = false;
  name = '';
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  visible = true;
  opacity = 1;
  blendMode: string;
  fills: unknown[] = [];
  strokes: unknown[] = [];
  effects: unknown[] = [];
  clipsContent = false;
  isMask = false;
  strokeWeight = 1;
  strokeAlign = 'INSIDE';
  dashPattern: number[] = [];
  topLeftRadius = 0;
  topRightRadius = 0;
  bottomRightRadius = 0;
  bottomLeftRadius = 0;
  maskType = 'ALPHA';
  private paths: { windingRule: string; data: string }[] = [];
  constructor(readonly type: string) {
    this.blendMode = type === 'GROUP' || type === 'FRAME' ? 'PASS_THROUGH' : 'NORMAL';
  }
  appendChild(n: AnyNode) {
    this.insertChild(this.children.length, n);
  }
  insertChild(i: number, n: AnyNode) {
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
    n.parent = this;
    this.children.splice(i, 0, n);
  }
  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  /** Like Figma, re-origins path data so its top-left point is (0,0). */
  set vectorPaths(v: { windingRule: string; data: string }[]) {
    const nums = v.flatMap((p) => p.data.split(' ').filter((t) => !/^[A-Z]$/.test(t)).map(Number));
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    const dx = Math.min(...xs);
    const dy = Math.min(...ys);
    this.paths = v.map((p) => ({ ...p, data: translatePathData(p.data, dx, dy) }));
    this.width = Math.max(...xs) - dx;
    this.height = Math.max(...ys) - dy;
  }
  get vectorPaths() {
    return this.paths;
  }
  // --- Text (only what the importer uses) ---
  characters = '';
  private _fontName = { family: 'Inter', style: 'Regular' };
  ranges: Record<string, unknown>[] = [];
  textAlignHorizontal = 'LEFT';
  textAutoResize = 'NONE';
  rotation = 0;
  fontSize = 12;
  get fontName() {
    return this._fontName;
  }
  set fontName(f: { family: string; style: string }) {
    requireLoaded(f);
    this._fontName = f;
  }
  setRangeFontName(start: number, end: number, f: { family: string; style: string }) {
    requireLoaded(f);
    this.ranges.push({ start, end, fontName: f });
  }
  setRangeFontSize(start: number, end: number, v: number) {
    this.fontSize = Math.max(this.fontSize === 12 ? 0 : this.fontSize, v);
    this.ranges.push({ start, end, fontSize: v });
  }
  setRangeFills(start: number, end: number, v: unknown) { this.ranges.push({ start, end, fills: v }); }
  setRangeLetterSpacing(start: number, end: number, v: unknown) { this.ranges.push({ start, end, letterSpacing: v }); }
  setRangeLineHeight(start: number, end: number, v: unknown) { this.ranges.push({ start, end, lineHeight: v }); }
  setRangeTextDecoration(start: number, end: number, v: unknown) { this.ranges.push({ start, end, textDecoration: v }); }
  setRangeTextCase(start: number, end: number, v: unknown) { this.ranges.push({ start, end, textCase: v }); }
  get absoluteTransform() {
    let x = 0;
    let y = 0;
    for (let n: MockNode | null = this; n && n.type !== 'PAGE'; n = n.parent) {
      x += n.x;
      y += n.y;
    }
    return [[1, 0, x], [0, 1, y]];
  }
  /** Fake glyph bounds: ink starts 0.2 em below the node's top and 2px in from its left. */
  get absoluteRenderBounds() {
    if (this.type !== 'TEXT') return null;
    const [[, , x], [, , y]] = this.absoluteTransform;
    return { x: x + 2, y: y + this.fontSize * 0.2, width: this.width - 4, height: this.fontSize * 0.8 };
  }

  clone(): MockNode {
    const c = new MockNode(this.type);
    Object.assign(c, { ...this, id: c.id, children: [], parent: null });
    for (const ch of this.children) c.appendChild(ch.clone());
    this.parent?.insertChild(this.parent.children.indexOf(this) + 1, c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
    this.removed = true;
  }
}

const loadedFonts = new Set<string>();
function requireLoaded(f: { family: string; style: string }) {
  if (!loadedFonts.has(`${f.family}/${f.style}`)) throw new Error(`Font not loaded: ${f.family} ${f.style}`);
}

export const AVAILABLE_FONTS = [
  { family: 'Inter', style: 'Regular' },
  { family: 'Inter', style: 'Bold' },
  { family: 'Arial', style: 'Regular' },
  { family: 'Oswald', style: 'Bold' },
];

export function installFigmaMock() {
  loadedFonts.clear();
  const page = new MockNode('PAGE');
  let hash = 0;
  const figma = {
    currentPage: Object.assign(page, { selection: [] as AnyNode[] }),
    viewport: { scrollAndZoomIntoView() {} },
    createFrame() {
      const f = new MockNode('FRAME');
      f.fills = [{ type: 'SOLID' }];
      page.appendChild(f);
      return f;
    },
    createRectangle() {
      const r = new MockNode('RECTANGLE');
      page.appendChild(r);
      return r;
    },
    createText() {
      const t = new MockNode('TEXT');
      page.appendChild(t);
      return t;
    },
    async loadFontAsync(f: { family: string; style: string }) {
      if (!AVAILABLE_FONTS.some((a) => a.family === f.family && a.style === f.style)) throw new Error('not available');
      loadedFonts.add(`${f.family}/${f.style}`);
    },
    async listAvailableFontsAsync() {
      return AVAILABLE_FONTS.map((fontName) => ({ fontName, fontStyle: fontName.style }));
    },
    createEllipse() {
      const e = new MockNode('ELLIPSE');
      page.appendChild(e);
      return e;
    },
    createVector() {
      const v = new MockNode('VECTOR');
      page.appendChild(v);
      return v;
    },
    createImage(bytes: Uint8Array) {
      if (!(bytes instanceof Uint8Array)) throw new Error('bad bytes');
      return { hash: `h${hash++}` };
    },
    group(nodes: AnyNode[], parent: AnyNode, index: number) {
      if (!nodes.length) throw new Error('Cannot group zero nodes');
      const g = new MockNode('GROUP');
      parent.insertChild(index, g);
      for (const n of nodes) g.appendChild(n);
      return g;
    },
  };
  (globalThis as any).figma = figma;
  return figma;
}

export function tree(n: MockNode, depth = 0): string[] {
  const flags = [
    n.visible ? '' : 'hidden',
    n.opacity < 1 ? n.opacity.toFixed(2) : '',
    n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH' ? n.blendMode : '',
    n.isMask ? `mask:${n.maskType}` : '',
    n.effects.length ? `fx:${(n.effects as { type: string }[]).map((e) => e.type).join(',')}` : '',
  ]
    .filter(Boolean).join(' ');
  const self = `${'  '.repeat(depth)}${n.type} ${n.name} @${n.x},${n.y} ${n.width}x${n.height}${flags ? ' ' + flags : ''}`;
  return [self, ...n.children.map((c) => tree(c, depth + 1)).flat()];
}
