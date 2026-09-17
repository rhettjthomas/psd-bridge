/** Minimal in-memory stand-in for the Figma plugin API, enough for the importer. */
type AnyNode = MockNode;

export class MockNode {
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
  clipsContent = false;
  constructor(readonly type: string) {
    this.blendMode = type === 'GROUP' ? 'PASS_THROUGH' : 'NORMAL';
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
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
    this.removed = true;
  }
}

export function installFigmaMock() {
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
  const flags = [n.visible ? '' : 'hidden', n.opacity < 1 ? n.opacity.toFixed(2) : '', n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH' ? n.blendMode : '']
    .filter(Boolean).join(' ');
  const self = `${'  '.repeat(depth)}${n.type} ${n.name} @${n.x},${n.y} ${n.width}x${n.height}${flags ? ' ' + flags : ''}`;
  return [self, ...n.children.map((c) => tree(c, depth + 1)).flat()];
}
