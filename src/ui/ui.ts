/**
 * UI iframe. Owns the file picker, toggles, and PSD parsing (ag-psd uses the
 * browser canvas here; the main thread has none).
 */
import { readPsd } from 'ag-psd';
import type { MainToUI, UIToMain } from '../core/messages';
import type { IRDocument, ReportItem } from '../core/model';
import { formatTree, psdToIR } from '../core/psd-reader';
import { DEFAULT_SETTINGS, type ImportSettings } from '../core/settings';

const TOGGLES: { key: keyof ImportSettings; icon: string; label: string; help: string }[] = [
  { key: 'editableText', icon: 'T', label: 'Editable text', help: 'Converts text layers to Figma text' },
  { key: 'editableVectors', icon: '◆', label: 'Editable vectors', help: 'Shape layers become Figma vectors' },
  { key: 'importHidden', icon: '◌', label: 'Import hidden layers', help: 'Keeps them hidden in Figma' },
  { key: 'rebuildShadows', icon: '◐', label: 'Rebuild shadows', help: 'Drop and inner shadows become Figma effects' },
  { key: 'flattenGroups', icon: '▤', label: 'Flatten groups', help: 'Places all layers in one frame' },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: ImportSettings = { ...DEFAULT_SETTINGS };
let current: { doc: IRDocument; report: ReportItem[] } | null = null;

function post(msg: UIToMain, transfer: Transferable[] = []) {
  parent.postMessage({ pluginMessage: msg }, '*', transfer);
}

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

async function loadFile(file: File) {
  current = null;
  $<HTMLButtonElement>('import-btn').disabled = true;
  showNotices([]);

  if (!/\.psd$/i.test(file.name)) {
    showNotices([{ level: 'error', text: `"${file.name}" isn't a .psd file.` }]);
    return;
  }

  $('dropzone-empty').hidden = true;
  $('dropzone-file').hidden = false;
  $('file-name').textContent = file.name;
  $('file-meta').textContent = `Reading ${formatBytes(file.size)}…`;
  setStatus('Parsing PSD…', 0);
  // Let the status paint before the synchronous parse blocks the thread.
  await new Promise((r) => setTimeout(r, 16));

  try {
    const buffer = await file.arrayBuffer();
    const t0 = performance.now();
    // M1 reads structure only. M2 switches to useImageData and encodes layer PNGs.
    const psd = readPsd(buffer, {
      skipThumbnail: true,
      skipCompositeImageData: true,
      skipLayerImageData: true,
      skipLinkedFilesData: true,
    });
    const result = psdToIR(psd, file.name);
    const ms = Math.round(performance.now() - t0);
    current = result;

    const { doc, report } = result;
    $('file-meta').textContent = `${doc.width} × ${doc.height} px · ${doc.layers.length} layers · ${formatBytes(file.size)}`;
    console.log(`[PSD Bridge] Parsed in ${ms} ms\n${formatTree(doc)}`, { doc, report });
    post({ type: 'debug-tree', doc });

    showNotices(
      report
        .filter((r) => r.layerName === doc.name)
        .map((r) => ({ level: 'warning' as const, text: r.reason })),
    );
    $<HTMLButtonElement>('import-btn').disabled = false;
  } catch (err) {
    console.error('[PSD Bridge] Parse failed', err);
    $('file-meta').textContent = formatBytes(file.size);
    const detail = err instanceof Error ? err.message : String(err);
    const text = /signature/i.test(detail)
      ? `"${file.name}" isn't a valid Photoshop document. Re-save it from Photoshop and try again.`
      : `Couldn't read this PSD: ${detail}`;
    showNotices([{ level: 'error', text }]);
  } finally {
    setStatus(null);
  }
}

function onImport() {
  if (!current) return;
  // M1: log the tree on the main thread. Node building arrives in M2.
  post({ type: 'debug-tree', doc: current.doc });
  const skipped = current.report.filter((r) => r.level === 'skipped').length;
  const approx = current.report.filter((r) => r.level === 'approximated').length;
  showNotices([
    { level: 'warning', text: `Import isn't built yet (Milestone 2). The layer tree was logged to the console.` },
    { level: 'warning', text: `Preflight: ${approx} approximated, ${skipped} skipped.` },
  ]);
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as MainToUI | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'init':
      settings = msg.settings;
      $('version').textContent = `v${msg.version}`;
      renderToggles();
      break;
    case 'progress':
      setStatus(msg.label, msg.total ? msg.done / msg.total : 0);
      break;
    case 'error':
      setStatus(null);
      showNotices([{ level: 'error', text: msg.message }]);
      break;
    case 'report':
      setStatus(null);
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

$('import-btn').addEventListener('click', onImport);
$('settings-btn').addEventListener('click', () => {
  showNotices([{ level: 'warning', text: 'Settings (font map import/export, reset) arrive with Milestones 5–6.' }]);
});

renderToggles();
post({ type: 'ui-ready' });
