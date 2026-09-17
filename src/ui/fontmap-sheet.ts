/**
 * "Font map" window: shows saved font matches as editable JSON.
 *
 * Figma's plugin iframe can block file downloads and the clipboard API, so the text
 * area is the reliable path: select it and press ⌘C, or paste a map and Save.
 * Copy, Download, and Load file are conveniences on top of that.
 */
import { parseFontMapJson, type FontMap } from '../core/fonts';

export interface FontMapSheetOptions {
  root: HTMLElement;
  getMap: () => FontMap;
  /** Replace the saved map (and rescan fonts). */
  saveMap: (map: FontMap) => void;
}

export class FontMapSheet {
  private readonly text: HTMLTextAreaElement;
  private readonly status: HTMLElement;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly opts: FontMapSheetOptions) {
    const { root } = opts;
    this.text = root.querySelector('#fontmap-text')!;
    this.status = root.querySelector('#fontmap-status')!;
    const file = root.querySelector<HTMLInputElement>('#fontmap-file')!;

    root.querySelector('#fontmap-close')!.addEventListener('click', () => this.close());
    root.querySelector('#fontmap-copy')!.addEventListener('click', () => this.copy());
    root.querySelector('#fontmap-download')!.addEventListener('click', () => this.download());
    root.querySelector('#fontmap-load')!.addEventListener('click', () => file.click());
    root.querySelector('#fontmap-save')!.addEventListener('click', () => this.save());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) await this.load(f);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen() {
    return !this.opts.root.hidden;
  }

  open() {
    this.returnFocus = document.activeElement as HTMLElement | null;
    const map = this.opts.getMap();
    this.text.value = format(map);
    const n = Object.keys(map).length;
    this.setStatus(
      n
        ? `${countLabel(n)} saved. Copy, or select the text and press ⌘C. To add matches, paste a map and Save.`
        : 'No saved matches yet. Check "Remember this match" when importing, or paste a map here and Save.',
    );
    this.opts.root.hidden = false;
    this.text.focus();
    this.text.select();
  }

  close() {
    this.opts.root.hidden = true;
    this.returnFocus?.focus();
  }

  private copy() {
    this.text.focus();
    this.text.select();
    // execCommand must run synchronously inside the click to count as a user gesture.
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    if (ok) {
      this.setStatus('Copied. Paste it into a text file and save it as .json to share.');
      return;
    }
    navigator.clipboard.writeText(this.text.value).then(
      () => this.setStatus('Copied. Paste it into a text file and save it as .json to share.'),
      () => this.setStatus('Figma blocked the clipboard. The text is selected, so press ⌘C (Ctrl+C) to copy it.', true),
    );
  }

  private download() {
    const blob = new Blob([this.text.value], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'psd-bridge-font-map.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    // There's no way to detect a blocked download, so say so plainly.
    this.setStatus('Download started, unless Figma blocked it. If no file appeared, use Copy instead.');
  }

  private async load(file: File) {
    let incoming: FontMap;
    try {
      incoming = parseStrict(await file.text());
    } catch {
      this.setStatus(`"${file.name}" isn't a valid font map (JSON).`, true);
      return;
    }
    let current: FontMap = {};
    try {
      current = parseStrict(this.text.value);
    } catch {
      // Unsaved edits that don't parse are replaced by the file's contents.
    }
    const merged = { ...current, ...incoming };
    this.text.value = format(merged);
    this.setStatus(`Loaded ${countLabel(Object.keys(incoming).length)} from "${file.name}". Click Save to keep them.`);
  }

  private save() {
    let map: FontMap;
    try {
      map = parseStrict(this.text.value);
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : 'That text isn\'t a valid font map.', true);
      return;
    }
    this.opts.saveMap(map);
    this.text.value = format(map);
    this.setStatus(`Saved ${countLabel(Object.keys(map).length)}.`);
  }

  private setStatus(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }
}

/** Empty text is an empty map; anything else must be a JSON object. */
export function parseStrict(text: string): FontMap {
  if (!text.trim()) return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That text isn't valid JSON. Check for a missing comma or quote.");
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('A font map is a JSON object like {"Font-PostScriptName": {"family": "…", "style": "…"}}.');
  }
  const map = parseFontMapJson(text);
  const dropped = Object.keys(data).length - Object.keys(map).length;
  if (dropped > 0) throw new Error(`${countLabel(dropped)} ${dropped === 1 ? 'is' : 'are'} missing a "family" or "style".`);
  return map;
}

function format(map: FontMap): string {
  return Object.keys(map).length ? JSON.stringify(map, null, 2) : '';
}

function countLabel(n: number): string {
  return `${n} font ${n === 1 ? 'match' : 'matches'}`;
}
