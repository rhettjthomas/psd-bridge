/**
 * UI iframe. Owns the file picker, toggles, and PSD parsing and pixel encoding
 * (ag-psd uses the browser canvas here; the main thread has none).
 */
import {
  getLayerImageData,
  getLayerMaskImageData,
  getLayerRealMaskImageData,
  readPsd,
  type Layer,
  type PatternInfo,
  type ReadOptions,
} from 'ag-psd';
import { BATCH_BYTE_LIMIT, LAYER_BATCH_SIZE, type MainToUI, type UIToMain } from '../core/messages';
import type { ImportReport, IRDocument, ReportItem } from '../core/model';
import type { FrameInfo } from '../core/messages';
import { planImport, type PlannedLayer } from '../core/plan';
import { formatTree, psdToIR } from '../core/psd-reader';
import { DEFAULT_SETTINGS, type ImportSettings } from '../core/settings';
import { encodeMask, encodePixels } from './encode';
import { copyText, FontsPanel } from './fonts-panel';
import { FontMapSheet } from './fontmap-sheet';
import { collectFontUsage } from '../core/fonts';

const TOGGLES: { key: keyof ImportSettings; icon: string; label: string; help: string }[] = [
  { key: 'editableText', icon: 'T', label: 'Editable text', help: 'Converts text layers to Figma text' },
  { key: 'editableVectors', icon: '◆', label: 'Editable vectors', help: 'Shape layers become Figma vectors' },
  { key: 'importHidden', icon: '◌', label: 'Import hidden layers', help: 'Keeps them hidden in Figma' },
  { key: 'rebuildShadows', icon: '◐', label: 'Rebuild shadows', help: 'Drop and inner shadows become Figma effects' },
  { key: 'flattenGroups', icon: '▤', label: 'Flatten groups', help: 'Places all layers in one frame' },
];

const STRUCTURE_ONLY: ReadOptions = {
  skipThumbnail: true,
  skipCompositeImageData: true,
  skipLayerImageData: true,
  skipLinkedFilesData: true,
};

// Keep compressed channels and decode one layer at a time, so large PSDs
// never sit fully decoded in memory.
const LAZY_PIXELS: ReadOptions = {
  skipThumbnail: true,
  skipCompositeImageData: true,
  skipLinkedFilesData: true,
  useRawData: true,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: ImportSettings = { ...DEFAULT_SETTINGS };
let currentFile: File | null = null;
let preflight: { doc: IRDocument; report: ReportItem[] } | null = null;
let importing = false;
let cancelRequested = false;
let importStarted = 0;

class ImportCanceled extends Error {}
let ackWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

function post(msg: UIToMain, transfer: Transferable[] = []) {
  parent.postMessage({ pluginMessage: msg }, '*', transfer);
}

function waitForAck(): Promise<void> {
  return new Promise((resolve, reject) => {
    ackWaiter = { resolve, reject };
  });
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

const fontsPanel = new FontsPanel({
  root: $('fonts'),
  rescan: () => requestFonts(),
  saveFontMap: (fontMap) => post({ type: 'save-font-map', fontMap }),
  onChange: () => updateImportButton(),
  notify: (level, text) => showNotices([{ level, text }]),
  openFontMap: () => fontMapSheet.open(),
});

const fontMapSheet = new FontMapSheet({
  root: $('fontmap-sheet'),
  getMap: () => fontsPanel.currentMap(),
  saveMap: (map) => fontsPanel.replaceMap(map),
});

function requestFonts() {
  const names = preflight ? collectFontUsage(preflight.doc.layers).map((u) => u.postScriptName) : [];
  if (names.length) post({ type: 'resolve-fonts', postScriptNames: names });
}

function updateImportButton() {
  const btn = $<HTMLButtonElement>('import-btn');
  btn.disabled = importing || !preflight || !fontsPanel.ready;
  const missing = fontsPanel.missing.length;
  btn.textContent = !fontsPanel.ready && !fontsPanel.pending && missing
    ? `Match ${missing} missing font${missing === 1 ? '' : 's'} to import`
    : 'Import to Figma';
}

// ---------- Rendering ----------

function renderToggles() {
  const root = $('toggles');
  root.replaceChildren(
    ...TOGGLES.map((t) => {
      const row = document.createElement('label');
      row.className = 'toggle-row';
      row.innerHTML = `
        <span class="toggle-icon" aria-hidden="true"></span>
        <span class="toggle-text"><span class="toggle-label"></span><span class="toggle-help"></span></span>
        <span class="switch"><input type="checkbox" role="switch" /><span class="switch-track"></span></span>`;
      row.querySelector('.toggle-icon')!.textContent = t.icon;
      row.querySelector('.toggle-label')!.textContent = t.label;
      row.querySelector('.toggle-help')!.textContent = t.help;
      const input = row.querySelector('input')!;
      input.checked = settings[t.key];
      input.addEventListener('change', () => {
        settings = { ...settings, [t.key]: input.checked };
        post({ type: 'save-settings', settings });
        fontsPanel.setEnabled(settings.editableText);
        renderPreflight();
      });
      return row;
    }),
  );
}

function showNotices(items: { level: 'error' | 'warning'; text: string }[]) {
  const root = $('notices');
  root.hidden = items.length === 0;
  root.replaceChildren(
    ...items.map((n) => {
      const p = document.createElement('div');
      p.className = `notice ${n.level}`;
      p.textContent = n.text;
      return p;
    }),
  );
}

function setStatus(label: string | null, fraction = 0) {
  $('status').hidden = label === null;
  $('status-label').textContent = label ?? '';
  $('progress-bar').style.width = `${Math.round(fraction * 100)}%`;
}

function setBusy(busy: boolean) {
  importing = busy;
  updateImportButton();
  $('import-btn').hidden = busy;
  $('cancel-btn').hidden = !busy;
  $<HTMLButtonElement>('cancel-btn').disabled = false;
  $<HTMLInputElement>('file-input').disabled = busy;
  for (const el of $('toggles').querySelectorAll('input')) el.disabled = busy;
}

let lastReport: { title: string; items: ReportItem[]; counts: string } | null = null;

function renderReport(title: string, items: ReportItem[], imported?: number, durationMs?: number) {
  const approx = items.filter((i) => i.level === 'approximated');
  const skipped = items.filter((i) => i.level === 'skipped');
  const counts = [
    imported !== undefined ? `${imported} imported` : '',
    `${approx.length} approximated`,
    `${skipped.length} skipped`,
    durationMs !== undefined ? formatDuration(durationMs) : '',
  ].filter(Boolean).join(' · ');
  lastReport = { title, items, counts };
  $('report').hidden = false;
  $('report-title').textContent = title;
  $('report-counts').textContent = counts;
  $('report-hint').hidden = !items.some((i) => i.nodeId);

  const groups = [
    { level: 'approximated', label: 'Approximated', list: approx },
    { level: 'skipped', label: 'Skipped', list: skipped },
  ].filter((g) => g.list.length);

  $('report-groups').replaceChildren(
    ...groups.map((g) => {
      const details = document.createElement('details');
      details.className = `level-${g.level}`;
      // Open short lists after an import so the cleanup list is visible right away.
      details.open = imported !== undefined && g.list.length <= 8;
      const summary = document.createElement('summary');
      summary.textContent = `${g.label} (${g.list.length})`;
      const ul = document.createElement('ul');
      for (const item of g.list) {
        const li = document.createElement('li');
        const el = document.createElement(item.nodeId ? 'button' : 'div');
        el.className = 'item';
        if (item.nodeId) {
          const id = item.nodeId;
          (el as HTMLButtonElement).type = 'button';
          el.title = 'Select in Figma';
          el.addEventListener('click', () => post({ type: 'select-node', nodeId: id }));
        }
        const name = document.createElement('span');
        name.className = 'item-name';
        name.textContent = item.layerName;
        const reason = document.createElement('span');
        reason.className = 'item-reason';
        reason.textContent = item.reason;
        el.append(name, reason);
        li.append(el);
        ul.append(li);
      }
      details.append(summary, ul);
      return details;
    }),
  );
}

function reportText(): string {
  if (!lastReport) return '';
  const lines = [`PSD Bridge — ${lastReport.title}`, currentFile ? currentFile.name : '', lastReport.counts, ''];
  for (const level of ['approximated', 'skipped'] as const) {
    const list = lastReport.items.filter((i) => i.level === level);
    if (!list.length) continue;
    lines.push(`${level === 'approximated' ? 'Approximated' : 'Skipped'} (${list.length})`);
    for (const i of list) lines.push(`- ${i.layerName}: ${i.reason}`);
    lines.push('');
  }
  return lines.filter((l, i) => l !== '' || i > 2).join('\n').trim();
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function renderPreflight() {
  if (!preflight || importing) return;
  const plan = planImport(preflight.doc, settings);
  renderReport('Preflight', [...preflight.report, ...plan.report]);
}

// ---------- File loading ----------

async function loadFile(file: File) {
  if (importing) return;
  preflight = null;
  currentFile = null;
  fontsPanel.reset([]);
  setBusy(false);
  showNotices([]);
  $('report').hidden = true;

  if (!/\.ps[db]$/i.test(file.name)) {
    showNotices([{ level: 'error', text: `"${file.name}" isn't a Photoshop file (.psd or .psb).` }]);
    return;
  }

  $('dropzone-empty').hidden = true;
  $('dropzone-file').hidden = false;
  $('file-name').textContent = file.name;
  $('file-meta').textContent = `Reading ${formatBytes(file.size)}…`;
  setStatus('Reading PSD…', 0);
  await nextFrame();

  try {
    const t0 = performance.now();
    const psd = readPsd(await file.arrayBuffer(), STRUCTURE_ONLY);
    const { doc, report } = psdToIR(psd, file.name);
    console.log(`[PSD Bridge] Parsed in ${Math.round(performance.now() - t0)} ms\n${formatTree(doc)}`, { doc, report });
    post({ type: 'debug-tree', doc });

    preflight = { doc, report };
    currentFile = file;
    fontsPanel.reset(collectFontUsage(doc.layers));
    requestFonts();
    $('file-meta').textContent = `${doc.width} × ${doc.height} px · ${doc.layers.length} layers · ${formatBytes(file.size)}`;
    renderPreflight();
  } catch (err) {
    console.error('[PSD Bridge] Parse failed', err);
    $('file-meta').textContent = formatBytes(file.size);
    showNotices([{ level: 'error', text: parseErrorMessage(file.name, err) }]);
  } finally {
    setStatus(null);
    setBusy(false);
  }
}

function parseErrorMessage(name: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (/signature/i.test(detail)) return `"${name}" isn't a valid Photoshop document. Re-save it from Photoshop and try again.`;
  if (/memory|allocation|array buffer/i.test(detail)) return `"${name}" is too large to load. Close other plugins or flatten unused layers, then try again.`;
  return `Couldn't read this PSD: ${detail}`;
}

// ---------- Import ----------

async function runImport() {
  if (!currentFile || !preflight || importing || !fontsPanel.ready) return;
  const file = currentFile;
  cancelRequested = false;
  importStarted = performance.now();
  setBusy(true);
  showNotices([]);
  $('report').hidden = true;
  setStatus('Reading layers…', 0);
  await nextFrame();

  let begun = false;
  try {
    const psd = readPsd(await file.arrayBuffer(), LAZY_PIXELS);
    const { doc, report: readReport, sources } = psdToIR(psd, file.name);
    const patterns = new PatternCache(psd.patterns ?? []);
    const plan = planImport(doc, settings);
    const { layers: _all, ...docInfo } = doc;
    const encodeReport: ReportItem[] = [];
    const fonts = fontsPanel.resolve();
    post({ type: 'save-font-map', fontMap: fonts.fontMap });
    fontsPanel.setFontMap(fonts.fontMap);

    post({
      type: 'import-begin',
      doc: docInfo,
      settings,
      totalLayers: plan.layers.length,
      preflight: [...readReport, ...plan.report],
      fonts: fonts.fonts,
      skippedFonts: fonts.skipped,
    });
    begun = true;

    let batch: PlannedLayer[] = [];
    let transfer: ArrayBuffer[] = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const ack = waitForAck();
      post({ type: 'layers-batch', layers: batch }, transfer);
      batch = [];
      transfer = [];
      bytes = 0;
      await ack;
    };

    for (let i = 0; i < plan.layers.length; i++) {
      if (cancelRequested) throw new ImportCanceled();
      const layer = plan.layers[i];
      setStatus(`Importing layer ${i + 1} of ${plan.layers.length}`, i / plan.layers.length);
      const src = layer.action === 'clip' ? undefined : sources[layer.id];
      const pngs = src ? await encodeLayer(src, layer, doc, patterns, encodeReport) : [];
      for (const png of pngs) {
        transfer.push(png.buffer as ArrayBuffer);
        bytes += png.byteLength;
      }
      batch.push(layer);
      if (batch.length >= LAYER_BATCH_SIZE || bytes >= BATCH_BYTE_LIMIT) await flush();
    }
    await flush();
    if (cancelRequested) throw new ImportCanceled();

    setStatus('Finishing…', 1);
    $<HTMLButtonElement>('cancel-btn').disabled = true;
    post({ type: 'import-end', report: encodeReport });
  } catch (err) {
    if (begun) post({ type: 'import-abort', message: String(err) });
    setStatus(null);
    setBusy(false);
    if (err instanceof ImportCanceled) {
      showNotices([{ level: 'warning', text: 'Import canceled. Nothing was added to the file.' }]);
      renderPreflight();
      return;
    }
    console.error('[PSD Bridge] Import failed', err);
    showNotices([{ level: 'error', text: `Import stopped: ${err instanceof Error ? err.message : String(err)}. Nothing was added to the file.` }]);
  }
}

/**
 * Decodes one layer's pixels and mask, encodes them to PNG, attaches them to the
 * planned layer, and frees the source's raw data. Returns the PNGs to transfer.
 */
async function encodeLayer(
  src: Layer,
  layer: PlannedLayer,
  docSize: { width: number; height: number },
  patterns: PatternCache,
  report: ReportItem[],
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const fail = (what: string, err: unknown) =>
    report.push({ level: 'skipped', layerName: layer.name, reason: `Couldn't decode ${what}: ${err instanceof Error ? err.message : String(err)}` });
  try {
    if (layer.action === 'vector') {
      const fill = layer.shape?.fill;
      if (fill?.type === 'pattern') {
        const img = await patterns.get(fill.patternId);
        if (img) {
          layer.shape = { ...layer.shape!, fill: { ...fill, image: img } };
          out.push(img.png);
        } else {
          // Without the pattern pixels, fall back to the layer's rendered pixels.
          layer.action = 'raster';
          report.push({ level: 'approximated', layerName: layer.name, reason: `Pattern "${fill.name}" not found in the PSD; shape imported as pixels.` });
        }
      }
    }

    if (layer.action === 'raster') {
      try {
        const pixels = getLayerImageData(src);
        if (pixels) {
          const enc = await encodePixels(pixels);
          layer.image = { width: enc.width, height: enc.height, png: enc.png, downscaled: enc.downscaled };
          out.push(enc.png);
        } else {
          report.push({ level: 'skipped', layerName: layer.name, reason: 'No pixel data in the PSD.' });
        }
      } catch (err) {
        fail('pixels', err);
      }
    }

    if (layer.mask && (layer.action !== 'raster' || layer.image?.png)) {
      try {
        const pixels = layer.mask.source === 'realMask' ? getLayerRealMaskImageData(src) : getLayerMaskImageData(src);
        // A group has no pixel bounds of its own; its mask may need to cover the whole canvas.
        const cover = layer.action === 'group' ? { left: 0, top: 0, width: docSize.width, height: docSize.height } : layer.bounds;
        const enc = await encodeMask(pixels, layer.mask.bounds, cover, layer.mask.defaultColor);
        layer.mask = {
          ...layer.mask,
          bounds: enc.bounds,
          image: { width: enc.width, height: enc.height, png: enc.png, downscaled: enc.downscaled },
        };
        out.push(enc.png);
      } catch (err) {
        fail('layer mask', err);
        layer.mask = undefined;
      }
    }
  } finally {
    delete src.rawData;
  }
  return out;
}

/** Encodes each Photoshop pattern once; every use gets its own copy of the bytes to transfer. */
class PatternCache {
  private readonly encoded = new Map<string, Promise<{ png: Uint8Array; width: number; height: number } | null>>();
  constructor(private readonly patterns: PatternInfo[]) {}

  async get(id: string) {
    if (!this.encoded.has(id)) {
      const p = this.patterns.find((x) => x.id === id);
      this.encoded.set(
        id,
        p
          ? encodePixels({ width: p.bounds.w, height: p.bounds.h, data: p.data }).then((e) => ({ png: e.png, width: e.width, height: e.height }))
          : Promise.resolve(null),
      );
    }
    const img = await this.encoded.get(id)!;
    return img && { ...img, png: img.png.slice() };
  }
}

function onReport(report: ImportReport) {
  setStatus(null);
  setBusy(false);
  renderReport('Import report', report.items, report.imported, performance.now() - importStarted);
  $('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- Export tab ----------

let frames: FrameInfo[] = [];

function renderFrames(selectedId: string | null) {
  const select = $<HTMLSelectElement>('frame-select');
  const previous = select.value;
  select.replaceChildren(
    ...frames.map((f) => {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name;
      return o;
    }),
  );
  const wanted = selectedId ?? previous;
  if (wanted && frames.some((f) => f.id === wanted)) select.value = wanted;
  renderFrameMeta();
}

function renderFrameMeta() {
  const frame = currentFrame();
  $('frame-meta').textContent = frame
    ? `${frame.width} × ${frame.height} px · ${frame.layerCount} layers`
    : 'No frames on this page. Select a frame on the canvas, then click Refresh.';
  $<HTMLButtonElement>('export-btn').disabled = !frame;
}

function currentFrame(): FrameInfo | undefined {
  const id = $<HTMLSelectElement>('frame-select').value;
  return frames.find((f) => f.id === id);
}

function renderExportPreview(doc: IRDocument, report: ReportItem[]) {
  const kinds = new Map<string, number>();
  for (const l of doc.layers) kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1);
  $('export-report').hidden = false;
  $('export-counts').textContent = [`${doc.layers.length} layers`, ...[...kinds].map(([k, n]) => `${n} ${k}`)].join(' · ');
  $('export-groups').replaceChildren(
    ...report.map((item) => {
      const div = document.createElement('div');
      div.className = 'item';
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = item.layerName;
      const reason = document.createElement('span');
      reason.className = 'item-reason';
      reason.textContent = item.reason;
      div.append(name, reason);
      return div;
    }),
  );
}

function showTab(tab: 'import' | 'export') {
  for (const name of ['import', 'export'] as const) {
    const active = name === tab;
    $(`panel-${name}`).hidden = !active;
    $(`tab-${name}`).classList.toggle('active', active);
    $(`tab-${name}`).setAttribute('aria-selected', String(active));
    $(`${name}-btn`).hidden = !active;
  }
  $('notices').hidden = true;
}

// ---------- Wiring ----------

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as MainToUI | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'init':
      settings = msg.settings;
      fontsPanel.setFontMap(msg.fontMap);
      fontsPanel.setEnabled(settings.editableText);
      $('version').textContent = `v${msg.version}`;
      $('menu-about').textContent = `PSD Bridge v${msg.version} · works offline`;
      renderToggles();
      break;
    case 'fonts':
      fontsPanel.update(msg.matches, msg.families, msg.fontMap);
      break;
    case 'batch-ack':
      ackWaiter?.resolve();
      ackWaiter = null;
      break;
    case 'progress':
      // The UI reports per-layer progress itself; the main thread's phase labels
      // (loading fonts) only matter before the first layer is sent.
      if (msg.done === 0 && /fonts/i.test(msg.label)) setStatus(msg.label, 0);
      break;
    case 'report':
      onReport(msg.report);
      break;
    case 'frames':
      frames = msg.frames;
      renderFrames(msg.selectedId);
      break;
    case 'frame-read':
      renderExportPreview(msg.doc, msg.report);
      break;
    case 'error':
      ackWaiter?.reject(new Error(msg.message));
      ackWaiter = null;
      setStatus(null);
      setBusy(false);
      showNotices([{ level: 'error', text: msg.message }]);
      break;
  }
};

const input = $<HTMLInputElement>('file-input');
input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (file) void loadFile(file);
  input.value = '';
});

const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files[0];
  if (file) void loadFile(file);
});

$('import-btn').addEventListener('click', () => void runImport());
$('cancel-btn').addEventListener('click', () => {
  cancelRequested = true;
  $<HTMLButtonElement>('cancel-btn').disabled = true;
  setStatus('Canceling…', 0);
});

$('tab-import').addEventListener('click', () => showTab('import'));
$('tab-export').addEventListener('click', () => showTab('export'));
$('refresh-frames').addEventListener('click', () => post({ type: 'refresh-frames' }));
$('frame-select').addEventListener('change', () => {
  $('export-report').hidden = true;
  renderFrameMeta();
});
$('export-btn').addEventListener('click', () => {
  const frame = currentFrame();
  if (frame) post({ type: 'read-frame', nodeId: frame.id });
});

$('prep-guide').addEventListener('click', () => post({ type: 'open-prep-guide' }));

$('copy-report').addEventListener('click', async () => {
  const ok = await copyText(reportText());
  showNotices([{ level: ok ? 'warning' : 'error', text: ok ? 'Report copied.' : "Couldn't copy the report." }]);
});

const menu = $('settings-menu');
const menuBtn = $('settings-btn');
const setMenu = (open: boolean) => {
  menu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector<HTMLButtonElement>('button')?.focus();
};
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(!!menu.hidden);
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) setMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (menu.hidden) return;
  const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'Escape') {
    setMenu(false);
    menuBtn.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  }
});
menu.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.action;
  if (!action) return;
  setMenu(false);
  switch (action) {
    case 'reset':
      if (importing) return;
      settings = { ...DEFAULT_SETTINGS };
      post({ type: 'save-settings', settings });
      renderToggles();
      fontsPanel.setEnabled(settings.editableText);
      renderPreflight();
      showNotices([{ level: 'warning', text: 'Import options reset to defaults.' }]);
      break;
    case 'font-map':
      fontMapSheet.open();
      break;
    case 'clear-map':
      fontsPanel.clearSaved();
      break;
  }
});

renderToggles();
post({ type: 'ui-ready' });
