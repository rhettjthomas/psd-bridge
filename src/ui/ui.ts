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
import { planImport, type PlannedLayer } from '../core/plan';
import { formatTree, psdToIR } from '../core/psd-reader';
import { DEFAULT_SETTINGS, type ImportSettings } from '../core/settings';
import { encodeMask, encodePixels } from './encode';

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
  $<HTMLButtonElement>('import-btn').disabled = busy || !preflight;
  $<HTMLInputElement>('file-input').disabled = busy;
  for (const el of $('toggles').querySelectorAll('input')) el.disabled = busy;
}

function renderReport(title: string, items: ReportItem[], imported?: number) {
  const approx = items.filter((i) => i.level === 'approximated');
  const skipped = items.filter((i) => i.level === 'skipped');
  $('report').hidden = false;
  $('report-title').textContent = title;
  $('report-counts').textContent = [
    imported !== undefined ? `${imported} imported` : '',
    `${approx.length} approximated`,
    `${skipped.length} skipped`,
  ].filter(Boolean).join(' · ');

  const groups = [
    { level: 'approximated', label: 'Approximated', list: approx },
    { level: 'skipped', label: 'Skipped', list: skipped },
  ].filter((g) => g.list.length);

  $('report-groups').replaceChildren(
    ...groups.map((g) => {
      const details = document.createElement('details');
      details.className = `level-${g.level}`;
      const summary = document.createElement('summary');
      summary.textContent = `${g.label} (${g.list.length})`;
      const ul = document.createElement('ul');
      for (const item of g.list) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'item-name';
        name.textContent = item.layerName;
        const reason = document.createElement('span');
        reason.className = 'item-reason';
        reason.textContent = item.reason;
        li.append(name, reason);
        ul.append(li);
      }
      details.append(summary, ul);
      return details;
    }),
  );
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
  setBusy(false);
  showNotices([]);
  $('report').hidden = true;

  if (!/\.psd$/i.test(file.name)) {
    showNotices([{ level: 'error', text: `"${file.name}" isn't a .psd file.` }]);
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
  if (!currentFile || !preflight || importing) return;
  const file = currentFile;
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

    post({
      type: 'import-begin',
      doc: docInfo,
      settings,
      totalLayers: plan.layers.length,
      preflight: [...readReport, ...plan.report],
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
      const layer = plan.layers[i];
      setStatus(`Encoding layer ${i + 1} of ${plan.layers.length}`, i / plan.layers.length);
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

    setStatus('Finishing…', 1);
    post({ type: 'import-end', report: encodeReport });
  } catch (err) {
    console.error('[PSD Bridge] Import failed', err);
    if (begun) post({ type: 'import-abort', message: String(err) });
    setStatus(null);
    setBusy(false);
    showNotices([{ level: 'error', text: `Import stopped: ${err instanceof Error ? err.message : String(err)}` }]);
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
  renderReport('Import report', report.items, report.imported);
  $('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- Wiring ----------

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as MainToUI | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'init':
      settings = msg.settings;
      $('version').textContent = `v${msg.version}`;
      renderToggles();
      break;
    case 'batch-ack':
      ackWaiter?.resolve();
      ackWaiter = null;
      break;
    case 'progress':
      setStatus(msg.label, msg.total ? msg.done / msg.total : 0);
      break;
    case 'report':
      onReport(msg.report);
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
$('settings-btn').addEventListener('click', () => {
  showNotices([{ level: 'warning', text: 'Settings (font map import/export, reset) arrive with Milestones 5–6.' }]);
});

renderToggles();
post({ type: 'ui-ready' });
