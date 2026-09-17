/**
 * Main thread. Owns the Figma document: settings storage, font matching and loading,
 * and node building. Never touches PSD bytes or canvas; the UI iframe does that.
 */
import { PREP_GUIDE_URL, type FrameInfo, type MainToUI, type UIToMain } from './core/messages';
import { formatTree } from './core/psd-reader';
import { FONT_MAP_KEY, normalizeSettings, SETTINGS_KEY } from './core/settings';
import { buildFontIndex, groupFamilies, matchFont, type FontMap } from './core/fonts';
import { isLicensed } from './licensing';
import { Importer } from './main/importer';
import { readFrame } from './main/figma-reader';
import { loadFonts } from './main/text';

declare const __VERSION__: string;

figma.showUI(__html__, { width: 340, height: 480, themeColors: true, title: 'PSD Bridge' });

let importer: Importer | null = null;

function post(msg: MainToUI) {
  figma.ui.postMessage(msg);
}

async function savedFontMap(): Promise<FontMap> {
  return ((await figma.clientStorage.getAsync(FONT_MAP_KEY)) as FontMap | undefined) ?? {};
}

async function sendInit() {
  const settings = await figma.clientStorage.getAsync(SETTINGS_KEY);
  post({
    type: 'init',
    settings: normalizeSettings(settings),
    fontMap: await savedFontMap(),
    version: __VERSION__,
    licensed: isLicensed(),
  });
}

async function resolveFonts(postScriptNames: string[]) {
  // Re-read every time so "Rescan fonts" picks up newly installed or activated fonts.
  const available = (await figma.listAvailableFontsAsync()).map((f) => f.fontName);
  const index = buildFontIndex(available);
  const fontMap = await savedFontMap();
  post({
    type: 'fonts',
    matches: postScriptNames.map((ps) => matchFont(ps, index, fontMap)),
    families: groupFamilies(available),
    fontMap,
  });
}

/** Containers that can be exported: the selection first, then the page's top-level frames. */
type Exportable = FrameNode | ComponentNode | InstanceNode | GroupNode;

const EXPORTABLE = ['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP'];

function isExportable(node: BaseNode): node is Exportable {
  return EXPORTABLE.indexOf(node.type) >= 0;
}

function frameInfo(node: Exportable): FrameInfo {
  const box = node.absoluteBoundingBox;
  return {
    id: node.id,
    name: node.name,
    width: Math.round(box?.width ?? node.width),
    height: Math.round(box?.height ?? node.height),
    layerCount: node.findAll(() => true).length,
  };
}

function sendFrames() {
  const selected = figma.currentPage.selection.filter(isExportable);
  const onPage = figma.currentPage.children.filter(isExportable);
  const seen = new Set<string>();
  const frames: FrameInfo[] = [];
  for (const node of [...selected, ...onPage]) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    frames.push(frameInfo(node));
  }
  post({ type: 'frames', frames, selectedId: selected[0]?.id ?? null });
}

async function selectNode(id: string) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.removed || node.type === 'DOCUMENT' || node.type === 'PAGE') {
    figma.notify('That layer is no longer in the file.');
    return;
  }
  let page: BaseNode | null = node;
  while (page && page.type !== 'PAGE') page = page.parent;
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page as PageNode);
  figma.currentPage.selection = [node as SceneNode];
  figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
}

async function handle(msg: UIToMain) {
  switch (msg.type) {
    case 'ui-ready':
      await sendInit();
      sendFrames();
      break;
    case 'save-settings':
      await figma.clientStorage.setAsync(SETTINGS_KEY, normalizeSettings(msg.settings));
      break;
    case 'save-font-map':
      await figma.clientStorage.setAsync(FONT_MAP_KEY, msg.fontMap);
      break;
    case 'debug-tree':
      console.log(`[PSD Bridge] Parsed layer tree\n${formatTree(msg.doc)}`);
      break;
    case 'resolve-fonts':
      await resolveFonts(msg.postScriptNames);
      break;
    case 'import-begin': {
      importer?.abort();
      importer = null;
      post({ type: 'progress', done: 0, total: msg.totalLayers, label: 'Loading fonts…' });
      // Load every font once, up front; unloaded fonts throw when text is built.
      const fonts = await loadFonts(msg.fonts, msg.skippedFonts);
      importer = new Importer(msg.doc, msg.settings, msg.totalLayers, [...msg.preflight, ...fonts.report], fonts.resolved);
      post({ type: 'progress', done: 0, total: msg.totalLayers, label: 'Placing layers…' });
      break;
    }
    case 'layers-batch': {
      if (!importer) throw new Error('Import was not started.');
      importer.addBatch(msg.layers);
      const { done, total } = importer;
      post({ type: 'progress', done, total, label: `Placing layer ${done} of ${total}` });
      post({ type: 'batch-ack' });
      break;
    }
    case 'import-end': {
      if (!importer) throw new Error('Import was not started.');
      const report = importer.finish(msg.report);
      importer = null;
      post({ type: 'report', report });
      figma.notify(`PSD Bridge: imported ${report.imported} layers`);
      break;
    }
    case 'import-abort':
      importer?.abort();
      importer = null;
      break;
    case 'select-node':
      await selectNode(msg.nodeId);
      break;
    case 'open-prep-guide':
      figma.openExternal(PREP_GUIDE_URL);
      break;
    case 'refresh-frames':
      sendFrames();
      break;
    case 'read-frame': {
      const node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node || !isExportable(node)) throw new Error('That frame is no longer on the canvas.');
      const { doc, report } = readFrame(node);
      console.log(`[PSD Bridge] Frame read for export\n${formatTree(doc)}`, { doc, report });
      post({ type: 'frame-read', doc, report });
      break;
    }
  }
}

// Handle messages strictly in order: import-begin awaits font loading, and the
// batches that follow must not start before it finishes.
let queue: Promise<void> = Promise.resolve();

figma.ui.onmessage = (msg: UIToMain) => {
  queue = queue.then(async () => {
    try {
      await handle(msg);
    } catch (err) {
      console.error('[PSD Bridge]', err);
      if (msg.type.startsWith('import') || msg.type === 'layers-batch') {
        importer?.abort();
        importer = null;
      }
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
};

// Keep the Export tab in step with what's selected on the canvas.
figma.on('selectionchange', () => {
  queue = queue.then(() => {
    try {
      sendFrames();
    } catch (err) {
      console.error('[PSD Bridge]', err);
    }
  });
});
